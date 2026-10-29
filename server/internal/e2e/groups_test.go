package e2e

import (
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
)

func TestGroups(t *testing.T) { forEachDB(t, testGroups) }

func isSysMember(action amv1.SysMember_Action, target int64) func(*amv1.ServerFrame) bool {
	return func(f *amv1.ServerFrame) bool {
		m := f.GetEvent().GetEvent().GetSysMember()
		return m != nil && m.Action == action && m.TargetUserId == target
	}
}

func testGroups(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "owner", "bob", "carol", "dave")
	owner, bob, carol, dave := us[0], us[1], us[2], us[3]

	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	carolWS := must(carol.cli.Connect(ctx))
	defer carolWS.Close()

	// --- create ---
	_, err := owner.cli.CreateGroup(ctx, "   ")
	wantCode(t, err, "invalid_group_name")
	g := must(owner.cli.CreateGroup(ctx, "测试群", bob.me.Id))
	if g.Kind != amv1.ConvKind_CONV_KIND_GROUP || len(g.Members) != 2 || g.Self.Role != amv1.MemberRole_MEMBER_ROLE_OWNER {
		t.Fatalf("bad group: %v", g)
	}
	waitPush(t, bobWS, "group conv push", func(f *amv1.ServerFrame) bool {
		return f.GetConv().GetConversation().GetId() == g.Id
	})
	// Group history: created + bob joined.
	page := must(bobWS.Sync(ctx, map[int64]int64{g.Id: 0}, 0))
	if len(page.Events) != 2 || !page.Events[0].GetSysConv().GetCreated() || page.Events[1].GetSysMember().GetAction() != amv1.SysMember_ACTION_JOIN {
		t.Fatalf("unexpected group history: %v", page.Events)
	}

	// --- invite ---
	added := must(bob.cli.InviteMembers(ctx, g.Id, carol.me.Id))
	if len(added.Added) != 1 {
		t.Fatalf("invite result: %v", added)
	}
	waitPush(t, carolWS, "carol added", func(f *amv1.ServerFrame) bool {
		return f.GetConv().GetConversation().GetId() == g.Id
	})
	waitPush(t, bobWS, "join event", isSysMember(amv1.SysMember_ACTION_JOIN, carol.me.Id))

	// --- join approval ---
	_, err = bob.cli.UpdateGroup(ctx, g.Id, &amv1.UpdateGroupRequest{JoinApproval: ptr(true)})
	wantCode(t, err, "no_permission")
	must(owner.cli.UpdateGroup(ctx, g.Id, &amv1.UpdateGroupRequest{JoinApproval: ptr(true), Notice: ptr("群公告")}))
	req := must(bob.cli.InviteMembers(ctx, g.Id, dave.me.Id))
	if len(req.Requested) != 1 || len(req.Added) != 0 {
		t.Fatalf("invite with approval: %v", req)
	}
	list := must(owner.cli.ListJoinRequests(ctx, g.Id))
	if len(list.Requests) != 1 || list.Requests[0].User.Id != dave.me.Id || list.Requests[0].Inviter.Id != bob.me.Id {
		t.Fatalf("join requests: %v", list)
	}
	_, err = bob.cli.ListJoinRequests(ctx, g.Id)
	wantCode(t, err, "no_permission")
	if err := owner.cli.DecideJoinRequest(ctx, g.Id, dave.me.Id, true); err != nil {
		t.Fatal(err)
	}
	wantCode(t, owner.cli.DecideJoinRequest(ctx, g.Id, dave.me.Id, true), "no_join_request")

	// --- admins and permissions ---
	wantCode(t, bob.cli.RemoveMember(ctx, g.Id, carol.me.Id), "no_permission")
	if err := owner.cli.SetAdmin(ctx, g.Id, bob.me.Id, true); err != nil {
		t.Fatal(err)
	}
	wantCode(t, bob.cli.SetAdmin(ctx, g.Id, carol.me.Id, true), "no_permission") // only owner
	// Admin mutes a member; muted member cannot speak.
	if err := bob.cli.Mute(ctx, g.Id, carol.me.Id, 600); err != nil {
		t.Fatal(err)
	}
	_, err = carolWS.SendText(ctx, g.Id, "hello?")
	wantCode(t, err, "muted")
	if err := bob.cli.Mute(ctx, g.Id, carol.me.Id, 0); err != nil {
		t.Fatal(err)
	}
	must(carolWS.SendText(ctx, g.Id, "I can talk again"))
	// Admin cannot act on the owner.
	wantCode(t, bob.cli.Mute(ctx, g.Id, owner.me.Id, 60), "no_permission")
	wantCode(t, bob.cli.RemoveMember(ctx, g.Id, owner.me.Id), "no_permission")

	// --- kick ---
	if err := bob.cli.RemoveMember(ctx, g.Id, carol.me.Id); err != nil {
		t.Fatal(err)
	}
	waitPush(t, carolWS, "removed push", func(f *amv1.ServerFrame) bool {
		r := f.GetConvRemoved()
		return r != nil && r.ConvId == g.Id && r.Reason == amv1.ConvRemovedPush_REASON_KICKED
	})
	_, err = carolWS.SendText(ctx, g.Id, "still here?")
	wantCode(t, err, "not_member")

	// --- leave / transfer / dissolve ---
	wantCode(t, owner.cli.RemoveMember(ctx, g.Id, owner.me.Id), "owner_cannot_leave")
	if err := owner.cli.TransferGroup(ctx, g.Id, bob.me.Id); err != nil {
		t.Fatal(err)
	}
	// Old owner is now a plain member and can leave.
	if err := owner.cli.RemoveMember(ctx, g.Id, owner.me.Id); err != nil {
		t.Fatal(err)
	}
	conv := must(bob.cli.UpdateGroup(ctx, g.Id, &amv1.UpdateGroupRequest{Name: ptr("新名字")}))
	if conv.Name != "新名字" || conv.Notice != "群公告" || conv.OwnerId != bob.me.Id {
		t.Fatalf("group after transfer/rename: %v", conv)
	}
	if err := bob.cli.DissolveGroup(ctx, g.Id); err != nil {
		t.Fatal(err)
	}
	waitPush(t, bobWS, "dissolved", func(f *amv1.ServerFrame) bool {
		r := f.GetConvRemoved()
		return r != nil && r.ConvId == g.Id && r.Reason == amv1.ConvRemovedPush_REASON_DISSOLVED
	})
	re := must(bob.cli.Connect(ctx))
	defer re.Close()
	for _, c := range re.Auth.Conversations {
		if c.Id == g.Id {
			t.Fatal("dissolved group still listed")
		}
	}

	// Groups are not DMs.
	dm := must(owner.cli.OpenDM(ctx, bob.me.Id))
	_, err = owner.cli.InviteMembers(ctx, dm.Id, carol.me.Id)
	wantCode(t, err, "not_group")

	// Only friends can be added.
	g2 := must(owner.cli.CreateGroup(ctx, "g2"))
	stranger := registerStranger(t, owner, base)
	_, err = owner.cli.InviteMembers(ctx, g2.Id, stranger.me.Id)
	wantCode(t, err, "not_friends")
}

func ptr[T any](v T) *T { return &v }

// registerStranger creates a user who is nobody's friend.
func registerStranger(t *testing.T, inviter *user, base string) *user {
	ctx := ctxT(t)
	code := unusedInvite(t, inviter)
	c := amclient.New(base, nil)
	resp := must(c.Register(ctx, &amv1.RegisterRequest{InviteCode: code, Username: "stranger", Password: "password-s"}))
	return &user{cli: c, me: resp.Me}
}

// unusedInvite returns one of the user's automatic invite codes.
func unusedInvite(t *testing.T, u *user) string {
	t.Helper()
	for _, inv := range must(u.cli.ListInvites(ctxT(t))).Invites {
		if inv.UsedBy == 0 {
			return inv.Code
		}
	}
	t.Fatal("no unused invite left")
	return ""
}
