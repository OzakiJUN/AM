// Package view converts store rows into protocol messages.
package view

import (
	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/store"
)

// User converts a user row. owners maps owner id -> owner row, used to fill
// owner_display_name for bot / ai accounts (may be nil).
func User(u *store.User, owners map[int64]*store.User) *amv1.User {
	if u == nil {
		return nil
	}
	out := &amv1.User{
		Id:          u.ID,
		Username:    u.Username,
		DisplayName: u.DisplayName,
		Avatar:      u.Avatar,
		AccountType: amv1.AccountType(u.AccountType),
		OwnerId:     u.OwnerID,
	}
	if o := owners[u.OwnerID]; o != nil {
		out.OwnerDisplayName = o.DisplayName
	}
	return out
}

func Member(m *store.Member) *amv1.MemberState {
	return &amv1.MemberState{
		Role:        amv1.MemberRole(m.Role),
		ReadSeq:     m.ReadSeq,
		PinnedOrder: m.PinnedOrder,
		DndUntil:    m.DndUntil,
		MutedUntil:  m.MutedUntil,
	}
}

func Conversation(c *store.ConvWithSelf, members []*amv1.User) *amv1.Conversation {
	return &amv1.Conversation{
		Id:      c.ID,
		Kind:    amv1.ConvKind(c.Kind),
		Name:    c.Name,
		Avatar:  c.Avatar,
		OwnerId: c.OwnerID,
		LastSeq: c.LastSeq,
		Members: members,
		Self:    Member(&c.Self),
	}
}
