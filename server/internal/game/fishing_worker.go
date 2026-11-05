package game

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/OzakiJUN/am/server/internal/store"
)

// Chronological settlement gives identical ordering to live ticks and catch-up.
// A batch limit only bounds transaction time; the next tick continues the queue.
func (s *Service) settlePond(st *State, accounts map[int64]*FishingAccount, now int64) bool {
	changed := false
	for step := 0; step < s.fishing.CatchupBatch; step++ {
		at := now + 1
		actor, target := -1, -1
		steal := false
		for i, p := range st.Pond.Seats {
			if p.User == 0 {
				continue
			}
			due := max(p.BiteAt, st.Pond.SettledAt)
			if due < at {
				at, actor, target, steal = due, i, -1, false
			}
		}
		for i := range st.Pond.Seats {
			for j := range st.Pond.Seats {
				if due, ok := s.nextTheft(st, accounts, i, j); ok && due < at {
					at, actor, target, steal = due, i, j, true
				}
			}
		}
		if actor < 0 || at > now {
			break
		}
		p := &st.Pond.Seats[actor]
		a := accounts[p.User]
		if steal {
			s.stealCatch(st, accounts, actor, target, at)
		} else {
			s.landCatch(a, p.User, at)
			s.cast(p, a, at)
		}
		st.Pond.SettledAt = at
		changed = true
	}
	st.Pond.CatchingUp = s.pondBacklog(st, accounts, now)
	return changed
}

// RunFishing owns the server timer. CloseFishing joins it before the database closes.
func (s *Service) RunFishing() {
	ctx, cancel := context.WithCancel(context.Background())
	s.fishingCancel = cancel
	s.fishingDone = make(chan struct{})
	go func() {
		defer close(s.fishingDone)
		timer := time.NewTicker(time.Duration(s.fishing.WorkerMS) * time.Millisecond)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				games, err := s.st.ActiveFishingGames(ctx)
				if err != nil {
					continue
				}
				sort.Slice(games, func(i, j int) bool { return games[i].ID < games[j].ID })
				for _, g := range games {
					if ctx.Err() != nil {
						return
					}
					var st State
					if json.Unmarshal([]byte(g.State), &st) != nil {
						continue
					}
					_, _ = s.pondChange(ctx, &store.User{}, g.ID, "refresh", 0)
				}
			}
		}
	}()
}
func (s *Service) CloseFishing() {
	if s.fishingCancel != nil {
		s.fishingCancel()
		<-s.fishingDone
	}
}

func (s *Service) pondBacklog(st *State, accounts map[int64]*FishingAccount, now int64) bool {
	for i, p := range st.Pond.Seats {
		if p.User == 0 {
			continue
		}
		if p.BiteAt <= now {
			return true
		}
		for j := range st.Pond.Seats {
			if due, ok := s.nextTheft(st, accounts, i, j); ok && due <= now {
				return true
			}
		}
	}
	return false
}
