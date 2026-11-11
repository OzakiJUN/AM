package e2e

import (
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/app"
)

// "Is writing…": passed to the other members, not stored, at most every 2 s,
// only for members, never for blocked DMs.
func TestTyping(t *testing.T) { forEachDB(t, testTyping) }

func testTyping(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "owner", "bob", "carol")
	owner, bob, carol := us[0], us[1], us[2]
	ch := must(owner.cli.CreateGroup(ctx, "频道", bob.me.Id))
	ownerWS := must(owner.cli.Connect(ctx))
	defer ownerWS.Close()
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	carolWS := must(carol.cli.Connect(ctx))
	defer carolWS.Close()

	if err := ownerWS.Typing(ctx, ch.Id); err != nil {
		t.Fatal(err)
	}
	p := waitPush(t, bobWS, "typing", func(f *amv1.ServerFrame) bool { return f.GetTyping() != nil }).GetTyping()
	if p.ConvId != ch.Id || p.UserId != owner.me.Id {
		t.Fatalf("typing push: %+v", p)
	}
	// Not a member: refused.
	wantCode(t, carolWS.Typing(ctx, ch.Id), "not_member")
	// Again at once: dropped quietly (no error), then passed on after 2 s.
	if err := ownerWS.Typing(ctx, ch.Id); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2100 * time.Millisecond)
	if err := ownerWS.Typing(ctx, ch.Id); err != nil {
		t.Fatal(err)
	}
	waitPush(t, bobWS, "typing again", func(f *amv1.ServerFrame) bool { return f.GetTyping().GetUserId() == owner.me.Id })

	// Blocked DM and invisible: nothing goes through. The next typing push
	// carol / the owner get is the one from the second channel.
	g2 := must(owner.cli.CreateGroup(ctx, "二", bob.me.Id, carol.me.Id))
	dm := must(bob.cli.OpenDM(ctx, carol.me.Id))
	if err := carol.cli.Block(ctx, bob.me.Id); err != nil {
		t.Fatal(err)
	}
	if err := bobWS.Typing(ctx, dm.Id); err != nil {
		t.Fatal(err)
	}
	must(bob.cli.SetPresence(ctx, &amv1.SetPresenceRequest{Invisible: true}))
	if err := bobWS.Typing(ctx, ch.Id); err != nil {
		t.Fatal(err)
	}
	must(bob.cli.SetPresence(ctx, &amv1.SetPresenceRequest{Invisible: false}))
	time.Sleep(2100 * time.Millisecond)
	if err := bobWS.Typing(ctx, g2.Id); err != nil {
		t.Fatal(err)
	}
	if p := waitPush(t, carolWS, "typing in g2", func(f *amv1.ServerFrame) bool { return f.GetTyping() != nil }).GetTyping(); p.ConvId != g2.Id {
		t.Fatalf("typing went through a block: %+v", p)
	}
	if p := waitPush(t, ownerWS, "typing in g2", func(f *amv1.ServerFrame) bool { return f.GetTyping().GetUserId() == bob.me.Id }).GetTyping(); p.ConvId != g2.Id {
		t.Fatalf("an invisible person's typing went through: %+v", p)
	}
}
