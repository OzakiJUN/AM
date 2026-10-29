// Package media stores uploaded images and files, makes thumbnails and
// fingerprints, and decides who may download what.
//
// Layout under <data_dir>/media:
//
//	blobs/ab/abcdef...   original files, named by SHA-256 (one copy per content)
//	thumbs/abcdef....jpg thumbnails / static first frames (.jpg or .png)
//	tmp/                 uploads in progress
//
// All file access goes through this package, so moving storage to object
// storage + CDN later only changes this file.
package media

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/draw"
	_ "image/gif" // register decoders
	"image/jpeg"
	"image/png"
	"io"
	"math/bits"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/store"
)

const (
	thumbMaxSide  = 320
	maxPixels     = 40_000_000 // refuse to decode images larger than this
	gcGracePeriod = 24 * time.Hour
)

var (
	ErrTooLarge     = apperr.New(http.StatusRequestEntityTooLarge, "too_large", "file is too large")
	ErrBlocked      = apperr.New(http.StatusForbidden, "blocked_media", "this image is blocked")
	ErrNotImage     = apperr.New(http.StatusBadRequest, "not_image", "this file is not a supported image")
	ErrMediaMissing = apperr.New(http.StatusNotFound, "media_not_found", "media not found")
	ErrBadImage     = apperr.New(http.StatusBadRequest, "bad_image", "image could not be read or is too large in pixels")
)

type Service struct {
	st            *store.Store
	ids           *idgen.Generator
	root          string
	maxBytes      int64
	blockDistance int
	now           func() time.Time
}

func New(st *store.Store, ids *idgen.Generator, dataDir string, maxUploadMB, blockDistance int) (*Service, error) {
	root := filepath.Join(dataDir, "media")
	for _, d := range []string{"blobs", "thumbs", "tmp"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o700); err != nil {
			return nil, err
		}
	}
	return &Service{
		st: st, ids: ids, root: root,
		maxBytes:      int64(maxUploadMB) << 20,
		blockDistance: blockDistance,
		now:           time.Now,
	}, nil
}

func (s *Service) blobPath(sha string) string {
	return filepath.Join(s.root, "blobs", sha[:2], sha)
}

func (s *Service) thumbPath(sha, mime string) string {
	ext := ".png"
	if mime == "image/jpeg" {
		ext = ".jpg"
	}
	return filepath.Join(s.root, "thumbs", sha+ext)
}

func thumbMime(mime string) string {
	if mime == "image/jpeg" {
		return "image/jpeg"
	}
	return "image/png"
}

var imageMimes = map[string]bool{"image/jpeg": true, "image/png": true, "image/gif": true, "image/webp": true}

// Upload stores a file from r. name is the original file name.
func (s *Service) Upload(ctx context.Context, uploaderID int64, name string, r io.Reader) (*store.Media, error) {
	tmp, err := os.CreateTemp(filepath.Join(s.root, "tmp"), "up-*")
	if err != nil {
		return nil, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once renamed

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(r, s.maxBytes+1))
	closeErr := tmp.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if n > s.maxBytes {
		return nil, ErrTooLarge
	}
	if n == 0 {
		return nil, apperr.ErrBadRequest
	}
	sha := hex.EncodeToString(h.Sum(nil))

	head := make([]byte, 512)
	f, err := os.Open(tmpName)
	if err != nil {
		return nil, err
	}
	hn, _ := io.ReadFull(f, head)
	f.Close()
	mime := http.DetectContentType(head[:hn])
	if i := strings.Index(mime, ";"); i >= 0 {
		mime = mime[:i]
	}

	m := &store.Media{
		ID:         s.ids.Next(),
		UploaderID: uploaderID,
		SHA256:     sha,
		Mime:       mime,
		Size:       n,
		Name:       cleanName(name),
		IsImage:    imageMimes[mime],
		CreatedAt:  s.now().UnixMilli(),
	}

	if m.IsImage {
		if err := s.processImage(ctx, tmpName, m); err != nil {
			return nil, err
		}
	}

	blob := s.blobPath(sha)
	if _, err := os.Stat(blob); errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(filepath.Dir(blob), 0o700); err != nil {
			return nil, err
		}
		if err := os.Rename(tmpName, blob); err != nil {
			return nil, err
		}
	}
	if err := s.st.CreateMedia(ctx, m); err != nil {
		return nil, err
	}
	return m, nil
}

// processImage fills width/height/phash, checks the blocklist and writes the thumbnail.
func (s *Service) processImage(ctx context.Context, path string, m *store.Media) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxPixels {
		return ErrBadImage
	}
	m.Width, m.Height = cfg.Width, cfg.Height
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	img, _, err := image.Decode(f) // for GIF this is the first frame
	if err != nil {
		return ErrBadImage
	}

	m.PHash = int64(DHash(img))
	blocked, err := s.isBlocked(ctx, m.PHash)
	if err != nil {
		return err
	}
	if blocked {
		return ErrBlocked
	}

	thumb := resizeToFit(img, thumbMaxSide)
	var buf bytes.Buffer
	if m.Mime == "image/jpeg" {
		err = jpeg.Encode(&buf, thumb, &jpeg.Options{Quality: 82})
	} else {
		err = png.Encode(&buf, thumb)
	}
	if err != nil {
		return err
	}
	if err := os.WriteFile(s.thumbPath(m.SHA256, m.Mime), buf.Bytes(), 0o600); err != nil {
		return err
	}
	m.HasThumb = true
	return nil
}

