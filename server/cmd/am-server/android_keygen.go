package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"os"
	"strings"
	"time"

	pkcs12 "software.sslmate.com/src/go-pkcs12"
)

// androidKeygen makes the key that signs the Android app (docs/release.md
// 安卓). Android only installs an update signed with the same key as the
// installed app, so this is made once and kept forever: the file goes into
// the AM repository's GitHub Secret ANDROID_SIGNING_KEY (CI signs the APK
// with it) and a copy is kept somewhere safe offline.
//
// The file is one line, "<password>:<base64 PKCS#12 keystore>"; the
// keystore holds one RSA key with a self-signed certificate (CI reads its
// alias with keytool).
func androidKeygen(args []string) error {
	fs := flag.NewFlagSet("android-keygen", flag.ContinueOnError)
	out := fs.String("out", "android_signing_key.txt", "file for the signing key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if _, err := os.Stat(*out); err == nil {
		return fmt.Errorf("%s already exists: delete or move it first (it may be a key you still need)", *out)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	line, fingerprint, err := makeAndroidKey(time.Now())
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, []byte(line+"\n"), 0o600); err != nil {
		return err
	}
	fmt.Println("Android signing key created.")
	fmt.Println()
	fmt.Println("SIGNING key (secret!) saved to:", *out)
	fmt.Println("  Paste its content into GitHub: AM > Settings > Secrets and variables >")
	fmt.Println("  Actions > New repository secret, name ANDROID_SIGNING_KEY.")
	fmt.Println("  Then copy the file somewhere safe offline (USB stick, password manager)")
	fmt.Println("  and delete it here. If it is lost, phones cannot update AM any more")
	fmt.Println("  (everyone would have to uninstall and install again).")
	fmt.Println("  Never send it to anyone, not even in a chat.")
	fmt.Println()
	fmt.Println("Certificate fingerprint (safe to share, send it to Claude):")
	fmt.Println("  SHA-256 " + fingerprint)
	return nil
}

// makeAndroidKey returns the secret line and the certificate's SHA-256
// fingerprint (what apksigner prints for a signed APK).
func makeAndroidKey(now time.Time) (line, fingerprint string, err error) {
	key, err := rsa.GenerateKey(rand.Reader, 4096)
	if err != nil {
		return "", "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 63))
	if err != nil {
		return "", "", err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "AM", Organization: []string{"OzakiJUN"}},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.AddDate(50, 0, 0),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return "", "", err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return "", "", err
	}
	password, err := randomPassword(32)
	if err != nil {
		return "", "", err
	}
	p12, err := pkcs12.Modern.WithRand(rand.Reader).Encode(key, cert, nil, password)
	if err != nil {
		return "", "", err
	}
	sum := sha256.Sum256(der)
	fp := strings.ToUpper(hex.EncodeToString(sum[:]))
	return password + ":" + base64.StdEncoding.EncodeToString(p12), fp, nil
}

func randomPassword(n int) (string, error) {
	const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
	b := make([]byte, n)
	for i := range b {
		v, err := rand.Int(rand.Reader, big.NewInt(int64(len(letters))))
		if err != nil {
			return "", err
		}
		b[i] = letters[v.Int64()]
	}
	return string(b), nil
}
