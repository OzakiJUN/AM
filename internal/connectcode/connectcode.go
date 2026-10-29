// Package connectcode encodes and parses AM connection codes.
//
// A connection code carries everything a client needs to reach a
// self-hosted server, so users paste one string (or scan a QR code) instead
// of typing an address and a 64-character certificate fingerprint:
//
//		am://connect?v=1&addr=47.1.2.3:7000&fp=<base64url sha256>&name=<server name>
//
//	  - addr: host:port as seen from the client (public IP / domain + port).
//	  - fp:   SHA-256 of the server's self-signed certificate, base64url
//	    without padding (hex with or without colons is accepted too). Absent
//	    when the server has a real certificate: the client then verifies it the
//	    normal way.
//	  - tls=off: the server speaks plain HTTP (local testing only).
//	  - name: display name of the server (optional).
package connectcode

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// Info is the content of a connection code.
type Info struct {
	Name    string
	Address string // host:port
	// Fingerprint is the certificate's SHA-256 (32 bytes), nil when the
	// server has a CA-signed certificate.
	Fingerprint []byte
	// Plain is true when the server runs without TLS.
	Plain bool
}

// String encodes the connection code.
func (i *Info) String() string {
	v := url.Values{}
	v.Set("v", "1")
	v.Set("addr", i.Address)
	if len(i.Fingerprint) > 0 {
		v.Set("fp", base64.RawURLEncoding.EncodeToString(i.Fingerprint))
	}
	if i.Plain {
		v.Set("tls", "off")
	}
	if i.Name != "" {
		v.Set("name", i.Name)
	}
	return "am://connect?" + v.Encode()
}

// BaseURL is the HTTP base URL of the server, e.g. "https://47.1.2.3:7000".
func (i *Info) BaseURL() string {
	if i.Plain {
		return "http://" + i.Address
	}
	return "https://" + i.Address
}

// FingerprintHex returns the fingerprint as colon-separated upper-case hex
// (the format am-server prints), or "" if there is none.
func (i *Info) FingerprintHex() string {
	if len(i.Fingerprint) == 0 {
		return ""
	}
	h := strings.ToUpper(hex.EncodeToString(i.Fingerprint))
	parts := make([]string, 0, len(i.Fingerprint))
	for j := 0; j < len(h); j += 2 {
		parts = append(parts, h[j:j+2])
	}
	return strings.Join(parts, ":")
}

// Parse decodes a connection code. Surrounding spaces are ignored.
func Parse(code string) (*Info, error) {
	u, err := url.Parse(strings.TrimSpace(code))
	if err != nil || u.Scheme != "am" || (u.Host != "connect" && u.Opaque != "connect") {
		return nil, errors.New("not an AM connection code (it should start with am://connect?)")
	}
	q := u.Query()
	if v := q.Get("v"); v != "" && v != "1" {
		return nil, fmt.Errorf("connection code version %s is newer than this client; please update", v)
	}
	info := &Info{Name: q.Get("name"), Address: q.Get("addr"), Plain: q.Get("tls") == "off"}
	host, port, err := net.SplitHostPort(info.Address)
	if err != nil || host == "" || port == "" {
		return nil, fmt.Errorf("connection code has a bad address %q", info.Address)
	}
	if fp := q.Get("fp"); fp != "" {
		if info.Fingerprint, err = ParseFingerprint(fp); err != nil {
			return nil, err
		}
	}
	return info, nil
}

// ParseFingerprint accepts base64url (with or without padding) or hex with
// optional ":" / "-" / " " separators, and returns the 32 raw bytes.
func ParseFingerprint(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	clean := strings.NewReplacer(":", "", "-", "", " ", "").Replace(s)
	if len(clean) == 64 {
		if b, err := hex.DecodeString(clean); err == nil {
			return b, nil
		}
	}
	if b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "=")); err == nil && len(b) == 32 {
		return b, nil
	}
	return nil, errors.New("bad certificate fingerprint in connection code")
}
