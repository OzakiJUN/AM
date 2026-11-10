package account

// An AI's search / browsing history (docs/design.md §9 搜索记录): the client
// running the AI writes what it searched, opened and watched; its owner reads
// it from any device. Kept retention.ai_browse_days (janitor) and at most
// limits.max_browse_log per AI.

import (
	"context"
	"net/http"
	"unicode/utf8"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

const (
	maxBrowseText  = 500
	maxBrowsePlace = 100
	browsePage     = 100
)

// SetBrowseLogLimit sets how many entries are kept per AI.
func (s *Service) SetBrowseLogLimit(n int) { s.maxBrowse = n }

// AddBrowseLog records one thing an AI did with its browser (the AI's own session).
func (s *Service) AddBrowseLog(ctx context.Context, me *store.User, r *amv1.AddBrowseLogRequest) error {
	if me.AccountType == int16(amv1.AccountType_ACCOUNT_TYPE_HUMAN) || me.OwnerID == 0 {
		return apperr.ErrNoPermission
	}
	switch r.GetKind() {
	case "search", "open", "watch":
	default:
		return apperr.ErrBadRequest
	}
	if r.GetText() == "" || utf8.RuneCountInString(r.GetText()) > maxBrowseText || utf8.RuneCountInString(r.GetPlace()) > maxBrowsePlace {
		return apperr.New(http.StatusBadRequest, "too_long", "text too long")
	}
	keep := s.maxBrowse
	if keep < 1 {
		keep = 1000
	}
	return s.st.AddBrowseLog(ctx, store.BrowseEntry{ID: s.ids.Next(), AIID: me.ID, At: s.now().UnixMilli(), Kind: r.GetKind(), Text: r.GetText(), Place: r.GetPlace()}, keep)
}

// BrowseLog lists one of owner's AIs' history, newest first, before an entry id (0 = newest).
func (s *Service) BrowseLog(ctx context.Context, owner *store.User, aiID, before int64, limit int) (*amv1.BrowseLogResponse, error) {
	if _, err := s.ownedAI(ctx, owner, aiID); err != nil {
		return nil, err
	}
	if limit < 1 || limit > browsePage {
		limit = browsePage
	}
	list, err := s.st.BrowseLog(ctx, aiID, before, limit)
	if err != nil {
		return nil, err
	}
	out := &amv1.BrowseLogResponse{Entries: make([]*amv1.BrowseLogEntry, 0, len(list))}
	for _, e := range list {
		out.Entries = append(out.Entries, &amv1.BrowseLogEntry{Id: e.ID, At: e.At, Kind: e.Kind, Text: e.Text, Place: e.Place})
	}
	return out, nil
}
