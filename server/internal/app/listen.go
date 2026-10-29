package app

import (
	"net"
	"time"

	"github.com/pires/go-proxyproto"
)

// Listen opens the server's TCP listener. With proxyProtocol on, a PROXY
// header (sent by frp) sets the client's real address, but only when the
// connection comes from this machine, so outsiders cannot fake their IP.
func Listen(addr string, proxyProtocol bool) (net.Listener, error) {
	ln, err := net.Listen("tcp", addr)
	if err != nil || !proxyProtocol {
		return ln, err
	}
	return &proxyproto.Listener{
		Listener:          ln,
		ConnPolicy:        proxyproto.MustPolicyFromRanges([]string{"127.0.0.0/8", "::1/128"}, proxyproto.USE, proxyproto.IGNORE),
		ReadHeaderTimeout: 10 * time.Second,
	}, nil
}
