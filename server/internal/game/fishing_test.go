package game

import (
	"encoding/json"
	"math/rand"
	"testing"

	"github.com/OzakiJUN/am/server/internal/idgen"
)

func TestFishingCatalogueAndBalance(t *testing.T) {
	r := DefaultFishingRules()
	if err := r.validate(); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, f := range r.Catalog {
		if names[f.Name] {
			t.Fatal("duplicate species")
		}
		names[f.Name] = true
	}
	if len(names) != 100 {
		t.Fatal("not 100 species")
	}
	bad := DefaultFishingRules()
	bad.FishWeights = []int{0, 0, 0, 0, 0}
	if bad.validate() == nil {
		t.Fatal("zero distribution allowed")
	}
	bad = DefaultFishingRules()
	bad.Catalog[0].Average = -1
	if bad.validate() == nil {
		t.Fatal("bad size accepted")
	}
	bad = DefaultFishingRules()
	bad.AutoCD = bad.AutoCD[:4]
	if bad.validate() == nil {
		t.Fatal("missing tool tier")
	}
}
func TestFishingCollectionAndRewards(t *testing.T) {
	ids := idgen.New(1)
	r := DefaultFishingRules()
	r.LootWeights = []int{1, 0, 0, 0}
	s := &Service{ids: ids, fishing: r, rnd: rand.New(rand.NewSource(9))}
	a := r.newAccount()
	for i := 0; i < 100; i++ {
		a.addCard("3:" + r.Catalog[i].ID)
		if a.Badges[3] != (i+1)/25 {
			t.Fatal("badge milestone")
		}
	}
	a.addCard("3:f001")
	if a.Badges[3] != 4 || a.Cards["3:f001"] != 2 {
		t.Fatal("duplicate changed unique progress")
	}
	s.reward(a, 1, 1000, true)
	if len(a.Fish) != 1 || len(a.Records) != 2 {
		t.Fatal("catch not recorded")
	}
	f := a.Fish[0]
	s.reward(a, 2, 1001, false)
	if len(a.Fish) != 2 || a.Fish[1].By != "2" || len(a.Records) != 2 {
		t.Fatal("stolen fish awarded a self-caught record")
	}
	if a.Records[f.Species+":max"].ID != f.ID {
		t.Fatal("existing record erased by steal")
	}
	a.Fish = nil
	if len(a.Records) != 2 {
		t.Fatal("selling erased showcase")
	}
}

func TestFishingContinuousPriceAndMoney(t *testing.T) {
	r := DefaultFishingRules()
	f := FishSpecies{Average: 50, Value: Coins(100)}
	a := fishPrice(f, 53.16, r.LengthValueScale, 0, r.Value)
	b := fishPrice(f, 53.17, r.LengthValueScale, 0, r.Value)
	if a == b {
		t.Fatal("nearby exact lengths priced identically")
	}
	if fishPrice(f, 25, r.LengthValueScale, 0, r.Value) <= f.Value || fishPrice(f, 100, r.LengthValueScale, 0, r.Value) <= f.Value {
		t.Fatal("extreme sizes should gain value")
	}
	data, err := json.Marshal(Coins(123.45))
	if err != nil || string(data) != "123.45" {
		t.Fatal("decimal money")
	}
	var money Money
	if json.Unmarshal([]byte("53.16"), &money) != nil || money != 5316 {
		t.Fatal("money precision")
	}
	if json.Unmarshal([]byte("53.161"), &money) == nil {
		t.Fatal("fractional cent accepted")
	}
}
func TestFishingOfflineChronologicalCatchup(t *testing.T) {
	r := DefaultFishingRules()
	r.WaitMin = 1
	r.WaitMax = 1
	r.Bite = 1
	r.LootWeights = []int{1, 0, 0, 0}
	r.InventoryLimit = 10000
	s := &Service{ids: idgen.New(1), fishing: r, rnd: rand.New(rand.NewSource(2))}
	a := r.newAccount()
	st := &State{Kind: Fishing, Status: Playing, Pond: &Pond{}}
	st.Pond.Seats[0] = Angler{User: 1, BiteAt: 1000, ExpiresAt: 2000}
	if !s.settlePond(st, map[int64]*FishingAccount{1: a}, 10000) || len(a.Fish) != 5 {
		t.Fatalf("offline catches %d", len(a.Fish))
	}
	n := len(a.Fish)
	s.settlePond(st, map[int64]*FishingAccount{1: a}, 10000)
	if len(a.Fish) != n {
		t.Fatal("catchup paid twice")
	}
	if r.StealCD[4] >= r.WardCD[4] || r.GlovePierce[4] == 0 {
		t.Fatal("top glove not stronger than ward")
	}
}

func TestFishingCatchupBatchKeepsPendingEvents(t *testing.T) {
	r := DefaultFishingRules()
	r.WaitMin = 1
	r.WaitMax = 1
	r.Bite = 1
	r.CatchupBatch = 1
	r.LootWeights = []int{1, 0, 0, 0}
	s := &Service{fishing: r, rnd: rand.New(rand.NewSource(4))}
	a := r.newAccount()
	st := &State{Pond: &Pond{}}
	st.Pond.Seats[0] = Angler{User: 1, BiteAt: 1000, ExpiresAt: 2000}
	accounts := map[int64]*FishingAccount{1: a}
	s.settlePond(st, accounts, 10000)
	if len(a.Fish) != 1 || !st.Pond.CatchingUp {
		t.Fatal("catchup discarded remainder")
	}
	for i := 0; i < 4; i++ {
		s.settlePond(st, accounts, 10000)
	}
	if len(a.Fish) != 5 || st.Pond.CatchingUp {
		t.Fatal("catchup failed to complete")
	}
}

// Every cast samples integer seconds across the configured inclusive range.
// A fast rod shortens it, but cannot go below the ten-second minimum.
func TestFishingWaitSeconds(t *testing.T) {
	r := DefaultFishingRules()
	if r.WaitMin != 10 || r.WaitMax != 3600 {
		t.Fatal("default wait must be 10–3600 seconds")
	}
	s := &Service{fishing: r, rnd: rand.New(rand.NewSource(37))}
	a := r.newAccount()
	seen := map[int64]bool{}
	const now int64 = 123456789
	for i := 0; i < 100000; i++ {
		var p Angler
		s.cast(&p, a, now)
		delta := p.BiteAt - now
		if delta%1000 != 0 || delta < 10000 || delta > 3600000 {
			t.Fatalf("invalid cast wait %d", delta)
		}
		if p.ExpiresAt-p.BiteAt != int64(r.Bite)*1000 {
			t.Fatal("bite window changed")
		}
		seen[delta/1000] = true
	}
	if len(seen) != 3591 {
		t.Fatalf("not all second values sampled: %d", len(seen))
	}
	a.Tools["speed"] = 5
	a.Equipped = []string{"speed"}
	for i := 0; i < 10000; i++ {
		var p Angler
		s.cast(&p, a, now)
		if delta := p.BiteAt - now; delta%1000 != 0 || delta < 10000 || delta > 1620000 {
			t.Fatalf("invalid accelerated cast %d", delta)
		}
	}
	// A single configured second is legal and deterministic, inclusive at both ends.
	r.WaitMin = 10
	r.WaitMax = 10
	var p Angler
	s.cast(&p, a, now)
	if p.BiteAt-now != 10000 {
		t.Fatal("speed rod broke minimum wait")
	}
}
