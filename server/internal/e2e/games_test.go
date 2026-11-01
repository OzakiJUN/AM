package e2e

import (
	"encoding/json"
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
)

// Board games in a channel: open, ask to join, host approves, play by the
// rules on the server, everyone in the channel gets their own view.
func TestGames(t *testing.T) {
	forEachDB(t, testGames, func(c *config.Config) { c.Limits.MaxGamesPerConv = 2 })
}

func testGames(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "ann", "bob", "cat", "dan", "eve")
	ann, bob, cat, dan, eve := us[0], us[1], us[2], us[3], us[4]
	ch := must(ann.cli.CreateGroup(ctx, "棋牌室", bob.me.Id, cat.me.Id, dan.me.Id))
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()

	// 五子棋: bob asks, ann lets him in, starts; black (ann) wins with five in a row.
	g := must(ann.cli.OpenGame(ctx, ch.Id, "gomoku", false))
	waitPush(t, bobWS, "game opened", func(f *amv1.ServerFrame) bool { return f.GetGame().GetId() == g.Id })
	if g.Status != "waiting" || len(g.Players) != 1 || g.Players[0].UserId != ann.me.Id {
		t.Fatalf("opened %+v", g)
	}
	_, err := eve.cli.GameStep(ctx, g.Id, "join")
	wantCode(t, err, "not_member")
	if g = must(bob.cli.GameStep(ctx, g.Id, "join")); len(g.Applicants) != 1 || len(g.Players) != 1 {
		t.Fatalf("bob should be asking: %+v", g)
	}
	_, err = bob.cli.GameStep(ctx, g.Id, "start")
	wantCode(t, err, "no_permission")
	must(ann.cli.DecideGame(ctx, g.Id, bob.me.Id, true))
	_, err = cat.cli.GameStep(ctx, g.Id, "join")
	wantCode(t, err, "game_full")
	g = must(ann.cli.GameStep(ctx, g.Id, "start"))
	if g.Status != "playing" || len(g.WaitingOn) != 1 || g.WaitingOn[0] != ann.me.Id {
		t.Fatalf("started %+v", g)
	}
	_, err = bob.cli.ActGame(ctx, g.Id, &amv1.GameActRequest{Action: "move", X: 7, Y: 7})
	wantCode(t, err, "not_your_turn")
	for i := int32(0); i < 4; i++ {
		must(ann.cli.ActGame(ctx, g.Id, &amv1.GameActRequest{Action: "move", X: i, Y: 0}))
		_, err = bob.cli.ActGame(ctx, g.Id, &amv1.GameActRequest{Action: "move", X: i, Y: 0})
		wantCode(t, err, "game_bad_move")
		must(bob.cli.ActGame(ctx, g.Id, &amv1.GameActRequest{Action: "move", X: i, Y: 1}))
	}
	g = must(ann.cli.ActGame(ctx, g.Id, &amv1.GameActRequest{Action: "move", X: 4, Y: 0}))
	var st struct {
		Winner int   `json:"winner"`
		Last   []int `json:"last"`
		Board  []int `json:"board"`
	}
	if err := json.Unmarshal([]byte(g.StateJson), &st); err != nil || g.Status != "ended" || st.Winner != 1 || len(st.Board) != 225 {
		t.Fatalf("ann should win: %s %s %v", g.Status, g.StateJson, err)
	}
	waitPush(t, bobWS, "game over", func(f *amv1.ServerFrame) bool { return f.GetGame().GetStatus() == "ended" })

	// 谁是卧底 with auto-approve: four players; each sees only their own word.
	u := must(ann.cli.OpenGame(ctx, ch.Id, "undercover", true))
	for _, p := range []*user{bob, cat, dan} {
		if _, err := p.cli.GameStep(ctx, u.Id, "join"); err != nil {
			t.Fatal(err)
		}
	}
	// The limit: two games at once (the finished one doesn't count).
	_, err = cat.cli.OpenGame(ctx, ch.Id, "reversi", false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = cat.cli.OpenGame(ctx, ch.Id, "reversi", false)
	wantCode(t, err, "game_limit")
	u = must(ann.cli.GameStep(ctx, u.Id, "start"))
	words := 0
	for _, p := range u.Players {
		if p.Word != "" {
			words++
			if p.UserId != ann.me.Id {
				t.Fatal("ann sees someone else's word")
			}
		}
	}
	if words != 1 {
		t.Fatalf("ann should see her word only: %+v", u.Players)
	}
	f := waitPush(t, bobWS, "bob's word", func(f *amv1.ServerFrame) bool {
		return f.GetGame().GetId() == u.Id && f.GetGame().GetStatus() == "playing"
	})
	for _, p := range f.GetGame().Players {
		if (p.Word != "") != (p.UserId == bob.me.Id) {
			t.Fatalf("bob's view: %+v", f.GetGame().Players)
		}
	}
	// Seat 0 (ann) describes first; saying the word itself is refused.
	_, err = bob.cli.ActGame(ctx, u.Id, &amv1.GameActRequest{Action: "say", Text: "嗯"})
	wantCode(t, err, "not_your_turn")
	must(ann.cli.ActGame(ctx, u.Id, &amv1.GameActRequest{Action: "say", Text: "很常见的东西"}))
	// The host ends it: everyone's words are shown.
	u = must(ann.cli.GameStep(ctx, u.Id, "end"))
	for _, p := range u.Players {
		if p.Word == "" {
			t.Fatalf("words at the end: %+v", u.Players)
		}
	}
	if l := must(dan.cli.ListGames(ctx, ch.Id)).Games; len(l) != 3 {
		t.Fatalf("listed %d games", len(l))
	}
	_, err = eve.cli.ListGames(ctx, ch.Id)
	wantCode(t, err, "not_member")

	// 再来一局: the same four seated again, waiting for the start.
	r := must(cat.cli.GameStep(ctx, u.Id, "rematch"))
	if r.Id == u.Id || r.Status != "waiting" || r.HostId != cat.me.Id || len(r.Players) != 4 {
		t.Fatalf("rematch %+v", r)
	}
	_, err = eve.cli.GameStep(ctx, u.Id, "rematch")
	wantCode(t, err, "not_member")
	_, err = bob.cli.GameStep(ctx, g.Id, "rematch")
	wantCode(t, err, "game_limit") // the reversi game and this rematch are open
	// Gomoku rematch swaps colours: bob (white before) is black now.
	must(cat.cli.GameStep(ctx, r.Id, "leave")) // cat was host: closes it
	g2 := must(bob.cli.GameStep(ctx, g.Id, "rematch"))
	if g2.Players[0].UserId != bob.me.Id || g2.Players[1].UserId != ann.me.Id {
		t.Fatalf("colours not swapped: %+v", g2.Players)
	}

	// 对局记录: the finished games, newest first.
	h := must(dan.cli.GameHistory(ctx, ch.Id, 0)).Games
	if len(h) != 3 || h[0].Id != r.Id || h[1].Id != u.Id || h[2].Id != g.Id {
		t.Fatalf("history %d", len(h))
	}
	if len(must(dan.cli.GameHistory(ctx, ch.Id, h[1].UpdatedAt)).Games) != 1 {
		t.Fatal("history paging")
	}
}
