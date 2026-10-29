package conv

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

const (
	roleMember = int16(amv1.MemberRole_MEMBER_ROLE_MEMBER)
	roleAdmin  = int16(amv1.MemberRole_MEMBER_ROLE_ADMIN)
	roleOwner  = int16(amv1.MemberRole_MEMBER_ROLE_OWNER)

	maxGroupNameLen = 32
	maxNoticeLen    = 1000
	maxMute         = 365 * 24 * time.Hour
)

func sysMember(action amv1.SysMember_Action, target, operator int64) *amv1.Event {
	return &amv1.Event{Body: &amv1.Event_SysMember{SysMember: &amv1.SysMember{
		Action: action, TargetUserId: target, OperatorId: operator,
	}}}
}

func validGroupName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n < 1 || n > maxGroupNameLen {
		return "", apperr.ErrInvalidGroupName
	}
	return name, nil
}

// loadGroupTx locks a group and returns it with the actor's member row.
func loadGroupTx(ctx context.Context, q *store.Queries, convID, actor int64) (*store.Conversation, *store.Member, error) {
	c, err := q.GetConvForUpdate(ctx, convID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil, apperr.ErrNotMember
	}
	if err != nil {
		return nil, nil, err
	}
	m, err := q.GetMember(ctx, convID, actor)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil, apperr.ErrNotMember
	}
	if err != nil {
		return nil, nil, err
	}
	if c.Kind != int16(amv1.ConvKind_CONV_KIND_GROUP) {
		return nil, nil, apperr.ErrNotGroup
	}
	return c, m, nil
}

func (s *Service) audit(ctx context.Context, q *store.Queries, actor int64, action string, convID, target int64, detail string) error {
	return q.AddAudit(ctx, &store.AuditEntry{
		ID: s.ids.Next(), ActorID: actor, Action: action, ConvID: convID, TargetID: target,
		Detail: detail, CreatedAt: s.now().UnixMilli(),
	})
}

func (s *Service) fanOut(ctx context.Context, rows []*store.Event, extra []int64) {
	for _, r := range rows {
		s.msg.FanOut(ctx, r, extra, 0)
	}
}

