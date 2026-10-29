// Package push is the interface business modules use to reach online users.
// The gateway implements it; modules depend only on this interface so they
// never import the gateway (and the gateway can later be split out onto
// several machines without touching them).
package push

import amv1 "github.com/OzakiJUN/am/gen/go/am/v1"

type Pusher interface {
	// ToUsers sends a frame to every online connection of the given users,
	// except the connection with id exceptConn (0 = none).
	ToUsers(userIDs []int64, frame *amv1.ServerFrame, exceptConn uint64)
	// CloseSession disconnects every connection that logged in with this session.
	CloseSession(sessionID int64)
}

// Nop discards everything. Useful in tests.
type Nop struct{}

func (Nop) ToUsers([]int64, *amv1.ServerFrame, uint64) {}
func (Nop) CloseSession(int64)                         {}
