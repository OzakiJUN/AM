// Package profile serves profile pages (a user's, or the server's): boards
// of widgets saved as versioned layouts, the numbers for the stats widget,
// and guestbook entries. See docs/design.md §7 and §8.
package profile

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/conv"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/message"
	"github.com/OzakiJUN/am/server/internal/store"
)

const (
	guestbookPage    = 30
	guestbookMaxText = 200
	// At most this many guestbook entries per person per minute.
	guestbookPerMinute = 3
)

var messageKinds = []int16{message.KindText, message.KindImage, message.KindFile}

type Service struct {
	st        *store.Store
	ids       *idgen.Generator
	acct      *account.Service
	conv      *conv.Service
	media     *media.Service
	retention config.Retention
	now       func() time.Time
}

func New(st *store.Store, ids *idgen.Generator, acct *account.Service, cs *conv.Service, md *media.Service, retention config.Retention) *Service {
	return &Service{st: st, ids: ids, acct: acct, conv: cs, media: md, retention: retention, now: time.Now}
}

// Owner names a profile: a user's (Kind = store.ProfileUser, ID = user id)
// or the server's (store.ProfileServer, 0).
type Owner struct {
	Kind int16
	ID   int64
}

func UserProfile(id int64) Owner { return Owner{store.ProfileUser, id} }

var ServerProfile = Owner{store.ProfileServer, 0}

// latest loads the current layout (empty, version 0, when never saved).
func (s *Service) latest(ctx context.Context, q *store.Queries, o Owner) (*amv1.ProfileLayout, error) {
	version, data, err := q.LatestLayout(ctx, o.Kind, o.ID)
	if errors.Is(err, store.ErrNotFound) {
		return &amv1.ProfileLayout{}, nil
	}
	if err != nil {
		return nil, err
	}
	l := &amv1.ProfileLayout{}
	if err := proto.Unmarshal(data, l); err != nil {
		return nil, err
	}
	l.Version = version
	return l, nil
}

// rights is what a viewer may do on a profile.
type rights struct {
	layout     bool
	content    func(w *amv1.Widget) bool
	setEditors bool
}

func (s *Service) rights(ctx context.Context, viewer *store.User, o Owner) (*rights, error) {
	all := func(*amv1.Widget) bool { return true }
	none := func(*amv1.Widget) bool { return false }
	if o.Kind == store.ProfileUser {
		if viewer.ID == o.ID {
			return &rights{layout: true, content: all}, nil
		}
		return &rights{content: none}, nil
	}
	if viewer.IsSiteAdmin {
		return &rights{layout: true, content: all, setEditors: true}, nil
	}
	set, err := s.acct.ProfileSettings(ctx)
	if err != nil {
		return nil, err
	}
	r := &rights{layout: set.LayoutEditors == "everyone", content: none}
	if set.WidgetContentEditable {
		r.content = func(w *amv1.Widget) bool { return w.GetContentEditors() != amv1.WidgetEditors_WIDGET_EDITORS_ADMINS }
	}
	return r, nil
}

// checkOwner makes sure a user profile belongs to an active account.
func (s *Service) checkOwner(ctx context.Context, o Owner) (*store.User, error) {
	if o.Kind != store.ProfileUser {
		return nil, nil
	}
	u, err := s.st.GetUser(ctx, o.ID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && u.Gone()) {
		return nil, apperr.ErrUserNotFound
	}
	return u, err
}

