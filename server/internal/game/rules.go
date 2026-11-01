// Package game runs the small board games played in channels and shared AI
// rooms (docs/design.md §13 小游戏): 五子棋 (gomoku), 黑白棋 (reversi),
// 谁是卧底 (undercover) and 数字迷踪 (trail, trail.go). People and AIs are players alike. The server holds
// the state and checks every move; this file is the pure rules (no I/O,
// randomness passed in) and is unit-tested.
package game

import (
	"math/rand"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/OzakiJUN/am/server/internal/apperr"
)

const (
	Gomoku     = "gomoku"
	Reversi    = "reversi"
	Undercover = "undercover"

	Waiting = "waiting"
	Playing = "playing"
	Ended   = "ended"

	// MaxRounds of 谁是卧底 before the undercover side wins by holding out.
	MaxRounds = 8
	// MaxSay is the longest description in 谁是卧底 (characters).
	MaxSay = 60
)

var (
	ErrBadMove   = apperr.New(http.StatusBadRequest, "game_bad_move", "this move is not allowed")
	ErrNotTurn   = apperr.New(http.StatusConflict, "not_your_turn", "it is not your turn")
	ErrGameState = apperr.New(http.StatusConflict, "game_state", "the game is not at that stage")
	ErrGameFull  = apperr.New(http.StatusConflict, "game_full", "the game has no free seat")
)

// Kinds lists the games, with their player counts.
var Kinds = map[string]struct{ Min, Max int }{
	Gomoku:     {2, 2},
	Reversi:    {2, 2},
	Undercover: {4, 8},
	Trail:      {2, 6},
}

// Player is one seat. Word and Spy are secret (see View).
type Player struct {
	ID   int64  `json:"id"`
	Out  bool   `json:"out,omitempty"`
	Word string `json:"word,omitempty"`
	Spy  bool   `json:"spy,omitempty"`
}

// Said is one description in 谁是卧底.
type Said struct {
	Seat  int    `json:"seat"`
	Round int    `json:"round"`
	Text  string `json:"text"`
}

// State is a whole game as stored. Board cells: 0 empty, 1 black (seat 0), 2 white (seat 1).
type State struct {
	Kind        string   `json:"kind"`
	Status      string   `json:"status"`
	Players     []Player `json:"players"`
	Applicants  []int64  `json:"applicants,omitempty"`
	AutoApprove bool     `json:"auto_approve,omitempty"`
	Size        int      `json:"size,omitempty"`
	Board       []int8   `json:"board,omitempty"`
	// Turn is the seat to move (-1 = nobody, e.g. while everyone votes).
	Turn  int   `json:"turn"`
	Moves int   `json:"moves,omitempty"`
	Last  []int `json:"last,omitempty"`
	// Winner: board games and 数字迷踪 seat+1 (-1 = draw); 谁是卧底 1 = civilians, 2 = undercover.
	Winner int    `json:"winner,omitempty"`
	Result string `json:"result,omitempty"`
	Phase  string `json:"phase,omitempty"` // 谁是卧底: describe / vote
	Round  int    `json:"round,omitempty"`
	Said   []Said `json:"said,omitempty"`
	// Votes[seat] = the seat voted for (-1 = not yet); kept secret until counted.
	Votes []int    `json:"votes,omitempty"`
	Words []string `json:"words,omitempty"` // [civilian, undercover], secret until the end
	// 数字迷踪: everyone's numbers (secret, see View) and every action.
	Hands []Hand   `json:"hands,omitempty"`
	Steps []Step   `json:"steps,omitempty"`
	Log   []string `json:"log,omitempty"`
}

// NewState makes a waiting game with the host in seat 0.
func NewState(kind string, host int64, autoApprove bool) (*State, error) {
	if _, ok := Kinds[kind]; !ok {
		return nil, apperr.ErrBadRequest
	}
	return &State{Kind: kind, Status: Waiting, Players: []Player{{ID: host}}, AutoApprove: autoApprove, Turn: -1}, nil
}

