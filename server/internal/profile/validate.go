package profile

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Board geometry (docs/protocol.md, "主页小组件").
const (
	MaxPages   = 3
	landCols   = 6
	landRows   = 4
	portCols   = 4
	portRows   = 6
	maxSide    = 4
	maxWidgets = 3 * 24 // can't have more than the cells anyway
	maxConfig  = 8 << 10
)

var (
	widgetIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	shaRe      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	colorRe    = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	presetRe   = regexp.MustCompile(`^[a-z0-9-]{1,20}$`)
	digitsRe   = regexp.MustCompile(`^[0-9]{1,20}$`)
)

// kindSpec describes a built-in widget kind.
type kindSpec struct {
	minW, minH int
	// 0 = both profiles, else only store.ProfileUser / store.ProfileServer.
	only int16
	// check validates the JSON config and returns the media it uses.
	check func(cfg []byte) ([]int64, error)
}

var kinds = map[string]kindSpec{
	"text": {2, 1, 0, func(c []byte) ([]int64, error) {
		var v struct{ Title, Text string }
		return nil, check(c, &v, func() bool { return maxLen(v.Title, 40) && maxLen(v.Text, 1000) })
	}},
	"image": {1, 1, 0, func(c []byte) ([]int64, error) {
		var v struct {
			MediaID string `json:"media_id"`
			Caption string
			Fit     string
		}
		if err := check(c, &v, func() bool {
			return maxLen(v.Caption, 80) && (v.Fit == "" || v.Fit == "cover" || v.Fit == "contain")
		}); err != nil {
			return nil, err
		}
		return mediaIDs(v.MediaID)
	}},
	"gallery": {2, 2, 0, func(c []byte) ([]int64, error) {
		var v struct {
			MediaIDs []string `json:"media_ids"`
			Interval int
			Caption  string
		}
		if err := check(c, &v, func() bool {
			return len(v.MediaIDs) <= 20 && (v.Interval == 0 || (v.Interval >= 2 && v.Interval <= 60)) && maxLen(v.Caption, 80)
		}); err != nil {
			return nil, err
		}
		return mediaIDs(v.MediaIDs...)
	}},
	"links": {2, 1, 0, func(c []byte) ([]int64, error) {
		var v struct {
			Items []struct{ Title, URL string } `json:"items"`
		}
		return nil, check(c, &v, func() bool {
			if len(v.Items) > 6 {
				return false
			}
			for _, it := range v.Items {
				if !maxLen(it.Title, 30) || len(it.URL) > 300 ||
					!(strings.HasPrefix(it.URL, "https://") || strings.HasPrefix(it.URL, "http://")) {
					return false
				}
			}
			return true
		})
	}},
	"countdown": {1, 1, 0, func(c []byte) ([]int64, error) {
		var v struct {
			Title string
			Date  int64
		}
		return nil, check(c, &v, func() bool { return maxLen(v.Title, 30) && v.Date >= 0 })
	}},
	"stats": {2, 1, 0, func(c []byte) ([]int64, error) {
		var v struct{ Items []string }
		return nil, check(c, &v, func() bool {
			for _, it := range v.Items {
				switch it {
				case "messages", "streak", "joined", "members", "channels", "age":
				default:
					return false
				}
			}
			return len(v.Items) <= 6
		})
	}},
	"guestbook": {2, 2, 0, func(c []byte) ([]int64, error) {
		var v struct{ Title string }
		return nil, check(c, &v, func() bool { return maxLen(v.Title, 30) })
	}},
	"music": {2, 2, 0, func(c []byte) ([]int64, error) {
		var v struct {
			Provider   string
			PlaylistID string `json:"playlist_id"`
			Title      string
		}
		return nil, check(c, &v, func() bool {
			return (v.Provider == "" || v.Provider == "netease") &&
				(v.PlaylistID == "" || digitsRe.MatchString(v.PlaylistID)) && maxLen(v.Title, 40)
		})
	}},
	"status": {2, 1, store.ProfileUser, func(c []byte) ([]int64, error) { return nil, check(c, &struct{}{}, nil) }},
	"online": {2, 2, store.ProfileServer, func(c []byte) ([]int64, error) { return nil, check(c, &struct{}{}, nil) }},
}

// check parses a widget config into v, then runs ok (nil = no limits).
// Unknown fields are allowed: newer clients may add some.
func check(cfg []byte, v any, ok func() bool) error {
	if json.Unmarshal(cfg, v) != nil || (ok != nil && !ok()) {
		return apperr.ErrInvalidWidget
	}
	return nil
}

func maxLen(s string, n int) bool { return utf8.RuneCountInString(s) <= n }

