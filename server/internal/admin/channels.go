package admin

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/message"
)

// Channel history: read-only view of every channel (public and private).
// Direct messages are never shown. Opening a channel is audited.

const historyPage = 50

func (h *handler) listChannels(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	limit, offset := page(r, 50)
	list, total, err := a.Store.ListChannelsAdmin(r.Context(), int16(amv1.ConvKind_CONV_KIND_GROUP),
		strings.TrimSpace(r.URL.Query().Get("q")), limit, offset)
	if err != nil {
		h.fail(w, err)
		return
	}
	out := []map[string]any{}
	for _, c := range list {
		out = append(out, map[string]any{
			"id": id64(c.ID), "name": c.Name, "avatar_media_id": id64(c.AvatarMediaID), "public": c.Public,
			"dissolved": c.Dissolved, "owner_name": c.OwnerName, "members": c.Members, "messages": c.LastSeq,
			"created_at": c.CreatedAt,
		})
	}
	writeJSON(w, map[string]any{"items": out, "total": total, "page_size": limit})
}

// channelEvents returns one page of history, oldest first. ?before=<seq>
// pages backwards; without it the latest page is returned and the visit is
// written to the audit log.
func (h *handler) channelEvents(w http.ResponseWriter, r *http.Request) {
	a, _, okk := h.running(w)
	if !okk {
		return
	}
	id, okID := pathID(r)
	if !okID {
		writeErr(w, http.StatusBadRequest, "bad_request", "bad channel id")
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	ctx := r.Context()
	c, events, err := a.Account.ChannelHistory(ctx, account.PanelActor, id, before, historyPage)
	if err != nil {
		h.fail(w, err)
		return
	}
	// Names of everyone the page mentions, and which messages were struck.
	ids := map[int64]bool{}
	var msgIDs []int64
	protos := make([]*amv1.Event, len(events))
	for i, row := range events {
		ev, err := message.ToProto(row, 0)
		if err != nil {
			h.fail(w, err)
			return
		}
		protos[i] = ev
		ids[ev.SenderId] = true
		ids[ev.GetRedaction().GetDeletedBy()] = true
		ids[ev.GetSysMember().GetTargetUserId()] = true
		ids[ev.GetSysMember().GetOperatorId()] = true
		ids[ev.GetSysConv().GetOperatorId()] = true
		msgIDs = append(msgIDs, ev.EventId)
	}
	idList := make([]int64, 0, len(ids))
	for id := range ids {
		if id != 0 {
			idList = append(idList, id)
		}
	}
	users, err := a.Store.GetUsers(ctx, idList)
	if err != nil {
		h.fail(w, err)
		return
	}
	struck, err := a.Store.StruckTargets(ctx, msgIDs, message.KindStrike)
	if err != nil {
		h.fail(w, err)
		return
	}
	name := func(id int64) string {
		if u := users[id]; u != nil {
			return u.DisplayName
		}
		return "(已不存在)"
	}
	items := []map[string]any{}
	for i := len(protos) - 1; i >= 0; i-- { // oldest first
		ev := protos[i]
		item := map[string]any{
			"event_id": id64(ev.EventId), "seq": ev.Seq, "sender_id": id64(ev.SenderId), "sender_name": name(ev.SenderId),
			"at": ev.CreatedAt, "struck": struck[ev.EventId],
		}
		if u := users[ev.SenderId]; u != nil && u.AvatarMediaID != 0 {
			item["sender_avatar"] = id64(u.AvatarMediaID)
		}
		if rd := ev.GetRedaction(); rd != nil {
			item["kind"], item["deleted_by"], item["reason"] = "deleted", name(rd.GetDeletedBy()), rd.GetReason()
			items = append(items, item)
			continue
		}
		switch b := ev.GetBody().(type) {
		case *amv1.Event_Text:
			item["kind"], item["text"] = "text", b.Text.GetText()
		case *amv1.Event_Image:
			item["kind"], item["media_id"] = "image", id64(b.Image.GetMediaId())
		case *amv1.Event_File:
			item["kind"], item["media_id"] = "file", id64(b.File.GetMediaId())
			item["file_name"], item["file_size"] = b.File.GetName(), b.File.GetSize()
		case *amv1.Event_SysConv, *amv1.Event_SysMember:
			item["kind"], item["text"] = "sys", sysText(ev, name)
		default:
			continue // strikes and admin deletes change other messages
		}
		items = append(items, item)
	}
	writeJSON(w, map[string]any{
		"channel": map[string]any{"id": id64(c.ID), "name": c.Name, "public": c.Public, "dissolved": c.Dissolved},
		"items":   items,
		// Seq to pass as ?before= for the previous page; 0 = this is the start.
		"before": func() int64 {
			if len(events) < historyPage || events[len(events)-1].Seq <= 1 {
				return 0
			}
			return events[len(events)-1].Seq
		}(),
	})
}

// sysText describes a system event, like the client does.
func sysText(ev *amv1.Event, name func(int64) string) string {
	// The operator defaults to the sender (the client does the same).
	opOf := func(id int64) int64 {
		if id == 0 {
			return ev.SenderId
		}
		return id
	}
	if c := ev.GetSysConv(); c != nil {
		op := name(opOf(c.GetOperatorId()))
		switch {
		case c.GetCreated():
			return op + " 创建了频道"
		case c.GetDissolved():
			return op + " 解散了频道"
		case c.Name != nil:
			return op + " 把频道名改为「" + c.GetName() + "」"
		case c.Notice != nil:
			return op + " 修改了频道公告"
		case c.Avatar != nil:
			return op + " 更换了频道头像"
		case c.JoinApproval != nil:
			if c.GetJoinApproval() {
				return op + " 开启了加入审批"
			}
			return op + " 关闭了加入审批"
		}
		return op + " 修改了频道信息"
	}
	m := ev.GetSysMember()
	opID := opOf(m.GetOperatorId())
	op, target := name(opID), name(m.GetTargetUserId())
	switch m.GetAction() {
	case amv1.SysMember_ACTION_JOIN:
		if opID == m.GetTargetUserId() {
			return target + " 加入了频道"
		}
		return op + " 邀请 " + target + " 加入了频道"
	case amv1.SysMember_ACTION_LEAVE:
		return target + " 退出了频道"
	case amv1.SysMember_ACTION_KICK:
		return op + " 把 " + target + " 移出了频道"
	case amv1.SysMember_ACTION_MUTE:
		return fmt.Sprintf("%s 禁言了 %s，到 %s", op, target, time.UnixMilli(m.GetUntil()).Format("2006-01-02 15:04"))
	case amv1.SysMember_ACTION_UNMUTE:
		return op + " 解除了 " + target + " 的禁言"
	case amv1.SysMember_ACTION_ROLE_CHANGE:
		switch m.GetNewRole() {
		case amv1.MemberRole_MEMBER_ROLE_OWNER:
			return target + " 成为了频道主"
		case amv1.MemberRole_MEMBER_ROLE_ADMIN:
			return op + " 把 " + target + " 设为了管理员"
		}
		return target + " 现在是普通成员"
	}
	return "成员变动"
}
