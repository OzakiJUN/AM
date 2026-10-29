package amclient

import (
	"crypto/tls"

	"github.com/OzakiJUN/am/internal/connectcode"
)

// ConnectInfo is the content of a connection code (see ParseConnectCode).
type ConnectInfo = connectcode.Info

// ParseConnectCode decodes an "am://connect?..." connection code, as shown
// in the server admin panel.
func ParseConnectCode(code string) (*ConnectInfo, error) { return connectcode.Parse(code) }

// NewFromCode creates a client for the server described by a connection
// code. With a fingerprint in the code the server certificate is pinned;
// without one it is verified against the system's CAs.
func NewFromCode(code string) (*Client, *ConnectInfo, error) {
	info, err := connectcode.Parse(code)
	if err != nil {
		return nil, nil, err
	}
	var tc *tls.Config
	if len(info.Fingerprint) > 0 {
		tc = PinnedTLSConfig(info.FingerprintHex())
	}
	return New(info.BaseURL(), tc), info, nil
}
