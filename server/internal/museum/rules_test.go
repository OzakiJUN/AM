package museum

import (
	"reflect"
	"testing"
)

func TestHang(t *testing.T) {
	// First empty place.
	h, at, pushed, full := Hang([]int64{1, 0, 3, 0, 0, 0, 0, 0}, 9, 0)
	if !reflect.DeepEqual(h, []int64{1, 9, 3, 0, 0, 0, 0, 0}) || at != 2 || pushed != 0 || full {
		t.Fatalf("first empty: %v %d %d %v", h, at, pushed, full)
	}
	// Jumping the queue: the empty place behind takes up the move.
	h, at, pushed, _ = Hang([]int64{1, 2, 3, 0, 5, 6, 7, 8}, 9, 2)
	if !reflect.DeepEqual(h, []int64{1, 9, 2, 3, 5, 6, 7, 8}) || at != 2 || pushed != 0 {
		t.Fatalf("queue jump: %v %d", h, pushed)
	}
	// Full: the last one drops out.
	h, _, pushed, _ = Hang([]int64{1, 2, 3, 4, 5, 6, 7, 8}, 9, 1)
	if !reflect.DeepEqual(h, []int64{9, 1, 2, 3, 4, 5, 6, 7}) || pushed != 8 {
		t.Fatalf("full jump: %v %d", h, pushed)
	}
	// Full and no position: refused.
	if _, _, _, full = Hang([]int64{1, 2, 3, 4, 5, 6, 7, 8}, 9, 0); !full {
		t.Fatal("full hall took a work without a position")
	}
	// Moving a work that is already up.
	h, at, pushed, _ = Hang([]int64{1, 2, 3, 0, 0, 0, 0, 0}, 3, 1)
	if !reflect.DeepEqual(h, []int64{3, 1, 2, 0, 0, 0, 0, 0}) || at != 1 || pushed != 0 {
		t.Fatalf("move: %v %d", h, pushed)
	}
	// Out-of-range positions are clamped.
	if _, at, _, _ = Hang(make([]int64, Slots), 9, 99); at != Slots {
		t.Fatalf("clamp: %d", at)
	}
}

func TestRemoveSwap(t *testing.T) {
	h, ok := Remove([]int64{1, 2, 3, 0, 0, 0, 0, 0}, 2)
	if !ok || !reflect.DeepEqual(h, []int64{1, 0, 3, 0, 0, 0, 0, 0}) {
		t.Fatalf("remove %v", h)
	}
	if _, ok := Remove(h, 42); ok {
		t.Fatal("removed a work that is not there")
	}
	if s := Swap([]int64{1, 2, 3, 0, 0, 0, 0, 0}, 1, 3); !reflect.DeepEqual(s, []int64{3, 2, 1, 0, 0, 0, 0, 0}) {
		t.Fatalf("swap %v", s)
	}
}

func TestSecond(t *testing.T) {
	all := []Entry{{ID: 1, Likes: 2, HungAt: 10}, {ID: 2, Likes: 5, HungAt: 20}, {ID: 3, Likes: 2, HungAt: 5},
		{ID: 4, Likes: 9, HungAt: 1, NSFW: true}}
	if got := Second(all, false); !reflect.DeepEqual(got, []int64{2, 3, 1}) {
		t.Fatalf("second without nsfw %v", got)
	}
	if got := Second(all, true); got[0] != 4 {
		t.Fatalf("second with nsfw %v", got)
	}
	var many []Entry
	for i := 0; i < 20; i++ {
		many = append(many, Entry{ID: int64(i), Likes: i})
	}
	if got := Second(many, true); len(got) != Slots || got[0] != 19 {
		t.Fatalf("top 8 %v", got)
	}
}

func TestVotesTitles(t *testing.T) {
	if NeedsVote(5, 5) || !NeedsVote(6, 5) {
		t.Fatal("needs vote")
	}
	if !Passed(1, 1) || Passed(1, 2) || !Passed(0, 0) {
		t.Fatal("passed")
	}
	if ti, bad := CleanTitle("  《夕阳下的猫和它的朋友们一起》 "); bad || ti != "夕阳下的猫和它的朋友们一" {
		t.Fatalf("title %q", ti)
	}
	if ti, _ := CleanTitle(""); ti != "无题" {
		t.Fatal(ti)
	}
	if _, bad := CleanTitle("萝莉"); !bad {
		t.Fatal("minor title accepted")
	}
	if _, bad := CleanTitle("loli girl"); !bad {
		t.Fatal("minor title accepted (en)")
	}
	if _, bad := CleanTitle("Minority Report"); bad {
		t.Fatal("whole words only")
	}
}
