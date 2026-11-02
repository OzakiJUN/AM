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
	"math"
	"math/bits"
	"net/http"
	"os"
	"path/filepath"
	"sort"
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

// Sound files the music widgets may play. Sniffing can't name every format
// (an MP3 without an ID3 tag, FLAC, AAC), so the file name counts too.
var (
	audioMimes = map[string]bool{"application/ogg": true, "video/mp4": true, "video/webm": true}
	audioExts  = map[string]bool{".mp3": true, ".m4a": true, ".aac": true, ".flac": true, ".ogg": true, ".opus": true, ".wav": true, ".webm": true}
)

// IsAudio reports whether a stored file is a sound file.
func IsAudio(m *store.Media) bool {
	if strings.HasPrefix(m.Mime, "audio/") {
		return true
	}
	ext := strings.ToLower(filepath.Ext(m.Name))
	return audioExts[ext] && (audioMimes[m.Mime] || m.Mime == "application/octet-stream")
}

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

// ReadOwn reads a file the user uploaded (at most max bytes; plugin zips).
func (s *Service) ReadOwn(ctx context.Context, userID, mediaID, max int64) ([]byte, error) {
	m, err := s.OwnUpload(ctx, userID, mediaID, false)
	if err != nil {
		return nil, err
	}
	if m.Size > max {
		return nil, ErrTooLarge
	}
	return os.ReadFile(s.blobPath(m.SHA256))
}

// StickerImage returns an image a user may send as a sticker although
// they did not upload it: it is in their collection or in the shared
// sticker library.
func (s *Service) StickerImage(ctx context.Context, userID, mediaID int64) (*store.Media, error) {
	ok, err := s.st.StickerMediaUsable(ctx, userID, mediaID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrMediaMissing
	}
	m, err := s.st.GetMedia(ctx, mediaID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrMediaMissing
	}
	if err != nil {
		return nil, err
	}
	if !m.IsImage {
		return nil, ErrNotImage
	}
	return m, nil
}

// VisibleImage returns an image the user uploaded or may see (e.g. one sent
// in a chat they are in), for putting it into their sticker collection.
func (s *Service) VisibleImage(ctx context.Context, userID, mediaID int64) (*store.Media, error) {
	m, err := s.st.GetMedia(ctx, mediaID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrMediaMissing
	}
	if err != nil {
		return nil, err
	}
	if m.UploaderID != userID {
		ok, err := s.st.CanAccessMedia(ctx, mediaID, userID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, ErrMediaMissing
		}
	}
	if !m.IsImage {
		return nil, ErrNotImage
	}
	return m, nil
}