// Seat of a user (-1 = not playing).
func (s *State) Seat(user int64) int {
	for i, p := range s.Players {
		if p.ID == user {
			return i
		}
	}
	return -1
}

func (s *State) Full() bool { return len(s.Players) >= Kinds[s.Kind].Max }

// TurnUser is the user who must act now (0 = nobody or several, like voting).
func (s *State) TurnUser() int64 {
	if s.Status != Playing || s.Turn < 0 || s.Turn >= len(s.Players) {
		return 0
	}
	return s.Players[s.Turn].ID
}

// Waiting on: everyone who still has to act (one seat, or all who have not voted).
func (s *State) Waiting() []int64 {
	if s.Status != Playing {
		return nil
	}
	if s.Kind == Undercover && s.Phase == "vote" {
		var out []int64
		for i, p := range s.Players {
			if !p.Out && s.Votes[i] < 0 {
				out = append(out, p.ID)
			}
		}
		return out
	}
	if u := s.TurnUser(); u != 0 {
		return []int64{u}
	}
	return nil
}

// Start begins a full enough game. pairs are 谁是卧底 word pairs.
func (s *State) Start(r *rand.Rand, pairs [][2]string) error {
	k := Kinds[s.Kind]
	if s.Status != Waiting {
		return ErrGameState
	}
	if len(s.Players) < k.Min {
		return ErrGameState
	}
	s.Status = Playing
	s.Applicants = nil
	switch s.Kind {
	case Gomoku:
		s.Size = 15
		s.Board = make([]int8, 15*15)
		s.Turn = 0
	case Reversi:
		s.Size = 8
		s.Board = make([]int8, 64)
		s.Board[3*8+3], s.Board[4*8+4] = 2, 2
		s.Board[3*8+4], s.Board[4*8+3] = 1, 1
		s.Turn = 0
	case Undercover:
		p := pairs[r.Intn(len(pairs))]
		civ, spy := p[0], p[1]
		if r.Intn(2) == 1 {
			civ, spy = spy, civ
		}
		s.Words = []string{civ, spy}
		n := len(s.Players)
		spies := 1
		if n >= 7 {
			spies = 2
		}
		for i := range s.Players {
			s.Players[i].Word = civ
		}
		for _, i := range r.Perm(n)[:spies] {
			s.Players[i].Spy = true
			s.Players[i].Word = spy
		}
		s.Round = 0
		s.nextRound()
	case Trail:
		s.startTrail(r)
	}
	return nil
}

func (s *State) end(winner int, result string) {
	s.Status = Ended
	s.Winner = winner
	s.Result = result
	s.Turn = -1
}

// ---- board games ----

var dirs = [8][2]int{{1, 0}, {0, 1}, {1, 1}, {1, -1}, {-1, 0}, {0, -1}, {-1, -1}, {-1, 1}}

func (s *State) at(x, y int) int8 {
	if x < 0 || y < 0 || x >= s.Size || y >= s.Size {
		return -1
	}
	return s.Board[y*s.Size+x]
}

// Move puts a stone for seat at (x, y) (gomoku / reversi).
func (s *State) Move(seat, x, y int) error {
	if s.Status != Playing || (s.Kind != Gomoku && s.Kind != Reversi) {
		return ErrGameState
	}
	if seat != s.Turn {
		return ErrNotTurn
	}
	if s.at(x, y) != 0 {
		return ErrBadMove
	}
	me := int8(seat + 1)
	if s.Kind == Reversi {
		flips := s.flips(x, y, me)
		if len(flips) == 0 {
			return ErrBadMove
		}
		for _, c := range flips {
			s.Board[c] = me
		}
	}
	s.Board[y*s.Size+x] = me
	s.Moves++
	s.Last = []int{x, y}
	if s.Kind == Gomoku {
		if s.five(x, y, me) {
			s.end(seat+1, "")
			return nil
		}
		if s.Moves == len(s.Board) {
			s.end(-1, "")
			return nil
		}
		s.Turn = 1 - seat
		return nil
	}
	other := 1 - seat
	switch {
	case len(s.Legal(other)) > 0:
		s.Turn = other
	case len(s.Legal(seat)) > 0:
		s.Log = append(s.Log, "pass")
	default:
		b, w := s.Count()
		switch {
		case b > w:
			s.end(1, "")
		case w > b:
			s.end(2, "")
		default:
			s.end(-1, "")
		}
	}
	return nil
}

