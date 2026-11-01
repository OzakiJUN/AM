package game

import (
	"errors"
	"math/rand"
	"testing"
)

func started(t *testing.T, kind string, n int) *State {
	t.Helper()
	s, err := NewState(kind, 100, false)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < n; i++ {
		s.Players = append(s.Players, Player{ID: int64(100 + i)})
	}
	if err := s.Start(rand.New(rand.NewSource(1)), [][2]string{{"苹果", "梨"}}); err != nil {
		t.Fatal(err)
	}
	return s
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestGomoku(t *testing.T) {
	s := started(t, Gomoku, 2)
	if err := s.Move(1, 7, 7); !errors.Is(err, ErrNotTurn) {
		t.Fatalf("white first: %v", err)
	}
	// Black plays a diagonal, white plays elsewhere.
	for i := 0; i < 4; i++ {
		must(t, s.Move(0, i, i))
		must(t, s.Move(1, i, 10))
	}
	if err := s.Move(0, 0, 0); !errors.Is(err, ErrBadMove) {
		t.Fatalf("occupied: %v", err)
	}
	must(t, s.Move(0, 4, 4))
	if s.Status != Ended || s.Winner != 1 {
		t.Fatalf("five in a row: %+v", s.Status)
	}
	if err := s.Move(1, 9, 9); !errors.Is(err, ErrGameState) {
		t.Fatalf("after the end: %v", err)
	}
}

func TestGomokuFiveFromBothSides(t *testing.T) {
	s := started(t, Gomoku, 2)
	for _, x := range []int{0, 1, 3, 4} {
		must(t, s.Move(0, x, 5))
		must(t, s.Move(1, x, 9))
	}
	must(t, s.Move(0, 2, 5)) // fills the gap: five
	if s.Winner != 1 {
		t.Fatal("gap filled should win")
	}
}

func TestReversi(t *testing.T) {
	s := started(t, Reversi, 2)
	if got := len(s.Legal(0)); got != 4 {
		t.Fatalf("opening moves: %d", got)
	}
	if err := s.Move(0, 0, 0); !errors.Is(err, ErrBadMove) {
		t.Fatalf("no flip: %v", err)
	}
	must(t, s.Move(0, 3, 2)) // flips (3,3)
	if b, w := s.Count(); b != 4 || w != 1 {
		t.Fatalf("count %d %d", b, w)
	}
	if s.Turn != 1 {
		t.Fatal("white's turn")
	}
}

func TestReversiPassAndEnd(t *testing.T) {
	// A tiny position: black can move, white then has no move but black still does -> pass.
	s := &State{Kind: Reversi, Status: Playing, Size: 8, Board: make([]int8, 64), Players: []Player{{ID: 1}, {ID: 2}}}
	// Row 0: B W _ ... ; black plays (2,0) and takes everything white has.
	s.Board[0], s.Board[1] = 1, 2
	must(t, s.Move(0, 2, 0))
	if s.Status != Ended || s.Winner != 1 {
		t.Fatalf("no moves left for anyone: %s %d", s.Status, s.Winner)
	}
}

func TestUndercover(t *testing.T) {
	s := started(t, Undercover, 4)
	spy := -1
	for i, p := range s.Players {
		if p.Spy {
			if spy >= 0 {
				t.Fatal("two spies with 4 players")
			}
			spy = i
		}
		if p.Word == "" {
			t.Fatal("no word")
		}
	}
	civ := s.Words[0]
	// Others don't see words or roles; I see my word only.
	v := s.View(s.Players[spy].ID)
	if v.Words != nil || v.Players[spy].Spy || v.Players[spy].Word != s.Words[1] || v.Players[(spy+1)%4].Word != "" {
		t.Fatalf("view leaks: %+v", v.Players)
	}
	if s.Phase != "describe" || s.Turn != 0 {
		t.Fatal("round 1 starts with seat 0")
	}
	if err := s.Say(1, "hi"); !errors.Is(err, ErrNotTurn) {
		t.Fatal(err)
	}
	if err := s.Say(0, "就是"+s.Players[0].Word+"啊"); !errors.Is(err, ErrBadMove) {
		t.Fatalf("saying the word: %v", err)
	}
	for i := 0; i < 4; i++ {
		must(t, s.Say(i, "一种水果"))
	}
	if s.Phase != "vote" {
		t.Fatal("vote after everyone spoke")
	}
	if err := s.Vote(0, 0); !errors.Is(err, ErrBadMove) {
		t.Fatal("self vote")
	}
	// Everyone votes the spy (the spy votes someone else).
	for i := 0; i < 4; i++ {
		target := spy
		if i == spy {
			target = (spy + 1) % 4
		}
		must(t, s.Vote(i, target))
		if i < 3 && s.View(0).Votes[i] != -2 {
			t.Fatal("votes stay secret until counted")
		}
	}
	if s.Status != Ended || s.Winner != 1 || !s.Players[spy].Out {
		t.Fatalf("civilians should win: %s %d", s.Status, s.Winner)
	}
	if s.View(0).Words[0] != civ {
		t.Fatal("words shown at the end")
	}
}

func TestUndercoverTieAndSpyWin(t *testing.T) {
	s := started(t, Undercover, 4)
	spy := 0
	for i, p := range s.Players {
		if p.Spy {
			spy = i
		}
	}
	civs := []int{}
	for i := range s.Players {
		if i != spy {
			civs = append(civs, i)
		}
	}
	say := func() {
		for s.Phase == "describe" {
			must(t, s.Say(s.Turn, "嗯"))
		}
	}
	say()
	// 2 votes for civs[0], 2 for civs[1]: a tie, nobody out, round 2.
	must(t, s.Vote(spy, civs[0]))
	must(t, s.Vote(civs[1], civs[0]))
	must(t, s.Vote(civs[0], civs[1]))
	must(t, s.Vote(civs[2], civs[1]))
	if s.Round != 2 || s.Phase != "describe" {
		t.Fatalf("tie -> next round: %d %s", s.Round, s.Phase)
	}
	say()
	// Vote a civilian out: 1 spy vs 2 civilians, go on.
	must(t, s.Vote(spy, civs[0]))
	must(t, s.Vote(civs[1], civs[0]))
	must(t, s.Vote(civs[2], civs[0]))
	must(t, s.Vote(civs[0], civs[1]))
	if s.Status != Playing || !s.Players[civs[0]].Out {
		t.Fatal("one civilian out")
	}
	if !s.View(0).Players[civs[0]].Out {
		t.Fatal("out shown")
	}
	// A civilian leaves: 1 vs 1, the undercover wins.
	must(t, s.Resign(civs[1]))
	if s.Status != Ended || s.Winner != 2 {
		t.Fatalf("spy should win: %s %d", s.Status, s.Winner)
	}
}

func TestResignBoard(t *testing.T) {
	s := started(t, Gomoku, 2)
	must(t, s.Resign(0))
	if s.Winner != 2 || s.Result != "resign" {
		t.Fatal("white wins when black resigns")
	}
}

func TestStartNeedsPlayers(t *testing.T) {
	s, _ := NewState(Undercover, 1, false)
	s.Players = append(s.Players, Player{ID: 2}, Player{ID: 3})
	if err := s.Start(rand.New(rand.NewSource(1)), [][2]string{{"a", "b"}}); !errors.Is(err, ErrGameState) {
		t.Fatal("3 players is too few")
	}
	if _, err := NewState("chess", 1, false); err == nil {
		t.Fatal("unknown kind")
	}
}
