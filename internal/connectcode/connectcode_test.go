package connectcode

import (
	"bytes"
	"crypto/sha256"
	"strings"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	fp := sha256.Sum256([]byte("cert"))
	in := &Info{Name: "小克的服务器 & co", Address: "47.1.2.3:7000", Fingerprint: fp[:]}
	code := in.String()
	if !strings.HasPrefix(code, "am://connect?") {
		t.Fatal(code)
	}
	out, err := Parse("  " + code + "\n")
	if err != nil {
		t.Fatal(err)
	}
	if out.Name != in.Name || out.Address != in.Address || !bytes.Equal(out.Fingerprint, in.Fingerprint) || out.Plain {
		t.Fatalf("got %+v", out)
	}
	if out.BaseURL() != "https://47.1.2.3:7000" {
		t.Fatal(out.BaseURL())
	}
	if len(out.FingerprintHex()) != 95 {
		t.Fatal(out.FingerprintHex())
	}
	// Hex fingerprints (as printed by the server) are accepted too.
	b, err := ParseFingerprint(out.FingerprintHex())
	if err != nil || !bytes.Equal(b, fp[:]) {
		t.Fatal(err)
	}
}

func TestPlainAndIPv6(t *testing.T) {
	out, err := Parse((&Info{Address: "[::1]:8443", Plain: true}).String())
	if err != nil {
		t.Fatal(err)
	}
	if !out.Plain || out.BaseURL() != "http://[::1]:8443" || out.Fingerprint != nil {
		t.Fatalf("got %+v", out)
	}
}

func TestBad(t *testing.T) {
	for _, c := range []string{
		"", "https://example.com", "am://connect?addr=nohost", "am://connect?addr=1.2.3.4:1&fp=abc",
		"am://connect?v=9&addr=1.2.3.4:1", "am://other?addr=1.2.3.4:1",
	} {
		if _, err := Parse(c); err == nil {
			t.Errorf("Parse(%q) should fail", c)
		}
	}
}