// Fingerprint returns a 256-bit perceptual hash (64 hex digits) of an
// image file, finer than the 64-bit one used for the blocklist: the shared
// sticker library uses it to find copies that look the same (re-saved,
// resized). "" when the picture is too plain to compare that way (then
// only identical files match). GIFs use their first frame.
func (s *Service) Fingerprint(m *store.Media) (string, error) {
	f, err := os.Open(s.blobPath(m.SHA256))
	if err != nil {
		return "", err
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil || cfg.Width*cfg.Height > maxPixels {
		return "", ErrBadImage
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	img, _, err := image.Decode(f)
	if err != nil {
		return "", ErrBadImage
	}
	h, ok := PHash256(img)
	if !ok {
		return "", nil
	}
	return fmt.Sprintf("%016x%016x%016x%016x", h[0], h[1], h[2], h[3]), nil
}

// PHash256 is a DCT perceptual hash: shrink to 32x32 grey, take the 16x16
// lowest frequencies, one bit per coefficient = "above their median". About
// half the bits are set for any picture, so different pictures land about
// 128 bits apart and re-saved / resized copies a few bits apart. ok is
// false for pictures with hardly any contrast.
func PHash256(img image.Image) (h [4]uint64, ok bool) {
	const n = 32
	small := image.NewGray(image.Rect(0, 0, n, n))
	xdraw.CatmullRom.Scale(small, small.Bounds(), img, img.Bounds(), draw.Src, nil)
	var px [n][n]float64
	var sum, sq float64
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			v := float64(small.GrayAt(x, y).Y)
			px[y][x] = v
			sum += v
			sq += v * v
		}
	}
	mean := sum / (n * n)
	if sq/(n*n)-mean*mean < 8*8 { // standard deviation under 8 of 255
		return h, false
	}
	// Separable DCT-II, only the 16 lowest frequencies each way.
	var cos [16][n]float64
	for u := 0; u < 16; u++ {
		for x := 0; x < n; x++ {
			cos[u][x] = math.Cos(float64(2*x+1) * float64(u) * math.Pi / (2 * n))
		}
	}
	var rows [n][16]float64
	for y := 0; y < n; y++ {
		for u := 0; u < 16; u++ {
			var a float64
			for x := 0; x < n; x++ {
				a += px[y][x] * cos[u][x]
			}
			rows[y][u] = a
		}
	}
	var c [256]float64
	for v := 0; v < 16; v++ {
		for u := 0; u < 16; u++ {
			var a float64
			for y := 0; y < n; y++ {
				a += rows[y][u] * cos[v][y]
			}
			c[v*16+u] = a
		}
	}
	// Median of the AC coefficients (the DC one is just the brightness).
	ac := make([]float64, 255)
	copy(ac, c[1:])
	sort.Float64s(ac)
	med := (ac[126] + ac[127]) / 2
	for i := 1; i < 256; i++ {
		if c[i] > med {
			h[i/64] |= 1 << (63 - uint(i%64))
		}
	}
	return h, true
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

// OpenForPanel returns a media file for the server admin panel: evidence,
// files sent in channels and avatars, never files sent in direct messages.
func (s *Service) OpenForPanel(ctx context.Context, mediaID int64, groupKind int16, thumb bool) (*File, error) {
	ok, err := s.st.PanelCanSeeMedia(ctx, mediaID, groupKind)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrMediaMissing
	}
	return s.Open(ctx, &store.User{IsSiteAdmin: true}, mediaID, thumb)
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

// ---- server icon ----

const (
	serverIconSide  = 256
	maxServerIconMB = 2
)

func (s *Service) serverIconPath() string { return filepath.Join(s.root, "server_icon.png") }

// SetServerIcon stores the server's icon: any supported image, re-encoded as
// a PNG of at most 256 px (which also strips metadata).
func (s *Service) SetServerIcon(data []byte) error {
	if len(data) > maxServerIconMB<<20 {
		return ErrTooLarge
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return ErrNotImage
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > maxPixels {
		return ErrBadImage
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return ErrBadImage
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, resizeToFit(img, serverIconSide)); err != nil {
		return err
	}
	tmp := s.serverIconPath() + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.serverIconPath())
}

// RemoveServerIcon deletes the icon (no icon is fine).
func (s *Service) RemoveServerIcon() error {
	if err := os.Remove(s.serverIconPath()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// ServerIcon returns the icon file and a version that changes with it, or
// nil when the server has no icon.
func (s *Service) ServerIcon() (*File, int64) {
	st, err := os.Stat(s.serverIconPath())
	if err != nil {
		return nil, 0
	}
	return &File{Path: s.serverIconPath(), Mime: "image/png", Name: "server_icon.png"}, st.ModTime().UnixMilli()
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

// AnyImage is a stored picture, whoever uploaded it (only for the server's
// own bot, which shows pictures its features keep).
func (s *Service) AnyImage(ctx context.Context, mediaID int64) (*store.Media, error) {
	m, err := s.st.GetMedia(ctx, mediaID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrMediaMissing
	}
	if err != nil {
		return nil, err
	}
	if !m.IsImage {
		return nil, ErrNotImage
	}
	return m, nil
}
