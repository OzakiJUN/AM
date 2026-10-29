package e2e

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/OzakiJUN/am/server/internal/app"
)

// With proxy protocol on, the address from frp's PROXY header becomes the
// client address; without a header the connection still works.
func TestProxyProtocol(t *testing.T) {
	ln, err := app.Listen("127.0.0.1:0", true)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, r.RemoteAddr)
	}), ReadHeaderTimeout: 5 * time.Second}
	go srv.Serve(ln)
	defer srv.Close()

	get := func(header string) string {
		c, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		io.WriteString(c, header+"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
		resp, err := http.ReadResponse(bufio.NewReader(c), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return string(b)
	}
	if got := get("PROXY TCP4 203.0.113.7 127.0.0.1 5555 8443\r\n"); !strings.HasPrefix(got, "203.0.113.7:") {
		t.Fatalf("with header: remote addr %q", got)
	}
	if got := get(""); !strings.HasPrefix(got, "127.0.0.1:") {
		t.Fatalf("without header: remote addr %q", got)
	}
}
