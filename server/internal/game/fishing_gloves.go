package game

import "fmt"

func gloveKind(k string) bool { return k == "glove" || k == "glove_haste" || k == "glove_value" }
func (a *FishingAccount) gloveQuality() int {
	return max(a.quality("glove"), a.quality("glove_haste"), a.quality("glove_value"))
}
func (r *FishingRules) theftCooldown(a *FishingAccount) int64 {
	reduction := 0
	if q := a.quality("glove_haste"); q > 0 {
		reduction = r.StealReduction[q-1]
	}
	return int64(max(1, r.StealBaseCD*(100-reduction)/100)) * 1000
}
func fishAvailableAt(f CaughtFish) int64 { return max(f.At, f.AcquiredAt) }
func hasStealable(a *FishingAccount, at int64) bool {
	for _, f := range a.Fish {
		if fishAvailableAt(f) <= at {
			return true
		}
	}
	return false
}

// A shared persisted timeline prevents offline replay from stealing fish before
// they were caught/acquired or before either player joined this pond.
func (s *Service) nextTheft(st *State, accounts map[int64]*FishingAccount, actor, target int) (int64, bool) {
	p, v := st.Pond.Seats[actor], st.Pond.Seats[target]
	if actor == target || p.User == 0 || v.User == 0 {
		return 0, false
	}
	a, victim := accounts[p.User], accounts[v.User]
	if a.gloveQuality() == 0 || len(a.Fish) >= s.fishing.InventoryLimit || len(victim.Fish) == 0 {
		return 0, false
	}
	available := fishAvailableAt(victim.Fish[0])
	for _, f := range victim.Fish[1:] {
		available = min(available, fishAvailableAt(f))
	}
	delay := int64(s.fishing.AutoStealDelay)
	later := func(at int64) int64 {
		if at > (1<<63-1)-delay {
			return 1<<63 - 1
		}
		return at + delay
	}
	return max(st.Pond.SettledAt, a.StealAt, later(p.JoinedAt), later(v.JoinedAt), later(available)), true
}
func (s *Service) stealCatch(st *State, accounts map[int64]*FishingAccount, actor, target int, now int64) {
	thief, victim := accounts[st.Pond.Seats[actor].User], accounts[st.Pond.Seats[target].User]
	quality := thief.gloveQuality()
	if quality == 0 || thief.StealAt > now || len(thief.Fish) >= s.fishing.InventoryLimit || !hasStealable(victim, now) {
		return
	}
	thief.StealAt = now + s.fishing.theftCooldown(thief)
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
	count, bonus := 1, 0
	if q := thief.quality("glove"); q > 0 {
		count = s.fishing.StealCount[q-1]
	}
	if q := thief.quality("glove_value"); q > 0 {
		bonus = s.fishing.StealValue[q-1]
	}
	count = min(count, s.fishing.InventoryLimit-len(thief.Fish))
	taken := 0
	for taken < count {
		var eligible []int
		for i, f := range victim.Fish {
			if fishAvailableAt(f) <= now {
				eligible = append(eligible, i)
			}
		}
		if len(eligible) == 0 {
			break
		}
		i := eligible[s.rnd.Intn(len(eligible))]
		f := victim.Fish[i]
		victim.Fish = append(victim.Fish[:i], victim.Fish[i+1:]...)
		// Preserve specimen identity/provenance. Re-stealing never compounds value.
		if f.BaseValue == 0 {
			f.BaseValue = f.Value
		}
		f.Value = (f.BaseValue*Money(100+bonus) + 50) / 100
		f.StealBonus = bonus
		f.AcquiredAt = now
		thief.Fish = append(thief.Fish, f)
		taken++
	}
	thief.Last = fmt.Sprintf("偷鱼成功！从对方鱼篓拿走 %d 条鱼", taken)
	victim.Last = fmt.Sprintf("鱼篓里的 %d 条鱼被偷走了", taken)
}
