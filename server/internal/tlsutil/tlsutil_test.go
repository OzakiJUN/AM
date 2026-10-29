package tlsutil

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/OzakiJUN/am/sdk/go/amclient"
)

// The fingerprint the server prints must be accepted by the client pin,
// and any other fingerprint must be rejected.
func TestFingerprintMatchesClientPin(t *testing.T) {
	dir := t.TempDir()
	cert, err := LoadOrCreateSelfSigned(dir, []string{"127.0.0.1", "localhost"})
	if err != nil {
		t.Fatal(err)
	}
	again, err := LoadOrCreateSelfSigned(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if Fingerprint(cert) != Fingerprint(again) {
		t.Fatal("certificate was regenerated instead of reused")
	}

	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	srv.StartTLS()
	defer srv.Close()

	get := func(fp string) error {
		c := &http.Client{Transport: &http.Transport{TLSClientConfig: amclient.PinnedTLSConfig(fp)}}
		resp, err := c.Get(srv.URL)
		if err == nil {
			resp.Body.Close()
		}
		return err
	}
	fp := Fingerprint(cert)
	if err := get(fp); err != nil {
		t.Fatalf("pinned request failed: %v", err)
	}
	if err := get(strings.ToLower(strings.ReplaceAll(fp, ":", " "))); err != nil {
		t.Fatalf("pin should ignore case and separators: %v", err)
	}
	wrong := "00" + fp[2:]
	if err := get(wrong); err == nil {
		t.Fatal("wrong fingerprint was accepted")
	}
}
