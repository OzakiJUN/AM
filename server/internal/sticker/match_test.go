package sticker

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"math/rand"
	"testing"

	xdraw "golang.org/x/image/draw"

	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/store"
)

// picture draws a few random blobs on a random background: different seeds
// give different pictures, like different stickers.
func picture(seed int64, w, h int) image.Image {
	r := rand.New(rand.NewSource(seed))
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{uint8(r.Intn(256)), uint8(r.Intn(256)), uint8(r.Intn(256)), 255}}, image.Point{}, draw.Src)
	for i := 0; i < 12; i++ {
		c := color.RGBA{uint8(r.Intn(256)), uint8(r.Intn(256)), uint8(r.Intn(256)), 255}
		x0, y0 := r.Intn(w), r.Intn(h)
		rect := image.Rect(x0, y0, x0+w/6+r.Intn(w/3), y0+h/6+r.Intn(h/3))
		draw.Draw(img, rect, &image.Uniform{c}, image.Point{}, draw.Src)
	}
	return img
}

func resized(img image.Image, w, h int) image.Image {
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(out, out.Bounds(), img, img.Bounds(), draw.Src, nil)
	return out
}

func recompressed(t *testing.T, img image.Image, q int) image.Image {
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, &jpeg.Options{Quality: q}); err != nil {
		t.Fatal(err)
	}
	out, err := jpeg.Decode(&b)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func printOf(img image.Image) print {
	b := img.Bounds()
	h, _ := media.PHash256(img)
	return print{h: h, ratio: ratioOf(b.Dx(), b.Dy())}
}

// meme draws "a line of text" (random glyph-like strokes) under a picture,
// the most common sticker: same layout, different words.
func meme(pic, words int64) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, 240, 240))
	draw.Draw(img, img.Bounds(), image.White, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(40, 20, 200, 170), picture(pic, 160, 150), image.Point{}, draw.Src)
	r := rand.New(rand.NewSource(words))
	for x := 30; x < 210; x += 12 {
		for i := 0; i < 3; i++ {
			gx, gy := x+r.Intn(8), 185+r.Intn(30)
			draw.Draw(img, image.Rect(gx, gy, gx+2+r.Intn(5), gy+2+r.Intn(10)), image.Black, image.Point{}, draw.Src)
		}
	}
	return img
}

const defaultDistance = 10 // stickers.dedupe_distance in default.toml

func TestCopiesMatch(t *testing.T) {
	for seed := int64(1); seed <= 20; seed++ {
		orig := picture(seed, 240, 240)
		a := printOf(orig)
		if !a.comparable() {
			t.Fatalf("seed %d: random picture got no fingerprint", seed)
		}
		for name, img := range map[string]image.Image{
			"half size": resized(orig, 120, 120),
			"bigger":    resized(orig, 300, 300),
			"jpeg 70":   recompressed(t, orig, 70),
			"small jpg": recompressed(t, resized(orig, 160, 160), 60),
		} {
			b := printOf(img)
			if !same(a, b, defaultDistance) {
				t.Errorf("seed %d %s: distance %d, not merged", seed, name, distance(a, b))
			}
		}
	}
}

func TestDifferentPicturesDoNotMatch(t *testing.T) {
	var prints []print
	for seed := int64(100); seed < 160; seed++ {
		prints = append(prints, printOf(picture(seed, 200, 200)))
	}
	closestPair := 256
	for i := range prints {
		for j := i + 1; j < len(prints); j++ {
			if d := distance(prints[i], prints[j]); d < closestPair {
				closestPair = d
			}
			if same(prints[i], prints[j], defaultDistance) {
				t.Errorf("pictures %d and %d merged (distance %d)", i, j, distance(prints[i], prints[j]))
			}
		}
	}
	t.Logf("closest two different pictures: %d bits apart", closestPair)
}

func TestShapeAndAnimationMatter(t *testing.T) {
	orig := picture(7, 240, 240)
	a := printOf(orig)
	wide := printOf(resized(orig, 240, 200))
	if same(a, wide, 256) {
		t.Error("a different shape was merged")
	}
	anim := a
	anim.animated = true
	if same(a, anim, 256) {
		t.Error("a GIF was merged with a still picture")
	}
	if same(a, a, 0) {
		t.Error("distance 0 must mean identical files only")
	}
}

func TestPlainPicturesOnlyMatchExactly(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 200, 200))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{250, 250, 250, 255}}, image.Point{}, draw.Src)
	draw.Draw(img, image.Rect(90, 98, 110, 102), &image.Uniform{color.RGBA{200, 200, 200, 255}}, image.Point{}, draw.Src)
	if p := printOf(img); p.comparable() {
		t.Fatal("an almost blank picture got a fingerprint")
	}
}

// Same picture, different words underneath: must stay two stickers. Same
// words, re-saved: one.
func TestMemesWithDifferentWords(t *testing.T) {
	worst, best := 256, 0
	for pic := int64(1); pic <= 10; pic++ {
		a := printOf(meme(pic, 1))
		for w := int64(2); w <= 6; w++ {
			b := printOf(meme(pic, w))
			if d := distance(a, b); d < worst {
				worst = d
			}
			if same(a, b, defaultDistance) {
				t.Errorf("picture %d: words 1 and %d merged (distance %d)", pic, w, distance(a, b))
			}
		}
		c := printOf(recompressed(t, resized(meme(pic, 1), 180, 180), 70))
		if d := distance(a, c); d > best {
			best = d
		}
		if !same(a, c, defaultDistance) {
			t.Errorf("picture %d: re-saved copy not merged (distance %d)", pic, distance(a, c))
		}
	}
	t.Logf("different words: at least %d bits apart; re-saved copy: at most %d", worst, best)
}

func TestPrintRoundTrip(t *testing.T) {
	p := printOf(picture(3, 100, 100))
	q, ok := parsePrint(p.hex(), false, p.ratio)
	if !ok || q.h != p.h {
		t.Fatalf("round trip: %v %v", ok, q.h)
	}
	if _, ok := parsePrint("zz", false, 1); ok {
		t.Error("bad hex accepted")
	}
	list := []store.LibraryPrint{{ID: 1, Fingerprint: printOf(picture(4, 100, 100)).hex(), Ratio: 1000}, {ID: 2, Fingerprint: p.hex(), Ratio: 1000}}
	if id := closest(p, list, defaultDistance); id != 2 {
		t.Errorf("closest = %d", id)
	}
}

func TestMergeTags(t *testing.T) {
	rows := []store.LibraryTag{
		{Key: "doge", Tag: "Doge", AddedBy: 1, AddedAt: 1},
		{Key: "狗头", Tag: "狗头", AddedBy: 1, AddedAt: 2},
		{Key: "狗头", Tag: "狗头", AddedBy: 2, AddedAt: 3},
		{Key: "doge", Tag: "doge", AddedBy: 3, AddedAt: 4},
		{Key: "开心", Tag: "开心", AddedBy: 2, AddedAt: 5},
	}
	all, mine := mergeTags(rows, 2)
	if fmt.Sprint(all) != "[Doge 狗头 开心]" || fmt.Sprint(mine) != "[狗头 开心]" {
		t.Fatalf("all %v mine %v", all, mine)
	}
	if got := cleanTags([]string{" a  b ", "A B", "", "c"}, 20); fmt.Sprint(got) != "[a b c]" {
		t.Fatalf("clean: %q", got)
	}
}
