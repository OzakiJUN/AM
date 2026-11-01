package game

import (
	"errors"
	"testing"
)

// trailGame: 3 players with known hands (seat 0: 1 2 3, seat 1: 4 5 6, seat 2: 7 8 9).
func trailGame(t *testing.T, n int) *State {
	t.Helper()
	s := started(t, Trail, n)
	for i := range s.Hands {
		s.Hands[i].Nums = []int{i*3 + 1, i*3 + 2, i*3 + 3}
	}
	return s
}

func TestTrailDeal(t *testing.T) {
	s := started(t, Trail, 6)
	seen := map[int]bool{}
	for _, h := range s.Hands {
		if len(h.Nums) != TrailHand {
			t.Fatalf("hand %v", h.Nums)
		}
		for _, n := range h.Nums {
			if n < 1 || n > TrailMax || seen[n] {
				t.Fatalf("bad or repeated number %d", n)
			}
			seen[n] = true
		}
	}
	if s.Turn != 0 {
		t.Fatal("first player starts")
	}
	if _, err := NewState(Trail, 1, false); err != nil {
		t.Fatal(err)
	}
}

func TestTrailAsk(t *testing.T) {
	s := trailGame(t, 3)
	if err := s.Ask(1, 0, "gt", 2); !errors.Is(err, ErrNotTurn) {
		t.Fatalf("not your turn: %v", err)
	}
	for _, bad := range []struct {
		target int
		q      string
		x      int
	}{{0, "gt", 5}, {1, "gt", 0}, {1, "mult", 9}, {1, "huh", 1}, {7, "odd", 0}} {
		if err := s.Ask(0, bad.target, bad.q, bad.x); !errors.Is(err, ErrBadMove) {
			t.Fatalf("%+v: %v", bad, err)
		}
	}
	must(t, s.Ask(0, 1, "gt", 5)) // 4 5 6: 6 > 5
	must(t, s.Ask(1, 2, "lt", 7)) // 7 8 9: none < 7
	must(t, s.Ask(2, 0, "mult", 3))
	got := []bool{s.Steps[0].Yes, s.Steps[1].Yes, s.Steps[2].Yes}
	if got[0] != true || got[1] != false || got[2] != true {
		t.Fatalf("answers %v", got)
	}
	if s.Turn != 0 || s.Steps[2].X != 3 {
		t.Fatalf("turn %d", s.Turn)
	}
}

func TestTrailGuessAndWin(t *testing.T) {
	s := trailGame(t, 2)
	// Wrong guess: the guesser gives away one parity.
	must(t, s.Guess(0, 1, 10))
	if st := s.Steps[0]; st.Yes || st.Hint != 0 || !st.Odd || !s.Hands[0].Hinted[0] {
		t.Fatalf("wrong guess: %+v", st)
	}
	must(t, s.Guess(1, 0, 1))
	if !s.Steps[1].Yes || !s.Hands[0].Shown[0] {
		t.Fatal("right guess turns the number up")
	}
	// A number already turned up is not guessed again.
	must(t, s.Guess(0, 1, 4))
	must(t, s.Guess(1, 0, 1))
	if s.Steps[3].Yes {
		t.Fatal("a shown number guessed again")
	}
	must(t, s.Guess(0, 1, 5))
	must(t, s.Guess(1, 0, 2))
	must(t, s.Guess(0, 1, 6))
	if s.Status != Ended || s.Winner != 1 || !s.Players[1].Out {
		t.Fatalf("all of seat 1 turned up: %+v %d", s.Status, s.Winner)
	}
}

func TestTrailView(t *testing.T) {
	s := trailGame(t, 3)
	must(t, s.Guess(0, 1, 5))
	v := s.View(100) // seat 0
	if v.Hands[0].Nums[0] != 1 {
		t.Fatal("own numbers visible")
	}
	if v.Hands[1].Nums[0] != 0 || v.Hands[1].Nums[1] != 5 || v.Hands[2].Nums[2] != 0 {
		t.Fatalf("others hidden except shown: %v %v", v.Hands[1].Nums, v.Hands[2].Nums)
	}
	if s.Hands[1].Nums[0] != 4 {
		t.Fatal("View changed the stored state")
	}
	if w := s.View(0); w.Hands[0].Nums[0] != 0 {
		t.Fatal("watchers see nothing hidden")
	}
}

func TestTrailResignAndSteps(t *testing.T) {
	s := trailGame(t, 3)
	must(t, s.Resign(1))
	if !s.Players[1].Out || !s.Hands[1].Shown[2] || s.Status != Playing {
		t.Fatal("resign: out with numbers shown, game goes on")
	}
	must(t, s.Ask(0, 2, "odd", 0))
	if s.Turn != 2 {
		t.Fatalf("skips the player who is out: %d", s.Turn)
	}
	if err := s.Ask(2, 1, "odd", 0); !errors.Is(err, ErrBadMove) {
		t.Fatal("asking a player who is out")
	}
	// Step limit: most hidden numbers wins.
	s.Hands[0].Shown[0] = true
	for s.Status == Playing {
		target := 0
		if s.Turn == 0 {
			target = 2
		}
		must(t, s.Ask(s.Turn, target, "odd", 0))
	}
	if s.Result != "steps" || s.Winner != 3 {
		t.Fatalf("step limit: %s %d", s.Result, s.Winner)
	}
}
