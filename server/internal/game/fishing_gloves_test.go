package game

import (
	"encoding/json"
	"math/rand"
	"reflect"
	"testing"
)

func gloveFixture() (*Service, *State, map[int64]*FishingAccount) {
	r := DefaultFishingRules()
	for i := range r.StealChance {
		r.StealChance[i] = 100
	}
	s := &Service{fishing: r, rnd: rand.New(rand.NewSource(42))}
	a, b := r.newAccount(), r.newAccount()
	b.Fish = []CaughtFish{{ID: "fish-1", Species: "f001", Length: 53.16, Value: 12345, By: "2", OwnerKey: b.Identity, At: 1000}}
	b.Records["f001:max"] = b.Fish[0]
	st := &State{Kind: Fishing, Status: Playing, Pond: &Pond{}}
	st.Pond.Seats[0] = Angler{User: 1, BiteAt: 9999999}
	st.Pond.Seats[1] = Angler{User: 2, BiteAt: 9999999}
	return s, st, map[int64]*FishingAccount{1: a, 2: b}
}
func TestFishingGloveVariants(t *testing.T) {
	for _, tc := range []struct {
		name  string
		gear  []string
		count int
		cd    int64
		bonus int
	}{
		{"base", []string{"glove_value"}, 1, 120000, 150},
		{"quantity", []string{"glove"}, 5, 120000, 0},
		{"haste", []string{"glove_haste"}, 1, 24000, 0},
		{"combination", []string{"glove", "glove_haste"}, 5, 24000, 0},
		{"quantity and value", []string{"glove", "glove_value"}, 5, 120000, 150},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, st, as := gloveFixture()
			a, b := as[1], as[2]
			for _, k := range tc.gear {
				a.Tools[k] = 5
			}
			a.Equipped = tc.gear
			for i := 2; i <= 7; i++ {
				f := b.Fish[0]
				f.ID = string(rune('a' + i))
				b.Fish = append(b.Fish, f)
			}
			s.stealCatch(st, as, 0, 1, 5000)
			if len(a.Fish) != tc.count || len(b.Fish) != 7-tc.count || a.StealAt != 5000+tc.cd {
				t.Fatalf("count/cooldown %d %d %d", len(a.Fish), len(b.Fish), a.StealAt)
			}
			seen := map[string]bool{}
			for _, f := range append(append([]CaughtFish{}, a.Fish...), b.Fish...) {
				if seen[f.ID] {
					t.Fatal("duplicated specimen")
				}
				seen[f.ID] = true
			}
			if len(a.Records) != 0 || len(b.Records) != 1 {
				t.Fatal("theft changed catch records")
			}
			for _, f := range a.Fish {
				if f.StealBonus != tc.bonus || f.By != "2" || f.OwnerKey != b.Identity || f.AcquiredAt != 5000 || f.BaseValue != 12345 || f.Value != (12345*Money(100+tc.bonus)+50)/100 {
					t.Fatal("provenance or rounded price lost")
				}
			}
			// Equipping a different glove cannot reset the account-wide cooldown.
			before := len(a.Fish)
			a.Tools["glove_haste"] = 5
			a.Equipped = []string{"glove_haste"}
			s.stealCatch(st, as, 0, 1, 5001)
			if len(a.Fish) != before || a.StealAt != 5000+tc.cd {
				t.Fatal("gear swap bypassed cooldown")
			}
		})
	}
}
func TestFishingTheftCapacityAndFailures(t *testing.T) {
	for _, tc := range []struct {
		name           string
		capacity, fish int
		block, miss    bool
		want           int
		cd             bool
	}{
		{"fewer fish", 10, 1, false, false, 1, true},
		{"one free slot", 1, 5, false, false, 1, true},
		{"full", 0, 5, false, false, 0, false},
		{"empty", 10, 0, false, false, 0, false},
		{"ward", 10, 5, true, false, 0, true},
		{"miss", 10, 5, false, true, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, st, as := gloveFixture()
			a, b := as[1], as[2]
			a.Tools["glove"] = 5
			a.Equipped = []string{"glove"}
			s.fishing.InventoryLimit = tc.capacity
			f := b.Fish[0]
			b.Fish = nil
			for i := 0; i < tc.fish; i++ {
				f.ID = string(rune('a' + i))
				b.Fish = append(b.Fish, f)
			}
			if tc.block {
				b.Tools["ward"] = 5
				b.Equipped = []string{"ward"}
				s.fishing.WardBlock[4] = 100
				s.fishing.GlovePierce[4] = 0
			}
			if tc.miss {
				s.fishing.StealChance[4] = 0
			}
			s.stealCatch(st, as, 0, 1, 5000)
			if len(a.Fish) != tc.want || len(b.Fish) != tc.fish-tc.want || (a.StealAt > 5000) != tc.cd {
				t.Fatal("quantity, inventory or cooldown")
			}
			if tc.block && b.WardAt != 95000 {
				t.Fatal("ward cooldown not retained")
			}
		})
	}
}
func TestFishingStolenPriceDoesNotCompound(t *testing.T) {
	s, st, as := gloveFixture()
	a, b := as[1], as[2]
	a.Tools["glove_value"] = 5
	a.Equipped = []string{"glove_value"}
	s.stealCatch(st, as, 0, 1, 5000)
	first := a.Fish[0]
	if first.Value != 30863 {
		t.Fatal("two-decimal price")
	}
	b.Tools["glove_value"] = 1
	b.Equipped = []string{"glove_value"}
	s.stealCatch(st, as, 1, 0, 8000)
	back := b.Fish[0]
	if back.ID != first.ID || back.Value != 14197 || back.BaseValue != 12345 || back.By != "2" {
		t.Fatal("retheft multiplied the sale bonus")
	}
	if !selfCaught(b, back, 2) || len(b.Records) != 1 {
		t.Fatal("original provenance or records changed after return")
	}
}
func TestFishingInventoryTheftOfflineMatchesLive(t *testing.T) {
	s, st, as := gloveFixture()
	for _, a := range as {
		a.Tools["glove_haste"] = 5
		a.Equipped = []string{"glove_haste"}
	}
	encoded, _ := json.Marshal(struct {
		State    *State
		Accounts map[int64]*FishingAccount
	}{st, as})
	var live struct {
		State    *State
		Accounts map[int64]*FishingAccount
	}
	if err := json.Unmarshal(encoded, &live); err != nil {
		t.Fatal(err)
	}
	online := &Service{fishing: s.fishing, rnd: rand.New(rand.NewSource(42))}
	for at := int64(0); at <= 500000; at += 1000 {
		online.settlePond(live.State, live.Accounts, at)
	}
	s.fishing.CatchupBatch = 2
	for step := 0; step < 1000; step++ {
		s.settlePond(st, as, 500000)
		if !st.Pond.CatchingUp {
			break
		}
	}
	// Same fish, ownership, prices, cooldowns and event ordering after a restart-sized batch.
	if !reflect.DeepEqual(as, live.Accounts) || !reflect.DeepEqual(st, live.State) {
		t.Fatal("offline theft differs from chronological ticks")
	}
	n := as[1].StealAt + as[2].StealAt
	s.settlePond(st, as, 500000)
	if as[1].StealAt+as[2].StealAt != n || len(as[1].Fish)+len(as[2].Fish) != 1 {
		t.Fatal("offline replay duplicated fish")
	}
	as[1].StealAt = 700000
	if due, ok := s.nextTheft(st, as, 0, 1); ok && due < 700000 {
		t.Fatal("equipped glove acted in the past")
	}
}
func TestFishingGloveRulesMigration(t *testing.T) {
	r := DefaultFishingRules()
	r.StealBaseCD = 0
	r.StealCount = nil
	r.StealReduction = nil
	r.StealValue = nil
	if r.validate() != nil || r.StealBaseCD != 120 || r.StealCount[4] != 5 || r.StealReduction[4] != 80 {
		t.Fatal("old rules failed to inherit glove defaults")
	}
	r.StealReduction[4] = 100
	if r.validate() == nil {
		t.Fatal("zero cooldown configuration accepted")
	}
}

func TestFishingFutureTimestampCannotStallCatchup(t *testing.T) {
	s, st, as := gloveFixture()
	a, b := as[1], as[2]
	a.Tools["glove"] = 1
	a.Equipped = []string{"glove"}
	b.Fish[0].At = 1<<63 - 1
	b.Fish[0].AcquiredAt = 1<<63 - 1
	if s.settlePond(st, as, 5000) || st.Pond.CatchingUp {
		t.Fatal("future fish caused a non-progressing theft loop")
	}
}
