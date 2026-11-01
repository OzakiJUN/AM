package httpapi

import (
	"net/http"
	"strconv"

	"google.golang.org/protobuf/proto"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Board games in channels and shared AI rooms (docs/design.md §13 小游戏).

func (a *API) listGames(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if r.URL.Query().Get("ended") == "1" {
		before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
		out, err := a.games.History(r.Context(), me, id, before)
		a.reply(w, out, err)
		return
	}
	out, err := a.games.List(r.Context(), me, id)
	a.reply(w, out, err)
}

func (a *API) openGame(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	req := &amv1.OpenGameRequest{}
	if !a.read(w, r, req) {
		return
	}
	out, err := a.games.Open(r.Context(), me, id, req.GetKind(), req.GetAutoApprove())
	a.reply(w, out, err)
}

func (a *API) getGame(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	out, err := a.games.Get(r.Context(), me, id)
	a.reply(w, out, err)
}

func (a *API) setGame(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	req := &amv1.SetGameRequest{}
	if !a.read(w, r, req) {
		return
	}
	out, err := a.games.SetAuto(r.Context(), me, id, req.GetAutoApprove())
	a.reply(w, out, err)
}

func (a *API) decideGame(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok1 := pathID(r, "id")
	user, ok2 := pathID(r, "user")
	if !ok1 || !ok2 {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	req := &amv1.DecideGameRequest{}
	if !a.read(w, r, req) {
		return
	}
	out, err := a.games.Decide(r.Context(), me, id, user, req.GetApprove())
	a.reply(w, out, err)
}

func (a *API) actGame(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, ok := pathID(r, "id")
	if !ok {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	req := &amv1.GameActRequest{}
	if !a.read(w, r, req) {
		return
	}
	out, err := a.games.Act(r.Context(), me, id, req)
	a.reply(w, out, err)
}

// gameStep handles join / start / leave / end / rematch (no body).
func (a *API) gameStep(step string) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
		id, ok := pathID(r, "id")
		if !ok {
			a.fail(w, apperr.ErrBadRequest)
			return
		}
		var out *amv1.Game
		var err error
		switch step {
		case "join":
			out, err = a.games.Join(r.Context(), me, id)
		case "start":
			out, err = a.games.Start(r.Context(), me, id)
		case "leave":
			out, err = a.games.Leave(r.Context(), me, id)
		case "end":
			out, err = a.games.End(r.Context(), me, id)
		case "rematch":
			out, err = a.games.Rematch(r.Context(), me, id)
		}
		a.reply(w, out, err)
	}
}

func (a *API) reply(w http.ResponseWriter, m proto.Message, err error) {
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, m)
}
