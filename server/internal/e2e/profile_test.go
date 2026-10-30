package e2e

import (
	"bytes"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/app"
)

func TestProfileWidgets(t *testing.T) { forEachDB(t, testProfileWidgets) }

func widget(id, kind string, w, h, page, x, y int32, cfg string) *amv1.Widget {
	return &amv1.Widget{Id: id, Kind: kind, Source: amv1.WidgetSource_WIDGET_SOURCE_BUILTIN, W: w, H: h,
		Landscape: &amv1.Cell{Page: page, X: x, Y: y}, Config: cfg}
}

func testProfileWidgets(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "owner", "alice", "bob")
	owner, alice, bob := us[0], us[1], us[2]
	aliceWS := must(alice.cli.Connect(ctx))
	defer aliceWS.Close()
	dm := must(alice.cli.OpenDM(ctx, bob.me.Id))
	must(aliceWS.SendText(ctx, dm.Id, "hi"))
	must(aliceWS.SendText(ctx, dm.Id, "hi again"))

	// Alice's profile: text, her own image, a guestbook; empty cells are fine.
	img := must(alice.cli.Upload(ctx, "a.png", bytes.NewReader(encodePNG(testImage(20, 20)))))
	layout := &amv1.ProfileLayout{Widgets: []*amv1.Widget{
		widget("t1", "text", 2, 1, 0, 0, 0, `{"title":"你好","text":"我是 alice"}`),
		widget("i1", "image", 2, 2, 0, 4, 2, `{"media_id":"`+itoa(img.Id)+`"}`),
		widget("g1", "guestbook", 2, 2, 1, 0, 0, `{"title":"留言"}`),
		widget("s1", "stats", 4, 1, 0, 0, 3, `{"items":["messages","streak","joined"]}`),
	}, Background: &amv1.ProfileBackground{Kind: "image", MediaId: img.Id, Blur: 10, Dim: 30}}
	v := must(alice.cli.SaveProfile(ctx, alice.me.Id, layout, 0))
	if v.Layout.Version != 1 || len(v.EditableWidgetIds) != 4 || !v.CanEditLayout {
		t.Fatalf("saved: %+v", v)
	}
	// Bob sees it read-only, with alice's stats; he can load her image.
	bv := must(bob.cli.GetProfile(ctx, alice.me.Id))
	if bv.CanEditLayout || len(bv.EditableWidgetIds) != 0 || len(bv.Layout.Widgets) != 4 || bv.User.GetId() != alice.me.Id {
		t.Fatalf("bob's view: %+v", bv)
	}
	if bv.Stats.Messages != 2 || bv.Stats.StreakDays != 1 || bv.Stats.JoinedAt == 0 {
		t.Fatalf("stats: %+v", bv.Stats)
	}
	if _, _, err := bob.cli.Download(ctx, "/api/v1/media/"+itoa(img.Id)); err != nil {
		t.Fatalf("bob cannot see alice's profile image: %v", err)
	}
	_, err := bob.cli.SaveProfile(ctx, alice.me.Id, layout, 1)
	wantCode(t, err, "no_permission")
	// Saving from an old version is a conflict.
	_, err = alice.cli.SaveProfile(ctx, alice.me.Id, layout, 0)
	wantCode(t, err, "layout_conflict")

	// Validation.
	bad := func(ws ...*amv1.Widget) {
		t.Helper()
		_, err := alice.cli.SaveProfile(ctx, alice.me.Id, &amv1.ProfileLayout{Widgets: ws}, 1)
		wantCode(t, err, "invalid_widget")
	}
	bad(widget("a", "text", 2, 1, 0, 0, 0, ""), widget("b", "text", 2, 1, 0, 1, 0, "")) // overlap
	bad(widget("a", "text", 2, 1, 0, 7, 0, ""))                                         // off the board (8 wide)
	bad(widget("a", "text", 2, 1, 3, 0, 0, ""))                                         // 4th page
	bad(widget("a", "image", 5, 1, 0, 0, 0, ""))                                        // wider than 4
	bad(widget("a", "gallery", 1, 1, 0, 0, 0, ""))                                      // below its minimum size
	bad(widget("a", "nope", 1, 1, 0, 0, 0, ""))                                         // unknown kind
	bad(widget("a", "online", 2, 2, 0, 0, 0, ""))                                       // server-only kind
	bad(widget("a", "text", 2, 1, 0, 0, 0, `{"title":"`+strings.Repeat("x", 41)+`"}`))  // title too long
	bad(widget("a", "links", 2, 1, 0, 0, 0, `{"items":[{"title":"x","url":"javascript:alert(1)"}]}`))
	bad(widget("a", "music", 2, 2, 0, 0, 0, `{"playlist_id":"abc"}`))
	bad(widget("a", "text", 2, 1, 0, 0, 0, ""), widget("a", "text", 2, 1, 1, 0, 0, "")) // same id
	portrait := &amv1.ProfileLayout{PortraitCustom: true, Widgets: []*amv1.Widget{widget("a", "text", 2, 1, 0, 0, 0, "")}}
	_, err = alice.cli.SaveProfile(ctx, alice.me.Id, portrait, 1) // custom portrait needs portrait cells
	wantCode(t, err, "invalid_widget")
	// Someone else's upload can't be put on your profile.
	bobImg := must(bob.cli.Upload(ctx, "b.png", bytes.NewReader(encodePNG(testImage(9, 9)))))
	_, err = alice.cli.SaveProfile(ctx, alice.me.Id, &amv1.ProfileLayout{Widgets: []*amv1.Widget{
		widget("i", "image", 1, 1, 0, 0, 0, `{"media_id":"`+itoa(bobImg.Id)+`"}`)}}, 1)
	wantCode(t, err, "media_not_found")

	// Guestbook.
	e1 := must(bob.cli.PostGuestbook(ctx, alice.me.Id, "g1", "  你的主页好看  "))
	if e1.Text != "你的主页好看" || e1.Author.GetId() != bob.me.Id {
		t.Fatalf("entry: %+v", e1)
	}
	_, err = bob.cli.PostGuestbook(ctx, alice.me.Id, "t1", "not a guestbook")
	wantCode(t, err, "not_found")
	_, err = bob.cli.PostGuestbook(ctx, alice.me.Id, "g1", strings.Repeat("长", 201))
	wantCode(t, err, "too_long")
	e2 := must(bob.cli.PostGuestbook(ctx, alice.me.Id, "g1", "第二条"))
	must(bob.cli.PostGuestbook(ctx, alice.me.Id, "g1", "第三条"))
	_, err = bob.cli.PostGuestbook(ctx, alice.me.Id, "g1", "第四条，太快了")
	wantCode(t, err, "rate_limited")
	wantCode(t, bob.cli.HideGuestbook(ctx, e1.Id, true), "no_permission")
	if err := alice.cli.HideGuestbook(ctx, e1.Id, true); err != nil {
		t.Fatal(err)
	}
	if l := must(bob.cli.ListGuestbook(ctx, alice.me.Id, "g1", 0)); len(l.Entries) != 2 || l.CanHide {
		t.Fatalf("bob's guestbook: %+v", l)
	}
	if l := must(alice.cli.ListGuestbook(ctx, alice.me.Id, "g1", 0)); len(l.Entries) != 3 || !l.CanHide || !l.Entries[2].Hidden {
		t.Fatalf("alice's guestbook: %+v", l)
	}
	wantCode(t, alice.cli.DeleteGuestbook(ctx, e2.Id, "广告"), "no_permission") // only site admins
	wantCode(t, owner.cli.DeleteGuestbook(ctx, e2.Id, ""), "reason_required")
	if err := owner.cli.DeleteGuestbook(ctx, e2.Id, "广告"); err != nil {
		t.Fatal(err)
	}
	if l := must(alice.cli.ListGuestbook(ctx, alice.me.Id, "g1", 0)); len(l.Entries) != 2 {
		t.Fatalf("deleted entry still listed: %+v", l)
	}
	if err := alice.cli.Block(ctx, bob.me.Id); err != nil {
		t.Fatal(err)
	}
	_, err = bob.cli.PostGuestbook(ctx, alice.me.Id, "g1", "被屏蔽了")
	wantCode(t, err, "blocked")

	// Server profile: rights follow the panel settings.
	sv := must(owner.cli.SaveProfile(ctx, 0, &amv1.ProfileLayout{Widgets: []*amv1.Widget{
		widget("news", "text", 4, 2, 0, 0, 0, `{"title":"公告"}`),
		widget("free", "text", 2, 1, 0, 4, 0, `{"title":"随便写"}`),
		widget("who", "online", 2, 2, 0, 4, 2, ""),
	}}, 0))
	if !sv.CanSetWidgetEditors || sv.Stats.Members != 3 {
		t.Fatalf("admin view: %+v", sv)
	}
	sv.Layout.Widgets[0].ContentEditors = amv1.WidgetEditors_WIDGET_EDITORS_ADMINS
	sv = must(owner.cli.SaveProfile(ctx, 0, sv.Layout, sv.Layout.Version))
	edit := func(l *amv1.ProfileLayout, f func(l *amv1.ProfileLayout)) *amv1.ProfileLayout {
		c := proto.Clone(l).(*amv1.ProfileLayout)
		f(c)
		return c
	}
	cur := must(bob.cli.GetProfile(ctx, 0))
	if cur.CanEditLayout || len(cur.EditableWidgetIds) != 0 {
		t.Fatalf("bob on server profile (defaults): %+v", cur)
	}
	_, err = bob.cli.SaveProfile(ctx, 0, edit(cur.Layout, func(l *amv1.ProfileLayout) { l.Widgets[1].Config = `{"title":"bob 来了"}` }), cur.Layout.Version)
	wantCode(t, err, "no_permission")
	set := func(layout string, content bool) {
		if err := a.Account.SetProfileSettings(ctx, account.PanelActor, &account.ProfileSettings{LayoutEditors: layout, WidgetContentEditable: content}); err != nil {
			t.Fatal(err)
		}
	}
	set("admins", true)
	cur = must(bob.cli.GetProfile(ctx, 0))
	if len(cur.EditableWidgetIds) != 2 { // "news" is admins-only
		t.Fatalf("editable: %v", cur.EditableWidgetIds)
	}
	cur = must(bob.cli.SaveProfile(ctx, 0, edit(cur.Layout, func(l *amv1.ProfileLayout) { l.Widgets[1].Config = `{"title":"bob 来了"}` }), cur.Layout.Version))
	_, err = bob.cli.SaveProfile(ctx, 0, edit(cur.Layout, func(l *amv1.ProfileLayout) { l.Widgets[0].Config = `{"title":"改公告"}` }), cur.Layout.Version)
	wantCode(t, err, "no_permission")
	_, err = bob.cli.SaveProfile(ctx, 0, edit(cur.Layout, func(l *amv1.ProfileLayout) { l.Widgets[1].Landscape.Page = 1 }), cur.Layout.Version)
	wantCode(t, err, "no_permission") // moving needs layout rights
	set("everyone", true)
	cur = must(bob.cli.SaveProfile(ctx, 0, edit(cur.Layout, func(l *amv1.ProfileLayout) { l.Widgets[1].Landscape.Page = 1 }), cur.Layout.Version))
	_, err = bob.cli.SaveProfile(ctx, 0, edit(cur.Layout, func(l *amv1.ProfileLayout) {
		l.Widgets[0].ContentEditors = amv1.WidgetEditors_WIDGET_EDITORS_EVERYONE
	}), cur.Layout.Version)
	wantCode(t, err, "no_permission") // per-widget rights are site-admin only

	// Admin panel: clear a profile.
	if err := a.Profile.Clear(ctx, account.PanelActor, alice.me.Id); err != nil {
		t.Fatal(err)
	}
	if v := must(bob.cli.GetProfile(ctx, alice.me.Id)); len(v.Layout.Widgets) != 0 || v.Layout.Version != 2 {
		t.Fatalf("after clear: %+v", v.Layout)
	}
}
