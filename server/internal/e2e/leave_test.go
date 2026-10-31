package e2e

import (
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
)

func TestLeaveServer(t *testing.T) {
	forEachDB(t, testLeaveServer, func(c *config.Config) { c.Server.DefaultChannel = "大厅" })
}

func testLeaveServer(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "owner", "bob", "carol")
	owner, bob, carol := us[0], us[1], us[2]

	shared := must(bob.cli.CreateGroup(ctx, "bob 的频道", carol.me.Id))
	solo := must(bob.cli.CreateGroup(ctx, "只有 bob"))
	bobWS := must(bob.cli.Connect(ctx))
	carolWS := must(carol.cli.Connect(ctx))
	defer carolWS.Close()

	if err := bob.cli.Leave(ctx); err != nil {
		t.Fatal(err)
	}
	waitClosed(t, bobWS)
	// The shared channel passed to carol; bob left it. The solo one is dissolved.
	waitPush(t, carolWS, "bob left", isSysMember(amv1.SysMember_ACTION_LEAVE, bob.me.Id))
	if c := must(carol.cli.GetConversation(ctx, shared.Id)); c.OwnerId != carol.me.Id || len(c.Members) != 1 {
		t.Fatalf("shared channel after bob left: owner %d, %d members", c.OwnerId, len(c.Members))
	}
	if c, _ := a.Store.GetConv(ctx, solo.Id); c == nil || !c.Dissolved {
		t.Fatal("bob's solo channel should be dissolved")
	}
	// Gone from the directory; cannot be messaged.
	for _, u := range must(carol.cli.ListUsers(ctx, "", 0, 50)).Users {
		if u.Id == bob.me.Id {
			t.Fatal("bob still listed")
		}
	}
	_, err := carol.cli.OpenDM(ctx, bob.me.Id)
	wantCode(t, err, "user_not_found")

	// Coming back needs a new invite code.
	login := func(invite string) error {
		_, err := amclient.New(base, nil).Login(ctx, &amv1.LoginRequest{Username: "bob", Password: "password-bob", InviteCode: invite})
		return err
	}
	wantCode(t, login(""), "left_server")
	wantCode(t, login("NOTACODE00"), "invalid_invite")
	invite := must(owner.cli.CreateInvite(ctx)).Code
	back := amclient.New(base, nil)
	resp := must(back.Login(ctx, &amv1.LoginRequest{Username: "bob", Password: "password-bob", InviteCode: invite}))
	if resp.Me.Id != bob.me.Id {
		t.Fatal("rejoin made a new account")
	}
	ws := must(back.Connect(ctx))
	defer ws.Close()
	public := 0
	for _, c := range ws.Auth.Conversations {
		if c.Public {
			public++
		}
		if c.Id == shared.Id {
			t.Fatal("bob is back in the channel he left")
		}
	}
	if public != 1 {
		t.Fatalf("bob should be back in the public channel, has %d", public)
	}
	// Back to normal: an invite code in the login request is ignored again.
	if err := login(invite); err != nil {
		t.Fatal(err)
	}
}
