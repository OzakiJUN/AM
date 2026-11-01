package e2e

import (
	"crypto/sha256"
	"strings"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/store"
)

func TestPresence(t *testing.T) { forEachDB(t, testPresence) }

func isPresence(uid int64, online bool) func(*amv1.ServerFrame) bool {
	return func(f *amv1.ServerFrame) bool {
		p := f.GetPresence().GetPresence()
		return p != nil && p.UserId == uid && p.Online == online
	}
}

func onlineIn(a *amv1.AuthResponse, uid int64) *amv1.Presence {
	for _, p := range a.GetPresences() {
		if p.UserId == uid {
			return p
		}
	}
	return nil
}

func testPresence(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "alice", "bob")
	alice, bob := us[0], us[1]

	// Signature.
	me := must(alice.cli.UpdateProfile(ctx, &amv1.UpdateProfileRequest{Bio: ptr("  hello there  ")}))
	if me.Bio != "hello there" {
		t.Fatalf("bio = %q", me.Bio)
	}
	_, err := alice.cli.UpdateProfile(ctx, &amv1.UpdateProfileRequest{Bio: ptr(strings.Repeat("x", 101))})
	wantCode(t, err, "bio_too_long")
	if u := must(bob.cli.GetUser(ctx, alice.me.Id)); u.Bio != "hello there" {
		t.Fatalf("bob sees bio %q", u.Bio)
	}

	// An AI account owned by alice (created directly: bot management is stage 2).
	aiID := alice.me.Id + 1000
	if err := a.Store.CreateUser(ctx, &store.User{ID: aiID, Username: "alice_ai", DisplayName: "AI",
		AccountType: int16(amv1.AccountType_ACCOUNT_TYPE_AI), OwnerID: alice.me.Id, CreatedAt: time.Now().UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	token := "am_test_ai_token"
	sum := sha256.Sum256([]byte(token))
	if err := a.Store.CreateSession(ctx, &store.Session{ID: aiID + 1, UserID: aiID, DeviceName: "ai", CreatedAt: 1, LastSeen: 1}, sum[:]); err != nil {
		t.Fatal(err)
	}
	ai := amclient.New(base, nil)
	ai.Token = token

	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	if p := onlineIn(bobWS.Auth, bob.me.Id); p == nil || !p.Online {
		t.Fatalf("bob's snapshot lacks himself: %v", bobWS.Auth.GetPresences())
	}
	aiWS := must(ai.Connect(ctx))
	defer aiWS.Close()
	waitPush(t, bobWS, "ai online", isPresence(aiID, true))

	aliceWS := must(alice.cli.Connect(ctx))
	waitPush(t, bobWS, "alice online", isPresence(alice.me.Id, true))
	waitPush(t, aiWS, "alice online (ai)", isPresence(alice.me.Id, true))
	if onlineIn(aliceWS.Auth, bob.me.Id) == nil || onlineIn(aliceWS.Auth, aiID) == nil {
		t.Fatalf("alice's snapshot = %v", aliceWS.Auth.GetPresences())
	}

	// Activity.
	_, err = alice.cli.SetPresence(ctx, &amv1.SetPresenceRequest{Activity: &amv1.Activity{Kind: amv1.ActivityKind_ACTIVITY_KIND_CUSTOM}})
	wantCode(t, err, "invalid_activity")
	_, err = alice.cli.SetPresence(ctx, &amv1.SetPresenceRequest{Activity: &amv1.Activity{Kind: 99}})
	wantCode(t, err, "invalid_activity")
	must(alice.cli.SetPresence(ctx, &amv1.SetPresenceRequest{Activity: &amv1.Activity{Kind: amv1.ActivityKind_ACTIVITY_KIND_LISTENING, Text: "晴天"}}))
	f := waitPush(t, bobWS, "activity", isPresence(alice.me.Id, true))
	if act := f.GetPresence().GetPresence().GetActivity(); act.GetKind() != amv1.ActivityKind_ACTIVITY_KIND_LISTENING || act.GetText() != "晴天" {
		t.Fatalf("activity = %v", act)
	}

	// Invisible: bob sees alice go offline; her AI still sees her, flagged.
	p := must(alice.cli.SetPresence(ctx, &amv1.SetPresenceRequest{Invisible: true}))
	if !p.Online || !p.Invisible || p.Activity != nil {
		t.Fatalf("alice's own view = %v", p)
	}
	waitPush(t, bobWS, "alice hidden", isPresence(alice.me.Id, false))
	waitPush(t, aiWS, "alice invisible (ai)", func(f *amv1.ServerFrame) bool {
		p := f.GetPresence().GetPresence()
		return p.GetUserId() == alice.me.Id && p.GetOnline() && p.GetInvisible()
	})

	// Reconnecting keeps the setting (it is saved), for every viewer.
	aliceWS.Close()
	waitPush(t, aiWS, "alice offline (ai)", isPresence(alice.me.Id, false))
	aliceWS = must(alice.cli.Connect(ctx))
	defer aliceWS.Close()
	if p := onlineIn(aliceWS.Auth, alice.me.Id); p == nil || !p.Invisible {
		t.Fatalf("alice's own snapshot = %v", p)
	}
	waitPush(t, aiWS, "alice back (ai)", isPresence(alice.me.Id, true))
	bob2 := must(bob.cli.Connect(ctx))
	if onlineIn(bob2.Auth, alice.me.Id) != nil {
		t.Fatal("bob's new snapshot shows invisible alice")
	}
	bob2.Close()

	// Visible again; leaving tells everyone.
	must(alice.cli.SetPresence(ctx, &amv1.SetPresenceRequest{}))
	waitPush(t, bobWS, "alice visible", isPresence(alice.me.Id, true))
	aliceWS.Close()
	waitPush(t, bobWS, "alice offline", isPresence(alice.me.Id, false))
}
