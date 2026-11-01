package e2e

import (
	"bytes"
	"strings"
	"testing"

	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
)

// Stickers: my own images with tags I typed; the tags travel with a sent sticker.
func TestStickers(t *testing.T) {
	forEachDB(t, testStickers, func(c *config.Config) { c.Limits.MaxStickers = 2 })
}

func testStickers(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "alice", "bob")
	alice, bob := us[0], us[1]
	img1 := must(alice.cli.Upload(ctx, "dog.png", bytes.NewReader(encodePNG(testImage(10, 10)))))
	img2 := must(alice.cli.Upload(ctx, "cat.png", bytes.NewReader(encodePNG(testImage(11, 11)))))
	img3 := must(alice.cli.Upload(ctx, "fish.png", bytes.NewReader(encodePNG(testImage(12, 12)))))
	doc := must(alice.cli.Upload(ctx, "a.txt", strings.NewReader("not a picture")))

	// Tags are trimmed, de-duplicated and capped.
	s1 := must(alice.cli.AddSticker(ctx, img1.Id, " 狗头 ", "狗头", "", strings.Repeat("长", 30)))
	if len(s1.Tags) != 2 || s1.Tags[0] != "狗头" || len([]rune(s1.Tags[1])) != 20 {
		t.Fatalf("tags: %q", s1.Tags)
	}
	// The same picture again: same sticker, tags added.
	if s := must(alice.cli.AddSticker(ctx, img1.Id, "doge")); s.Id != s1.Id || len(s.Tags) != 3 {
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