func dedupe(ids []int64, exclude int64) []int64 {
	seen := map[int64]bool{exclude: true}
	var out []int64
	for _, id := range ids {
		if id != 0 && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// checkUsers fails with ErrUserNotFound unless every id is an account that is not banned.
func checkUsers(ctx context.Context, q *store.Queries, ids []int64) error {
	users, err := q.GetUsers(ctx, ids)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if u := users[id]; u == nil || u.Banned {
			return apperr.ErrUserNotFound
		}
	}
	return nil
}

// CreateGroup creates a channel with the creator as owner. A private channel
// gets the listed members; a public one (site admins only) gets everyone.
func (s *Service) CreateGroup(ctx context.Context, me *store.User, req *amv1.CreateGroupRequest) (*amv1.Conversation, error) {
	if req.GetPublic() && !me.IsSiteAdmin {
		return nil, apperr.ErrNoPermission
	}
	return s.createGroup(ctx, me, req.GetName(), req.GetMemberIds(), req.GetPublic())
}

func (s *Service) createGroup(ctx context.Context, me *store.User, rawName string, memberIDs []int64, public bool) (*amv1.Conversation, error) {
	name, err := validGroupName(rawName)
	if err != nil {
		return nil, err
	}
	ids := dedupe(memberIDs, me.ID)
	if !public && len(ids)+1 > s.limits.MaxGroupMembers {
		return nil, apperr.ErrGroupFull
	}
	convID := s.ids.Next()
	now := s.now().UnixMilli()
	var rows []*store.Event
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		if public {
			// Everyone on the server; no "X joined" line per person.
			all, err := q.ActiveUserIDs(ctx)
			if err != nil {
				return err
			}
			ids = dedupe(all, me.ID)
		} else if err := checkUsers(ctx, q, ids); err != nil {
			return err
		}
		c := &store.Conversation{ID: convID, Kind: int16(amv1.ConvKind_CONV_KIND_GROUP), Name: name, OwnerID: me.ID,
			Public: public, CreatedAt: now}
		if err := q.CreateConversation(ctx, c, ""); err != nil {
			return err
		}
		if err := q.AddMember(ctx, &store.Member{ConvID: convID, UserID: me.ID, Role: roleOwner, JoinedAt: now}); err != nil {
			return err
		}
		row, err := s.msg.AppendSystem(ctx, q, convID, me.ID, &amv1.Event{Body: &amv1.Event_SysConv{SysConv: &amv1.SysConv{
			OperatorId: me.ID, Name: &name, Created: true,
		}}})
		if err != nil {
			return err
		}
		rows = append(rows, row)
		for _, id := range ids {
			if err := q.AddMember(ctx, &store.Member{ConvID: convID, UserID: id, Role: roleMember, JoinedAt: now}); err != nil {
				return err
			}
			if public {
				continue
			}
			row, err := s.msg.AppendSystem(ctx, q, convID, me.ID, sysMember(amv1.SysMember_ACTION_JOIN, id, me.ID))
			if err != nil {
				return err
			}
			rows = append(rows, row)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Conversation first, so clients know it before its events arrive.
	s.pushConv(ctx, convID, append([]int64{me.ID}, ids...))
	s.fanOut(ctx, rows, nil)
	return s.ConvView(ctx, convID, me.ID)
}

// InviteMembers adds people to a channel, or files join requests when the
// channel needs approval and the inviter is not an admin.
func (s *Service) InviteMembers(ctx context.Context, me *store.User, convID int64, userIDs []int64) (*amv1.InviteMembersResponse, error) {
	ids := dedupe(userIDs, me.ID)
	out := &amv1.InviteMembersResponse{}
	var rows []*store.Event
	now := s.now().UnixMilli()
	needsApproval := false
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		c, m, err := loadGroupTx(ctx, q, convID, me.ID)
		if err != nil {
			return err
		}
		// Anyone may join a public channel anyway, so no approval there.
		needsApproval = !c.Public && c.JoinApproval && m.Role < roleAdmin
		public := c.Public
		if err := checkUsers(ctx, q, ids); err != nil {
			return err
		}
		count, err := q.CountMembers(ctx, convID)
		if err != nil {
			return err
		}
		for _, id := range ids {
			if _, err := q.GetMember(ctx, convID, id); err == nil {
				continue // already in
			} else if !errors.Is(err, store.ErrNotFound) {
				return err
			}
			if needsApproval {
				if err := q.UpsertJoinRequest(ctx, &store.JoinRequest{ConvID: convID, UserID: id, InviterID: me.ID, CreatedAt: now}); err != nil {
					return err
				}
				out.Requested = append(out.Requested, id)
				continue
			}
			if !public && count >= s.limits.MaxGroupMembers {
				return apperr.ErrGroupFull
			}
			if err := q.AddMember(ctx, &store.Member{ConvID: convID, UserID: id, Role: roleMember, JoinedAt: now}); err != nil {
				return err
			}
			_ = q.DeleteJoinRequest(ctx, convID, id) // drop a stale request, if any
			count++
			row, err := s.msg.AppendSystem(ctx, q, convID, me.ID, sysMember(amv1.SysMember_ACTION_JOIN, id, me.ID))
			if err != nil {
				return err
			}
			rows = append(rows, row)
			out.Added = append(out.Added, id)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.pushConv(ctx, convID, out.Added)
	s.fanOut(ctx, rows, nil)
	if len(out.Requested) > 0 {
		s.notifyJoinRequests(ctx, convID, me.ID, out.Requested)
	}
	return out, nil
}

func (s *Service) notifyJoinRequests(ctx context.Context, convID, inviterID int64, userIDs []int64) {
	roles, err := s.st.MemberRoles(ctx, []int64{convID})
	if err != nil {
		return
	}
	var admins []int64
	for _, m := range roles[convID] {
		if m.Role >= roleAdmin {
			admins = append(admins, m.UserID)
		}
	}
	users, err := s.usersView(ctx, append([]int64{inviterID}, userIDs...))
	if err != nil {
		return
	}
	for _, id := range userIDs {
		s.push.ToUsers(admins, &amv1.ServerFrame{Msg: &amv1.ServerFrame_JoinRequest{JoinRequest: &amv1.JoinRequestPush{
			ConvId: convID, User: users[id], Inviter: users[inviterID],
		}}}, 0)
	}
}

// RemoveMember: target == me leaves; otherwise kicks (needs a higher role).
func (s *Service) RemoveMember(ctx context.Context, me *store.User, convID, target int64) error {
	var row *store.Event
	reason := amv1.ConvRemovedPush_REASON_LEFT
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		_, m, err := loadGroupTx(ctx, q, convID, me.ID)
		if err != nil {
			return err
		}
		if target == me.ID {
			if m.Role == roleOwner {
				return apperr.ErrOwnerCannotLeave
			}
			if err := q.RemoveMember(ctx, convID, me.ID); err != nil {
				return err
			}
			row, err = s.msg.AppendSystem(ctx, q, convID, me.ID, sysMember(amv1.SysMember_ACTION_LEAVE, me.ID, me.ID))
			return err
		}
		t, err := q.GetMember(ctx, convID, target)
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotInGroup
		}
		if err != nil {
			return err
		}
		if m.Role < roleAdmin || m.Role <= t.Role {
			return apperr.ErrNoPermission
		}
		if err := q.RemoveMember(ctx, convID, target); err != nil {
			return err
		}
		reason = amv1.ConvRemovedPush_REASON_KICKED
		row, err = s.msg.AppendSystem(ctx, q, convID, me.ID, sysMember(amv1.SysMember_ACTION_KICK, target, me.ID))
		if err != nil {
			return err
		}
		return s.audit(ctx, q, me.ID, "kick", convID, target, "")
	})
	if err != nil {
		return err
	}
	s.msg.FanOut(ctx, row, []int64{target}, 0)
	s.push.ToUsers([]int64{target}, &amv1.ServerFrame{Msg: &amv1.ServerFrame_ConvRemoved{ConvRemoved: &amv1.ConvRemovedPush{
		ConvId: convID, Reason: reason,
	}}}, 0)
	return nil
}