func (s *Service) isBlocked(ctx context.Context, phash int64) (bool, error) {
	list, err := s.st.ListBlockedHashes(ctx)
	if err != nil {
		return false, err
	}
	for _, b := range list {
		if bits.OnesCount64(uint64(b.PHash)^uint64(phash)) <= s.blockDistance {
			return true, nil
		}
	}
	return false, nil
}

// Block adds a media item's fingerprint to the blocklist.
func (s *Service) Block(ctx context.Context, q *store.Queries, mediaID int64, reason string, by int64) error {
	m, err := q.GetMedia(ctx, mediaID)
	if err != nil || m.PHash == 0 {
		return err
	}
	return q.AddBlockedHash(ctx, s.ids.Next(), m.PHash, reason, by, s.now().UnixMilli())
}

// OwnUpload returns a media item the user uploaded (only your own uploads
// can be sent or used as an avatar).
func (s *Service) OwnUpload(ctx context.Context, userID, mediaID int64, mustBeImage bool) (*store.Media, error) {
	m, err := s.st.GetMedia(ctx, mediaID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && m.UploaderID != userID) {
		return nil, ErrMediaMissing
	}
	if err != nil {
		return nil, err
	}
	if mustBeImage && !m.IsImage {
		return nil, ErrNotImage
	}
	return m, nil
}

// File is an opened media file ready to be served.
type File struct {
	Path string
	Mime string
	Name string
}

// Open checks access and returns the original or the thumbnail.
func (s *Service) Open(ctx context.Context, user *store.User, mediaID int64, thumb bool) (*File, error) {
	m, err := s.st.GetMedia(ctx, mediaID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrMediaMissing
	}
	if err != nil {
		return nil, err
	}
	if !user.IsSiteAdmin {
		ok, err := s.st.CanAccessMedia(ctx, mediaID, user.ID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, ErrMediaMissing // don't reveal that it exists
		}
	}
	if thumb {
		if !m.HasThumb {
			return nil, ErrMediaMissing
		}
		return &File{Path: s.thumbPath(m.SHA256, m.Mime), Mime: thumbMime(m.Mime)}, nil
	}
	return &File{Path: s.blobPath(m.SHA256), Mime: m.Mime, Name: m.Name}, nil
}

// GC deletes media rows nobody refers to (after a grace period, so fresh
// uploads that are about to be sent are kept) and blobs no row uses.
func (s *Service) GC(ctx context.Context) (int, error) {
	before := s.now().Add(-gcGracePeriod).UnixMilli()
	list, err := s.st.UnreferencedMedia(ctx, before, 500)
	if err != nil {
		return 0, err
	}
	for _, m := range list {
		if err := s.st.DeleteMedia(ctx, m.ID); err != nil {
			return 0, err
		}
		left, err := s.st.CountMediaBySHA(ctx, m.SHA256)
		if err != nil {
			return 0, err
		}
		if left == 0 {
			_ = os.Remove(s.blobPath(m.SHA256))
			_ = os.Remove(s.thumbPath(m.SHA256, m.Mime))
		}
	}
	return len(list), nil
}

// DHash computes a 64-bit difference hash: shrink to 9x8 grey, then one bit
// per pixel = "brighter than its right neighbour". Re-saved, resized or
// slightly edited copies get hashes within a few bits of each other.
func DHash(img image.Image) uint64 {
	small := image.NewGray(image.Rect(0, 0, 9, 8))
	xdraw.ApproxBiLinear.Scale(small, small.Bounds(), img, img.Bounds(), draw.Src, nil)
	var h uint64
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			h <<= 1
			if small.GrayAt(x, y).Y > small.GrayAt(x+1, y).Y {
				h |= 1
			}
		}
	}
	return h
}

func resizeToFit(img image.Image, maxSide int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= maxSide && h <= maxSide {
		// Still re-encode (strips metadata, normalises GIF to one frame).
		out := image.NewRGBA(image.Rect(0, 0, w, h))
		draw.Draw(out, out.Bounds(), img, b.Min, draw.Src)
		return out
	}
	if w >= h {
		h = h * maxSide / w
		w = maxSide
	} else {
		w = w * maxSide / h
		h = maxSide
	}
	if w < 1 {
		w = 1
	}
	if h < 1 {
		h = 1
	}
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(out, out.Bounds(), img, b, draw.Src, nil)
	return out
}

func cleanName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, name)
	if name == "." || name == "/" {
		name = ""
	}
	for utf8.RuneCountInString(name) > 120 {
		r := []rune(name)
		name = string(r[:120])
	}
	return name
}

// ContentDisposition builds a safe header value for downloads.
func ContentDisposition(name string) string {
	if name == "" {
		return "inline"
	}
	return fmt.Sprintf("inline; filename*=UTF-8''%s", urlEscape(name))
}

func urlEscape(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.IndexByte("-._~", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
