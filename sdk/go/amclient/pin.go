package amclient

import (
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
	want := normalizeFingerprint(fingerprint)
	return &tls.Config{
		InsecureSkipVerify: true, //nolint:gosec // replaced by the pin check below
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 {
				return errors.New("no server certificate")
			}
			sum := sha256.Sum256(rawCerts[0])
			got := strings.ToUpper(hex.EncodeToString(sum[:]))
			if got != want {
				return fmt.Errorf("server certificate fingerprint mismatch (got %s) - check the fingerprint in your config", got)
			}
			return nil
		},
	}
}

func normalizeFingerprint(fp string) string {
	r := strings.NewReplacer(":", "", " ", "", "-", "")
	return strings.ToUpper(r.Replace(strings.TrimSpace(fp)))
}
