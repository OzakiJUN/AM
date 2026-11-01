package game

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand"
	"net/http"
	"sync"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/push"
	"github.com/OzakiJUN/am/server/internal/store"
)

var ErrGameLimit = apperr.New(http.StatusForbidden, "game_limit", "this conversation already has the most games allowed")

// Ended games stay in the live list this long (so everyone sees the
// result); after that they are in the game history (History) until the
// janitor deletes them (retention.games_days).
const ShowEnded = 6 * time.Hour

type Service struct {
	st   *store.Store
	ids  *idgen.Generator
	push push.Pusher
	max  int

	mu  sync.Mutex
	rnd *rand.Rand
}

// New: max = games open or running at once per conversation (0 = games off).
func New(st *store.Store, ids *idgen.Generator, p push.Pusher, max int) *Service {
	return &Service{st: st, ids: ids, push: p, max: max, rnd: rand.New(rand.NewSource(time.Now().UnixNano()))}
}

func load(g *store.Game) (*State, error) {
	var s State
	if err := json.Unmarshal([]byte(g.State), &s); err != nil {
		return nil, err
	}
	return &s, nil
}

// view is the game as `viewer` sees it.
func view(g *store.Game, s *State, viewer int64) *amv1.Game {
	v := s.View(viewer)
	out := &amv1.Game{
		Id: g.ID, ConvId: g.ConvID, Kind: g.Kind, HostId: g.HostID, Status: s.Status,
		Applicants: v.Applicants, AutoApprove: s.AutoApprove, WaitingOn: s.Waiting(),
		CreatedAt: g.CreatedAt, UpdatedAt: g.UpdatedAt,
	}
	for _, p := range v.Players {
		out.Players = append(out.Players, &amv1.GamePlayer{UserId: p.ID, Out: p.Out, Spy: p.Spy, Word: p.Word})
	}
	// The board / speech part; players and applicants are in their own fields.
	pub := *v
	pub.Players, pub.Applicants = nil, nil
	if s.Kind == Reversi && s.Status == Playing {
		legal := s.Legal(s.Turn)
		b, _ := json.Marshal(struct {
			*State
			Legal [][2]int `json:"legal"`
		}{&pub, legal})
		out.StateJson = string(b)
		return out
	}
	b, _ := json.Marshal(&pub)
	out.StateJson = string(b)
	return out
}

// member checks that me is in the conversation (and it still exists).
func member(ctx context.Context, q *store.Queries, convID, me int64) error {
	c, err := q.GetConv(ctx, convID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && c.Dissolved) {
		return apperr.ErrNotMember
	}
	if err != nil {
		return err
	}
	if _, err := q.GetMember(ctx, convID, me); errors.Is(err, store.ErrNotFound) {
		return apperr.ErrNotMember
	} else if err != nil {
		return err
	}
	return nil
}

// broadcast sends everyone in the conversation their own view.
func (s *Service) broadcast(ctx context.Context, g *store.Game, st *State) {
	ids, err := s.st.MemberIDs(ctx, []int64{g.ConvID})
	if err != nil {
		return
	}
	var others []int64
	for _, u := range ids[g.ConvID] {
		if st.Seat(u) >= 0 && st.Kind == Undercover {
			s.push.ToUsers([]int64{u}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_Game{Game: view(g, st, u)}}, 0)
			continue
		}
		others = append(others, u)
	}
	if len(others) > 0 {
		s.push.ToUsers(others, &amv1.ServerFrame{Msg: &amv1.ServerFrame_Game{Game: view(g, st, 0)}}, 0)
	}
}

// Open starts a waiting game in a conversation, with me in the first seat.
func (s *Service) Open(ctx context.Context, me *store.User, convID int64, kind string, autoApprove bool) (*amv1.Game, error) {
	st, err := NewState(kind, me.ID, autoApprove)
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	b, _ := json.Marshal(st)
	g := &store.Game{ID: s.ids.Next(), ConvID: convID, Kind: kind, HostID: me.ID, Status: st.Status, State: string(b), CreatedAt: now, UpdatedAt: now}
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		if err := member(ctx, q, convID, me.ID); err != nil {
			return err
		}
		n, err := q.CountActiveGames(ctx, convID)
		if err != nil {
			return err
		}
		if n >= s.max {
			return ErrGameLimit
		}
		return q.CreateGame(ctx, g)
	})
	if err != nil {
		return nil, err
	}
	s.broadcast(ctx, g, st)
	return view(g, st, me.ID), nil
}

