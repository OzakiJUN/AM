// Package connectcode encodes and parses AM join codes.
//
// A join code carries everything a client needs to reach a self-hosted
// server and register: the server address, a pin of its certificate and
// (optionally) an invite code. It is obfuscated so the address is not
// written out in plain text, and it looks like
//
//	AM1-K7QM-2XPA-9RTD-...
//
// Without an invite it is a "server code", used to add a server on a new
// device when you already have an account.
//
// The obfuscation only hides the address from casual eyes; the client has
// to decode it to connect, so it is not a secret from anyone determined.
//
// Binary layout (before obfuscation and base32):
//
//	version(1)=1 | salt(2) | flags(1) | host | port(2, big endian)
//	| pin(16, if flagPin) | invite(7, if flagInvite) | check(2)
//
// flags: bit0 plain HTTP (no TLS), bit1 pin present, bit2 invite present,
// bits4-5 host type (0 IPv4: 4 bytes, 1 IPv6: 16 bytes, 2 name: length byte
// + bytes). pin = first 16 bytes of the certificate's SHA-256. invite = the
// 10-character invite code packed as 5-bit values. check = first 2 bytes of
// SHA-256 over everything before it. Every byte after the salt is XORed
// with a key stream derived from the salt (itself a hash of the content), so
// codes for the same server do not share a visible prefix, yet encoding the
// same content twice gives the same code.
package connectcode

