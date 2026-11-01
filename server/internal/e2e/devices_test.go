package e2e

import (
	"bytes"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
)

// Several devices of one person: at most limits.max_devices (3 by default),
// pairing a new device with a one-time code, logging out, shared state.
func TestDevices(t *testing.T) { forEachDB(t, testDevices) }

func testDevices(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "owner", "bob")
	owner, bob := us[0], us[1]
	login := func() (*amclient.Client, error) {
		c := amclient.New(base, nil)
		_, err := c.Login(ctx, &amv1.LoginRequest{Username: "bob", Password: "password-bob", DeviceName: "phone"})
		return c, err
	}

	// Registering was device 1; two more fit, the 4th is refused.
	second := must(login())
	third := must(login())
	_, err := login()
	wantCode(t, err, "too_many_devices")
	if s := must(bob.cli.ListSessions(ctx)); len(s.Sessions) != 3 || s.MaxDevices != 3 {
		t.Fatalf("sessions %d, max %d", len(s.Sessions), s.MaxDevices)
	}
	// No pairing code while full either.
	_, err = bob.cli.CreatePairTicket(ctx, nil)
	wantCode(t, err, "too_many_devices")
	// Other accounts are not affected.
	must(owner.cli.CreatePairTicket(ctx, nil))

	// Logging out frees a place; the logged-out token stops working.
	old := third.Token
	if err := third.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	third.Token = old
	_, err = third.ListSessions(ctx)
	wantCode(t, err, "unauthorized")

	// Pairing: the bundle goes to the new device, the code works once.
	bundle := []byte("encrypted-for-the-new-device")
	tk := must(bob.cli.CreatePairTicket(ctx, bundle))
	if tk.ExpiresAt-time.Now().UnixMilli() > int64(5*time.Minute/time.Millisecond) || tk.ExpiresAt <= time.Now().UnixMilli() {
		t.Fatalf("expires_at %d", tk.ExpiresAt)
	}
	// A newer code replaces the older one.
	tk2 := must(bob.cli.CreatePairTicket(ctx, bundle))
	_, err = amclient.New(base, nil).RedeemPairTicket(ctx, tk.Ticket, "old code")
	wantCode(t, err, "invalid_pair_code")
	tk = tk2
	paired := amclient.New(base, nil)
	resp := must(paired.RedeemPairTicket(ctx, tk.Ticket, "AM Android"))
	if resp.Me.Id != bob.me.Id || !bytes.Equal(resp.Bundle, bundle) {
		t.Fatalf("redeemed as %d, bundle %q", resp.Me.Id, resp.Bundle)
	}
	if s := must(paired.ListSessions(ctx)); len(s.Sessions) != 3 {
		t.Fatalf("after pairing: %d sessions", len(s.Sessions))
	}
	_, err = amclient.New(base, nil).RedeemPairTicket(ctx, tk.Ticket, "again")
	wantCode(t, err, "invalid_pair_code")
	logins := must(bob.cli.ListLogins(ctx)).Records
	if logins[0].Kind != "pair" || logins[0].DeviceName != "AM Android" {
		t.Fatalf("login record %+v", logins[0])
	}

	// Full again: a code made earlier cannot squeeze in a 4th device.
	if err := second.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	tk = must(bob.cli.CreatePairTicket(ctx, nil))
	must(login())
	_, err = amclient.New(base, nil).RedeemPairTicket(ctx, tk.Ticket, "late")
	wantCode(t, err, "too_many_devices")

	// Shared state: optimistic saves.
	st := must(bob.cli.ClientState(ctx))
	if st.UpdatedAt != 0 || len(st.Data) != 0 {
		t.Fatal("state should start empty")
	}
	s1 := must(bob.cli.PutClientState(ctx, []byte("v1"), 0))
	_, err = paired.PutClientState(ctx, []byte("stale"), 0)
	wantCode(t, err, "state_conflict")
	s2 := must(paired.PutClientState(ctx, []byte("v2"), s1.UpdatedAt))
	if got := must(bob.cli.ClientState(ctx)); string(got.Data) != "v2" || got.UpdatedAt != s2.UpdatedAt || s2.UpdatedAt <= s1.UpdatedAt {
		t.Fatalf("state %q at %d", got.Data, got.UpdatedAt)
	}
	_, err = bob.cli.PutClientState(ctx, make([]byte, 33<<10), s2.UpdatedAt)
	if err == nil {
		t.Fatal("oversized state accepted")
	}
}
