package e2e

import (
	"bytes"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
)

// Channel museums (docs/design.md §13 博物馆): hanging (with and without a
// vote), the full hall, swapping, the warehouse, likes, the second hall,
// NSFW, AI-made pictures, who can see the pictures.
func TestMuseum(t *testing.T) {
	forEachDB(t, testMuseum, func(c *config.Config) { c.Museum.MinMembers = 4; c.Museum.VoteMinutes = 30 })
}

func testMuseum(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "admin", "bob", "carol")
	admin, bob, carol := us[0], us[1], us[2]
	adminWS := must(admin.cli.Connect(ctx))
	defer adminWS.Close()

	// A public channel with three people: changes happen at once.
	pub := must(admin.cli.CreatePublicChannel(ctx, "画廊"))
	ai := must(admin.cli.CreateAI(ctx, "画家")).User
	helper := must(admin.cli.CreateAI(ctx, "助手")).User
	must(bob.cli.JoinChannel(ctx, pub.Id))
	post := func(c *amclient.Conn, conv int64, seed int64) int64 {
		cli := admin.cli
		if c != adminWS {
			cli = carol.cli
		}
		up := must(cli.Upload(ctx, "p.png", bytes.NewReader(encodePNG(stickerPic(seed, 64, 64)))))
		return must(c.SendImage(ctx, conv, up.Id)).EventId
	}
	ev := post(adminWS, pub.Id, 1)
	r := must(bob.cli.MuseumHang(ctx, pub.Id, &amv1.MuseumHangRequest{EventId: ev, Title: "  《夕阳》 "}))
	if !r.Done || r.Text != "《夕阳》挂在第一展厅 No.1" {
		t.Fatalf("hang: %+v", r)
	}
	waitPush(t, adminWS, "museum event", func(f *amv1.ServerFrame) bool { return f.GetEvent().GetEvent().GetSysMuseum().GetKind() == "done" })
	v := must(admin.cli.Museum(ctx, pub.Id))
	if len(v.Hall) != 8 || v.Hall[0].Title != "夕阳" || v.Hall[0].Method != "投稿" || v.Hall[0].ByUserId != bob.me.Id || v.NeedsVote {
		t.Fatalf("view: %+v", v.Hall[0])
	}
	// Fill the hall; the ninth needs a position, and pushes the last one out.
	for i := int64(2); i <= 8; i++ {
		must(admin.cli.MuseumHang(ctx, pub.Id, &amv1.MuseumHangRequest{EventId: post(adminWS, pub.Id, i)}))
	}
	ninth := post(adminWS, pub.Id, 9)
	_, err := admin.cli.MuseumHang(ctx, pub.Id, &amv1.MuseumHangRequest{EventId: ninth})
	wantCode(t, err, "museum_full")
	r = must(admin.cli.MuseumHang(ctx, pub.Id, &amv1.MuseumHangRequest{EventId: ninth, Title: "插队", Slot: 1}))
	if !r.Done || r.Text != "《插队》挂在第一展厅 No.1；挤出去的《无题》进了仓库" {
		t.Fatalf("queue jump: %s", r.Text)
	}
	v = must(admin.cli.Museum(ctx, pub.Id))
	if v.Hall[0].Title != "插队" || v.Hall[1].Title != "夕阳" || len(v.Store) != 1 {
		t.Fatalf("after jump: %s %s %d", v.Hall[0].Title, v.Hall[1].Title, len(v.Store))
	}
	// Swap, take down, hang from the warehouse.
	must(admin.cli.MuseumSwap(ctx, pub.Id, 1, 2))
	v = must(admin.cli.Museum(ctx, pub.Id))
	if v.Hall[0].Title != "夕阳" {
		t.Fatal("swap")
	}
	sunset := v.Hall[0].Id
	must(admin.cli.MuseumRemove(ctx, pub.Id, sunset))
	if v = must(admin.cli.Museum(ctx, pub.Id)); v.Hall[0].Id != 0 || len(v.Store) != 2 || v.Store[0].Id != sunset {
		t.Fatalf("remove: %v %d", v.Hall[0].Id, len(v.Store))
	}
	r = must(admin.cli.MuseumHang(ctx, pub.Id, &amv1.MuseumHangRequest{ArtId: sunset}))
	if !r.Done || r.Text != "《夕阳》挂在第一展厅 No.1" {
		t.Fatalf("rehang: %s", r.Text)
	}

	// Likes: anyone can like a work of a public channel; the second hall follows them.
	if l := must(carol.cli.MuseumLike(ctx, sunset, true)); l.Likes != 1 || !l.Liked {
		t.Fatalf("like %+v", l)
	}
	must(carol.cli.MuseumLike(ctx, sunset, true)) // twice = once
	if l := must(bob.cli.MuseumLike(ctx, sunset, true)); l.Likes != 2 {
		t.Fatalf("likes %d", l.Likes)
	}

	// A private channel of five: changes need a vote.
	priv := must(carol.cli.CreateGroup(ctx, "小圈子", admin.me.Id, bob.me.Id))
	must(admin.cli.InviteMembers(ctx, priv.Id, ai.Id, helper.Id))
	carolWS := must(carol.cli.Connect(ctx))
	defer carolWS.Close()
	v = must(carol.cli.Museum(ctx, priv.Id))
	if !v.NeedsVote || len(v.Second) == 0 || v.Second[0].Id != sunset || v.Second[0].ConvName != "画廊" {
		t.Fatalf("private view: %v %+v", v.NeedsVote, v.Second)
	}
	pe := post(carolWS, priv.Id, 20)
	r = must(carol.cli.MuseumHang(ctx, priv.Id, &amv1.MuseumHangRequest{EventId: pe, Title: "秘密"}))
	if r.Done || r.VoteId == 0 {
		t.Fatalf("should vote: %+v", r)
	}
	vote := must(carol.cli.Museum(ctx, priv.Id)).Votes[0]
	if vote.Yes != 1 || vote.Mine != 1 || vote.MediaId == 0 {
		t.Fatalf("vote %+v", vote)
	}
	must(bob.cli.MuseumVote(ctx, r.VoteId, false))
	if got := must(admin.cli.MuseumVote(ctx, r.VoteId, false)); got.No != 2 || got.Mine != -1 {
		t.Fatalf("ballot %+v", got)
	}
	// Time is up: more against than for -> nothing happens, the new work is gone.
	a.Museum.SetClock(func() time.Time { return time.Now().Add(31 * time.Minute) })
	if err := a.Museum.Settle(ctx); err != nil {
		t.Fatal(err)
	}
	waitPush(t, carolWS, "vote failed", func(f *amv1.ServerFrame) bool { return f.GetEvent().GetEvent().GetSysMuseum().GetKind() == "failed" })
	if v = must(carol.cli.Museum(ctx, priv.Id)); v.Hall[0].Id != 0 || len(v.Store) != 0 || len(v.Votes) != 0 {
		t.Fatalf("failed vote changed things: %+v", v)
	}
	a.Museum.SetClock(time.Now)
	r = must(carol.cli.MuseumHang(ctx, priv.Id, &amv1.MuseumHangRequest{EventId: pe, Title: "秘密"}))
	must(bob.cli.MuseumVote(ctx, r.VoteId, true))
	// One vote per work / place at a time.
	must(carol.cli.MuseumSwap(ctx, priv.Id, 3, 4))
	_, err = bob.cli.MuseumSwap(ctx, priv.Id, 4, 5)
	wantCode(t, err, "museum_vote_open")
	a.Museum.SetClock(func() time.Time { return time.Now().Add(31 * time.Minute) })
	if err := a.Museum.Settle(ctx); err != nil {
		t.Fatal(err)
	}
	a.Museum.SetClock(time.Now)
	v = must(carol.cli.Museum(ctx, priv.Id))
	if v.Hall[0].Title != "秘密" {
		t.Fatalf("passed vote not applied: %+v", v.Hall[0])
	}
	secret := v.Hall[0]
	pubMedia := must(admin.cli.Museum(ctx, pub.Id)).Hall[0].MediaId
	// Private channel works stay inside: not in the second hall, picture not for outsiders, no likes from them.
	for _, s := range must(admin.cli.Museum(ctx, pub.Id)).Second {
		if s.Id == secret.Id {
			t.Fatal("private work in the second hall")
		}
	}
	// NSFW only where allowed; an AI's picture brings its method and flag.
	_, err = admin.cli.MuseumHang(ctx, pub.Id, &amv1.MuseumHangRequest{EventId: post(adminWS, pub.Id, 30), Slot: 2, Nsfw: true})
	wantCode(t, err, "museum_nsfw")
	must(admin.cli.InviteMembers(ctx, pub.Id, ai.Id))
	runner := amclient.New(base, nil)
	runner.Token = must(admin.cli.RunAI(ctx, ai.Id, "PC")).Token
	aiWS := must(runner.Connect(ctx))
	defer aiWS.Close()
	up := must(runner.Upload(ctx, "ai.png", bytes.NewReader(encodePNG(stickerPic(40, 64, 64)))))
	drawn := must(aiWS.SendImageMade(ctx, pub.Id, up.Id, "NovelAI V5", true))
	if drawn.GetImage().GetMadeWith() != "NovelAI V5" || !drawn.GetImage().GetNsfw() {
		t.Fatalf("ai image meta dropped: %+v", drawn.GetImage())
	}
	_, err = admin.cli.MuseumHang(ctx, pub.Id, &amv1.MuseumHangRequest{EventId: drawn.EventId, Slot: 2})
	wantCode(t, err, "museum_nsfw")
	clean := must(aiWS.SendImageMade(ctx, pub.Id, must(runner.Upload(ctx, "ai2.png", bytes.NewReader(encodePNG(stickerPic(41, 64, 64))))).Id, "NovelAI V5", false))
	must(admin.cli.MuseumHang(ctx, pub.Id, &amv1.MuseumHangRequest{EventId: clean.EventId, Slot: 2}))
	if m := must(admin.cli.Museum(ctx, pub.Id)).Hall[1].Method; m != "NovelAI V5" {
		t.Fatalf("method %q", m)
	}
	human := must(adminWS.SendImageMade(ctx, pub.Id, must(admin.cli.Upload(ctx, "h.png", bytes.NewReader(encodePNG(stickerPic(42, 64, 64))))).Id, "NovelAI V5", true))
	if human.GetImage().GetMadeWith() != "" || human.GetImage().GetNsfw() {
		t.Fatal("a person's picture kept AI metadata")
	}
	_, err = admin.cli.MuseumHang(ctx, pub.Id, &amv1.MuseumHangRequest{EventId: human.EventId, Title: "萝莉"})
	wantCode(t, err, "museum_title")
	// With NSFW allowed in the channel, the NSFW work goes up; elsewhere it shows hidden.
	// Only the admin panel sets it (channel owners can't).
	_, err = admin.cli.UpdateGroup(ctx, pub.Id, &amv1.UpdateGroupRequest{Nsfw: ptr(true)})
	wantCode(t, err, "no_permission")
	if err := a.Conv.SetNsfw(ctx, pub.Id, true); err != nil {
		t.Fatal(err)
	}
	must(admin.cli.MuseumHang(ctx, pub.Id, &amv1.MuseumHangRequest{EventId: drawn.EventId, Slot: 3}))
	if err := a.Conv.SetNsfw(ctx, pub.Id, false); err != nil {
		t.Fatal(err)
	}
	if h := must(admin.cli.Museum(ctx, pub.Id)).Hall[2]; !h.Hidden || h.MediaId != 0 {
		t.Fatalf("nsfw work shown in a channel without nsfw: %+v", h)
	}

	// Someone new on the server (not in the private channel).
	dave := registerStranger(t, admin, base)
	if _, _, err := dave.cli.Download(ctx, "/api/v1/media/"+itoa(secret.MediaId)); err == nil {
		t.Fatal("outsider sees a private channel's work")
	}
	if _, _, err := dave.cli.Download(ctx, "/api/v1/media/"+itoa(pubMedia)); err != nil {
		t.Fatalf("public work hidden: %v", err)
	}
	_, err = dave.cli.MuseumLike(ctx, secret.Id, true)
	wantCode(t, err, "not_found")
	_, err = dave.cli.Museum(ctx, priv.Id)
	wantCode(t, err, "not_member")

}