// History: a conversation's finished games, newest first, before `before` (ms; 0 = now).
func (s *Service) History(ctx context.Context, me *store.User, convID, before int64) (*amv1.ListGamesResponse, error) {
	if err := member(ctx, s.st.Queries, convID, me.ID); err != nil {
		return nil, err
	}
	if before <= 0 {
		before = time.Now().UnixMilli() + 1
	}
	list, err := s.st.EndedGames(ctx, convID, before, 30)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListGamesResponse{}
	for _, g := range list {
		if st, err := load(g); err == nil {
			out.Games = append(out.Games, view(g, st, me.ID))
		}
	}
	return out, nil
}

// Rematch: a player of a finished game opens the same game again with the
// same players already seated (two-player games swap colours). Players
// who left the conversation are not seated again.
func (s *Service) Rematch(ctx context.Context, me *store.User, id int64) (*amv1.Game, error) {
	var g *store.Game
	var st *State
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		old, err := q.GetGame(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := member(ctx, q, old.ConvID, me.ID); err != nil {
			return err
		}
		prev, err := load(old)
		if err != nil {
			return err
		}
		if prev.Status != Ended {
			return ErrGameState
		}
		if prev.Seat(me.ID) < 0 {
			return apperr.ErrNoPermission
		}
		n, err := q.CountActiveGames(ctx, old.ConvID)
		if err != nil {
			return err
		}
		if n >= s.max {
			return ErrGameLimit
		}
		ids := make([]int64, 0, len(prev.Players))
		for _, p := range prev.Players {
			ids = append(ids, p.ID)
		}
		if len(ids) == 2 {
			ids[0], ids[1] = ids[1], ids[0]
		}
		st, _ = NewState(old.Kind, me.ID, prev.AutoApprove)
		st.Players = nil
		for _, u := range ids {
			if member(ctx, q, old.ConvID, u) == nil {
				st.Players = append(st.Players, Player{ID: u})
			}
		}
		now := time.Now().UnixMilli()
		b, _ := json.Marshal(st)
		g = &store.Game{ID: s.ids.Next(), ConvID: old.ConvID, Kind: old.Kind, HostID: me.ID, Status: st.Status, State: string(b), CreatedAt: now, UpdatedAt: now}
		return q.CreateGame(ctx, g)
	})
	if err != nil {
		return nil, err
	}
	s.broadcast(ctx, g, st)
	return view(g, st, me.ID), nil
}

// List: a conversation's open and running games, and those that ended lately.
func (s *Service) List(ctx context.Context, me *store.User, convID int64) (*amv1.ListGamesResponse, error) {
	if err := member(ctx, s.st.Queries, convID, me.ID); err != nil {
		return nil, err
	}
	list, err := s.st.ListGames(ctx, convID, time.Now().Add(-ShowEnded).UnixMilli())
	if err != nil {
		return nil, err
	}
	out := &amv1.ListGamesResponse{}
	for _, g := range list {
		st, err := load(g)
		if err != nil {
			continue
		}
		out.Games = append(out.Games, view(g, st, me.ID))
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, me *store.User, id int64) (*amv1.Game, error) {
	g, err := s.st.GetGame(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := member(ctx, s.st.Queries, g.ConvID, me.ID); err != nil {
		return nil, err
	}
	st, err := load(g)
	if err != nil {
		return nil, err
	}
	return view(g, st, me.ID), nil
}

// change runs fn on the locked game of a conversation me is in, saves and pushes it.
func (s *Service) change(ctx context.Context, me *store.User, id int64, fn func(q *store.Queries, g *store.Game, st *State) error) (*amv1.Game, error) {
	var g *store.Game
	var st *State
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		var err error
		g, err = q.GetGameForUpdate(ctx, id)
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return err
		}
		if err := member(ctx, q, g.ConvID, me.ID); err != nil {
			return err
		}
		if st, err = load(g); err != nil {
			return err
		}
		if err := fn(q, g, st); err != nil {
			return err
		}
		b, _ := json.Marshal(st)
		g.State, g.Status, g.UpdatedAt = string(b), st.Status, time.Now().UnixMilli()
		return q.SaveGame(ctx, g)
	})
	if err != nil {
		return nil, err
	}
	s.broadcast(ctx, g, st)
	return view(g, st, me.ID), nil
}

func without(list []int64, id int64) []int64 {
	out := list[:0:0]
	for _, x := range list {
		if x != id {
			out = append(out, x)
		}
	}
	return out
}

