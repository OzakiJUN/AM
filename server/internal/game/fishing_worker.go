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
			a := accounts[p.User]
			due := p.ExpiresAt
			if q := a.quality("auto"); q > 0 {
				ready := max(p.BiteAt, a.AutoAt)
				if ready <= p.ExpiresAt {
					due = ready
				}
			}
			if due < at {
				at, actor, target, steal = due, i, -1, false
			}
		}
		for i, p := range st.Pond.Seats {
			if p.User == 0 {
				continue
			}
			a := accounts[p.User]
			if a.quality("glove") == 0 {
				continue
			}
			for j, v := range st.Pond.Seats {
				if i == j || v.User == 0 {
					continue
				}
				due := max(v.BiteAt+int64(s.fishing.AutoStealDelay), a.StealAt)
				if due <= v.ExpiresAt && due < at {
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
			s.reward(a, p.User, at, true)
			if q := a.quality("auto"); q > 0 && at == max(p.BiteAt, a.AutoAt) && at <= p.ExpiresAt {
				a.AutoAt = at + int64(s.fishing.AutoCD[q-1])*1000
			}
			s.cast(p, a, at)
		}
		changed = true
	}
	st.Pond.CatchingUp = s.pondBacklog(st, accounts, now)
	return changed
}
func (s *Service) stealCatch(st *State, accounts map[int64]*FishingAccount, actor, target int, now int64) {
	p := &st.Pond.Seats[target]
	thief := accounts[st.Pond.Seats[actor].User]
	victim := accounts[p.User]
	quality := thief.quality("glove")
	thief.StealAt = now + int64(s.fishing.StealCD[quality-1])*1000
	if ward := victim.quality("ward"); ward > 0 && victim.WardAt <= now {
		victim.WardAt = now + int64(s.fishing.WardCD[ward-1])*1000
		block := max(0, s.fishing.WardBlock[ward-1]-s.fishing.GlovePierce[quality-1])
		if s.rnd.Intn(100) < block {
			thief.Last = "结界挡住了手套"
			victim.Last = "结界挡住一次偷鱼"
			return
		}
	}
	if s.rnd.Intn(100) >= s.fishing.StealChance[quality-1] {
		thief.Last = "手套失手了"
		return
	}
	s.reward(thief, p.User, now, false)
	thief.Last = "偷鱼成功！" + thief.Last
	victim.Last = "钩上的收获被偷走了"
	s.cast(p, victim, now)
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
		a := accounts[p.User]
		due := p.ExpiresAt
		if q := a.quality("auto"); q > 0 {
			ready := max(p.BiteAt, a.AutoAt)
			if ready <= p.ExpiresAt {
				due = ready
			}
		}
		if due <= now {
			return true
		}
		if a.quality("glove") > 0 {
			for j, v := range st.Pond.Seats {
				if i == j || v.User == 0 {
					continue
				}
				due := max(v.BiteAt+int64(s.fishing.AutoStealDelay), a.StealAt)
				if due <= v.ExpiresAt && due <= now {
					return true
				}
			}
		}
	}
	return false
}
