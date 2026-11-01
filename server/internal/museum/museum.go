package museum

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/message"
	"github.com/OzakiJUN/am/server/internal/store"
)

var (
	ErrMuseumOff  = apperr.New(http.StatusForbidden, "museum_off", "the museum is turned off on this server")
	ErrHallFull   = apperr.New(http.StatusConflict, "museum_full", "the first hall is full; choose a position to put it at")
	ErrMuseumNSFW = apperr.New(http.StatusForbidden, "museum_nsfw", "this work is NSFW and this channel doesn't allow NSFW")
	ErrBadTitle   = apperr.New(http.StatusBadRequest, "museum_title", "the title can't be used")
	ErrMuseumBusy = apperr.New(http.StatusConflict, "museum_vote_open", "a vote on this work is still open")
)

// Config is the [museum] section.
type Config struct {
	Enabled     bool
	MinMembers  int
	VoteMinutes int
}

// Service runs the museums.
type Service struct {
	cfg  Config
	st   *store.Store
	ids  *idgen.Generator
	msg  *message.Service
	log  *slog.Logger
	now  func() time.Time
	quit chan struct{}
}

func New(cfg Config, st *store.Store, ids *idgen.Generator, msg *message.Service, log *slog.Logger) *Service {
	return &Service{cfg: cfg, st: st, ids: ids, msg: msg, log: log, now: time.Now, quit: make(chan struct{})}
}

// SetClock replaces the clock (tests).
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// Enabled: museums are on.
func (s *Service) Enabled() bool { return s.cfg.Enabled }

// Run settles votes whose time is up until Close.
func (s *Service) Run() {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.quit:
			return
		case <-t.C:
			if err := s.Settle(context.Background()); err != nil {
				s.log.Error("museum: settle votes", "err", err)
			}
		}
	}
}

// Close stops Run.
func (s *Service) Close() {
	select {
	case <-s.quit:
	default:
		close(s.quit)
	}
}

// action is a change waiting for (or done without) a vote.
type action struct {
	Type   string `json:"type"` // hang | remove | swap
	Art    int64  `json:"art,omitempty"`
	Slot   int    `json:"slot,omitempty"`
	A      int    `json:"a,omitempty"`
	B      int    `json:"b,omitempty"`
	NewArt bool   `json:"new,omitempty"` // a new work: deleted when the vote fails
}

// channel returns the channel I'm in (groups only).
func (s *Service) channel(ctx context.Context, me *store.User, convID int64) (*store.ConvWithSelf, error) {
	if !s.cfg.Enabled {
		return nil, ErrMuseumOff
	}
	c, err := s.st.GetConvForUser(ctx, convID, me.ID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.ErrNotMember
	}
	if err != nil {
		return nil, err
	}
	if c.Kind != int16(amv1.ConvKind_CONV_KIND_GROUP) || c.Dissolved {
		return nil, apperr.ErrNotGroup
	}
	return c, nil
}

func hallOf(arts []*store.MuseumArt) []int64 {
	h := make([]int64, Slots)
	for _, a := range arts {
		if a.Slot >= 1 && a.Slot <= Slots {
			h[a.Slot-1] = a.ID
		}
	}
	return h
}

