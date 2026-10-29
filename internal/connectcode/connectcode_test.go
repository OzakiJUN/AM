package connectcode

import (
	"bytes"
	"crypto/sha256"
	"strings"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	sum := sha256.Sum256([]byte("cert"))
	cases := []*Join{
		{Address: "47.1.2.3:7000", Pin: sum[:PinSize], Invite: "K7QM2XPA9R"},
		{Address: "[2001:db8::1]:8443", Pin: sum[:]},
		{Address: "chat.example.com:443"},
		{Address: "127.0.0.1:8443", Plain: true, Invite: "ABCDEFGH23"},
	}
	for _, in := range cases {
		code, err := in.Encode()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(code, "AM1-") {
			t.Fatal(code)
		}
		for _, variant := range []string{
			code,
			"  " + strings.ToLower(code) + "\n",
			strings.ReplaceAll(code, "-", ""),
			URL("https://github.com/OzakiJUN/AM/releases/latest", code),
		} {
			out, err := Parse(variant)
			if err != nil {
				t.Fatalf("%q: %v", variant, err)
			}
			wantPin := in.Pin
			if len(wantPin) > PinSize {
				wantPin = wantPin[:PinSize]
			}
			if out.Address != in.Address || !bytes.Equal(out.Pin, wantPin) || out.Plain != in.Plain || out.Invite != in.Invite {
				t.Fatalf("got %+v want %+v", out, in)
			}
		}
	}
}

func TestCodesForSameServerLookDifferent(t *testing.T) {
	a, _ := (&Join{Address: "47.1.2.3:7000", Invite: "K7QM2XPA9R"}).Encode()
	b, _ := (&Join{Address: "47.1.2.3:7000", Invite: "K7QM2XPA9S"}).Encode()
	if a[:12] == b[:12] {
		t.Fatal("codes for different invites share a prefix")
	}
	again, _ := (&Join{Address: "47.1.2.3:7000", Invite: "K7QM2XPA9R"}).Encode()
	if again != a {
		t.Fatal("same content gave a different code")
	}
}

func TestLength(t *testing.T) {
	sum := sha256.Sum256([]byte("cert"))
	code, _ := (&Join{Address: "47.1.2.3:7000", Pin: sum[:], Invite: "K7QM2XPA9R"}).Encode()
	if len(code) > 75 {
		t.Fatalf("code too long (%d): %s", len(code), code)
	}
	t.Log(code)
}

func TestBad(t *testing.T) {
	good, _ := (&Join{Address: "47.1.2.3:7000", Invite: "K7QM2XPA9R"}).Encode()
	typo := []byte(good)
	if typo[10] == 'A' {
		typo[10] = 'B'
	} else {
		typo[10] = 'A'
	}
	for _, c := range []string{"", "hello", "AM1-", "AM1-AAAA", good[:len(good)-3], string(typo), "AM9-" + good[4:]} {
		if _, err := Parse(c); err == nil {
			t.Errorf("Parse(%q) should fail", c)
		}
	}
	if _, err := (&Join{Address: "1.2.3.4:1", Invite: "short"}).Encode(); err == nil {
		t.Error("short invite accepted")
	}
	if _, err := (&Join{Address: "1.2.3.4:0"}).Encode(); err == nil {
		t.Error("port 0 accepted")
	}
}
