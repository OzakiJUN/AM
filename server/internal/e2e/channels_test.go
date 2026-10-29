package e2e

import (
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
)

func TestChannels(t *testing.T) {
	forEachDB(t, testChannels, func(c *config.Config) { c.Server.DefaultChannel = "大厅" })
}

func TestBlocks(t *testing.T) { forEachDB(t, testBlocks) }

func testChannels(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "admin", "bob")
	admin, bob := us[0], us[1]

	// The first admin got the default channel; bob joined it on registration.
	hall := onlyChannel(t, must(admin.cli.ListChannels(ctx)))
	if hall.Name != "大厅" || hall.MemberCount != 2 || !hall.Joined {
		t.Fatalf("default channel = %v", hall)
	}
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	if len(bobWS.Auth.Conversations) != 1 || !bobWS.Auth.Conversations[0].Public {
		t.Fatalf("bob's conversations = %v", bobWS.Auth.Conversations)
	}
	if bobWS.Auth.IsSiteAdmin {
		t.Fatal("bob reported as site admin")
	}
	adminWS := must(admin.cli.Connect(ctx))
	defer adminWS.Close()
	if !adminWS.Auth.IsSiteAdmin {
		t.Fatal("admin not reported as site admin")
	}

	// Only site admins create public channels; everyone is added.
	_, err := bob.cli.CreatePublicChannel(ctx, "bob's")
	wantCode(t, err, "no_permission")
	news := must(admin.cli.CreatePublicChannel(ctx, "公告"))
	if !news.Public || len(news.Members) != 2 {
		t.Fatalf("public channel = %v", news)
	}
	waitPush(t, bobWS, "public channel push", func(f *amv1.ServerFrame) bool {
		return f.GetConv().GetConversation().GetId() == news.Id
	})

	// Leave, see it in "browse", join again.
	if err := bob.cli.RemoveMember(ctx, news.Id, bob.me.Id); err != nil {
		t.Fatal(err)
	}
	for _, c := range must(bob.cli.ListChannels(ctx)).Channels {
		if c.Id == news.Id && c.Joined {
			t.Fatal("left channel still marked joined")
		}
	}
	back := must(bob.cli.JoinChannel(ctx, news.Id))
	if back.Id != news.Id || back.Self.Role != amv1.MemberRole_MEMBER_ROLE_MEMBER {
		t.Fatalf("join = %v", back)
	}
	must(bob.cli.JoinChannel(ctx, news.Id)) // joining twice is fine

	// Private channels cannot be joined without an invite.
	private := must(admin.cli.CreateGroup(ctx, "secret"))
	if private.Public {
		t.Fatal("CreateGroup made a public channel")
	}
	_, err = bob.cli.JoinChannel(ctx, private.Id)
	wantCode(t, err, "not_public")
}

func onlyChannel(t *testing.T, r *amv1.ListChannelsResponse) *amv1.ChannelInfo {
	t.Helper()
	if len(r.Channels) != 1 {
		t.Fatalf("want 1 public channel, got %v", r.Channels)
	}
	return r.Channels[0]
}

func testBlocks(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "alice", "bob")
	alice, bob := us[0], us[1]
	aliceWS := must(alice.cli.Connect(ctx))
	defer aliceWS.Close()

	dm := must(alice.cli.OpenDM(ctx, bob.me.Id))
	hi := must(aliceWS.SendText(ctx, dm.Id, "hi"))

	if err := bob.cli.Block(ctx, alice.me.Id); err != nil {
		t.Fatal(err)
	}
	wantCode(t, bob.cli.Block(ctx, bob.me.Id), "self")
	if b := must(bob.cli.ListBlocks(ctx)); len(b.Users) != 1 || b.Users[0].Id != alice.me.Id {
		t.Fatalf("blocks = %v", b.Users)
	}
	// Both directions stop; striking an old message still works.
	_, err := aliceWS.SendText(ctx, dm.Id, "hello?")
	wantCode(t, err, "blocked")
	_, err = bob.cli.OpenDM(ctx, alice.me.Id)
	wantCode(t, err, "blocked")
	must(aliceWS.Strike(ctx, dm.Id, hi.EventId))

	if err := bob.cli.Unblock(ctx, alice.me.Id); err != nil {
		t.Fatal(err)
	}
	must(aliceWS.SendText(ctx, dm.Id, "hello again"))
}
