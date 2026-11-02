package draw

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math"

	// Pictures people send: JPEG, GIF, WebP besides PNG.
	_ "image/gif"
	_ "image/jpeg"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

var errPicture = errors.New("这张图读不出来")

func decode(b []byte) (image.Image, error) {
	im, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, errPicture
	}
	return im, nil
}

func pngB64(im image.Image) (string, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, im); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// Picture is a PNG ready for NovelAI.
type Picture struct {
	B64           string
	Width, Height int
}

// FitImage scales and crops a picture to the normal size nearest its shape (img2img).
func FitImage(b []byte) (Picture, error) {
	im, err := decode(b)
	if err != nil {
		return Picture{}, err
	}
	sw, sh := im.Bounds().Dx(), im.Bounds().Dy()
	w, h := SizeFor(OrientationOf(sw, sh), false)
	s := max(float64(w)/float64(sw), float64(h)/float64(sh))
	dw, dh := int(float64(sw)*s+0.5), int(float64(sh)*s+0.5)
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, image.Rect((w-dw)/2, (h-dh)/2, (w-dw)/2+dw, (h-dh)/2+dh), im, im.Bounds(), xdraw.Over, nil)
	out, err := pngB64(dst)
	return Picture{B64: out, Width: w, Height: h}, err
}

// PadReference fits a character reference into 1024×1536 / 1536×1024 /
// 1472×1472 with black around it.
func PadReference(b []byte) (string, error) {
	im, err := decode(b)
	if err != nil {
		return "", err
	}
	sw, sh := im.Bounds().Dx(), im.Bounds().Dy()
	w, h := ReferenceCanvas(sw, sh)
	s := min(float64(w)/float64(sw), float64(h)/float64(sh))
	dw, dh := max(1, int(float64(sw)*s+0.5)), max(1, int(float64(sh)*s+0.5))
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.Draw(dst, dst.Bounds(), &image.Uniform{C: color.Black}, image.Point{}, xdraw.Src)
	xdraw.CatmullRom.Scale(dst, image.Rect((w-dw)/2, (h-dh)/2, (w-dw)/2+dw, (h-dh)/2+dh), im, im.Bounds(), xdraw.Over, nil)
	return pngB64(dst)
}

// ShrinkPNG makes a picture a PNG of at most maxPixels (vibe encoding, upscaling).
func ShrinkPNG(b []byte, maxPixels int) (Picture, error) {
	im, err := decode(b)
	if err != nil {
		return Picture{}, err
	}
	sw, sh := im.Bounds().Dx(), im.Bounds().Dy()
	s := 1.0
	if sw*sh > maxPixels {
		s = math.Sqrt(float64(maxPixels) / float64(sw*sh))
	}
	w, h := max(1, int(float64(sw)*s+0.5)), max(1, int(float64(sh)*s+0.5))
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), im, im.Bounds(), xdraw.Over, nil)
	out, err := pngB64(dst)
	return Picture{B64: out, Width: w, Height: h}, err
}