// UpdateGroup changes name / avatar / notice / join approval (admins and owner).
func (s *Service) UpdateGroup(ctx context.Context, me *store.User, convID int64, req *amv1.UpdateGroupRequest) (*amv1.Conversation, error) {
	change := &amv1.SysConv{OperatorId: me.ID}
	var name, notice *string
	var avatarMedia *int64
	if req.Name != nil {
		n, err := validGroupName(req.GetName())
		if err != nil {
			return nil, err
		}
		name, change.Name = &n, &n
	}
	if req.Notice != nil {
		n := strings.TrimSpace(req.GetNotice())
		if utf8.RuneCountInString(n) > maxNoticeLen {
			return nil, apperr.ErrNoticeTooLong
		}
		notice, change.Notice = &n, &n
	}
	if req.AvatarMediaId != nil {
		id := req.GetAvatarMediaId()
		url := ""
		if id != 0 {
			m, err := s.media.OwnUpload(ctx, me.ID, id, true)
			if err != nil {
				return nil, err
			}
			url = fmt.Sprintf("/api/v1/media/%d", m.ID)
		}
		avatarMedia, change.Avatar = &id, &url
	}
	change.JoinApproval = req.JoinApproval
	if name == nil && notice == nil && avatarMedia == nil && req.JoinApproval == nil {
		return s.ConvView(ctx, convID, me.ID)
	}

	var row *store.Event
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		_, m, err := loadGroupTx(ctx, q, convID, me.ID)
		if err != nil {
			return err
		}
		if m.Role < roleAdmin {
			return apperr.ErrNoPermission
		}
		if err := q.UpdateConvInfo(ctx, convID, name, avatarMedia, notice, req.JoinApproval); err != nil {
			return err
		}
		row, err = s.msg.AppendSystem(ctx, q, convID, me.ID, &amv1.Event{Body: &amv1.Event_SysConv{SysConv: change}})
		return err
	})
	if err != nil {
		return nil, err
	}
	s.msg.FanOut(ctx, row, nil, 0)
	return s.ConvView(ctx, convID, me.ID)
}

