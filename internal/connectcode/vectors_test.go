package connectcode

import (
	"crypto/sha256"
	"fmt"
	"os"
	"testing"
)

// TestPrintVectors prints join codes for the TypeScript decoder test
// (client/src/lib/joincode.test.ts). Run with AM_PRINT_VECTORS=1.
func TestPrintVectors(t *testing.T) {
	if os.Getenv("AM_PRINT_VECTORS") == "" {
		t.Skip()
	}
	sum := sha256.Sum256([]byte("cert"))
	for _, j := range []*Join{
		{Address: "47.1.2.3:7000", Pin: sum[:PinSize], Invite: "K7QM2XPA9R"},
		{Address: "[2001:db8::1]:8443", Pin: sum[:PinSize]},
		{Address: "chat.example.com:443"},
		{Address: "127.0.0.1:8443", Plain: true, Invite: "ABCDEFGH23"},
	} {
		c, _ := j.Encode()
		fmt.Printf("%s|%s|%x|%v|%s\n", c, j.Address, j.Pin, j.Plain, j.Invite)
	}
}