func mediaIDs(ids ...string) ([]int64, error) {
	var out []int64
	for _, s := range ids {
		if s == "" {
			continue
		}
		id, err := strconv.ParseInt(s, 10, 64)
		if err != nil || id <= 0 {
			return nil, apperr.ErrInvalidWidget
		}
		out = append(out, id)
	}
	return out, nil
}

// validate checks a layout for profile kind `owner` and returns the media
// every widget uses (by widget id; "" = background).
func validate(l *amv1.ProfileLayout, owner int16) (map[string][]int64, error) {
	if len(l.GetWidgets()) > maxWidgets {
		return nil, apperr.ErrInvalidWidget
	}
	media := map[string][]int64{}
	land := map[int32]*board{}
	port := map[int32]*board{}
	for _, w := range l.GetWidgets() {
		if !widgetIDRe.MatchString(w.GetId()) || media[w.GetId()] != nil {
			return nil, apperr.ErrInvalidWidget
		}
		if len(w.GetConfig()) > maxConfig || (w.GetConfig() != "" && !json.Valid([]byte(w.GetConfig()))) {
			return nil, apperr.ErrInvalidWidget
		}
		minW, minH := 1, 1
		var ids []int64
		switch w.GetSource() {
		case amv1.WidgetSource_WIDGET_SOURCE_BUILTIN:
			spec, ok := kinds[w.GetKind()]
			if !ok || (spec.only != 0 && spec.only != owner) {
				return nil, apperr.ErrInvalidWidget
			}
			cfg := []byte(w.GetConfig())
			if len(cfg) == 0 {
				cfg = []byte("{}")
			}
			var err error
			if ids, err = spec.check(cfg); err != nil {
				return nil, err
			}
			minW, minH = spec.minW, spec.minH
		case amv1.WidgetSource_WIDGET_SOURCE_WORKSHOP:
			if w.GetWorkshopId() == "" || len(w.GetWorkshopId()) > 100 || len(w.GetWorkshopVersion()) > 40 ||
				!shaRe.MatchString(w.GetPackageSha256()) || len(w.GetKind()) > 64 {
				return nil, apperr.ErrInvalidWidget
			}
		default:
			return nil, apperr.ErrInvalidWidget
		}
		if w.GetSnapshotMediaId() != 0 {
			ids = append(ids, w.GetSnapshotMediaId())
		}
		if w.GetW() < int32(minW) || w.GetH() < int32(minH) || w.GetW() > maxSide || w.GetH() > maxSide {
			return nil, apperr.ErrInvalidWidget
		}
		if !place(land, w.GetLandscape(), w.GetW(), w.GetH(), landCols, landRows) {
			return nil, apperr.ErrInvalidWidget
		}
		if l.GetPortraitCustom() && !place(port, w.GetPortrait(), w.GetW(), w.GetH(), portCols, portRows) {
			return nil, apperr.ErrInvalidWidget
		}
		if ids == nil {
			ids = []int64{}
		}
		media[w.GetId()] = ids
	}
	bg := l.GetBackground()
	switch bg.GetKind() {
	case "":
	case "color":
		if !colorRe.MatchString(bg.GetValue()) {
			return nil, apperr.ErrInvalidWidget
		}
	case "gradient":
		if !presetRe.MatchString(bg.GetValue()) {
			return nil, apperr.ErrInvalidWidget
		}
	case "image":
		if bg.GetMediaId() <= 0 {
			return nil, apperr.ErrInvalidWidget
		}
		media[""] = []int64{bg.GetMediaId()}
	default:
		return nil, apperr.ErrInvalidWidget
	}
	if bg.GetBlur() < 0 || bg.GetBlur() > 40 || bg.GetDim() < 0 || bg.GetDim() > 80 {
		return nil, apperr.ErrInvalidWidget
	}
	return media, nil
}

// board marks the cells taken on one page of one orientation.
type board struct{ taken [portRows][landCols]bool }

func place(pages map[int32]*board, c *amv1.Cell, w, h int32, cols, rows int32) bool {
	if c == nil || c.GetPage() < 0 || c.GetPage() >= MaxPages || c.GetX() < 0 || c.GetY() < 0 ||
		c.GetX()+w > cols || c.GetY()+h > rows {
		return false
	}
	b := pages[c.GetPage()]
	if b == nil {
		b = &board{}
		pages[c.GetPage()] = b
	}
	for y := c.GetY(); y < c.GetY()+h; y++ {
		for x := c.GetX(); x < c.GetX()+w; x++ {
			if b.taken[y][x] {
				return false
			}
			b.taken[y][x] = true
		}
	}
	return true
}