// View is a channel's museum as I see it.
func (s *Service) View(ctx context.Context, me *store.User, convID int64) (*amv1.MuseumView, error) {
	c, err := s.channel(ctx, me, convID)
	if err != nil {
		return nil, err
	}
	arts, err := s.st.MuseumArtsOfConv(ctx, convID)
	if err != nil {
		return nil, err
	}
	all, err := s.st.HungArtsInPublic(ctx)
	if err != nil {
		return nil, err
	}
	byID := map[int64]*store.MuseumArt{}
	var entries []Entry
	for _, a := range all {
		byID[a.ID] = a
		entries = append(entries, Entry{ID: a.ID, Likes: a.Likes, HungAt: a.HungAt, Created: a.CreatedAt, NSFW: a.NSFW})
	}
	second := Second(entries, c.Nsfw)
	ids := []int64{}
	for _, a := range arts {
		byID[a.ID] = a
		ids = append(ids, a.ID)
	}
	ids = append(ids, second...)
	liked, err := s.st.LikedArts(ctx, me.ID, ids)
	if err != nil {
		return nil, err
	}
	view := func(a *store.MuseumArt) *amv1.MuseumArt {
		v := &amv1.MuseumArt{Id: a.ID, MediaId: a.MediaID, Title: a.Title, ByUserId: a.ByUser, Method: a.Method, Nsfw: a.NSFW,
			Likes: int32(a.Likes), Liked: liked[a.ID], HungAt: a.HungAt, Slot: int32(max(a.Slot, 0)), ConvId: a.ConvID, ConvName: a.ConvName}
		if a.NSFW && !c.Nsfw {
			v.Hidden, v.MediaId = true, 0
		}
		return v
	}
	out := &amv1.MuseumView{NeedsVote: false, VoteMinutes: int32(s.cfg.VoteMinutes)}
	n, err := s.st.CountMembers(ctx, convID)
	if err != nil {
		return nil, err
	}
	out.NeedsVote = NeedsVote(n, s.cfg.MinMembers)
	for i, id := range hallOf(arts) {
		if id == 0 {
			out.Hall = append(out.Hall, &amv1.MuseumArt{Slot: int32(i + 1)})
		} else {
			out.Hall = append(out.Hall, view(byID[id]))
		}
	}
	for _, id := range second {
		out.Second = append(out.Second, view(byID[id]))
	}
	for _, a := range arts {
		if a.Slot == 0 {
			out.Store = append(out.Store, view(a))
		}
	}
	votes, err := s.st.VotesOfConv(ctx, convID)
	if err != nil {
		return nil, err
	}
	vids := make([]int64, len(votes))
	for i, v := range votes {
		vids[i] = v.ID
	}
	mine, err := s.st.MyBallots(ctx, me.ID, vids)
	if err != nil {
		return nil, err
	}
	for _, v := range votes {
		out.Votes = append(out.Votes, &amv1.MuseumVote{Id: v.ID, Text: v.Text, ByUserId: v.ByUser, EndsAt: v.EndsAt,
			Yes: int32(v.Yes), No: int32(v.No), Mine: int32(mine[v.ID]), MediaId: v.MediaID})
	}
	return out, nil
}