// Get returns a profile page as viewer sees it.
func (s *Service) Get(ctx context.Context, viewer *store.User, o Owner) (*amv1.ProfileView, error) {
	owner, err := s.checkOwner(ctx, o)
	if err != nil {
		return nil, err
	}
	l, err := s.latest(ctx, s.st.Queries, o)
	if err != nil {
		return nil, err
	}
	r, err := s.rights(ctx, viewer, o)
	if err != nil {
		return nil, err
	}
	out := &amv1.ProfileView{Layout: l, CanEditLayout: r.layout, CanSetWidgetEditors: r.setEditors}
	for _, w := range l.GetWidgets() {
		if r.content(w) {
			out.EditableWidgetIds = append(out.EditableWidgetIds, w.GetId())
		}
	}
	if out.Stats, err = s.stats(ctx, o, owner); err != nil {
		return nil, err
	}
	if owner != nil {
		if out.User, err = s.conv.UserView(ctx, owner); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Service) stats(ctx context.Context, o Owner, owner *store.User) (*amv1.ProfileStats, error) {
	st := &amv1.ProfileStats{}
	if owner != nil {
		n, err := s.st.CountMessages(ctx, owner.ID, messageKinds)
		if err != nil {
			return nil, err
		}
		days, err := s.st.RecentDays(ctx, owner.ID, 400)
		if err != nil {
			return nil, err
		}
		st.Messages, st.StreakDays, st.JoinedAt = n, streak(days, s.now()), owner.CreatedAt
		return st, nil
	}
	members, err := s.st.CountActiveUsers(ctx)
	if err != nil {
		return nil, err
	}
	msgs, err := s.st.CountMessages(ctx, 0, messageKinds)
	if err != nil {
		return nil, err
	}
	channels, err := s.st.CountChannels(ctx, int16(amv1.ConvKind_CONV_KIND_GROUP))
	if err != nil {
		return nil, err
	}
	created, err := s.st.FirstAccountAt(ctx)
	if err != nil {
		return nil, err
	}
	st.Members, st.Messages, st.Channels, st.CreatedAt = int32(members), msgs, int32(channels), created
	return st, nil
}

// streak counts consecutive days (newest first, yyyymmdd) ending today or
// yesterday (today may not have a login yet).
func streak(days []int, now time.Time) int32 {
	if len(days) == 0 {
		return 0
	}
	d := now
	if days[0] != account.DayKey(d) {
		d = d.AddDate(0, 0, -1)
		if days[0] != account.DayKey(d) {
			return 0
		}
	}
	n := int32(0)
	for _, day := range days {
		if day != account.DayKey(d) {
			break
		}
		n++
		d = d.AddDate(0, 0, -1)
	}
	return n
}

// Save stores a new version of a profile's layout. Every change is checked
// against what the actor may do: layout changes (add, remove, move, resize,
// background) need layout rights; changing a widget's contents needs content
// rights for it; per-widget content editors are site-admin only.
func (s *Service) Save(ctx context.Context, actor *store.User, o Owner, req *amv1.SaveProfileRequest) (*amv1.ProfileView, error) {
	if _, err := s.checkOwner(ctx, o); err != nil {
		return nil, err
	}
	next := req.GetLayout()
	if next == nil {
		next = &amv1.ProfileLayout{}
	}
	next = proto.Clone(next).(*amv1.ProfileLayout)
	if o.Kind == store.ProfileUser {
		for _, w := range next.GetWidgets() {
			w.ContentEditors = amv1.WidgetEditors_WIDGET_EDITORS_UNSPECIFIED
		}
	}
	media, err := validate(next, o.Kind)
	if err != nil {
		return nil, err
	}
	r, err := s.rights(ctx, actor, o)
	if err != nil {
		return nil, err
	}
	if o.Kind == store.ProfileUser && actor.ID != o.ID {
		return nil, apperr.ErrNoPermission // only the owner saves a personal profile
	}
	cur, err := s.latest(ctx, s.st.Queries, o)
	if err != nil {
		return nil, err
	}
	if cur.GetVersion() != req.GetBaseVersion() {
		return nil, apperr.ErrLayoutConflict
	}
	if err := allowed(cur, next, r); err != nil {
		return nil, err
	}
	// New media must be the actor's own uploads (images).
	old := map[int64]bool{}
	if curMedia, err := validate(cur, o.Kind); err == nil {
		for _, ids := range curMedia {
			for _, id := range ids {
				old[id] = true
			}
		}
	}
	var all []int64
	for _, ids := range media {
		for _, id := range ids {
			if !old[id] {
				if _, err := s.media.OwnUpload(ctx, actor.ID, id, true); err != nil {
					return nil, err
				}
			}
			all = append(all, id)
		}
	}
	if err := s.store(ctx, o, cur.GetVersion(), next, all, actor.ID); err != nil {
		return nil, err
	}
	return s.Get(ctx, actor, o)
}

// store writes version base+1 (conflict if someone got there first).
func (s *Service) store(ctx context.Context, o Owner, base int64, l *amv1.ProfileLayout, media []int64, by int64) error {
	now := s.now().UnixMilli()
	l.Version, l.UpdatedAt, l.UpdatedBy = 0, now, by
	data, err := proto.Marshal(l)
	if err != nil {
		return err
	}
	return s.st.InTx(ctx, func(q *store.Queries) error {
		v, _, err := q.LatestLayout(ctx, o.Kind, o.ID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if v != base {
			return apperr.ErrLayoutConflict
		}
		if err := q.AddLayout(ctx, o.Kind, o.ID, base+1, data, by, now); err != nil {
			if store.IsUniqueViolation(err) {
				return apperr.ErrLayoutConflict
			}
			return err
		}
		if err := q.SetProfileMedia(ctx, o.Kind, o.ID, media); err != nil {
			return err
		}
		if o.Kind == store.ProfileServer {
			return q.AddAudit(ctx, &store.AuditEntry{ID: s.ids.Next(), ActorID: by, Action: "server_layout", CreatedAt: now})
		}
		return nil
	})
}

// allowed compares two layouts against the actor's rights.
func allowed(cur, next *amv1.ProfileLayout, r *rights) error {
	if r.layout && r.setEditors {
		return nil // site admin / profile owner
	}
	before := map[string]*amv1.Widget{}
	for _, w := range cur.GetWidgets() {
		before[w.GetId()] = w
	}
	layoutChanged := len(cur.GetWidgets()) != len(next.GetWidgets()) || cur.GetPortraitCustom() != next.GetPortraitCustom() ||
		!proto.Equal(cur.GetBackground(), next.GetBackground())
	for _, w := range next.GetWidgets() {
		b := before[w.GetId()]
		if b == nil {
			layoutChanged = true // added (its first contents come with it)
			continue
		}
		if b.GetKind() != w.GetKind() || b.GetSource() != w.GetSource() || b.GetW() != w.GetW() || b.GetH() != w.GetH() ||
			!proto.Equal(b.GetLandscape(), w.GetLandscape()) || !proto.Equal(b.GetPortrait(), w.GetPortrait()) ||
			b.GetWorkshopId() != w.GetWorkshopId() || b.GetWorkshopVersion() != w.GetWorkshopVersion() ||
			b.GetPackageSha256() != w.GetPackageSha256() {
			layoutChanged = true
		}
		if b.GetContentEditors() != w.GetContentEditors() && !r.setEditors {
			return apperr.ErrNoPermission
		}
		if (b.GetConfig() != w.GetConfig() || b.GetSnapshotMediaId() != w.GetSnapshotMediaId()) && !r.content(b) {
			return apperr.ErrNoPermission
		}
	}
	if layoutChanged && !r.layout {
		return apperr.ErrNoPermission
	}
	return nil
}

// Clear empties a user's profile (admin panel, for content that breaks the
// rules). The old layout stays as an older version until it is purged.
func (s *Service) Clear(ctx context.Context, actorID, userID int64) error {
	o := UserProfile(userID)
	if _, err := s.st.GetUser(ctx, userID); errors.Is(err, store.ErrNotFound) {
		return apperr.ErrUserNotFound
	} else if err != nil {
		return err
	}
	cur, err := s.latest(ctx, s.st.Queries, o)
	if err != nil {
		return err
	}
	if err := s.store(ctx, o, cur.GetVersion(), &amv1.ProfileLayout{}, nil, actorID); err != nil {
		return err
	}
	return s.st.AddAudit(ctx, &store.AuditEntry{ID: s.ids.Next(), ActorID: actorID, Action: "profile_clear",
		TargetID: userID, CreatedAt: s.now().UnixMilli()})
}

// ---- guestbook ----

// guestbookWidget checks that the profile has a guestbook widget with this id.
func (s *Service) guestbookWidget(ctx context.Context, o Owner, widgetID string) error {
	l, err := s.latest(ctx, s.st.Queries, o)
	if err != nil {
		return err
	}
	for _, w := range l.GetWidgets() {
		if w.GetId() == widgetID && w.GetKind() == "guestbook" && w.GetSource() == amv1.WidgetSource_WIDGET_SOURCE_BUILTIN {
			return nil
		}
	}
	return apperr.ErrNotFound
}

// canHide: the profile's owner, or a site admin.
func canHide(viewer *store.User, o Owner) bool {
	return viewer.IsSiteAdmin || (o.Kind == store.ProfileUser && o.ID == viewer.ID)
}

func (s *Service) ListGuestbook(ctx context.Context, viewer *store.User, o Owner, widgetID string, before int64) (*amv1.ListGuestbookResponse, error) {
	if _, err := s.checkOwner(ctx, o); err != nil {
		return nil, err
	}
	if err := s.guestbookWidget(ctx, o, widgetID); err != nil {
		return nil, err
	}
	hide := canHide(viewer, o)
	rows, err := s.st.ListGuestbook(ctx, o.Kind, o.ID, widgetID, before, guestbookPage, hide)
	if err != nil {
		return nil, err
	}
	out := &amv1.ListGuestbookResponse{CanHide: hide}
	ids := make([]int64, 0, len(rows))
	for _, e := range rows {
		ids = append(ids, e.AuthorID)
	}
	users, err := s.conv.UsersView(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, e := range rows {
		out.Entries = append(out.Entries, &amv1.GuestbookEntry{
			Id: e.ID, Author: users[e.AuthorID], Text: e.Text, CreatedAt: e.CreatedAt, Hidden: e.HiddenBy != 0,
		})
	}
	if len(rows) == guestbookPage {
		out.NextBefore = rows[len(rows)-1].ID
	}
	return out, nil
}

func (s *Service) PostGuestbook(ctx context.Context, author *store.User, o Owner, widgetID, text string) (*amv1.GuestbookEntry, error) {
	if _, err := s.checkOwner(ctx, o); err != nil {
		return nil, err
	}
	if err := s.guestbookWidget(ctx, o, widgetID); err != nil {
		return nil, err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, apperr.ErrEmptyMessage
	}
	if utf8.RuneCountInString(text) > guestbookMaxText {
		return nil, apperr.ErrTooLong
	}
	if o.Kind == store.ProfileUser && o.ID != author.ID {
		blocked, err := s.st.BlockedEither(ctx, author.ID, o.ID)
		if err != nil {
			return nil, err
		}
		if blocked {
			return nil, apperr.ErrBlocked
		}
	}
	now := s.now()
	n, err := s.st.CountGuestbookSince(ctx, author.ID, now.Add(-time.Minute).UnixMilli())
	if err != nil {
		return nil, err
	}
	if n >= guestbookPerMinute {
		return nil, apperr.ErrRateLimited
	}
	e := &store.GuestbookEntry{ID: s.ids.Next(), OwnerKind: o.Kind, OwnerID: o.ID, WidgetID: widgetID,
		AuthorID: author.ID, Text: text, CreatedAt: now.UnixMilli()}
	if err := s.st.AddGuestbook(ctx, e); err != nil {
		return nil, err
	}
	me, err := s.conv.UserView(ctx, author)
	if err != nil {
		return nil, err
	}
	return &amv1.GuestbookEntry{Id: e.ID, Author: me, Text: e.Text, CreatedAt: e.CreatedAt}, nil
}

// HideGuestbook hides an entry from everyone but the owner / admins, or shows it again.
func (s *Service) HideGuestbook(ctx context.Context, actor *store.User, entryID int64, hidden bool) error {
	e, err := s.st.GetGuestbook(ctx, entryID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && e.DeletedBy != 0) {
		return apperr.ErrNotFound
	}
	if err != nil {
		return err
	}
	if !canHide(actor, Owner{e.OwnerKind, e.OwnerID}) {
		return apperr.ErrNoPermission
	}
	by, at := int64(0), int64(0)
	if hidden {
		by, at = actor.ID, s.now().UnixMilli()
	}
	return s.st.SetGuestbookHidden(ctx, entryID, by, at)
}

// DeleteGuestbook takes an entry down for everyone (site admins). The text
// is kept as evidence for retention.evidence_days, then purged.
func (s *Service) DeleteGuestbook(ctx context.Context, actor *store.User, entryID int64, reason string) error {
	if !actor.IsSiteAdmin {
		return apperr.ErrNoPermission
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return apperr.ErrReasonRequired
	}
	if utf8.RuneCountInString(reason) > 200 {
		return apperr.ErrBadRequest
	}
	now := s.now()
	purge := now.Add(time.Duration(s.retention.EvidenceDays) * 24 * time.Hour).UnixMilli()
	return s.st.InTx(ctx, func(q *store.Queries) error {
		err := q.DeleteGuestbook(ctx, entryID, actor.ID, reason, now.UnixMilli(), purge)
		if errors.Is(err, store.ErrNotFound) {
			return apperr.ErrNotFound
		}
		if err != nil {
			return err
		}
		return q.AddAudit(ctx, &store.AuditEntry{ID: s.ids.Next(), ActorID: actor.ID, Action: "guestbook_delete",
			Detail: reason, CreatedAt: now.UnixMilli()})
	})
}
