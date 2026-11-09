package main

import (
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

func TestAndroidKey(t *testing.T) {
	now := time.Now()
	line, fp, err := makeAndroidKey(now)
	if err != nil {
		t.Fatal(err)
	}
	password, b64, ok := strings.Cut(line, ":")
	if !ok || len(password) != 32 || strings.ContainsAny(password, ":+/= ") {
		t.Fatalf("bad line %q", line[:40])
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	key, cert, err := pkcs12.Decode(data, password)
	if err != nil {
		t.Fatal(err)
	}
	if k, ok := key.(*rsa.PrivateKey); !ok || k.N.BitLen() != 4096 {
		t.Fatalf("key %T", key)
	}
	sum := sha256.Sum256(cert.Raw)
	if fp != strings.ToUpper(hex.EncodeToString(sum[:])) {
		t.Fatal("fingerprint")
	}
	if cert.NotAfter.Before(now.AddDate(49, 0, 0)) || cert.Subject.CommonName != "AM" {
		t.Fatalf("cert %v %v", cert.NotAfter, cert.Subject)
	}
	if _, _, err := pkcs12.Decode(data, "wrong"); err == nil {
		t.Fatal("wrong password accepted")
	}
	// Two keys are never the same.
	line2, _, _ := makeAndroidKey(now)
	if line2 == line {
		t.Fatal("same key twice")
	}
}
