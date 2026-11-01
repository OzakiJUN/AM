package httpapi

import (
	"context"
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

// My AI accounts (docs/design.md §9, §10).

func (a *API) aiView(ctx context.Context, in *account.AIInfo) (*amv1.AIAccount, error) {
	u, err := a.conv.UserView(ctx, in.User)
	if err != nil {
		return nil, err
	}
	out := &amv1.AIAccount{User: u, Settings: in.Settings, SettingsUpdatedAt: in.UpdatedAt, ShareRequests: int32(in.ShareRequests)}
	if a.hosting != nil {
		h, err := a.hosting.Of(ctx, in.User.ID)
		if err != nil {
			return nil, err
		}
		out.Hosting = a.hostingView(h)
	}
	return out, nil
}

func (a *API) listAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	list, err := a.acct.ListAI(r.Context(), me)
	if err != nil {
		a.fail(w, err)
		return
	}
	out := &amv1.ListAIResponse{}
	for i := range list {
		v, err := a.aiView(r.Context(), &list[i])
		if err != nil {
			a.fail(w, err)
			return
		}
		out.Ais = append(out.Ais, v)
	}
	a.ok(w, out)
}

func (a *API) createAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.CreateAIRequest{}
	if !a.read(w, r, req) {
		return
	}
	info, err := a.acct.CreateAI(r.Context(), me, req.GetDisplayName())
	if err != nil {
		a.fail(w, err)
		return
	}
	v, err := a.aiView(r.Context(), info)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}

func (a *API) updateAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.UpdateProfileRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	u, err := a.acct.UpdateAIProfile(r.Context(), me, id, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	v, err := a.conv.UserView(r.Context(), u)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}

func (a *API) putAISettings(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.PutAISettingsRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	info, err := a.acct.PutAISettings(r.Context(), me, id, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	v, err := a.aiView(r.Context(), info)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, v)
}

func (a *API) runAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	req := &amv1.RunAIRequest{}
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if !a.read(w, r, req) {
		return
	}
	token, u, err := a.acct.RunAI(r.Context(), me, id, req.GetDeviceName(), account.Client{IP: clientIP(r)})
	if err != nil {
		a.fail(w, err)
		return
	}
	a.sessionResponse(w, r, token, u)
}

func (a *API) deleteAI(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if err := a.acct.DeleteAI(r.Context(), me, id); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

// aiLeaveChannel takes my AI out of a channel (it is put in with the normal
// invite, by me or anyone else in the channel).
func (a *API) aiLeaveChannel(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok1 := pathID(r, "id")
	conv, ok2 := pathID(r, "conv")
	if !ok1 || !ok2 {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	ai, err := a.acct.OwnedAI(r.Context(), me, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	if err := a.conv.RemoveMember(r.Context(), ai, conv, ai.ID); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

// createAIRoom makes a shared room for my AI (it answers everyone in it).
func (a *API) createAIRoom(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	req := &amv1.CreateAIRoomRequest{}
	if !a.read(w, r, req) {
		return
	}
	ai, err := a.acct.OwnedAI(r.Context(), me, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	c, err := a.conv.CreateAIRoom(r.Context(), me, ai, req.GetName(), req.GetMemberIds())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, c)
}

func (a *API) getPortraits(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	pack, err := a.acct.PortraitPack(r.Context(), id)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.PortraitPack{MediaIds: pack})
}

func (a *API) putPortraits(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	req := &amv1.PortraitPack{}
	if !a.read(w, r, req) {
		return
	}
	if err := a.acct.SetPortraitPack(r.Context(), me, id, req.GetMediaIds()); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.PortraitPack{MediaIds: req.GetMediaIds()})
}

func (a *API) requestShare(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	userView := func(u *store.User) *amv1.User {
		v, err := a.conv.UserView(r.Context(), u)
		if err != nil {
			return nil
		}
		return v
	}
	if err := a.acct.RequestShare(r.Context(), me, id, userView); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) listShareRequests(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	list, err := a.acct.ShareRequests(r.Context(), me, id)
	if err != nil {
		a.fail(w, err)
		return
	}
	out := &amv1.ShareRequests{}
	for _, u := range list {
		v, err := a.conv.UserView(r.Context(), u)
		if err != nil {
			a.fail(w, err)
			return
		}
		out.Users = append(out.Users, v)
	}
	a.ok(w, out)
}

// decideShareRequest: approved = into the AI's shared room (made if it has none).
func (a *API) decideShareRequest(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok1 := pathID(r, "id")
	user, ok2 := pathID(r, "user")
	if !ok1 || !ok2 {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	req := &amv1.DecideShareRequest{}
	if !a.read(w, r, req) {
		return
	}
	ai, asker, room, err := a.acct.TakeShareRequest(r.Context(), me, id, user)
	if err != nil {
		a.fail(w, err)
		return
	}
	if !req.GetApprove() || asker.Gone() {
		a.ok(w, &amv1.Empty{})
		return
	}
	var c *amv1.Conversation
	if room == 0 {
		c, err = a.conv.CreateAIRoom(r.Context(), me, ai, "", []int64{asker.ID})
	} else if _, err = a.conv.InviteMembers(r.Context(), me, room, []int64{asker.ID}); err == nil {
		c, err = a.conv.ConvView(r.Context(), room, me.ID)
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, c)
}
