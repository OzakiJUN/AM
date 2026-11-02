package game

import (
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
	bad.SizeWeights = []int{0, 0, 0, 0, 0}
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
	r.SizeWeights = []int{0, 0, 0, 0, 1}
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
	if len(a.Fish) != 1 || a.Fish[0].Grade != 4 || len(a.Records) != 2 {
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
