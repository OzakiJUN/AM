package e2e

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"log/slog"
	"math/rand"
	"strings"
	"testing"
	"time"

	xdraw "golang.org/x/image/draw"

	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/sticker"
	"github.com/OzakiJUN/am/server/internal/store"
)

// stickerPic draws random blocks: different seeds look different.
func stickerPic(seed int64, w, h int) image.Image {
	r := rand.New(rand.NewSource(seed))
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.RGBA{uint8(r.Intn(256)), uint8(r.Intn(256)), uint8(r.Intn(256)), 255}}, image.Point{}, draw.Src)
	for i := 0; i < 12; i++ {
		c := color.RGBA{uint8(r.Intn(256)), uint8(r.Intn(256)), uint8(r.Intn(256)), 255}
		x0, y0 := r.Intn(w), r.Intn(h)
		draw.Draw(img, image.Rect(x0, y0, x0+w/6+r.Intn(w/3), y0+h/6+r.Intn(h/3)), &image.Uniform{c}, image.Point{}, draw.Src)
	}
	return img
}

// resavedJPEG is the same picture made smaller and saved as JPEG.
func resavedJPEG(img image.Image, w, h int) []byte {
	out := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(out, out.Bounds(), img, img.Bounds(), draw.Src, nil)
	var b bytes.Buffer
	_ = jpeg.Encode(&b, out, &jpeg.Options{Quality: 75})
	return b.Bytes()
}

// Stickers: my own images with tags I typed; the tags travel with a sent sticker.
func TestStickers(t *testing.T) {
	forEachDB(t, testStickers, func(c *config.Config) { c.Limits.MaxStickers = 2 })
}

func testStickers(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "alice", "bob")
	alice, bob := us[0], us[1]
	img1 := must(alice.cli.Upload(ctx, "dog.png", bytes.NewReader(encodePNG(stickerPic(1, 120, 120)))))
	img2 := must(alice.cli.Upload(ctx, "cat.png", bytes.NewReader(encodePNG(stickerPic(2, 120, 120)))))
	img3 := must(alice.cli.Upload(ctx, "fish.png", bytes.NewReader(encodePNG(stickerPic(3, 120, 120)))))
	doc := must(alice.cli.Upload(ctx, "a.txt", strings.NewReader("not a picture")))

	// Tags are trimmed, de-duplicated and capped, and keep the order they were typed in.
	s1 := must(alice.cli.AddSticker(ctx, img1.Id, " 狗头 ", "狗头", "", strings.Repeat("长", 30), "abc"))
	if len(s1.Tags) != 3 || s1.Tags[0] != "狗头" || len([]rune(s1.Tags[1])) != 20 || s1.Tags[2] != "abc" {
		t.Fatalf("tags: %q", s1.Tags)
	}
	// The same picture again: same sticker, tags added.
	if s := must(alice.cli.AddSticker(ctx, img1.Id, "doge")); s.Id != s1.Id || len(s.Tags) != 4 {
		t.Fatalf("re-add: %+v", s)
	}
	must(alice.cli.AddSticker(ctx, img2.Id))
	_, err := alice.cli.AddSticker(ctx, img3.Id)
	wantCode(t, err, "sticker_limit")
	_, err = alice.cli.AddSticker(ctx, doc.Id)
	wantCode(t, err, "not_image")
	// Only your own uploads, only your own stickers.
	_, err = bob.cli.AddSticker(ctx, img3.Id)
	wantCode(t, err, "media_not_found")
	_, err = bob.cli.SetStickerTags(ctx, s1.Id, "偷改")
	wantCode(t, err, "not_found")
	if s := must(alice.cli.SetStickerTags(ctx, s1.Id, "开心")); len(s.Tags) != 1 || s.Tags[0] != "开心" {
		t.Fatalf("set tags: %+v", s)
	}
	if l := must(alice.cli.ListStickers(ctx)).Stickers; len(l) != 2 || l[1].Id != s1.Id {
		t.Fatalf("list: %+v", l)
	}
	if len(must(bob.cli.ListStickers(ctx)).Stickers) != 0 {
		t.Fatal("bob sees alice's stickers")
	}

	// Sending one: an image message carrying the tags.
	dm := must(alice.cli.OpenDM(ctx, bob.me.Id))
	ws := must(alice.cli.Connect(ctx))
	defer ws.Close()
	e := must(ws.SendSticker(ctx, dm.Id, img1.Id, "开心", "开心", " "))
	if tags := e.GetImage().GetStickerTags(); len(tags) != 1 || tags[0] != "开心" {
		t.Fatalf("sent tags: %q", tags)
	}

	// Deleting: gone from the list; the message keeps its picture.
	if err := alice.cli.DeleteSticker(ctx, s1.Id); err != nil {
		t.Fatal(err)
	}
	wantCode(t, alice.cli.DeleteSticker(ctx, s1.Id), "not_found")
	if _, _, err := bob.cli.Download(ctx, "/api/v1/media/"+itoa(img1.Id)); err != nil {
		t.Fatalf("bob lost the sent sticker: %v", err)
	}
}

