package e2e

import (
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
)

// Pinning and do-not-disturb are my own settings per channel / DM, shared
// by my devices.
func TestPinDnd(t *testing.T) { forEachDB(t, testPinDnd) }

func testPinDnd(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "owner", "bob")
	owner, bob := us[0], us[1]
	dm := must(owner.cli.OpenDM(ctx, bob.me.Id))
	ch := must(owner.cli.CreateGroup(ctx, "频道", bob.me.Id))

	// A second device of the owner hears about the change.
	other := amclient.New(base, nil)
	must(other.Login(ctx, &amv1.LoginRequest{Username: "owner", Password: "password-owner", DeviceName: "phone"}))
	ws := must(other.Connect(ctx))
	defer ws.Close()

	c := must(owner.cli.SetPinned(ctx, dm.Id, true))
	if c.Self.PinnedOrder <= 0 {
		t.Fatal("not pinned")
	}
	waitPush(t, ws, "pin reaches my other device", func(f *amv1.ServerFrame) bool {
		p := f.GetConv()
		return p != nil && p.Conversation.Id == dm.Id && p.Conversation.Self.PinnedOrder > 0
	})
	// Pinned later = higher.
	time.Sleep(2 * time.Millisecond)
	if c2 := must(owner.cli.SetPinned(ctx, ch.Id, true)); c2.Self.PinnedOrder <= c.Self.PinnedOrder {
		t.Fatal("later pin should come first")
	}
	if c := must(owner.cli.SetPinned(ctx, dm.Id, false)); c.Self.PinnedOrder != 0 {
		t.Fatal("not unpinned")
	}
	// Only my own setting: bob's view is unchanged.
	if c := must(bob.cli.GetConversation(ctx, ch.Id)); c.Self.PinnedOrder != 0 {
		t.Fatal("pin leaked to bob")
	}

	until := time.Now().Add(time.Hour).UnixMilli()
	if c := must(owner.cli.SetDnd(ctx, ch.Id, until)); c.Self.DndUntil != until {
		t.Fatalf("dnd %d", c.Self.DndUntil)
	}
	if c := must(owner.cli.SetDnd(ctx, dm.Id, -1)); c.Self.DndUntil != -1 {
		t.Fatal("dnd forever not kept")
	}
	if c := must(owner.cli.SetDnd(ctx, dm.Id, 0)); c.Self.DndUntil != 0 {
		t.Fatal("dnd not off")
	}
	_, err := owner.cli.SetDnd(ctx, dm.Id, -5)
	wantCode(t, err, "bad_request")

	// Not a member: refused.
	solo := must(bob.cli.CreateGroup(ctx, "bob 自己的"))
	_, err = owner.cli.SetPinned(ctx, solo.Id, true)
	wantCode(t, err, "not_member")
}
