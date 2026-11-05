package e2e

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/game"
	"github.com/OzakiJUN/am/server/internal/store"
	"google.golang.org/protobuf/proto"
)

func fishingTestRules(t *testing.T, r *game.FishingRules) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "rules.json")
	if err := os.WriteFile(file, must(json.Marshal(r)), 0600); err != nil {
		t.Fatal(err)
	}
	return file
}
func TestFishingClientRelayedSave(t *testing.T) { forEachDB(t, testFishingClientRelayedSave) }
func testFishingClientRelayedSave(t *testing.T, dest *app.App, base string) {
	ctx := ctxT(t)
	rules := game.DefaultFishingRules()
	rules.LootWeights = []int{1, 0, 0, 0}
	rules.WorkerMS = 60000
	file := fishingTestRules(t, rules)
	origin, url := setup(t, "sqlite", func(c *config.Config) { c.Fishing.RulesFile = file })
	alice := newServerUsers(t, origin, url, "alice")[0]
	people := newServerUsers(t, dest, base, "samehuman", "unrelated")
	bob, other := people[0], people[1]
	account := func(u *user) game.FishingAccount {
		t.Helper()
		data := must(u.cli.FishingAccount(ctx))
		var a game.FishingAccount
		if err := json.Unmarshal([]byte(data.StateJson), &a); err != nil {
			t.Fatal(err)
		}
		return a
	}
	room := must(alice.cli.CreateGroup(ctx, "origin"))
	g := must(alice.cli.OpenGame(ctx, room.Id, "fishing", true))
	err := origin.Store.InTx(ctx, func(q *store.Queries) error {
		g, err := q.GetGameForUpdate(ctx, g.Id)
		if err != nil {
			return err
		}
		var st game.State
		if err = json.Unmarshal([]byte(g.State), &st); err != nil {
			return err
		}
		st.Pond.Seats[0].BiteAt = time.Now().UnixMilli() - 1
		st.Pond.Seats[0].ExpiresAt = time.Now().UnixMilli() - 1
		g.State = string(must(json.Marshal(st)))
		return q.SaveGame(ctx, g)
	})
	if err != nil {
		t.Fatal(err)
	}
	must(alice.cli.GetGame(ctx, g.Id))
	err = origin.Store.InTx(ctx, func(q *store.Queries) error {
		raw, e := q.FishingAccountForUpdate(ctx, alice.me.Id, "")
		if e != nil {
			return e
		}
		var saved game.FishingAccount
		if e = json.Unmarshal([]byte(raw), &saved); e != nil {
			return e
		}
		saved.Tools = map[string]int{"speed": 1, "auto": 1, "value": 1, "glove": 3, "glove_haste": 4, "glove_value": 5, "ward": 1}
		saved.Equipped = []string{"glove_haste", "glove_value"}
		saved.StealAt = time.Now().UnixMilli() + 120000
		saved.Fish[0].BaseValue = saved.Fish[0].Value
		saved.Fish[0].Value = (saved.Fish[0].BaseValue*250 + 50) / 100
		saved.Fish[0].StealBonus = 150
		saved.Fish[0].AcquiredAt = time.Now().UnixMilli()
		b, e := json.Marshal(saved)
		if e != nil {
			return e
		}
		return q.SaveFishingAccount(ctx, alice.me.Id, string(b))
	})
	if err != nil {
		t.Fatal(err)
	}
	purchase := &amv1.FishingActionRequest{Action: "buy_pack", RequestId: "purchase-before-move"}
	must(alice.cli.FishingAction(ctx, purchase))
	before, target := account(alice), account(bob)
	exported := must(alice.cli.FishingSync(ctx, &amv1.FishingSyncRequest{Mode: "export", ExpectedRevision: before.Revision, TransferId: "transfer-once", Destination: target.LocalSlot}))
	// A frozen source cannot keep spending or earning while a client migrates it.
	_, err = alice.cli.FishingAction(ctx, &amv1.FishingActionRequest{Action: "buy_pack", RequestId: "after-frozen-request"})
	wantCode(t, err, "game_state")
	wrong := account(other)
	_, err = other.cli.FishingSync(ctx, &amv1.FishingSyncRequest{Mode: "activate", ExpectedRevision: wrong.Revision, StateJson: exported.StateJson, TransferId: "transfer-once"})
	wantCode(t, err, "bad_request")
	req := &amv1.FishingSyncRequest{Mode: "activate", ExpectedRevision: target.Revision, StateJson: exported.StateJson, TransferId: "transfer-once"}
	must(bob.cli.FishingSync(ctx, req))
	moved := account(bob)
	if moved.Frozen || moved.Identity != before.Identity || moved.LocalSlot != target.LocalSlot || moved.Coins != before.Coins || moved.Packs != 1 || len(moved.Fish) != 1 || moved.Fish[0].ID != before.Fish[0].ID {
		t.Fatal("save did not continue across servers")
	}
	if len(moved.Tools) != 7 || moved.Tools["glove_haste"] != 4 || moved.Tools["glove_value"] != 5 || moved.StealAt != before.StealAt || moved.Fish[0].StealBonus != 150 || moved.Fish[0].BaseValue != before.Fish[0].BaseValue || moved.Fish[0].AcquiredAt != before.Fish[0].AcquiredAt {
		t.Fatal("glove state lost in cross-server save")
	}
	must(bob.cli.FishingSync(ctx, req))
	if account(bob).Revision != moved.Revision {
		t.Fatal("activation retry changed save")
	}
	must(bob.cli.FishingAction(ctx, purchase))
	if account(bob).Coins != moved.Coins || account(bob).Packs != 1 {
		t.Fatal("cross-server request replay charged twice")
	}
	// This specimen's owner key remains valid although local account IDs differ.
	if moved.Fish[0].OwnerKey != moved.Identity {
		t.Fatal("global fish owner lost")
	}
	// The same fish id and global owner are valid in both profile layouts.
	layout := &amv1.ProfileLayout{Widgets: []*amv1.Widget{{Id: "fish", Kind: "fishing_fish", Source: amv1.WidgetSource_WIDGET_SOURCE_BUILTIN, W: 2, H: 2, Landscape: &amv1.Cell{}, Config: `{"ids":["` + moved.Fish[0].ID + `"]}`}}}
	layoutData := must(proto.Marshal(layout))
	if err := dest.Store.AddLayout(ctx, store.ProfileUser, bob.me.Id, 1, layoutData, bob.me.Id, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if err := origin.Store.AddLayout(ctx, store.ProfileUser, alice.me.Id, 1, layoutData, alice.me.Id, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	showcase := must(dest.Games.FishingShowcase(ctx, bob.me.Id))
	var display struct{ Records map[string]game.CaughtFish }
	_ = json.Unmarshal([]byte(showcase.StateJson), &display)
	if len(display.Records) != 1 || display.Records[moved.Fish[0].ID].OwnerKey != moved.Identity {
		t.Fatal("cross-server exhibit lost fish identity")
	}
	must(bob.cli.FishingAction(ctx, &amv1.FishingActionRequest{Action: "sell", FishIds: []string{moved.Fish[0].ID}, RequestId: "sell-after-move"}))
	moved = account(bob)
	data := must(json.Marshal(map[string]any{"account": moved, "receipts": map[string]string{}}))
	source := account(alice)
	must(alice.cli.FishingSync(ctx, &amv1.FishingSyncRequest{Mode: "mirror", ExpectedRevision: source.Revision, StateJson: string(data)}))
	mirror := account(alice)
	if !mirror.Frozen || mirror.Identity != moved.Identity || mirror.LocalSlot != source.LocalSlot {
		t.Fatal("mirror became an earning copy")
	}
	_, err = alice.cli.OpenGame(ctx, room.Id, "fishing", true)
	wantCode(t, err, "game_state")
	mirrorShowcase := must(origin.Games.FishingShowcase(ctx, alice.me.Id))
	display.Records = nil
	_ = json.Unmarshal([]byte(mirrorShowcase.StateJson), &display)
	if len(display.Records) != 0 {
		t.Fatal("sold fish survived in mirrored profile")
	}
	// Replaying the old snapshot cannot overwrite the advanced active destination.
	_, err = bob.cli.FishingSync(ctx, &amv1.FishingSyncRequest{Mode: "mirror", ExpectedRevision: moved.Revision, StateJson: exported.StateJson})
	wantCode(t, err, "game_state")
}
func TestFishingServerRunsWithoutClients(t *testing.T) {
	r := game.DefaultFishingRules()
	r.WaitMin = 1
	r.WaitMax = 1
	r.Bite = 1
	r.WorkerMS = 100
	r.LootWeights = []int{1, 0, 0, 0}
	file := fishingTestRules(t, r)
	forEachDB(t, func(t *testing.T, a *app.App, base string) {
		ctx := ctxT(t)
		u := newServerUsers(t, a, base, "offline")[0]
		ch := must(u.cli.CreateGroup(ctx, "offline pond"))
		must(u.cli.OpenGame(ctx, ch.Id, "fishing", true))
		// No game refresh, websocket or account HTTP request follows. Only inspect storage.
		deadline := time.Now().Add(5500 * time.Millisecond)
		for time.Now().Before(deadline) {
			raw := must(a.Store.FishingAccount(ctx, u.me.Id))
			var saved game.FishingAccount
			_ = json.Unmarshal([]byte(raw), &saved)
			if len(saved.Fish) >= 2 {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("server did not keep catching while all clients were absent")
	}, func(c *config.Config) { c.Fishing.RulesFile = file })
}

func TestFishingLegacySaveUpgrade(t *testing.T) {
	forEachDB(t, func(t *testing.T, a *app.App, base string) {
		ctx := ctxT(t)
		u := newServerUsers(t, a, base, "legacyfisher")[0]
		must(u.cli.FishingAccount(ctx))
		raw := `{"version":1,"coins":200,"fish":[{"id":"old-fish","species":"f001","length_cm":53.16,"value":12,"caught_by":"` + strconv.FormatInt(u.me.Id, 10) + `"}],"records":{},"tools":{},"cards":{}}`
		if err := a.Store.SaveFishingAccount(ctx, u.me.Id, raw); err != nil {
			t.Fatal(err)
		}
		get := func() game.FishingAccount {
			var save game.FishingAccount
			_ = json.Unmarshal([]byte(must(u.cli.FishingAccount(ctx)).StateJson), &save)
			return save
		}
		first, second := get(), get()
		if first.Identity == "" || first.Identity != second.Identity || first.LocalSlot != second.LocalSlot || first.Revision != second.Revision {
			t.Fatal("legacy identity not persisted")
		}
		if first.Coins != game.Coins(200) || first.Fish[0].Value != game.Coins(12) || first.Fish[0].Length != .53 || first.Fish[0].OwnerKey != first.Identity {
			t.Fatal("legacy currency, length or ownership changed incorrectly")
		}
	})
}
