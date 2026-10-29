package desktop

import (
	"bytes"
	"testing"
)

func TestIcoImage(t *testing.T) {
	png := []byte{0x89, 'P', 'N', 'G'}
	for _, size := range []int{16, 24, 32, 48, 64, 128, 256} {
		data := icoImage(IconICO, size)
		if data == nil || !bytes.HasPrefix(data, png) && len(data) < 40 {
			t.Fatalf("size %d: no image", size)
		}
	}
	if icoImage([]byte("junk"), 16) != nil {
		t.Fatal("junk accepted")
	}
	// 20 px asks for the next bigger one (24), not 16.
	if !bytes.Equal(icoImage(IconICO, 20), icoImage(IconICO, 24)) {
		t.Fatal("picked the wrong size")
	}
}
