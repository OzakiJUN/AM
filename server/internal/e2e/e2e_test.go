// End-to-end tests: run the real server and drive it with the Go client,
// the same way the apps will.
//
// Every test runs against SQLite (always) and PostgreSQL (when
// AM_TEST_DATABASE_URL points at a throw-away database; its schema is wiped):
//
//	AM_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/am_test?sslmode=disable go test ./...
package e2e

import (
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
)

func TestChat(t *testing.T) { forEachDB(t, testChat) }

func testChat(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)

	// --- registration and invites ---
	bootstrap := must(a.Account.EnsureBootstrapInvite(ctx))
	if bootstrap == "" {
		t.Fatal("no bootstrap invite on empty server")
	}
	alice := amclient.New(base, nil)
	aliceMe := must(alice.Register(ctx, &amv1.RegisterRequest{
		InviteCode: bootstrap, Username: "alice", Password: "password-a", DisplayName: "Alice", DeviceName: "test",
	})).Me
	if aliceMe.AccountType != amv1.AccountType_ACCOUNT_TYPE_HUMAN {
		t.Fatalf("alice account type = %v", aliceMe.AccountType)
	}
	if again := must(a.Account.EnsureBootstrapInvite(ctx)); again != "" {
		t.Fatal("bootstrap invite still offered after first user")
	}
	if inv := must(alice.ListInvites(ctx)); inv.Remaining != -1 {
		t.Fatalf("admin should have unlimited invites, remaining=%d", inv.Remaining)
	}

	inviteForBob := must(alice.CreateInvite(ctx))
	bob := amclient.New(base, nil)
	bobMe := must(bob.Register(ctx, &amv1.RegisterRequest{
		InviteCode: inviteForBob.Code, Username: "bob", Password: "password-b", DeviceName: "test",
	})).Me
	if bobMe.DisplayName != "bob" {
		t.Fatalf("display name should default to username, got %q", bobMe.DisplayName)
	}

	// Used invite cannot be reused.
	_, err := amclient.New(base, nil).Register(ctx, &amv1.RegisterRequest{
		InviteCode: inviteForBob.Code, Username: "carol", Password: "password-c",
	})
	wantCode(t, err, "invalid_invite")

	// Normal users get exactly 3 codes.
	var bobCodes []string
	for i := 0; i < 3; i++ {
		bobCodes = append(bobCodes, must(bob.CreateInvite(ctx)).Code)
	}
	_, err = bob.CreateInvite(ctx)
	wantCode(t, err, "invite_limit")

	// Username uniqueness ignores case; failed attempt must not burn the code.
	_, err = amclient.New(base, nil).Register(ctx, &amv1.RegisterRequest{
		InviteCode: bobCodes[0], Username: "ALICE", Password: "password-x",
	})
	wantCode(t, err, "username_taken")
	_, err = amclient.New(base, nil).Register(ctx, &amv1.RegisterRequest{
		InviteCode: bobCodes[0], Username: "x", Password: "password-x",
	})
	wantCode(t, err, "invalid_username")
	carol := amclient.New(base, nil)
	must(carol.Register(ctx, &amv1.RegisterRequest{InviteCode: bobCodes[0], Username: "carol", Password: "password-c"}))

	// --- login ---
	_, err = amclient.New(base, nil).Login(ctx, &amv1.LoginRequest{Username: "alice", Password: "nope-nope"})
	wantCode(t, err, "wrong_credentials")
	_, err = amclient.New(base, nil).Login(ctx, &amv1.LoginRequest{Username: "nobody", Password: "nope-nope"})
	wantCode(t, err, "wrong_credentials")
	must(amclient.New(base, nil).Login(ctx, &amv1.LoginRequest{Username: "Alice", Password: "password-a"}))

	// --- websocket ---
	aliceWS := must(alice.Connect(ctx))
	defer aliceWS.Close()
	bobWS := must(bob.Connect(ctx))
	if bobWS.Auth.Me.Id != bobMe.Id || len(bobWS.Auth.Conversations) != 0 {
		t.Fatalf("unexpected auth response: %v", bobWS.Auth)
	}

	// Bad token is rejected.
	bad := amclient.New(base, nil)
	bad.Token = "am_invalid"
	_, err = bad.Connect(ctx)
	wantCode(t, err, "unauthorized")

	// --- friends ---
	_, err = alice.OpenDM(ctx, bobMe.Id)
	wantCode(t, err, "not_friends")
	if err := alice.RequestFriend(ctx, "bob"); err != nil {
		t.Fatal(err)
	}
	waitPush(t, bobWS, "friend request push", func(f *amv1.ServerFrame) bool {
		p := f.GetFriend()
		return p != nil && p.Kind == amv1.FriendPush_KIND_REQUEST_RECEIVED && p.User.Id == aliceMe.Id
	})
	fl := must(bob.ListFriends(ctx))
	if len(fl.Incoming) != 1 || fl.Incoming[0].Id != aliceMe.Id {
		t.Fatalf("bob incoming = %v", fl.Incoming)
	}
	if err := bob.AcceptFriend(ctx, aliceMe.Id); err != nil {
		t.Fatal(err)
	}
	waitPush(t, aliceWS, "friend accepted push", func(f *amv1.ServerFrame) bool {
		p := f.GetFriend()
		return p != nil && p.Kind == amv1.FriendPush_KIND_ACCEPTED
	})
	wantCode(t, alice.RequestFriend(ctx, "bob"), "already_friends")

	// --- DM ---
	dm := must(alice.OpenDM(ctx, bobMe.Id))
	if dm.Kind != amv1.ConvKind_CONV_KIND_DM || len(dm.Members) != 2 {
		t.Fatalf("bad dm: %v", dm)
	}
	waitPush(t, bobWS, "conv push", func(f *amv1.ServerFrame) bool {
		return f.GetConv().GetConversation().GetId() == dm.Id
	})
	if again := must(bob.OpenDM(ctx, aliceMe.Id)); again.Id != dm.Id {
		t.Fatal("second OpenDM created a new conversation")
	}

	// --- send and receive ---
	hello := must(aliceWS.SendTextWithID(ctx, dm.Id, "hello 你好", "cid-1"))
	if hello.Seq != 1 || hello.GetText().GetText() != "hello 你好" || hello.ClientMsgId != "cid-1" {
		t.Fatalf("bad sent event: %v", hello)
	}
	got := waitPush(t, bobWS, "message push", func(f *amv1.ServerFrame) bool {
		return f.GetEvent().GetEvent().GetEventId() == hello.EventId
	}).GetEvent().GetEvent()
	if got.ClientMsgId != "" {
		t.Fatal("client_msg_id leaked to another user")
	}
	if got.SenderId != aliceMe.Id {
		t.Fatal("wrong sender")
	}

	// Resend with the same client_msg_id returns the same event.
	dup := must(aliceWS.SendTextWithID(ctx, dm.Id, "hello 你好", "cid-1"))
	if dup.EventId != hello.EventId || dup.Seq != 1 {
		t.Fatalf("resend created a new event: %v", dup)
	}

	_, err = aliceWS.SendText(ctx, dm.Id, "   ")
	wantCode(t, err, "empty_message")

	// Carol is not in the DM.
	carolWS := must(carol.Connect(ctx))
	defer carolWS.Close()
	_, err = carolWS.SendText(ctx, dm.Id, "hi")
	wantCode(t, err, "not_member")

	// --- strike ---
	_, err = bobWS.Strike(ctx, dm.Id, hello.EventId)
	wantCode(t, err, "cannot_strike")
	strike := must(aliceWS.Strike(ctx, dm.Id, hello.EventId))
	if strike.Seq != 2 || strike.GetStrike().GetTargetEventId() != hello.EventId {
		t.Fatalf("bad strike event: %v", strike)
	}
	_, err = aliceWS.Strike(ctx, dm.Id, hello.EventId)
	wantCode(t, err, "already_struck")
	_, err = aliceWS.Strike(ctx, dm.Id, strike.EventId)
	wantCode(t, err, "cannot_strike")

	// --- offline catch-up ---
	bobWS.Close()
	<-bobWS.Done()
	for _, text := range []string{"m3", "m4", "m5"} {
		must(aliceWS.SendText(ctx, dm.Id, text))
	}
	bobWS = must(bob.Connect(ctx))
	defer bobWS.Close()
	if n := len(bobWS.Auth.Conversations); n != 1 || bobWS.Auth.Conversations[0].LastSeq != 5 {
		t.Fatalf("bob sees conversations %v", bobWS.Auth.Conversations)
	}
	page := must(bobWS.Sync(ctx, map[int64]int64{dm.Id: 1}, 2))
	if len(page.Events) != 2 || page.Events[0].Seq != 2 || len(page.HasMore) != 1 {
		t.Fatalf("bad first page: %v", page)
	}
	page = must(bobWS.Sync(ctx, map[int64]int64{dm.Id: 3}, 0))
	if len(page.Events) != 2 || page.Events[1].GetText().GetText() != "m5" || len(page.HasMore) != 0 {
		t.Fatalf("bad second page: %v", page)
	}
	// Carol cannot sync someone else's DM (silently empty).
	if p := must(carolWS.Sync(ctx, map[int64]int64{dm.Id: 0}, 0)); len(p.Events) != 0 {
		t.Fatal("non-member got events")
	}

	// --- read position ---
	if err := bobWS.MarkRead(ctx, dm.Id, 99); err != nil {
		t.Fatal(err)
	}
	bob2 := must(bob.Connect(ctx))
	if rs := bob2.Auth.Conversations[0].Self.ReadSeq; rs != 5 {
		t.Fatalf("read_seq = %d, want 5 (clamped to last_seq)", rs)
	}
	bob2.Close()

	// --- revoke session disconnects it ---
	sessions := must(bob.ListSessions(ctx))
	var current int64
	for _, s := range sessions.Sessions {
		if s.Current {
			current = s.Id
		}
	}
	if current == 0 {
		t.Fatal("current session not marked")
	}
	if err := bob.RevokeSession(ctx, current); err != nil {
		t.Fatal(err)
	}
	select {
	case <-bobWS.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("revoked session was not disconnected")
	}
	_, err = bob.ListFriends(ctx)
	wantCode(t, err, "unauthorized")
}