// SetAdmin makes a member an admin or back to a member (owner only).
func (s *Service) SetAdmin(ctx context.Context, me *store.User, convID, target int64, admin bool) error {
	newRole := roleMember
	if admin {
		newRole = roleAdmin
	}
	var row *store.Event
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		_, m, err := loadGroupTx(ctx, q, convID, me.ID)
		if err != nil {
			return err
		}
		if m.Role != roleOwner || target == me.ID {
			return apperr.ErrNoPermission
		}
		t, err := q.GetMember(ctx, convID, target)
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotInGroup
		}
		if err != nil {
			return err
		}
		if t.Role == newRole {
			return nil
		}
		if err := q.SetMemberRole(ctx, convID, target, newRole); err != nil {
			return err
		}
		ev := sysMember(amv1.SysMember_ACTION_ROLE_CHANGE, target, me.ID)
		ev.GetSysMember().NewRole = amv1.MemberRole(newRole)
		row, err = s.msg.AppendSystem(ctx, q, convID, me.ID, ev)
		return err
	})
	if err != nil || row == nil {
		return err
	}
	s.msg.FanOut(ctx, row, nil, 0)
	return nil
}

// Transfer hands ownership to another member; the old owner becomes a member.
func (s *Service) Transfer(ctx context.Context, me *store.User, convID, target int64) error {
	var rows []*store.Event
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		_, m, err := loadGroupTx(ctx, q, convID, me.ID)
		if err != nil {
			return err
		}
		if m.Role != roleOwner {
			return apperr.ErrNoPermission
		}
		if target == me.ID {
			return apperr.ErrSelf
		}
		if _, err := q.GetMember(ctx, convID, target); errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotInGroup
		} else if err != nil {
			return err
		}
		if err := q.SetMemberRole(ctx, convID, target, roleOwner); err != nil {
			return err
		}
		if err := q.SetMemberRole(ctx, convID, me.ID, roleMember); err != nil {
			return err
		}
		if err := q.SetConvOwner(ctx, convID, target); err != nil {
			return err
		}
		for _, change := range []struct {
			user int64
			role int16
		}{{target, roleOwner}, {me.ID, roleMember}} {
			ev := sysMember(amv1.SysMember_ACTION_ROLE_CHANGE, change.user, me.ID)
			ev.GetSysMember().NewRole = amv1.MemberRole(change.role)
			row, err := s.msg.AppendSystem(ctx, q, convID, me.ID, ev)
			if err != nil {
				return err
			}
			rows = append(rows, row)
		}
		return s.audit(ctx, q, me.ID, "transfer", convID, target, "")
	})
	if err != nil {
		return err
	}
	s.fanOut(ctx, rows, nil)
	return nil
}

// Dissolve ends a group (owner only). History stays on the server.
func (s *Service) Dissolve(ctx context.Context, me *store.User, convID int64) error {
	var row *store.Event
	var members []int64
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		_, m, err := loadGroupTx(ctx, q, convID, me.ID)
		if err != nil {
			return err
		}
		if m.Role != roleOwner {
			return apperr.ErrNoPermission
		}
		ids, err := q.MemberIDs(ctx, []int64{convID})
		if err != nil {
			return err
		}
		members = ids[convID]
		row, err = s.msg.AppendSystem(ctx, q, convID, me.ID, &amv1.Event{Body: &amv1.Event_SysConv{SysConv: &amv1.SysConv{
			OperatorId: me.ID, Dissolved: true,
		}}})
		if err != nil {
			return err
		}
		if err := q.MarkDissolved(ctx, convID); err != nil {
			return err
		}
		return s.audit(ctx, q, me.ID, "dissolve", convID, 0, "")
	})
	if err != nil {
		return err
	}
	s.msg.FanOut(ctx, row, members, 0)
	s.push.ToUsers(members, &amv1.ServerFrame{Msg: &amv1.ServerFrame_ConvRemoved{ConvRemoved: &amv1.ConvRemovedPush{
		ConvId: convID, Reason: amv1.ConvRemovedPush_REASON_DISSOLVED,
	}}}, 0)
	return nil
}