// Hang proposes to put a picture from this channel's chat (new work) or a
// work of this channel into the first hall.
func (s *Service) Hang(ctx context.Context, me *store.User, convID int64, req *amv1.MuseumHangRequest) (*amv1.MuseumResult, error) {
	c, err := s.channel(ctx, me, convID)
	if err != nil {
		return nil, err
	}
	slot := int(req.GetSlot())
	if slot < 0 || slot > Slots {
		return nil, apperr.ErrBadRequest
	}
	now := s.now().UnixMilli()
	var art *store.MuseumArt
	if req.GetArtId() != 0 {
		art, err = s.st.GetMuseumArt(ctx, req.GetArtId())
		if errors.Is(err, store.ErrNotFound) || (err == nil && (art.ConvID != convID || art.Slot < 0)) {
			return nil, apperr.ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		if art.Slot > 0 && slot == 0 {
			return &amv1.MuseumResult{Done: true, Text: fmt.Sprintf("《%s》已经在展厅里了", art.Title)}, nil
		}
		if art.NSFW && !c.Nsfw {
			return nil, ErrMuseumNSFW
		}
	} else {
		ev, err := s.msg.Get(ctx, me, convID, req.GetEventId())
		if err != nil {
			return nil, err
		}
		img := ev.GetImage()
		if img == nil || ev.GetRedaction() != nil {
			return nil, apperr.ErrBadRequest
		}
		title, bad := CleanTitle(req.GetTitle())
		if bad {
			return nil, ErrBadTitle
		}
		nsfw := req.GetNsfw() || img.GetNsfw()
		if nsfw && !c.Nsfw {
			return nil, ErrMuseumNSFW
		}
		method := img.GetMadeWith()
		if method == "" {
			method = "投稿"
		}
		art = &store.MuseumArt{ID: s.ids.Next(), ConvID: convID, Slot: -1, MediaID: img.GetMediaId(), Title: title, ByUser: me.ID,
			SourceEvent: ev.GetEventId(), Method: method, NSFW: nsfw, CreatedAt: now, StoredAt: now}
	}
	arts, err := s.st.MuseumArtsOfConv(ctx, convID)
	if err != nil {
		return nil, err
	}
	if _, _, _, full := Hang(hallOf(arts), art.ID, slot); full {
		return nil, ErrHallFull
	}
	where := "第一展厅"
	if slot > 0 {
		where += fmt.Sprintf(" No.%d（插队）", slot)
	}
	act := action{Type: "hang", Art: art.ID, Slot: slot}
	if art.Slot == -1 {
		act.NewArt = true
		if err := s.st.InsertMuseumArt(ctx, art); err != nil {
			return nil, err
		}
	}
	return s.propose(ctx, me, convID, act, fmt.Sprintf("把《%s》挂进%s", art.Title, where), art.MediaID)
}

// Remove proposes to take a work of this channel's first hall down (into the warehouse).
func (s *Service) Remove(ctx context.Context, me *store.User, convID, artID int64) (*amv1.MuseumResult, error) {
	if _, err := s.channel(ctx, me, convID); err != nil {
		return nil, err
	}
	art, err := s.st.GetMuseumArt(ctx, artID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && art.ConvID != convID) {
		return nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if art.Slot <= 0 {
		return &amv1.MuseumResult{Done: true, Text: fmt.Sprintf("《%s》已经不在展厅里了", art.Title)}, nil
	}
	return s.propose(ctx, me, convID, action{Type: "remove", Art: artID}, fmt.Sprintf("把《%s》撤展", art.Title), 0)
}

// Swap proposes to exchange two positions of the first hall.
func (s *Service) Swap(ctx context.Context, me *store.User, convID int64, a, b int) (*amv1.MuseumResult, error) {
	if _, err := s.channel(ctx, me, convID); err != nil {
		return nil, err
	}
	if a < 1 || a > Slots || b < 1 || b > Slots || a == b {
		return nil, apperr.ErrBadRequest
	}
	return s.propose(ctx, me, convID, action{Type: "swap", A: a, B: b}, fmt.Sprintf("调换第一展厅 No.%d 和 No.%d", a, b), 0)
}

// propose does a change now (few members) or starts a vote on it.
func (s *Service) propose(ctx context.Context, me *store.User, convID int64, act action, text string, mediaID int64) (*amv1.MuseumResult, error) {
	n, err := s.st.CountMembers(ctx, convID)
	if err != nil {
		return nil, err
	}
	if !NeedsVote(n, s.cfg.MinMembers) {
		var result string
		var row *store.Event
		err := s.st.InTx(ctx, func(q *store.Queries) error {
			var err error
			if result, err = s.apply(ctx, q, convID, act); err != nil {
				return err
			}
			row, err = s.msg.AppendSystem(ctx, q, convID, me.ID, &amv1.Event{Body: &amv1.Event_SysMuseum{SysMuseum: &amv1.SysMuseum{
				Kind: "done", OperatorId: me.ID, Text: result, ArtId: act.Art, MediaId: mediaID}}})
			return err
		})
		if err != nil {
			return nil, err
		}
		s.msg.FanOut(ctx, row, nil, 0)
		return &amv1.MuseumResult{Done: true, Text: result}, nil
	}
	b, _ := json.Marshal(act)
	v := &store.MuseumVote{ID: s.ids.Next(), ConvID: convID, Action: string(b), Text: text, ByUser: me.ID,
		EndsAt: s.now().Add(time.Duration(s.cfg.VoteMinutes) * time.Minute).UnixMilli(), MediaID: mediaID}
	var row *store.Event
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		if _, err := q.GetConvForUpdate(ctx, convID); err != nil {
			return err
		}
		open, err := q.VotesOfConv(ctx, convID)
		if err != nil {
			return err
		}
		for _, o := range open {
			var other action
			if json.Unmarshal([]byte(o.Action), &other) == nil && clashes(act, other) {
				return ErrMuseumBusy
			}
		}
		if err := q.InsertMuseumVote(ctx, v); err != nil {
			return err
		}
		// The one who asks counts as a yes.
		if err := q.SetBallot(ctx, v.ID, me.ID, true); err != nil {
			return err
		}
		row, err = s.msg.AppendSystem(ctx, q, convID, me.ID, &amv1.Event{Body: &amv1.Event_SysMuseum{SysMuseum: &amv1.SysMuseum{
			Kind: "proposed", OperatorId: me.ID, Text: text, VoteId: v.ID, EndsAt: v.EndsAt, ArtId: act.Art, MediaId: mediaID, Yes: 1}}})
		return err
	})
	if err != nil {
		return nil, err
	}
	s.msg.FanOut(ctx, row, nil, 0)
	return &amv1.MuseumResult{Text: fmt.Sprintf("发起了投票：%s（%d 分钟，反对多于同意就不执行）", text, s.cfg.VoteMinutes), VoteId: v.ID}, nil
}