// Join: take a seat (host, auto-approve) or ask the host for one.
func (s *Service) Join(ctx context.Context, me *store.User, id int64) (*amv1.Game, error) {
	return s.change(ctx, me, id, func(_ *store.Queries, g *store.Game, st *State) error {
		if st.Status != Waiting {
			return ErrGameState
		}
		if st.Seat(me.ID) >= 0 {
			return nil
		}
		if st.Full() {
			return ErrGameFull
		}
		if st.AutoApprove {
			st.Applicants = without(st.Applicants, me.ID)
			st.Players = append(st.Players, Player{ID: me.ID})
			return nil
		}
		for _, a := range st.Applicants {
			if a == me.ID {
				return nil
			}
		}
		st.Applicants = append(st.Applicants, me.ID)
		return nil
	})
}

// Decide: the host lets an applicant in (if there is still a seat and they are still here) or not.
func (s *Service) Decide(ctx context.Context, me *store.User, id, user int64, approve bool) (*amv1.Game, error) {
	return s.change(ctx, me, id, func(q *store.Queries, g *store.Game, st *State) error {
		if g.HostID != me.ID {
			return apperr.ErrNoPermission
		}
		found := false
		for _, a := range st.Applicants {
			found = found || a == user
		}
		if !found {
			return apperr.ErrNotFound
		}
		st.Applicants = without(st.Applicants, user)
		if !approve {
			return nil
		}
		if st.Status != Waiting {
			return ErrGameState
		}
		if st.Full() {
			return ErrGameFull
		}
		if err := member(ctx, q, g.ConvID, user); err != nil {
			return nil // they left the channel: just drop the request
		}
		st.Players = append(st.Players, Player{ID: user})
		return nil
	})
}

// SetAuto turns auto-approve on or off; turning it on lets waiting applicants in.
func (s *Service) SetAuto(ctx context.Context, me *store.User, id int64, on bool) (*amv1.Game, error) {
	return s.change(ctx, me, id, func(q *store.Queries, g *store.Game, st *State) error {
		if g.HostID != me.ID {
			return apperr.ErrNoPermission
		}
		st.AutoApprove = on
		if on && st.Status == Waiting {
			for _, a := range st.Applicants {
				if !st.Full() && member(ctx, q, g.ConvID, a) == nil {
					st.Players = append(st.Players, Player{ID: a})
				}
			}
			st.Applicants = nil
		}
		return nil
	})
}

// Start: the host begins the game once enough players sit.
func (s *Service) Start(ctx context.Context, me *store.User, id int64) (*amv1.Game, error) {
	return s.change(ctx, me, id, func(_ *store.Queries, g *store.Game, st *State) error {
		if g.HostID != me.ID {
			return apperr.ErrNoPermission
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		return st.Start(s.rnd, Pairs)
	})
}

// Act is a player's move: move (x, y), say (text), vote (target seat) or resign.
func (s *Service) Act(ctx context.Context, me *store.User, id int64, req *amv1.GameActRequest) (*amv1.Game, error) {
	return s.change(ctx, me, id, func(_ *store.Queries, _ *store.Game, st *State) error {
		seat := st.Seat(me.ID)
		if seat < 0 {
			return apperr.ErrNoPermission
		}
		switch req.GetAction() {
		case "move":
			return st.Move(seat, int(req.GetX()), int(req.GetY()))
		case "say":
			return st.Say(seat, req.GetText())
		case "vote":
			return st.Vote(seat, int(req.GetTarget()))
		case "resign":
			return st.Resign(seat)
		}
		return apperr.ErrBadRequest
	})
}

// Leave: before the start, give up my seat or request (the host leaving
// closes the game); while playing, it counts as resigning.
func (s *Service) Leave(ctx context.Context, me *store.User, id int64) (*amv1.Game, error) {
	return s.change(ctx, me, id, func(_ *store.Queries, g *store.Game, st *State) error {
		switch st.Status {
		case Waiting:
			if g.HostID == me.ID {
				st.end(0, "closed")
				return nil
			}
			st.Applicants = without(st.Applicants, me.ID)
			if i := st.Seat(me.ID); i >= 0 {
				st.Players = append(st.Players[:i], st.Players[i+1:]...)
			}
			return nil
		case Playing:
			if st.Seat(me.ID) < 0 {
				return apperr.ErrNoPermission
			}
			return st.Resign(st.Seat(me.ID))
		}
		return ErrGameState
	})
}

// End: the host stops the game (no winner).
func (s *Service) End(ctx context.Context, me *store.User, id int64) (*amv1.Game, error) {
	return s.change(ctx, me, id, func(_ *store.Queries, g *store.Game, st *State) error {
		if g.HostID != me.ID {
			return apperr.ErrNoPermission
		}
		if st.Status == Ended {
			return ErrGameState
		}
		st.end(0, "closed")
		return nil
	})
}
