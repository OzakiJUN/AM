package game

// 数字迷踪 (trail): our own deduction game (docs/design.md §13 小游戏).
// Every player is dealt TrailHand different numbers from 1..TrailMax, face
// down and in random order. On your turn you either ask one player a yes /
// no question about their hidden numbers (the server answers truthfully),
// or guess one of their numbers: right, and that number is turned up; wrong,
// and you give away whether one of your own hidden numbers is odd or even.
// A player whose numbers are all turned up is out; the last one in wins.
// After TrailMaxSteps actions the one with the most hidden numbers wins.

import "math/rand"

const (
	Trail         = "trail"
	TrailMax      = 20
	TrailHand     = 3
	TrailMaxSteps = 90
)

// Hand is one player's numbers (secret except Shown ones, see View).
type Hand struct {
	Nums []int `json:"nums"`
	// Shown: guessed by someone, face up for everyone.
	Shown []bool `json:"shown"`
	// Hinted: its parity was given away after a wrong guess.
	Hinted []bool `json:"hinted"`
}

func (h Hand) hidden() []int {
	var out []int
	for i, n := range h.Nums {
		if !h.Shown[i] {
			out = append(out, n)
		}
	}
	return out
}

// Step is one action, public: a question and its answer, or a guess.
type Step struct {
	Seat   int    `json:"seat"`
	Target int    `json:"target"`
	Kind   string `json:"kind"` // ask | guess
	Q      string `json:"q,omitempty"`
	X      int    `json:"x"`
	Yes    bool   `json:"yes"`
	// After a wrong guess: which of the guesser's cards had its parity given away (-1 = none left).
	Hint int  `json:"hint"`
	Odd  bool `json:"odd,omitempty"`
}

// Questions a player may ask about another player's hidden numbers.
var TrailQuestions = map[string][2]int{
	"gt":   {1, TrailMax - 1}, // 有没有比 X 大的
	"lt":   {2, TrailMax},     // 有没有比 X 小的
	"mult": {2, 6},            // 有没有 X 的倍数
	"odd":  {0, 0},            // 有没有单数
	"even": {0, 0},            // 有没有双数
}

// Answer reports whether a set of numbers satisfies a question.
func Answer(nums []int, q string, x int) bool {
	for _, n := range nums {
		switch {
		case q == "gt" && n > x, q == "lt" && n < x, q == "mult" && n%x == 0,
			q == "odd" && n%2 == 1, q == "even" && n%2 == 0:
			return true
		}
	}
	return false
}

func (s *State) startTrail(r *rand.Rand) {
	deck := r.Perm(TrailMax)
	s.Hands = make([]Hand, len(s.Players))
	for i := range s.Players {
		h := Hand{Shown: make([]bool, TrailHand), Hinted: make([]bool, TrailHand)}
		for k := 0; k < TrailHand; k++ {
			h.Nums = append(h.Nums, deck[i*TrailHand+k]+1)
		}
		s.Hands[i] = h
	}
	s.Turn = 0
}

func (s *State) trailTurn(seat, target int) error {
	if s.Status != Playing || s.Kind != Trail {
		return ErrGameState
	}
	if seat != s.Turn {
		return ErrNotTurn
	}
	if target < 0 || target >= len(s.Players) || target == seat || s.Players[target].Out {
		return ErrBadMove
	}
	return nil
}

// Ask: seat asks target one question; the answer is about target's hidden numbers.
func (s *State) Ask(seat, target int, q string, x int) error {
	if err := s.trailTurn(seat, target); err != nil {
		return err
	}
	r, ok := TrailQuestions[q]
	if !ok || (r != [2]int{0, 0} && (x < r[0] || x > r[1])) {
		return ErrBadMove
	}
	if r == [2]int{0, 0} {
		x = 0
	}
	s.Steps = append(s.Steps, Step{Seat: seat, Target: target, Kind: "ask", Q: q, X: x, Yes: Answer(s.Hands[target].hidden(), q, x), Hint: -1})
	s.trailNext()
	return nil
}

// Guess: seat names one of target's numbers.
func (s *State) Guess(seat, target, x int) error {
	if err := s.trailTurn(seat, target); err != nil {
		return err
	}
	if x < 1 || x > TrailMax {
		return ErrBadMove
	}
	st := Step{Seat: seat, Target: target, Kind: "guess", X: x, Hint: -1}
	h := &s.Hands[target]
	for i, n := range h.Nums {
		if n == x && !h.Shown[i] {
			h.Shown[i] = true
			st.Yes = true
		}
	}
	if st.Yes {
		if len(h.hidden()) == 0 {
			s.Players[target].Out = true
		}
	} else {
		mine := &s.Hands[seat]
		for i := range mine.Nums {
			if !mine.Shown[i] && !mine.Hinted[i] {
				mine.Hinted[i] = true
				st.Hint, st.Odd = i, mine.Nums[i]%2 == 1
				break
			}
		}
	}
	s.Steps = append(s.Steps, st)
	s.trailNext()
	return nil
}

// trailNext ends the game or passes the turn to the next player still in.
func (s *State) trailNext() {
	in := 0
	last := -1
	for i, p := range s.Players {
		if !p.Out {
			in++
			last = i
		}
	}
	if in <= 1 {
		s.end(last+1, "")
		return
	}
	if len(s.Steps) >= TrailMaxSteps {
		best, top, tie := -1, -1, false
		for i, p := range s.Players {
			if p.Out {
				continue
			}
			n := len(s.Hands[i].hidden())
			switch {
			case n > top:
				best, top, tie = i, n, false
			case n == top:
				tie = true
			}
		}
		if tie {
			s.end(-1, "steps")
		} else {
			s.end(best+1, "steps")
		}
		return
	}
	n := len(s.Players)
	for k := 1; k <= n; k++ {
		if i := (s.Turn + k) % n; !s.Players[i].Out {
			s.Turn = i
			return
		}
	}
}

// trailLeave: a player resigns: their numbers are turned up and they are out.
func (s *State) trailLeave(seat int) {
	h := &s.Hands[seat]
	for i := range h.Shown {
		h.Shown[i] = true
	}
	s.Players[seat].Out = true
	if s.Turn == seat {
		s.trailNext()
		return
	}
	in, last := 0, -1
	for i, p := range s.Players {
		if !p.Out {
			in++
			last = i
		}
	}
	if in <= 1 {
		s.end(last+1, "")
	}
}

// hideHands keeps only what viewer may see: their own numbers, face-up ones.
func (v *State) hideHands(viewer int64) {
	if v.Status == Ended {
		return
	}
	hands := make([]Hand, len(v.Hands))
	for i, h := range v.Hands {
		c := Hand{Nums: append([]int(nil), h.Nums...), Shown: h.Shown, Hinted: h.Hinted}
		if i >= len(v.Players) || v.Players[i].ID != viewer {
			for k := range c.Nums {
				if !h.Shown[k] {
					c.Nums[k] = 0
				}
			}
		}
		hands[i] = c
	}
	v.Hands = hands
}
