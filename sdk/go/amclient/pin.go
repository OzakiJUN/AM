package amclient

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// PinnedTLSConfig returns a TLS config that accepts exactly the server
// certificate whose SHA-256 fingerprint is given (as printed by am-server,
// "AB:CD:..."; separators and case are ignored). No CA or hostname check is
// done, so it works with the self-signed certificate and a bare IP address.
func PinnedTLSConfig(fingerprint string) *tls.Config {
	b, err := hex.DecodeString(normalizeFingerprint(fingerprint))
	if err != nil {
		b = []byte("invalid fingerprint")
	}
	return PinnedTLSConfigBytes(b)
}

// PinnedTLSConfigBytes pins the certificate by its SHA-256, or by the first
// bytes of it (at least 16, as carried in join codes).
func PinnedTLSConfigBytes(pin []byte) *tls.Config {
	want := append([]byte{}, pin...)
	return &tls.Config{
		InsecureSkipVerify: true, //nolint:gosec // replaced by the pin check below
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return errors.New("no server certificate")
			}
			if len(want) < 16 || len(want) > sha256.Size {
				return errors.New("certificate pin has a bad length")
			}
			sum := sha256.Sum256(rawCerts[0])
			if !bytes.Equal(sum[:len(want)], want) {
				return fmt.Errorf("server certificate fingerprint mismatch (got %s) - get a new join code from the server",
					strings.ToUpper(hex.EncodeToString(sum[:])))
			}
			return nil
		},
	}
}

func normalizeFingerprint(fp string) string {
	r := strings.NewReplacer(":", "", " ", "", "-", "")
	return strings.ToUpper(r.Replace(strings.TrimSpace(fp)))
}