// Mute stops a member from sending for a while (needs a higher role).
func (s *Service) Mute(ctx context.Context, me *store.User, convID int64, req *amv1.MuteMemberRequest) error {
	target := req.GetUserId()
	d := time.Duration(req.GetDurationSeconds()) * time.Second
	if d < 0 {
		return apperr.ErrBadRequest
	}
	if d > maxMute {
		d = maxMute
	}
	var until int64
	action := amv1.SysMember_ACTION_UNMUTE
	if d > 0 {
		until = s.now().Add(d).UnixMilli()
		action = amv1.SysMember_ACTION_MUTE
	}
	var row *store.Event
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		_, m, err := loadGroupTx(ctx, q, convID, me.ID)
		if err != nil {
			return err
		}
		t, err := q.GetMember(ctx, convID, target)
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotInGroup
		}
		if err != nil {
			return err
		}
		if m.Role < roleAdmin || m.Role <= t.Role {
			return apperr.ErrNoPermission
		}
		if err := q.SetMemberMute(ctx, convID, target, until); err != nil {
			return err
		}
		ev := sysMember(action, target, me.ID)
		ev.GetSysMember().Until = until
		row, err = s.msg.AppendSystem(ctx, q, convID, me.ID, ev)
		if err != nil {
			return err
		}
		return s.audit(ctx, q, me.ID, "mute", convID, target, fmt.Sprintf("until=%d", until))
	})
	if err != nil {
		return err
	}
	s.msg.FanOut(ctx, row, nil, 0)
	return nil
}

func (s *Service) requireGroupAdmin(ctx context.Context, convID, userID int64) error {
	c, err := s.st.GetConvForUser(ctx, convID, userID)
	if errors.Is(err, store.ErrNotFound) {
		return apperr.ErrNotMember
	}
	if err != nil {
		return err
	}
	if c.Kind != int16(amv1.ConvKind_CONV_KIND_GROUP) {
		return apperr.ErrNotGroup
	}
	if c.Self.Role < roleAdmin {
		return apperr.ErrNoPermission
	}
	return nil
}

func (s *Service) ListJoinRequests(ctx context.Context, me *store.User, convID int64) (*amv1.ListJoinRequestsResponse, error) {
	if err := s.requireGroupAdmin(ctx, convID, me.ID); err != nil {
		return nil, err
	}
	list, err := s.st.ListJoinRequests(ctx, convID)
	if err != nil {
		return nil, err
	}
	var ids []int64
	for _, r := range list {
		ids = append(ids, r.UserID, r.InviterID)
	}
	users, err := s.usersView(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListJoinRequestsResponse{}
	for _, r := range list {
		out.Requests = append(out.Requests, &amv1.JoinRequestInfo{
			User: users[r.UserID], Inviter: users[r.InviterID], CreatedAt: r.CreatedAt,
		})
	}
	return out, nil
}

// DecideJoinRequest approves or rejects a pending request (admins and owner).
func (s *Service) DecideJoinRequest(ctx context.Context, me *store.User, convID, userID int64, approve bool) error {
	var row *store.Event
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		_, m, err := loadGroupTx(ctx, q, convID, me.ID)
		if err != nil {
			return err
		}
		if m.Role < roleAdmin {
			return apperr.ErrNoPermission
		}
		if err := q.DeleteJoinRequest(ctx, convID, userID); errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNoJoinRequest
		} else if err != nil {
			return err
		}
		if !approve {
			return nil
		}
		if _, err := q.GetMember(ctx, convID, userID); err == nil {
			return nil // joined meanwhile
		}
		count, err := q.CountMembers(ctx, convID)
		if err != nil {
			return err
		}
		if count >= s.limits.MaxGroupMembers {
			return apperr.ErrGroupFull
		}
		if err := q.AddMember(ctx, &store.Member{ConvID: convID, UserID: userID, Role: roleMember, JoinedAt: s.now().UnixMilli()}); err != nil {
			return err
		}
		row, err = s.msg.AppendSystem(ctx, q, convID, me.ID, sysMember(amv1.SysMember_ACTION_JOIN, userID, me.ID))
		return err
	})
	if err != nil || row == nil {
		return err
	}
	s.pushConv(ctx, convID, []int64{userID})
	s.msg.FanOut(ctx, row, nil, 0)
	return nil
}
