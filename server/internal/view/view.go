// Package view converts store rows into protocol messages.
package view

import (
	"fmt"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/store"
)

// MediaURL and ThumbURL are the download paths of a media item.
func MediaURL(id int64) string { return fmt.Sprintf("/api/v1/media/%d", id) }
func ThumbURL(id int64) string { return fmt.Sprintf("/api/v1/media/%d/thumb", id) }

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
		Bio:         u.Bio,
	}
	if u.AvatarMediaID != 0 {
		out.Avatar = MediaURL(u.AvatarMediaID)
		out.AvatarStatic = ThumbURL(u.AvatarMediaID)
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

// Conversation converts a conversation; members and roles are parallel slices.
func Conversation(c *store.ConvWithSelf, members []*amv1.User, roles []amv1.MemberRole) *amv1.Conversation {
	avatar := c.Avatar
	if c.AvatarMedia != 0 {
		avatar = MediaURL(c.AvatarMedia)
	}
	return &amv1.Conversation{
		Id:           c.ID,
		Kind:         amv1.ConvKind(c.Kind),
		Name:         c.Name,
		Avatar:       avatar,
		OwnerId:      c.OwnerID,
		LastSeq:      c.LastSeq,
		Members:      members,
		MemberRoles:  roles,
		Self:         Member(&c.Self),
		Notice:       c.Notice,
		JoinApproval: c.JoinApproval,
		Public:       c.Public,
	}
}

func Media(m *store.Media) *amv1.MediaInfo {
	out := &amv1.MediaInfo{
		Id:      m.ID,
		Mime:    m.Mime,
		Size:    m.Size,
		Width:   int32(m.Width),
		Height:  int32(m.Height),
		Name:    m.Name,
		IsImage: m.IsImage,
		Url:     MediaURL(m.ID),
	}
	if m.HasThumb {
		out.ThumbUrl = ThumbURL(m.ID)
	}
	return out
}
