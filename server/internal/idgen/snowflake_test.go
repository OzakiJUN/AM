package idgen

import "testing"

func TestUniqueAndOrdered(t *testing.T) {
	g := New(1)
	prev := int64(0)
	seen := make(map[int64]bool)
	for i := 0; i < 100000; i++ {
		id := g.Next()
		if id <= prev {
			t.Fatalf("id %d not greater than previous %d", id, prev)
		}
		if seen[id] {
			t.Fatalf("duplicate id %d", id)
		}
		seen[id] = true
		prev = id
	}
}

func TestClockBackwards(t *testing.T) {
	g := New(1)
	ms := Epoch + 1000
	g.now = func() int64 { return ms }
	a := g.Next()
	ms -= 500
	b := g.Next()
	if b <= a {
		t.Fatalf("id went backwards: %d then %d", a, b)
	}
}
