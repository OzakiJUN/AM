package httpapi

import (
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Several devices of one person: logout, pairing a new device, shared state.

func (a *API) logout(w http.ResponseWriter, r *http.Request, sess *store.Session, me *store.User) {
	if err := a.acct.Logout(r.Context(), me.ID, sess.ID); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) createPair(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.CreatePairTicketRequest{}
	if !a.read(w, r, req) {
		return
	}
	t, err := a.acct.CreatePairTicket(r.Context(), me, req.GetBundle())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, t)
}

func (a *API) redeemPair(w http.ResponseWriter, r *http.Request) {
	req := &amv1.RedeemPairTicketRequest{}
	if !a.read(w, r, req) {
		return
	}
	token, u, bundle, err := a.acct.RedeemPairTicket(r.Context(), req, account.Client{IP: clientIP(r)})
	if err != nil {
		a.fail(w, err)
		return
	}
	me, err := a.conv.UserView(r.Context(), u)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.PairRedeemResponse{Token: token, Me: me, Bundle: bundle})
}

func (a *API) getClientState(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	st, err := a.acct.ClientState(r.Context(), me.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, st)
}

func (a *API) putClientState(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.PutClientStateRequest{}
	if !a.read(w, r, req) {
		return
	}
	st, err := a.acct.PutClientState(r.Context(), me.ID, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, st)
}
