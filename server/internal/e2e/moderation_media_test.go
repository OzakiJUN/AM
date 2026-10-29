package e2e

import (
	"bytes"
	"image"
	"image/color"
	"image/color/palette"
	"image/gif"
	"image/jpeg"
	"image/png"
	"strings"
	"testing"
	"time"

	xdraw "golang.org/x/image/draw"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/app"
)

func TestModerationAndMedia(t *testing.T) { forEachDB(t, testModerationAndMedia) }

// testImage draws a gradient so the perceptual hash has some structure.
func testImage(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 255 / w), uint8(y * 255 / h), uint8((x + y) % 256), 255})
		}
	}
	return img
}

func encodePNG(img image.Image) []byte {
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

func testGIF() []byte {
	frames := &gif.GIF{}
	for i := 0; i < 2; i++ {
		p := image.NewPaletted(image.Rect(0, 0, 64, 64), palette.Plan9)
		for y := 0; y < 64; y++ {
			for x := 0; x < 64; x++ {
				p.SetColorIndex(x, y, uint8((x+y+i*40)%200))
			}
		}
		frames.Image = append(frames.Image, p)
		frames.Delay = append(frames.Delay, 10)
	}
	var b bytes.Buffer
	_ = gif.EncodeAll(&b, frames)
	return b.Bytes()
}

func testModerationAndMedia(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "siteadmin", "bob", "carol", "dave")
	site, bob, carol, dave := us[0], us[1], us[2], us[3]

	// --- login records ---
	logins := must(bob.cli.ListLogins(ctx))
	if len(logins.Records) == 0 || logins.Records[0].Kind != "register" || logins.Records[0].Ip == "" {
		t.Fatalf("login records: %v", logins.Records)
	}

	g := must(bob.cli.CreateGroup(ctx, "mod", carol.me.Id, dave.me.Id))
	if err := bob.cli.SetAdmin(ctx, g.Id, dave.me.Id, true); err != nil {
		t.Fatal(err)
	}
	carolWS := must(carol.cli.Connect(ctx))
	defer carolWS.Close()
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	daveWS := must(dave.cli.Connect(ctx))
	defer daveWS.Close()

	// --- admin delete rules ---
	bad := must(carolWS.SendText(ctx, g.Id, "违规内容"))
	ownerMsg := must(bobWS.SendText(ctx, g.Id, "owner says hi"))
	adminMsg := must(daveWS.SendText(ctx, g.Id, "admin says hi"))

	wantCode(t, carol.cli.AdminDelete(ctx, adminMsg.EventId, "no", false), "no_permission")
	wantCode(t, dave.cli.AdminDelete(ctx, ownerMsg.EventId, "no", false), "no_permission")
	wantCode(t, dave.cli.AdminDelete(ctx, bad.EventId, "  ", false), "reason_required")
	if err := dave.cli.AdminDelete(ctx, bad.EventId, "违规", false); err != nil {
		t.Fatal(err)
	}
	wantCode(t, dave.cli.AdminDelete(ctx, bad.EventId, "again", false), "already_deleted")
	if err := bob.cli.AdminDelete(ctx, adminMsg.EventId, "owner removes admin msg", false); err != nil {
		t.Fatal(err)
	}
	waitPush(t, carolWS, "admin_delete event", func(f *amv1.ServerFrame) bool {
		d := f.GetEvent().GetEvent().GetAdminDelete()
		return d != nil && d.TargetEventId == bad.EventId && d.Reason == "违规"
	})

	// The deleted message syncs without content but with the record.
	page := must(carolWS.Sync(ctx, map[int64]int64{g.Id: bad.Seq - 1}, 1))
	got := page.Events[0]
	if got.EventId != bad.EventId || got.GetText() != nil || got.Redaction == nil || got.Redaction.DeletedBy != dave.me.Id {
		t.Fatalf("deleted message as synced: %v", got)
	}
	// Content kept in the evidence store, with a future purge date.
	ev := must(a.Store.GetEvidence(ctx, bad.EventId))
	if len(ev.Payload) == 0 || ev.PurgeAfter <= time.Now().UnixMilli() || ev.Reason != "违规" {
		t.Fatalf("evidence: %+v", ev)
	}
	audit, _, auditErr := a.Store.ListAudit(ctx, 20, 0)
	if auditErr != nil {
		t.Fatal(auditErr)
	}
	found := false
	for _, e := range audit {
		if e.Action == "admin_delete" && e.TargetID == bad.EventId {
			found = true
		}
	}
	if !found {
		t.Fatal("admin_delete not in audit log")
	}
	// Site admin may delete anywhere, even in a DM they are not in.
	dm := must(bob.cli.OpenDM(ctx, carol.me.Id))
	dmMsg := must(bobWS.SendText(ctx, dm.Id, "dm text"))
	wantCode(t, carol.cli.AdminDelete(ctx, dmMsg.EventId, "x", false), "no_permission")
	if err := site.cli.AdminDelete(ctx, dmMsg.EventId, "site admin", false); err != nil {
		t.Fatal(err)
	}

	// --- images ---
	pic := encodePNG(testImage(400, 200))
	info := must(carol.cli.Upload(ctx, "pic.png", bytes.NewReader(pic)))
	if !info.IsImage || info.Width != 400 || info.Height != 200 || info.ThumbUrl == "" || info.Mime != "image/png" {
		t.Fatalf("image upload: %v", info)
	}
	// Uploaded but not sent: others cannot see it yet.
	_, _, err := bob.cli.Download(ctx, info.Url)
	wantCode(t, err, "media_not_found")
	_, err = bobWS.SendImage(ctx, g.Id, info.Id) // not bob's upload
	wantCode(t, err, "media_not_found")

	imgEv := must(carolWS.SendImage(ctx, g.Id, info.Id))
	if imgEv.GetImage().GetWidth() != 400 {
		t.Fatalf("image event: %v", imgEv)
	}
	orig, mime := must2(bob.cli.Download(ctx, info.Url))
	if !bytes.Equal(orig, pic) || mime != "image/png" {
		t.Fatalf("download original: %d bytes, %s", len(orig), mime)
	}
	thumb, _ := must2(bob.cli.Download(ctx, info.ThumbUrl))
	tcfg, _, err := image.DecodeConfig(bytes.NewReader(thumb))
	if err != nil || tcfg.Width != 320 || tcfg.Height != 160 {
		t.Fatalf("thumbnail %dx%d err=%v", tcfg.Width, tcfg.Height, err)
	}
	stranger := registerStranger(t, site, base)
	_, _, err = stranger.cli.Download(ctx, info.Url)
	wantCode(t, err, "media_not_found")

	// Same image uploaded again shares the stored file.
	again := must(bob.cli.Upload(ctx, "copy.png", bytes.NewReader(pic)))
	if again.Id == info.Id {
		t.Fatal("second upload should get its own media id")
	}

	// --- delete + block ---
	if err := dave.cli.AdminDelete(ctx, imgEv.EventId, "blocked picture", true); err != nil {
		t.Fatal(err)
	}
	_, _, err = bob.cli.Download(ctx, info.Url)
	wantCode(t, err, "media_not_found") // no longer in a visible message
	_, err = dave.cli.Upload(ctx, "re.png", bytes.NewReader(pic))
	wantCode(t, err, "blocked_media")
	bigger := image.NewRGBA(image.Rect(0, 0, 800, 400)) // same picture, resized + re-encoded
	xdraw.CatmullRom.Scale(bigger, bigger.Bounds(), testImage(400, 200), image.Rect(0, 0, 400, 200), xdraw.Src, nil)
	var jb bytes.Buffer
	_ = jpeg.Encode(&jb, bigger, &jpeg.Options{Quality: 70})
	_, err = dave.cli.Upload(ctx, "re.jpg", &jb)
	wantCode(t, err, "blocked_media")

	// --- files ---
	fileInfo := must(carol.cli.Upload(ctx, "notes 笔记.txt", strings.NewReader("hello file")))
	if fileInfo.IsImage || fileInfo.ThumbUrl != "" || fileInfo.Name != "notes 笔记.txt" {
		t.Fatalf("file upload: %v", fileInfo)
	}
	fileEv := must(carolWS.SendFile(ctx, g.Id, fileInfo.Id, ""))
	if fileEv.GetFile().GetName() != "notes 笔记.txt" || fileEv.GetFile().GetSize() != 10 {
		t.Fatalf("file event: %v", fileEv)
	}
	body, _ := must2(bob.cli.Download(ctx, fileInfo.Url))
	if string(body) != "hello file" {
		t.Fatalf("file content %q", body)
	}
	_, err = carolWS.SendImage(ctx, g.Id, fileInfo.Id)
	wantCode(t, err, "not_image")

	// --- GIF avatar ---
	gifInfo := must(carol.cli.Upload(ctx, "avatar.gif", bytes.NewReader(testGIF())))
	if gifInfo.Mime != "image/gif" {
		t.Fatalf("gif mime %s", gifInfo.Mime)
	}
	me := must(carol.cli.UpdateProfile(ctx, &amv1.UpdateProfileRequest{AvatarMediaId: ptr(gifInfo.Id), DisplayName: ptr("卡罗尔")}))
	if me.Avatar == "" || me.AvatarStatic == "" || me.DisplayName != "卡罗尔" {
		t.Fatalf("profile: %v", me)
	}
	anim, mime := must2(stranger.cli.Download(ctx, me.Avatar)) // avatars are visible to everyone
	if mime != "image/gif" || len(anim) == 0 {
		t.Fatalf("avatar download: %s", mime)
	}
	static, mime := must2(stranger.cli.Download(ctx, me.AvatarStatic))
	if mime != "image/png" {
		t.Fatalf("static avatar mime %s", mime)
	}
	if _, err := png.Decode(bytes.NewReader(static)); err != nil {
		t.Fatalf("static avatar is not a PNG: %v", err)
	}
	_, err = carol.cli.UpdateProfile(ctx, &amv1.UpdateProfileRequest{AvatarMediaId: ptr(fileInfo.Id)})
	wantCode(t, err, "not_image")

	// --- retention ---
	far := time.Now().Add(400 * 24 * time.Hour).UnixMilli()
	n := must(a.Store.PurgeEvidence(ctx, far))
	if n < 3 {
		t.Fatalf("purged %d evidence rows, want >= 3", n)
	}
	unused := must(a.Store.UnreferencedMedia(ctx, far, 100))
	ids := map[int64]bool{}
	for _, m := range unused {
		ids[m.ID] = true
	}
	if !ids[info.Id] || !ids[again.Id] || ids[gifInfo.Id] || ids[fileInfo.Id] {
		t.Fatalf("unreferenced media after purge: %v", ids)
	}
}

func must2[A, B any](a A, b B, err error) (A, B) {
	if err != nil {
		panic(err)
	}
	return a, b
}