func (s *State) five(x, y int, c int8) bool {
	for _, d := range dirs[:4] {
		n := 1
		for k := 1; s.at(x+d[0]*k, y+d[1]*k) == c; k++ {
			n++
		}
		for k := 1; s.at(x-d[0]*k, y-d[1]*k) == c; k++ {
			n++
		}
		if n >= 5 {
			return true
		}
	}
	return false
}

// flips: the cells a reversi stone at (x, y) would turn over.
func (s *State) flips(x, y int, me int8) []int {
	if s.at(x, y) != 0 {
		return nil
	}
	var out []int
	for _, d := range dirs {
		var line []int
		cx, cy := x+d[0], y+d[1]
		for s.at(cx, cy) == 3-me {
			line = append(line, cy*s.Size+cx)
			cx, cy = cx+d[0], cy+d[1]
		}
		if len(line) > 0 && s.at(cx, cy) == me {
			out = append(out, line...)
		}
	}
	return out
}

// Legal lists the reversi moves of a seat as [x, y].
func (s *State) Legal(seat int) [][2]int {
	if s.Kind != Reversi || s.Board == nil {
		return nil
	}
	var out [][2]int
	for y := 0; y < s.Size; y++ {
		for x := 0; x < s.Size; x++ {
			if len(s.flips(x, y, int8(seat+1))) > 0 {
				out = append(out, [2]int{x, y})
			}
		}
	}
	return out
}

// Count returns the black and white stones.
func (s *State) Count() (b, w int) {
	for _, c := range s.Board {
		switch c {
		case 1:
			b++
		case 2:
			w++
		}
	}
	return
}

// ---- 谁是卧底 ----

func (s *State) alive() (spies, civ int) {
	for _, p := range s.Players {
		if p.Out {
			continue
		}
		if p.Spy {
			spies++
		} else {
			civ++
		}
	}
	return
}

// nextSpeaker: the first seat after `from` that is in and has not spoken this round (-1 = none).
func (s *State) nextSpeaker(from int) int {
	spoke := map[int]bool{}
	for _, x := range s.Said {
		if x.Round == s.Round {
			spoke[x.Seat] = true
		}
	}
	n := len(s.Players)
	for k := 1; k <= n; k++ {
		i := (from + k) % n
		if !s.Players[i].Out && !spoke[i] {
			return i
		}
	}
	return -1
}

func (s *State) nextRound() {
	s.Round++
	if s.Round > MaxRounds {
		s.end(2, "rounds")
		return
	}
	s.Phase = "describe"
	s.Votes = nil
	s.Turn = s.nextSpeaker(-1)
}

// checkWin ends 谁是卧底 when one side has won.
func (s *State) checkWin() bool {
	spies, civ := s.alive()
	switch {
	case spies == 0:
		s.end(1, "")
	case spies >= civ:
		s.end(2, "")
	default:
		return false
	}
	return true
}

// Say is a seat's description in its turn; it may not contain its own word.
func (s *State) Say(seat int, text string) error {
	if s.Status != Playing || s.Kind != Undercover || s.Phase != "describe" {
		return ErrGameState
	}
	if seat != s.Turn {
		return ErrNotTurn
	}
	text = strings.Join(strings.Fields(text), " ")
	if text == "" || utf8.RuneCountInString(text) > MaxSay || strings.Contains(strings.ToLower(text), strings.ToLower(s.Players[seat].Word)) {
		return ErrBadMove
	}
	s.Said = append(s.Said, Said{Seat: seat, Round: s.Round, Text: text})
	s.afterSpeech(seat)
	return nil
}