// clashes: two changes on the same work, or two swaps of the same place.
func clashes(a, b action) bool {
	if a.Art != 0 && a.Art == b.Art {
		return true
	}
	if a.Type == "swap" && b.Type == "swap" {
		return a.A == b.A || a.A == b.B || a.B == b.A || a.B == b.B
	}
	return false
}

// apply makes a change; returns what happened, in words.
func (s *Service) apply(ctx context.Context, q *store.Queries, convID int64, act action) (string, error) {
	if _, err := q.GetConvForUpdate(ctx, convID); err != nil {
		return "", err
	}
	arts, err := q.MuseumArtsOfConv(ctx, convID)
	if err != nil {
		return "", err
	}
	byID := map[int64]*store.MuseumArt{}
	for _, a := range arts {
		byID[a.ID] = a
	}
	hall := hallOf(arts)
	now := s.now().UnixMilli()
	place := func(next []int64) error {
		for i, id := range next {
			if id != 0 && hall[i] != id {
				hungAt := int64(0)
				if a := byID[id]; a != nil && a.Slot <= 0 {
					hungAt = now
				}
				if err := q.SetArtSlot(ctx, id, i+1, hungAt, 0); err != nil {
					return err
				}
			}
		}
		return nil
	}
	switch act.Type {
	case "hang":
		a := byID[act.Art]
		if a == nil {
			return "这幅作品已经不在了", nil
		}
		next, at, pushed, full := Hang(hall, a.ID, act.Slot)
		if full {
			if a.Slot == -1 {
				if err := q.SetArtSlot(ctx, a.ID, 0, 0, now); err != nil {
					return "", err
				}
				return fmt.Sprintf("第一展厅满了，《%s》先放进了仓库", a.Title), nil
			}
			return "第一展厅满了，没挂上（要指定位置插队）", nil
		}
		if err := place(next); err != nil {
			return "", err
		}
		msg := fmt.Sprintf("《%s》挂在第一展厅 No.%d", a.Title, at)
		if pushed != 0 {
			if err := q.SetArtSlot(ctx, pushed, 0, 0, now); err != nil {
				return "", err
			}
			msg += fmt.Sprintf("；挤出去的《%s》进了仓库", byID[pushed].Title)
		}
		return msg, nil
	case "remove":
		a := byID[act.Art]
		if a == nil || a.Slot <= 0 {
			return "这幅作品已经不在展厅里了", nil
		}
		if err := q.SetArtSlot(ctx, a.ID, 0, 0, now); err != nil {
			return "", err
		}
		return fmt.Sprintf("《%s》撤下来了，放进了仓库", a.Title), nil
	case "swap":
		next := Swap(hall, act.A, act.B)
		for i, id := range next {
			if id != 0 && hall[i] != id {
				if err := q.SetArtSlot(ctx, id, i+1, 0, 0); err != nil {
					return "", err
				}
			}
		}
		return fmt.Sprintf("第一展厅 No.%d 和 No.%d 换好了", act.A, act.B), nil
	}
	return "", fmt.Errorf("museum: unknown action %q", act.Type)
}

