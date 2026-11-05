package game

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

type fishingSnapshot struct {
	Account  *FishingAccount   `json:"account"`
	Receipts map[string]string `json:"receipts"`
}

func (s *Service) FishingSync(ctx context.Context, me *store.User, req *amv1.FishingSyncRequest) (*amv1.FishingData, error) {
	if req.Mode == "export" {
		data, err := s.FishingAccount(ctx, me)
		if err != nil {
			return nil, err
		}
		var current FishingAccount
		if json.Unmarshal([]byte(data.StateJson), &current) != nil {
			return nil, apperr.ErrBadRequest
		}
		if current.Room != "" {
			id, _ := strconv.ParseInt(current.Room, 10, 64)
			g, err := s.pondChange(ctx, me, id, "refresh", 0)
			if err != nil {
				return nil, err
			}
			var st State
			_ = json.Unmarshal([]byte(g.StateJson), &st)
			if st.Pond != nil && st.Pond.CatchingUp {
				return nil, ErrGameState
			}
		}
	}
	var out fishingSnapshot
	err := s.st.InTx(ctx, func(q *store.Queries) error {
		a, err := s.account(ctx, q, me.ID)
		if err != nil {
			return err
		}
		if req.Mode == "export" {
			if len(req.TransferId) < 8 || len(req.TransferId) > 64 || len(req.Destination) != 32 {
				return apperr.ErrBadRequest
			}
			if !(a.Frozen && a.TransferID == req.TransferId && a.TransferTo == req.Destination) {
				if a.Frozen || a.Revision != req.ExpectedRevision {
					return ErrGameState
				}
				a.Frozen = true
				a.Room = ""
				a.TransferID = req.TransferId
				a.TransferTo = req.Destination
				if err = saveAccount(ctx, q, me.ID, a); err != nil {
					return err
				}
			}
			receipts, err := q.FishingReceipts(ctx, me.ID)
			out = fishingSnapshot{a, receipts}
			return err
		}
		if req.Mode != "mirror" && req.Mode != "activate" {
			return apperr.ErrBadRequest
		}
		var snapshot fishingSnapshot
		if json.Unmarshal([]byte(req.StateJson), &snapshot) != nil || snapshot.Account == nil {
			return apperr.ErrBadRequest
		}
		incoming := snapshot.Account
		if err = s.validateFishingSave(incoming); err != nil {
			return err
		}
		if req.Mode == "activate" && !a.Frozen && a.Identity == incoming.Identity && a.TransferID == req.TransferId {
			out.Account = a
			return nil
		}
		if a.Revision != req.ExpectedRevision {
			return ErrGameState
		}
		fresh := a.Revision <= 1 && len(a.Records) == 0 && a.Room == "" && len(a.Fish) == 0 && len(a.Cards) == 0 && len(a.Tools) == 0 && a.Packs == 0 && a.Coins == s.fishing.StartCoins
		if !fresh && (!a.Frozen || a.Identity != incoming.Identity || a.Revision > incoming.Revision) {
			return ErrGameState
		}
		wasFrozen := incoming.Frozen
		incoming.LocalSlot = a.LocalSlot
		incoming.Room = ""
		incoming.Frozen = true
		if req.Mode == "activate" {
			if !wasFrozen || req.TransferId == "" || incoming.TransferID != req.TransferId || incoming.TransferTo != a.LocalSlot {
				return apperr.ErrBadRequest
			}
			if len(snapshot.Receipts) > 200000 {
				return apperr.ErrTooLong
			}
			for key, hash := range snapshot.Receipts {
				if len(key) < 8 || len(key) > 64 || len(hash) != 64 {
					return apperr.ErrBadRequest
				}
				if _, err = q.FishingReceipt(ctx, me.ID, key, hash); err != nil {
					return err
				}
			}
			incoming.Frozen = false
			incoming.Revision++
		}
		b, err := json.Marshal(incoming)
		if err != nil {
			return err
		}
		if err = q.SaveFishingAccount(ctx, me.ID, string(b)); err != nil {
			return err
		}
		out.Account = incoming
		return nil
	})
	if err != nil {
		return nil, err
	}
	b, _ := json.Marshal(out)
	return &amv1.FishingData{StateJson: string(b)}, nil
}
func (s *Service) validateFishingSave(a *FishingAccount) error {
	key, err := hex.DecodeString(a.Identity)
	if err != nil || len(key) != 16 || a.Version != 2 || a.Coins < 0 || a.Coins > Coins(1e13) || len(a.Fish) > s.fishing.InventoryLimit || len(a.Cards) > 500 || len(a.Records) > 200 || len(a.Equipped) > 2 || len(a.Tools) > 7 || a.Packs < 0 || a.Packs > s.fishing.PackLimit {
		return apperr.ErrBadRequest
	}
	if len(a.Last) > 2048 || len(a.Opened) > 4 {
		return apperr.ErrBadRequest
	}
	for _, n := range a.Badges {
		if n < 0 || n > 4 {
			return apperr.ErrBadRequest
		}
	}
	species := map[string]bool{}
	for _, f := range s.fishing.Catalog {
		species[f.ID] = true
	}
	ids := map[string]bool{}
	for _, f := range a.Fish {
		if f.ID == "" || len(f.ID) > 40 || ids[f.ID] || !species[f.Species] || f.Length <= 0 || f.Length > 1e12 || f.Value < 0 || f.Value > Coins(1e13) || f.BaseValue < 0 || f.BaseValue > Coins(1e13) || f.At < 0 || f.At > 1e15 || f.AcquiredAt < 0 || f.AcquiredAt > 1e15 || f.StealBonus < 0 || f.StealBonus > 1000 || f.OwnerKey == "" {
			return apperr.ErrBadRequest
		}
		ids[f.ID] = true
	}
	for k, q := range a.Tools {
		if !toolKind(k) || q < 1 || q > 5 {
			return apperr.ErrBadRequest
		}
	}
	equipped := map[string]bool{}
	for _, k := range a.Equipped {
		if equipped[k] || a.Tools[k] == 0 {
			return apperr.ErrBadRequest
		}
		equipped[k] = true
	}
	for k, n := range a.Cards {
		parts := strings.Split(k, ":")
		if len(parts) != 2 || !species[parts[1]] || n < 1 || n > 1e9 {
			return apperr.ErrBadRequest
		}
		quality, err := strconv.Atoi(parts[0])
		if err != nil || quality < 0 || quality > 4 {
			return apperr.ErrBadRequest
		}
	}
	if a.AutoAt < 0 || a.StealAt < 0 || a.WardAt < 0 {
		return apperr.ErrBadRequest
	}
	return nil
}