func (s *State) afterSpeech(seat int) {
	if next := s.nextSpeaker(seat); next >= 0 {
		s.Turn = next
		return
	}
	s.Phase = "vote"
	s.Turn = -1
	s.Votes = make([]int, len(s.Players))
	for i := range s.Votes {
		s.Votes[i] = -1
	}
}

// Vote: seat votes another seat out; counted when everyone still in has voted.
func (s *State) Vote(seat, target int) error {
	if s.Status != Playing || s.Kind != Undercover || s.Phase != "vote" {
		return ErrGameState
	}
	if s.Players[seat].Out || s.Votes[seat] >= 0 {
		return ErrNotTurn
	}
	if target < 0 || target >= len(s.Players) || target == seat || s.Players[target].Out {
		return ErrBadMove
	}
	s.Votes[seat] = target
	s.count()
	return nil
}

// count tallies the votes once everyone still in has voted.
func (s *State) count() {
	tally := map[int]int{}
	for i, p := range s.Players {
		if p.Out {
			continue
		}
		if s.Votes[i] < 0 {
			return
		}
		tally[s.Votes[i]]++
	}
	best, top, tie := -1, 0, false
	for t, n := range tally {
		switch {
		case n > top:
			best, top, tie = t, n, false
		case n == top:
			tie = true
		}
	}
	if tie || best < 0 {
		s.Log = append(s.Log, "tie")
	} else {
		s.Players[best].Out = true
		s.Log = append(s.Log, "out:"+itoa(best))
		if s.checkWin() {
			return
		}
	}
	s.nextRound()
}

// Resign: a 2-player game is lost; in 谁是卧底 the seat is out.
func (s *State) Resign(seat int) error {
	if s.Status != Playing {
		return ErrGameState
	}
	if s.Kind == Trail {
		if s.Players[seat].Out {
			return ErrGameState
		}
		s.trailLeave(seat)
		return nil
	}
	if s.Kind != Undercover {
		s.end(2-seat, "resign")
		return nil
	}
	if s.Players[seat].Out {
		return ErrGameState
	}
	s.Players[seat].Out = true
	s.Log = append(s.Log, "left:"+itoa(seat))
	if s.checkWin() {
		return nil
	}
	if s.Phase == "describe" && s.Turn == seat {
		s.afterSpeech(seat)
	} else if s.Phase == "vote" {
		// Votes for the leaver no longer count.
		for i, t := range s.Votes {
			if t == seat {
				s.Votes[i] = -1
			}
		}
		s.count()
	}
	return nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

// View is the state as a viewer may see it: secret words and roles only
// for oneself, others' roles once they are out, everything at the end;
// votes only after they are counted (who has voted is shown as -2).
func (s *State) View(viewer int64) *State {
	v := *s
	v.Players = append([]Player(nil), s.Players...)
	v.Applicants = append([]int64(nil), s.Applicants...)
	if s.Kind == Trail {
		v.hideHands(viewer)
		return &v
	}
	if s.Kind != Undercover || s.Status == Ended {
		return &v
	}
	v.Words = nil
	for i := range v.Players {
		p := &v.Players[i]
		if p.ID == viewer {
			p.Spy = false // the word, not the role (players don't know which side they are on)
			continue
		}
		if !p.Out {
			p.Spy = false
		}
		p.Word = ""
	}
	if s.Votes != nil {
		v.Votes = make([]int, len(s.Votes))
		for i, t := range s.Votes {
			v.Votes[i] = -1
			if t >= 0 {
				v.Votes[i] = -2
			}
		}
	}
	return &v
}
