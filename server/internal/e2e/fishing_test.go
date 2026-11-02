package e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/game"
	"github.com/OzakiJUN/am/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestFishing(t *testing.T) {
	rules := game.DefaultFishingRules()
	rules.LootWeights = []int{1, 0, 0, 0}
	for i := range rules.StealChance {
		rules.StealChance[i] = 100
	}
	path := filepath.Join(t.TempDir(), "fishing.json")
	mustWrite := func() {
		b, err := json.Marshal(rules)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	mustWrite()
	forEachDB(t, testFishing, func(c *config.Config) { c.Fishing.RulesFile = path; c.Limits.MaxGamesPerConv = 10 })
}
func testFishing(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	var names []string
	for i := 0; i < 14; i++ {
		names = append(names, fmt.Sprintf("fisher%d", i))
	}
	us := newServerUsers(t, a, base, names...)
	host, other, outsider := us[0], us[1], us[13]
	var memberIDs []int64
	for _, u := range us[1:13] {
		memberIDs = append(memberIDs, u.me.Id)
	}
	conv := must(host.cli.CreateGroup(ctx, "鱼塘", memberIDs...))
	second := must(host.cli.CreateGroup(ctx, "别的频道", other.me.Id))
	call := func(u *user, method, path string, body []byte) (int, []byte) {
		t.Helper()
		req := must(http.NewRequestWithContext(ctx, method, base+path, bytes.NewReader(body)))
		req.Header.Set("Authorization", "Bearer "+u.cli.Token)
		resp := must(u.cli.HTTP.Do(req))
		defer resp.Body.Close()
		return resp.StatusCode, must(io.ReadAll(resp.Body))
	}
	account := func(u *user) game.FishingAccount {
		t.Helper()
		code, b := call(u, "GET", "/api/v1/fishing/me", nil)
		if code != 200 {
			t.Fatalf("account %d %s", code, b)
		}
		var out amv1.FishingData
		if err := protojson.Unmarshal(b, &out); err != nil {
			t.Fatal(err)
		}
		var account game.FishingAccount
		if err := json.Unmarshal([]byte(out.StateJson), &account); err != nil {
			t.Fatal(err)
		}
		return account
	}
	shop := func(u *user, req *amv1.FishingActionRequest) (int, game.FishingAccount) {
		t.Helper()
		b := must(protojson.Marshal(req))
		code, b := call(u, "POST", "/api/v1/fishing/me", b)
		var result game.FishingAccount
		if code == 200 {
			var out amv1.FishingData
			if err := protojson.Unmarshal(b, &out); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(out.StateJson), &result); err != nil {
				t.Fatal(err)
			}
		}
		return code, result
	}
	updateAccount := func(u *user, fn func(*game.FishingAccount)) {
		t.Helper()
		v := account(u)
		fn(&v)
		b := must(json.Marshal(v))
		if err := a.Store.SaveFishingAccount(ctx, u.me.Id, string(b)); err != nil {
			t.Fatal(err)
		}
	}
	setBite := func(id int64, user int64, expired bool) {
		t.Helper()
		if err := a.Store.InTx(ctx, func(q *store.Queries) error {
			g, err := q.GetGameForUpdate(ctx, id)
			if err != nil {
				return err
			}
			var state game.State
			if err = json.Unmarshal([]byte(g.State), &state); err != nil {
				return err
			}
			now := time.Now().UnixMilli()
			for i := range state.Pond.Seats {
				p := &state.Pond.Seats[i]
				if p.User == user {
					p.BiteAt = now - 1000
					p.ExpiresAt = now + 25000
					if expired {
						p.ExpiresAt = now - 1
					}
				}
			}
			b, _ := json.Marshal(state)
			g.State = string(b)
			return q.SaveGame(ctx, g)
		}); err != nil {
			t.Fatal(err)
		}
	}
	g := must(host.cli.OpenGame(ctx, conv.Id, "fishing", false))
	if g.Status != "playing" || len(g.Players) != 1 {
		t.Fatal("pond did not start immediately")
	}
	var state game.State
	if err := json.Unmarshal([]byte(g.StateJson), &state); err != nil || len(state.Pond.Seats) != 12 {
		t.Fatal("not twelve seats")
	}
	_, err := outsider.cli.GameStep(ctx, g.Id, "join")
	wantCode(t, err, "not_member")
	for _, u := range us[1:12] {
		must(u.cli.GameStep(ctx, g.Id, "join"))
	}
	_, err = us[12].cli.GameStep(ctx, g.Id, "join")
	wantCode(t, err, "game_full")
	_, err = host.cli.OpenGame(ctx, second.Id, "fishing", true)
	wantCode(t, err, "game_state")
	_, err = host.cli.ActGame(ctx, g.Id, &amv1.GameActRequest{Action: "reel"})
	wantCode(t, err, "game_bad_move")
	setBite(g.Id, host.me.Id, false)
	must(host.cli.ActGame(ctx, g.Id, &amv1.GameActRequest{Action: "reel"}))
	first := account(host)
	if len(first.Fish) != 1 || len(first.Records) != 2 {
		t.Fatal("missing persistent catch")
	}
	_, err = host.cli.ActGame(ctx, g.Id, &amv1.GameActRequest{Action: "reel"})
	wantCode(t, err, "game_bad_move")
	req := &amv1.FishingActionRequest{Action: "sell", FishIds: []string{first.Fish[0].ID}, RequestId: "sell-once-only"}
	status, sold := shop(host, req)
	if status != 200 || len(sold.Fish) != 0 || sold.Coins != first.Coins+first.Fish[0].Value || len(sold.Records) != 2 {
		t.Fatal("sale or records")
	}
	status, retry := shop(host, req)
	if status != 200 || retry.Coins != sold.Coins {
		t.Fatal("retry paid twice")
	}
	// Mount an arbitrary individual by catch id. The archive survives sale,
	// even if this fish is no longer a size record, and cannot resolve another owner.
	savedRecords := sold.Records
	updateAccount(host, func(a *game.FishingAccount) { a.Records = map[string]game.CaughtFish{} })
	fishID := first.Fish[0].ID
	outsiderFish := first.Fish[0]
	outsiderFish.ID = "1234567"
	outsiderFish.By = strconv.FormatInt(other.me.Id, 10)
	outsiderData := must(json.Marshal(outsiderFish))
	mustNoErr := a.Store.ArchiveFishingCatch(ctx, other.me.Id, 1234567, string(outsiderData))
	if mustNoErr != nil {
		t.Fatal(mustNoErr)
	}
	layout := &amv1.ProfileLayout{Widgets: []*amv1.Widget{{Id: "my-fish", Kind: "fishing_fish", Source: amv1.WidgetSource_WIDGET_SOURCE_BUILTIN, W: 2, H: 2, Config: fmt.Sprintf(`{"ids":["%s","1234567"]}`, fishID), Landscape: &amv1.Cell{}}}}
	layoutBytes := must(proto.Marshal(layout))
	if err := a.Store.AddLayout(ctx, store.ProfileUser, host.me.Id, 1, layoutBytes, host.me.Id, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	code, publicBody := call(other, "GET", fmt.Sprintf("/api/v1/users/%d/fishing-showcase", host.me.Id), nil)
	if code != 200 {
		t.Fatal("mounted archive unavailable")
	}
	var mountedData amv1.FishingData
	if err := protojson.Unmarshal(publicBody, &mountedData); err != nil {
		t.Fatal(err)
	}
	var mounted struct{ Records map[string]game.CaughtFish }
	if err := json.Unmarshal([]byte(mountedData.StateJson), &mounted); err != nil {
		t.Fatal(err)
	}
	if len(mounted.Records) != 1 || mounted.Records[fishID].ID != fishID {
		t.Fatal("sold exhibit vanished or foreign fish leaked")
	}
	updateAccount(host, func(a *game.FishingAccount) { a.Records = savedRecords })
	req.Action = "buy_pack"
	if code, _ := shop(host, req); code != 400 {
		t.Fatal("request id accepted with changed payload")
	}
	// Two simultaneous pack requests with one id spend once.
	updateAccount(host, func(a *game.FishingAccount) { a.Coins = 100000 })
	req = &amv1.FishingActionRequest{Action: "buy_pack", RequestId: "parallel-pack-once"}
	data := must(protojson.Marshal(req))
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); code, _ := call(host, "POST", "/api/v1/fishing/me", data); codes <- code }()
	}
	wg.Wait()
	close(codes)
	for c := range codes {
		if c != 200 {
			t.Fatal("parallel purchase failed", c)
		}
	}
	after := account(host)
	if after.Packs != 1 || after.Coins != 100000-180 {
		t.Fatal("double spend")
	}
	if code, opened := shop(host, &amv1.FishingActionRequest{Action: "open_pack", RequestId: "open-just-once"}); code != 200 || len(opened.Opened) != 4 || opened.Packs != 0 {
		t.Fatal("pack not four cards")
	}
	for i, k := range []string{"glove", "ward", "speed"} {
		if code, _ := shop(host, &amv1.FishingActionRequest{Action: "buy_tool", Item: k, Quality: 1, RequestId: fmt.Sprintf("buy-tool-%d", i)}); code != 200 {
			t.Fatal("buy tool")
		}
		code, _ := shop(host, &amv1.FishingActionRequest{Action: "equip", Item: k, RequestId: fmt.Sprintf("equip-tool-%d", i)})
		if (i < 2 && code != 200) || (i == 2 && code == 200) {
			t.Fatal("two tool limit")
		}
	}
	// Ward protects a pending catch, then its persistent cooldown permits a later theft.
	updateAccount(other, func(a *game.FishingAccount) { a.Tools["ward"] = 1; a.Equipped = []string{"ward"} })
	setBite(g.Id, other.me.Id, false)
	must(host.cli.ActGame(ctx, g.Id, &amv1.GameActRequest{Action: "steal", Target: 1}))
	if account(other).WardAt <= time.Now().UnixMilli() {
		t.Fatal("ward didn't activate")
	}
	updateAccount(host, func(a *game.FishingAccount) { a.StealAt = 0 })
	must(host.cli.ActGame(ctx, g.Id, &amv1.GameActRequest{Action: "steal", Target: 1}))
	if len(account(host).Fish) != 1 || len(account(other).Fish) != 0 {
		t.Fatal("theft wrong owner")
	}
	stolen := account(host)
	if stolen.Fish[0].By != strconv.FormatInt(other.me.Id, 10) {
		t.Fatal("stolen catch became self record")
	}
	if len(stolen.Records) != 2 {
		t.Fatal("steal changed self records")
	}
	// Automatic rod catches once per cooldown, preserves state across leaving/reopening.
	updateAccount(host, func(a *game.FishingAccount) { a.Tools["auto"] = 1; a.Equipped = []string{"auto"}; a.AutoAt = 0 })
	setBite(g.Id, host.me.Id, false)
	must(host.cli.GetGame(ctx, g.Id))
	auto := account(host)
	if len(auto.Fish) != 2 || auto.AutoAt <= time.Now().UnixMilli() {
		t.Fatal("automatic reel")
	}
	setBite(g.Id, host.me.Id, false)
	must(host.cli.GetGame(ctx, g.Id))
	if len(account(host).Fish) != 2 {
		t.Fatal("auto ignored cooldown")
	}
	setBite(g.Id, host.me.Id, true)
	must(host.cli.GetGame(ctx, g.Id))
	if len(account(host).Fish) != 2 {
		t.Fatal("expired bite rewarded")
	}
	must(host.cli.GameStep(ctx, g.Id, "leave"))
	again := must(host.cli.OpenGame(ctx, second.Id, "fishing", true))
	kept := account(host)
	if len(kept.Fish) != 2 || kept.AutoAt != auto.AutoAt || len(kept.Cards) == 0 {
		t.Fatal("state lost across channels")
	}
	code, b := call(other, "GET", fmt.Sprintf("/api/v1/users/%d/fishing-showcase", host.me.Id), nil)
	if code != 200 {
		t.Fatal("showcase")
	}
	var public amv1.FishingData
	mustErr := protojson.Unmarshal(b, &public)
	if mustErr != nil {
		t.Fatal(mustErr)
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal([]byte(public.StateJson), &fields)
	if len(fields) != 3 || fields["coins"] != nil || fields["fish"] != nil {
		t.Fatal("showcase leaked private state")
	}
	must(host.cli.GameStep(ctx, again.Id, "end"))
	if account(host).Room != "" {
		t.Fatal("closing didn't release seat lock")
	}
	// Old account catches survive a fresh reader of the same persistent store.
	raw := must(a.Store.FishingAccount(ctx, host.me.Id))
	if !bytes.Contains([]byte(raw), []byte("length_cm")) {
		t.Fatal("not stored")
	}
}
