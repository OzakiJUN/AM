package amclient

import (
	"crypto/tls"

	"github.com/OzakiJUN/am/internal/connectcode"
)

// Join is the content of a join code (see ParseJoinCode).
type Join = connectcode.Join

// ParseJoinCode decodes a join code ("AM1-..."), or a QR URL containing
// "join=<code>".
func ParseJoinCode(code string) (*Join, error) { return connectcode.Parse(code) }

// NewFromJoinCode creates a client for the server in a join code. With a pin
// in the code the server certificate is pinned; without one it is verified
// against the system's CAs. The invite code (if any) is in the returned Join.
func NewFromJoinCode(code string) (*Client, *Join, error) {
	j, err := connectcode.Parse(code)
	if err != nil {
		return nil, nil, err
	}
	var tc *tls.Config
	if len(j.Pin) > 0 {
		tc = PinnedTLSConfigBytes(j.Pin)
	}
	c := New(j.BaseURL(), tc)
	c.server = &connectcode.Join{Address: j.Address, Pin: j.Pin, Plain: j.Plain}
	return c, j, nil
}

// JoinCodeFor builds a join code for one of your invite codes from the
// server address this client uses. Servers fill Invite.join_code themselves
// when they know their public address; use this when it is empty. Only
// works for clients made with NewFromJoinCode.
func (c *Client) JoinCodeFor(invite string) (string, error) {
	if c.server == nil {
		return "", errNoServer
	}
	j := *c.server
	j.Invite = invite
	return j.Encode()
}
