// Package music reads NetEase Cloud Music links for the music widgets
// (docs/design.md §7): a song or a playlist becomes title, artist, track
// list and a cover copied into the asker's uploads. The JSON endpoints used
// here are the ones music.163.com's own pages call; they are not a public
// API and may change, so everything fails soft (music_unavailable).
// Playing is not done here: listeners stream the song from NetEase.
package music

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/store"
)

const (
	MaxTracks = 50
	maxBody   = 4 << 20
	maxCover  = 3 << 20
	maxTitle  = 40
	maxArtist = 30
)

type Service struct {
	enabled bool
	base    string
	hc      *http.Client
	media   *media.Service
}

// New: base is the NetEase address (config media.netease_api; tests use a fake).
func New(enabled bool, base string, md *media.Service) *Service {
	return &Service{enabled: enabled, base: strings.TrimRight(base, "/"), media: md, hc: &http.Client{Timeout: 15 * time.Second}}
}

var (
	idRe    = regexp.MustCompile(`(?:[?&#]|^)id=(\d{1,20})`)
	pathRe  = regexp.MustCompile(`/(song|playlist)/(\d{1,20})`)
	shortRe = regexp.MustCompile(`^https?://(?:[a-z0-9-]+\.)?163cn\.tv/`)
)

// parse finds "song" / "playlist" and the id in a link.
func parse(link string) (kind, id string, ok bool) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || (u.Host != "" && !strings.HasSuffix(u.Host, "163.com")) {
		return "", "", false
	}
	// The SPA keeps the real path in the fragment: music.163.com/#/song?id=1
	full := u.Path + "?" + u.RawQuery
	if u.Fragment != "" {
		full = u.Fragment
	}
	if m := pathRe.FindStringSubmatch(full); m != nil {
		return m[1], m[2], true
	}
	m := idRe.FindStringSubmatch(full[strings.Index(full, "?")+1:])
	if m == nil {
		return "", "", false
	}
	switch {
	case strings.Contains(full, "playlist"):
		return "playlist", m[1], true
	case strings.Contains(full, "song"):
		return "song", m[1], true
	}
	return "", "", false
}

func (s *Service) get(ctx context.Context, rawURL string, max int64) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36")
	req.Header.Set("Referer", "https://music.163.com/")
	resp, err := s.hc.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("status %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(b)) > max {
		return nil, "", fmt.Errorf("too big")
	}
	return b, resp.Request.URL.String(), nil
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > n {
		return string([]rune(s)[:n])
	}
	return s
}

type artist struct {
	Name string `json:"name"`
}

func names(a []artist) string {
	var out []string
	for _, x := range a {
		if x.Name != "" {
			out = append(out, x.Name)
		}
	}
	return strings.Join(out, " / ")
}

// A track in either of NetEase's two shapes (song/detail: artists/album; v6: ar/al).
type track struct {
	ID      int64    `json:"id"`
	Name    string   `json:"name"`
	Artists []artist `json:"artists"`
	Ar      []artist `json:"ar"`
	Album   struct {
		PicURL string `json:"picUrl"`
	} `json:"album"`
	Al struct {
		PicURL string `json:"picUrl"`
	} `json:"al"`
}

func (t track) artist() string {
	if len(t.Ar) > 0 {
		return names(t.Ar)
	}
	return names(t.Artists)
}

func (t track) cover() string {
	if t.Al.PicURL != "" {
		return t.Al.PicURL
	}
	return t.Album.PicURL
}

func (t track) view() *amv1.MusicTrack {
	return &amv1.MusicTrack{NeteaseId: fmt.Sprint(t.ID), Title: clip(t.Name, maxTitle), Artist: clip(t.artist(), maxArtist)}
}

func (s *Service) songs(ctx context.Context, ids []string) ([]track, error) {
	b, _, err := s.get(ctx, s.base+"/api/song/detail/?ids=["+strings.Join(ids, ",")+"]", maxBody)
	if err != nil {
		return nil, err
	}
	var v struct {
		Code  int     `json:"code"`
		Songs []track `json:"songs"`
	}
	if json.Unmarshal(b, &v) != nil || v.Code != 200 {
		return nil, fmt.Errorf("bad answer")
	}
	return v.Songs, nil
}