import (
	"bytes"
	"crypto/sha256"
	"encoding/base32"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// Alphabet of invite codes and of the join code text: no 0/O, 1/I/L.
const Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

// PinSize is how many bytes of the certificate SHA-256 a join code keeps.
// 128 bits: forging a certificate that matches is far out of reach.
const PinSize = 16

const (
	version    = 1
	prefix     = "AM1-"
	flagPlain  = 1 << 0
	flagPin    = 1 << 1
	flagInvite = 1 << 2
	hostShift  = 4
	hostIPv4   = 0
	hostIPv6   = 1
	hostName   = 2
	inviteLen  = 10
)

var enc = base32.NewEncoding(Alphabet).WithPadding(base32.NoPadding)

// Join is the content of a join code.
type Join struct {
	Address string // host:port
	// Pin is the start of the certificate's SHA-256 (PinSize bytes), nil
	// when the server has a CA-signed certificate.
	Pin []byte
	// Plain is true when the server runs without TLS (local testing).
	Plain bool
	// Invite is the invite code, "" for a server code.
	Invite string
}

// Encode returns the join code text, e.g. "AM1-K7QM-2XPA-...".
func (j *Join) Encode() (string, error) {
	host, portStr, err := net.SplitHostPort(j.Address)
	if err != nil {
		return "", fmt.Errorf("address %q: %w", j.Address, err)
	}
	port, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil || port == 0 {
		return "", fmt.Errorf("bad port in %q", j.Address)
	}
	var body bytes.Buffer
	flags := byte(0)
	if j.Plain {
		flags |= flagPlain
	}
	if len(j.Pin) > 0 {
		if len(j.Pin) < PinSize {
			return "", errors.New("pin too short")
		}
		flags |= flagPin
	}
	if j.Invite != "" {
		flags |= flagInvite
	}
	ip := net.ParseIP(host)
	switch {
	case ip != nil && ip.To4() != nil:
		flags |= hostIPv4 << hostShift
		body.Write(ip.To4())
	case ip != nil:
		flags |= hostIPv6 << hostShift
		body.Write(ip.To16())
	default:
		if len(host) == 0 || len(host) > 253 {
			return "", fmt.Errorf("bad host %q", host)
		}
		flags |= hostName << hostShift
		body.WriteByte(byte(len(host)))
		body.WriteString(strings.ToLower(host))
	}
	_ = binary.Write(&body, binary.BigEndian, uint16(port))
	if len(j.Pin) > 0 {
		body.Write(j.Pin[:PinSize])
	}
	if j.Invite != "" {
		packed, err := packInvite(j.Invite)
		if err != nil {
			return "", err
		}
		body.Write(packed)
	}

	plain := append([]byte{flags}, body.Bytes()...)
	// The salt comes from the content: the same server + invite always
	// gives the same code, different invites look completely different.
	h := sha256.Sum256(append([]byte("AM join salt"), plain...))
	salt := h[:2]
	head := append([]byte{version}, salt...)
	sum := sha256.Sum256(append(append([]byte{}, head...), plain...))
	plain = append(plain, sum[:2]...)
	xor(plain, salt)
	text := enc.EncodeToString(append(head, plain...))
	return prefix + group(text), nil
}

// Parse decodes a join code. It accepts the bare code ("AM1-..."), the code
// with spaces or without dashes, and a URL containing "join=<code>" (as put
// in QR codes).
func Parse(s string) (*Join, error) {
	s = strings.TrimSpace(s)
	if i := strings.Index(s, "join="); i >= 0 {
		s = s[i+len("join="):]
		if j := strings.IndexAny(s, "&#"); j >= 0 {
			s = s[:j]
		}
		if u, err := url.QueryUnescape(s); err == nil {
			s = u
		}
	}
	s = strings.ToUpper(s)
	s = strings.NewReplacer("-", "", " ", "", "\n", "", "\r", "", "\t", "").Replace(s)
	if !strings.HasPrefix(s, "AM1") {
		return nil, errors.New("这不是 AM 加入码（应该以 AM1- 开头）")
	}
	raw, err := enc.DecodeString(s[3:])
	if err != nil || len(raw) < 3+1+4+2+2 {
		return nil, errors.New("加入码不完整，请整段复制")
	}
	if raw[0] != version {
		return nil, fmt.Errorf("加入码版本 %d 比客户端新，请更新客户端", raw[0])
	}
	head, rest := raw[:3], append([]byte{}, raw[3:]...)
	xor(rest, head[1:3])
	payload, check := rest[:len(rest)-2], rest[len(rest)-2:]
	sum := sha256.Sum256(append(append([]byte{}, head...), payload...))
	if !bytes.Equal(sum[:2], check) {
		return nil, errors.New("加入码有误（可能抄错了），请整段复制")
	}
	r := bytes.NewReader(payload)
	flags, _ := r.ReadByte()
	j := &Join{Plain: flags&flagPlain != 0}
	var host string
	switch (flags >> hostShift) & 3 {
	case hostIPv4:
		b := make([]byte, 4)
		if _, err := io.ReadFull(r, b); err != nil {
			return nil, errBroken
		}
		host = net.IP(b).String()
	case hostIPv6:
		b := make([]byte, 16)
		if _, err := io.ReadFull(r, b); err != nil {
			return nil, errBroken
		}
		host = net.IP(b).String()
	case hostName:
		n, err := r.ReadByte()
		if err != nil || n == 0 {
			return nil, errBroken
		}
		b := make([]byte, n)
		if _, err := io.ReadFull(r, b); err != nil {
			return nil, errBroken
		}
		host = string(b)
	default:
		return nil, errBroken
	}
	var port uint16
	if err := binary.Read(r, binary.BigEndian, &port); err != nil || port == 0 {
		return nil, errBroken
	}
	j.Address = net.JoinHostPort(host, strconv.Itoa(int(port)))
	if flags&flagPin != 0 {
		j.Pin = make([]byte, PinSize)
		if _, err := io.ReadFull(r, j.Pin); err != nil {
			return nil, errBroken
		}
	}
	if flags&flagInvite != 0 {
		b := make([]byte, 7)
		if _, err := io.ReadFull(r, b); err != nil {
			return nil, errBroken
		}
		j.Invite = unpackInvite(b)
	}
	if r.Len() != 0 {
		return nil, errBroken
	}
	return j, nil
}

var errBroken = errors.New("加入码有误，请整段复制")

// BaseURL is the HTTP base URL of the server, e.g. "https://47.1.2.3:7000".
func (j *Join) BaseURL() string {
	if j.Plain {
		return "http://" + j.Address
	}
	return "https://" + j.Address
}

// URL returns downloadURL with "#join=<code>" appended, for QR codes: other
// scanners open the download page, the AM client reads the code.
func URL(downloadURL, code string) string {
	if downloadURL == "" || code == "" {
		return ""
	}
	if i := strings.Index(downloadURL, "#"); i >= 0 {
		downloadURL = downloadURL[:i]
	}
	return downloadURL + "#join=" + code
}

// PinOf returns the pin (first PinSize bytes of SHA-256) of a DER certificate.
func PinOf(certDER []byte) []byte {
	sum := sha256.Sum256(certDER)
	return sum[:PinSize]
}

// FingerprintHex formats a full or partial certificate hash as
// colon-separated upper-case hex ("AB:CD:...").
func FingerprintHex(b []byte) string {
	h := strings.ToUpper(hex.EncodeToString(b))
	parts := make([]string, 0, len(b))
	for i := 0; i < len(h); i += 2 {
		parts = append(parts, h[i:i+2])
	}
	return strings.Join(parts, ":")
}

func xor(b, salt []byte) {
	stream := sha256.Sum256(append([]byte("AM join code v1"), salt...))
	for i := range b {
		if i > 0 && i%len(stream) == 0 {
			stream = sha256.Sum256(stream[:])
		}
		b[i] ^= stream[i%len(stream)]
	}
}

func group(s string) string {
	var b strings.Builder
	for i, c := range s {
		if i > 0 && i%4 == 0 {
			b.WriteByte('-')
		}
		b.WriteRune(c)
	}
	return b.String()
}

func packInvite(code string) ([]byte, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if len(code) != inviteLen {
		return nil, fmt.Errorf("invite code must be %d characters", inviteLen)
	}
	var v uint64
	for _, c := range code {
		i := strings.IndexRune(Alphabet, c)
		if i < 0 {
			return nil, fmt.Errorf("invite code has a bad character %q", c)
		}
		v = v<<5 | uint64(i)
	}
	out := make([]byte, 7) // 50 bits
	for i := 6; i >= 0; i-- {
		out[i] = byte(v)
		v >>= 8
	}
	return out, nil
}

func unpackInvite(b []byte) string {
	var v uint64
	for _, x := range b {
		v = v<<8 | uint64(x)
	}
	out := make([]byte, inviteLen)
	for i := inviteLen - 1; i >= 0; i-- {
		out[i] = Alphabet[v&31]
		v >>= 5
	}
	return string(out)
}