// The shared library: one copy per picture (same look counts), earliest
// uploader shown, everyone's tags, private stickers, admin hide / delete.
func TestStickerLibrary(t *testing.T) {
	forEachDB(t, testStickerLibrary, func(*config.Config) {})
}

func testStickerLibrary(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "alice", "bob", "carol")
	alice, bob, carol := us[0], us[1], us[2]
	dog := stickerPic(10, 200, 200)
	aliceDog := must(alice.cli.Upload(ctx, "dog.png", bytes.NewReader(encodePNG(dog))))
	s1 := must(alice.cli.AddSticker(ctx, aliceDog.Id, "狗头"))
	if s1.LibraryId == 0 || s1.Private || s1.UploaderId != alice.me.Id || s1.Sha256 == "" {
		t.Fatalf("shared by default: %+v", s1)
	}

	// Bob adds a smaller re-saved copy: merged into alice's, her picture.
	bobDog := must(bob.cli.Upload(ctx, "dog.jpg", bytes.NewReader(resavedJPEG(dog, 150, 150))))
	s2 := must(bob.cli.AddSticker(ctx, bobDog.Id, "doge"))
	if s2.LibraryId != s1.LibraryId || s2.MediaId != aliceDog.Id || s2.UploaderId != alice.me.Id {
		t.Fatalf("copy not merged: %+v vs %+v", s2, s1)
	}
	if len(s2.Tags) != 2 || len(s2.MyTags) != 1 || s2.MyTags[0] != "doge" {
		t.Fatalf("tags: %q mine %q", s2.Tags, s2.MyTags)
	}
	// A different picture is a different entry.
	cat := must(bob.cli.Upload(ctx, "cat.png", bytes.NewReader(encodePNG(stickerPic(11, 200, 200)))))
	s3 := must(bob.cli.AddSticker(ctx, cat.Id, "猫"))
	if s3.LibraryId == s1.LibraryId {
		t.Fatal("different pictures merged")
	}

	// Carol sees both, searches by tag, sends one she does not have.
	lib := must(carol.cli.StickerLibrary(ctx, "", "hot", 0))
	if len(lib.Items) != 2 || lib.Items[0].Id != s1.LibraryId || lib.Items[0].Collectors != 2 || lib.Items[0].MyStickerId != 0 {
		t.Fatalf("library: %+v", lib.Items)
	}
	if l := must(carol.cli.StickerLibrary(ctx, "DOG", "", 0)).Items; len(l) != 1 || l[0].Id != s1.LibraryId {
		t.Fatalf("search: %+v", l)
	}
	if l := must(carol.cli.StickerLibrary(ctx, "狗 猫", "", 0)).Items; len(l) != 0 {
		t.Fatalf("all words must match: %+v", l)
	}
	if l := must(carol.cli.StickerLibrary(ctx, "", "new", 0)).Items; l[0].Id != s3.LibraryId {
		t.Fatalf("newest first: %+v", l)
	}
	dm := must(carol.cli.OpenDM(ctx, alice.me.Id))
	ws := must(carol.cli.Connect(ctx))
	defer ws.Close()
	must(ws.SendSticker(ctx, dm.Id, aliceDog.Id, "狗头"))

	// Tags: anyone adds, you take off only your own.
	lt := must(carol.cli.EditLibraryTags(ctx, s1.LibraryId, []string{"开心"}, []string{"狗头"}))
	if len(lt.Tags) != 3 || len(lt.MyTags) != 1 {
		t.Fatalf("carol's tag edit: %q mine %q", lt.Tags, lt.MyTags)
	}
	// Bob replaces his tags: only his change.
	s2 = must(bob.cli.SetStickerTags(ctx, s2.Id, "柴犬"))
	if strings.Join(s2.Tags, ",") != "狗头,开心,柴犬" || strings.Join(s2.MyTags, ",") != "柴犬" {
		t.Fatalf("bob's tags: %q mine %q", s2.Tags, s2.MyTags)
	}
	many := make([]string, 20)
	for i := range many {
		many[i] = "t" + itoa(int64(i))
	}
	_, err := carol.cli.EditLibraryTags(ctx, s1.LibraryId, many, nil)
	wantCode(t, err, "sticker_tags_full")

	// Collect, and a lookup by file finds the library entry.
	s4 := must(carol.cli.CollectSticker(ctx, s3.LibraryId))
	if again := must(carol.cli.CollectSticker(ctx, s3.LibraryId)); again.Id != s4.Id {
		t.Fatal("collected twice")
	}
	found := must(carol.cli.LookupStickers(ctx, s1.Sha256, strings.Repeat("0", 64), "nope"))
	if len(found) != 1 || found[s1.Sha256] != s1.LibraryId {
		t.Fatalf("lookup: %v", found)
	}

	// Private: never in the library; going private when others have it
	// keeps the entry, going private as the only one takes it down.
	fish := must(carol.cli.Upload(ctx, "fish.png", bytes.NewReader(encodePNG(stickerPic(12, 200, 200)))))
	p := must(carol.cli.AddPrivateSticker(ctx, fish.Id, true, "鱼"))
	if p.LibraryId != 0 || !p.Private || len(must(bob.cli.StickerLibrary(ctx, "鱼", "", 0)).Items) != 0 {
		t.Fatalf("private sticker shared: %+v", p)
	}
	p = must(carol.cli.SetStickerPrivate(ctx, p.Id, false))
	if p.LibraryId == 0 || len(must(bob.cli.StickerLibrary(ctx, "鱼", "", 0)).Items) != 1 {
		t.Fatalf("shared again: %+v", p)
	}
	p = must(carol.cli.SetStickerPrivate(ctx, p.Id, true))
	if p.LibraryId != 0 || len(p.Tags) != 1 || len(must(bob.cli.StickerLibrary(ctx, "鱼", "", 0)).Items) != 0 {
		t.Fatalf("only one had it, still listed: %+v", p)
	}
	s4 = must(carol.cli.SetStickerPrivate(ctx, s4.Id, true))
	if l := must(alice.cli.StickerLibrary(ctx, "猫", "", 0)).Items; len(l) != 1 || l[0].Collectors != 1 {
		t.Fatalf("bob still has it: %+v", l)
	}

	// Pictures seen in a chat can be collected; others' private uploads can't.
	ws2 := must(alice.cli.Connect(ctx))
	defer ws2.Close()
	pic := must(alice.cli.Upload(ctx, "sent.png", bytes.NewReader(encodePNG(stickerPic(13, 200, 200)))))
	must(ws2.SendImage(ctx, dm.Id, pic.Id))
	if s := must(carol.cli.AddPrivateSticker(ctx, pic.Id, true)); !s.Private {
		t.Fatal("collect from chat")
	}
	hidden := must(alice.cli.Upload(ctx, "mine.png", bytes.NewReader(encodePNG(stickerPic(14, 200, 200)))))
	_, err = carol.cli.AddSticker(ctx, hidden.Id)
	wantCode(t, err, "media_not_found")

	// Admin hide: not listed, bob keeps it; admin delete: gone from every
	// collection, kept as evidence, blocked.
	if err := a.Stickers.SetHidden(ctx, 0, s3.LibraryId, true); err != nil {
		t.Fatal(err)
	}
	if l := must(alice.cli.StickerLibrary(ctx, "猫", "", 0)).Items; len(l) != 0 {
		t.Fatal("hidden picture listed")
	}
	if l := must(bob.cli.ListStickers(ctx)).Stickers; len(l) != 2 {
		t.Fatalf("bob lost the hidden one: %d", len(l))
	}
	if err := a.Stickers.AdminDelete(ctx, 0, s1.LibraryId, " ", false); !errors.Is(err, apperr.ErrReasonRequired) {
		t.Fatalf("no reason: %v", err)
	}
	if err := a.Stickers.AdminDelete(ctx, 0, s1.LibraryId, "违规", true); err != nil {
		t.Fatal(err)
	}
	for _, u := range []*user{alice, bob} {
		for _, x := range must(u.cli.ListStickers(ctx)).Stickers {
			if x.LibraryId == s1.LibraryId {
				t.Fatal("deleted picture still in a collection")
			}
		}
	}
	_, err = carol.cli.CollectSticker(ctx, s1.LibraryId)
	wantCode(t, err, "not_found")
	items, total, err := a.Stickers.AdminList(ctx, "", "deleted", false, 50, 0)
	if err != nil || total != 1 || items[0].DeleteReason != "违规" || items[0].PurgeAfter <= time.Now().UnixMilli() {
		t.Fatalf("evidence: %v %d %+v", err, total, items)
	}
	_, err = bob.cli.Upload(ctx, "again.png", bytes.NewReader(encodePNG(dog)))
	wantCode(t, err, "blocked_media")
	far := time.Now().Add(400 * 24 * time.Hour).UnixMilli()
	if n := must(a.Store.PurgeStickerLibrary(ctx, far)); n != 1 {
		t.Fatalf("purged %d", n)
	}
}

// Stickers made while the library was off are shared when it is turned on.
func TestStickerLibraryLinksOld(t *testing.T) {
	forEachDB(t, func(t *testing.T, a *app.App, base string) {
		ctx := ctxT(t)
		us := newServerUsers(t, a, base, "alice")
		img := must(us[0].cli.Upload(ctx, "a.png", bytes.NewReader(encodePNG(stickerPic(20, 100, 100)))))
		s := must(us[0].cli.AddSticker(ctx, img.Id, "旧"))
		if s.LibraryId != 0 || s.Private {
			t.Fatalf("library off: %+v", s)
		}
		on := sticker.New(a.Store, idgen.New(9), a.Media, sticker.Config{Max: 10, Library: true, DefaultPublic: true, DedupeDistance: 10})
		on.LinkWaiting(ctx, slog.New(slog.DiscardHandler))
		l := must(on.List(ctx, &store.User{ID: us[0].me.Id})).Stickers
		if len(l) != 1 || l[0].LibraryId == 0 || l[0].Tags[0] != "旧" {
			t.Fatalf("not linked: %+v", l)
		}
	}, func(c *config.Config) { c.Stickers.Library = false })
}