// Resolve reads a link and copies the cover into me's uploads.
func (s *Service) Resolve(ctx context.Context, me *store.User, link string) (*amv1.ResolveMusicResponse, error) {
	if !s.enabled {
		return nil, apperr.ErrMusicUnavail
	}
	link = strings.TrimSpace(link)
	if i := strings.Index(link, "http"); i > 0 {
		link = link[i:] // "分享单曲：晴天 https://…" pasted whole
	}
	if f := strings.Fields(link); len(f) > 0 {
		link = f[0]
	}
	if shortRe.MatchString(link) {
		// Short share links redirect to the real page.
		_, final, err := s.get(ctx, link, maxBody)
		if err != nil {
			return nil, apperr.ErrMusicUnavail
		}
		link = final
	}
	kind, id, ok := parse(link)
	if !ok {
		return nil, apperr.ErrMusicLink
	}
	out := &amv1.ResolveMusicResponse{Kind: kind, NeteaseId: id}
	var cover string
	if kind == "song" {
		list, err := s.songs(ctx, []string{id})
		if err != nil || len(list) == 0 {
			return nil, apperr.ErrMusicUnavail
		}
		t := list[0]
		out.Title, out.Artist, cover = clip(t.Name, maxTitle), clip(t.artist(), maxArtist), t.cover()
		out.Tracks = []*amv1.MusicTrack{t.view()}
	} else {
		b, _, err := s.get(ctx, s.base+"/api/v6/playlist/detail?id="+id+"&n=1000", maxBody)
		if err != nil {
			return nil, apperr.ErrMusicUnavail
		}
		var v struct {
			Code     int `json:"code"`
			Playlist struct {
				Name        string  `json:"name"`
				CoverImgURL string  `json:"coverImgUrl"`
				Tracks      []track `json:"tracks"`
				TrackIDs    []struct {
					ID int64 `json:"id"`
				} `json:"trackIds"`
				Creator struct {
					Nickname string `json:"nickname"`
				} `json:"creator"`
			} `json:"playlist"`
		}
		if json.Unmarshal(b, &v) != nil || v.Code != 200 {
			return nil, apperr.ErrMusicUnavail
		}
		p := v.Playlist
		out.Title, out.Artist, cover = clip(p.Name, maxTitle), clip(p.Creator.Nickname, maxArtist), p.CoverImgURL
		tracks := p.Tracks
		// Without a login NetEase may list only the ids: look the songs up.
		if len(tracks) < MaxTracks && len(p.TrackIDs) > len(tracks) {
			var ids []string
			for _, t := range p.TrackIDs {
				if len(ids) == MaxTracks {
					break
				}
				ids = append(ids, fmt.Sprint(t.ID))
			}
			if more, err := s.songs(ctx, ids); err == nil {
				tracks = more
			}
		}
		for _, t := range tracks {
			if len(out.Tracks) == MaxTracks {
				break
			}
			out.Tracks = append(out.Tracks, t.view())
		}
	}
	if cover != "" {
		// A cover that can't be copied is no reason to fail: the widget shows a placeholder.
		if m, err := s.copyCover(ctx, me, cover); err == nil {
			out.CoverMediaId = m.ID
		}
	}
	return out, nil
}

// copyCover downloads a cover (NetEase's image hosts, or the configured
// address in tests) and stores it as me's upload.
func (s *Service) copyCover(ctx context.Context, me *store.User, raw string) (*store.Media, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	base, _ := url.Parse(s.base)
	if !(strings.HasSuffix(u.Host, ".126.net") || (base != nil && u.Host == base.Host)) || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, fmt.Errorf("cover host %q not allowed", u.Host)
	}
	q := u.Query()
	q.Set("param", "400y400") // NetEase scales on request
	u.RawQuery = q.Encode()
	b, _, err := s.get(ctx, u.String(), maxCover)
	if err != nil {
		return nil, err
	}
	return s.media.Upload(ctx, me.ID, "cover.jpg", strings.NewReader(string(b)))
}