// Vote casts (or changes) my ballot.
func (s *Service) Vote(ctx context.Context, me *store.User, voteID int64, agree bool) (*amv1.MuseumVote, error) {
	if !s.cfg.Enabled {
		return nil, ErrMuseumOff
	}
	v, err := s.st.GetMuseumVote(ctx, voteID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if _, err := s.channel(ctx, me, v.ConvID); err != nil {
		return nil, err
	}
	if err := s.st.SetBallot(ctx, voteID, me.ID, agree); err != nil {
		return nil, err
	}
	if v, err = s.st.GetMuseumVote(ctx, voteID); err != nil {
		return nil, err
	}
	mine := int32(-1)
	if agree {
		mine = 1
	}
	return &amv1.MuseumVote{Id: v.ID, Text: v.Text, ByUserId: v.ByUser, EndsAt: v.EndsAt, Yes: int32(v.Yes), No: int32(v.No), Mine: mine, MediaId: v.MediaID}, nil
}

// Like likes (or takes back a like on) a work I can see.
func (s *Service) Like(ctx context.Context, me *store.User, artID int64, on bool) (*amv1.MuseumArt, error) {
	if !s.cfg.Enabled {
		return nil, ErrMuseumOff
	}
	a, err := s.st.GetMuseumArt(ctx, artID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && a.Slot < 0) {
		return nil, apperr.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !a.Public {
		if _, err := s.st.GetConvForUser(ctx, a.ConvID, me.ID); err != nil {
			return nil, apperr.ErrNotFound
		}
	}
	if _, err := s.st.LikeArt(ctx, artID, me.ID, on, s.now().UnixMilli()); err != nil {
		return nil, err
	}
	if a, err = s.st.GetMuseumArt(ctx, artID); err != nil {
		return nil, err
	}
	return &amv1.MuseumArt{Id: a.ID, MediaId: a.MediaID, Title: a.Title, ByUserId: a.ByUser, Method: a.Method, Nsfw: a.NSFW,
		Likes: int32(a.Likes), Liked: on, HungAt: a.HungAt, Slot: int32(max(a.Slot, 0)), ConvId: a.ConvID, ConvName: a.ConvName}, nil
}

// Settle ends the votes whose time is up: applied when not more are
// against than for; a new work whose vote failed is deleted.
func (s *Service) Settle(ctx context.Context) error {
	ended, err := s.st.EndedMuseumVotes(ctx, s.now().UnixMilli())
	if err != nil {
		return err
	}
	for _, v := range ended {
		var act action
		_ = json.Unmarshal([]byte(v.Action), &act)
		var row *store.Event
		err := s.st.InTx(ctx, func(q *store.Queries) error {
			if err := q.DeleteMuseumVote(ctx, v.ID); err != nil {
				return err
			}
			kind, text := "failed", fmt.Sprintf("投票结束：同意 %d，反对 %d，没通过。%s 不执行", v.Yes, v.No, v.Text)
			if Passed(v.Yes, v.No) {
				result, err := s.apply(ctx, q, v.ConvID, act)
				if err != nil {
					return err
				}
				kind, text = "passed", fmt.Sprintf("投票结束：同意 %d，反对 %d，通过！%s", v.Yes, v.No, result)
			} else if act.NewArt {
				if err := q.DeleteMuseumArt(ctx, act.Art); err != nil {
					return err
				}
			}
			var err error
			row, err = s.msg.AppendSystem(ctx, q, v.ConvID, v.ByUser, &amv1.Event{Body: &amv1.Event_SysMuseum{SysMuseum: &amv1.SysMuseum{
				Kind: kind, OperatorId: v.ByUser, Text: text, VoteId: v.ID, ArtId: act.Art, Yes: int32(v.Yes), No: int32(v.No)}}})
			return err
		})
		if err != nil {
			return err
		}
		s.msg.FanOut(ctx, row, nil, 0)
	}
	return nil
}
