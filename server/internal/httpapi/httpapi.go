// Package httpapi serves the HTTP API (/api/v1/...). Bodies are protobuf
// messages encoded as JSON (protojson); see proto/am/v1/api.proto.
package httpapi

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/conv"
	"github.com/OzakiJUN/am/server/internal/store"
)

const maxBody = 64 << 10 // 64 KiB

var (
	marshalOpts   = protojson.MarshalOptions{EmitUnpopulated: true}
	unmarshalOpts = protojson.UnmarshalOptions{DiscardUnknown: true}
)

type API struct {
	acct    *account.Service
	conv    *conv.Service
	log     *slog.Logger
	limiter *ipLimiter
}

func New(acct *account.Service, cs *conv.Service, loginPerMinute int, log *slog.Logger) *API {
	return &API{acct: acct, conv: cs, log: log, limiter: newIPLimiter(loginPerMinute)}
}

// Register adds the API routes to mux.
func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	mux.HandleFunc("POST /api/v1/register", a.limited(a.register))
	mux.HandleFunc("POST /api/v1/login", a.limited(a.login))

	mux.HandleFunc("GET /api/v1/sessions", a.authed(a.listSessions))
	mux.HandleFunc("DELETE /api/v1/sessions/{id}", a.authed(a.revokeSession))
	mux.HandleFunc("GET /api/v1/invites", a.authed(a.listInvites))
	mux.HandleFunc("POST /api/v1/invites", a.authed(a.createInvite))
	mux.HandleFunc("GET /api/v1/friends", a.authed(a.listFriends))
	mux.HandleFunc("POST /api/v1/friends/request", a.authed(a.requestFriend))
	mux.HandleFunc("POST /api/v1/friends/accept", a.authed(a.acceptFriend))
	mux.HandleFunc("POST /api/v1/dm", a.authed(a.openDM))
}

// ---- plumbing ----

type authedHandler func(w http.ResponseWriter, r *http.Request, sess *store.Session, me *store.User)

func (a *API) authed(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		sess, me, err := a.acct.Authenticate(r.Context(), token)
		if err != nil {
			a.fail(w, err)
			return
		}
		h(w, r, sess, me)
	}
}

func (a *API) limited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.limiter.allow(clientIP(r)) {
			a.fail(w, apperr.ErrRateLimited)
			return
		}
		h(w, r)
	}
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (a *API) read(w http.ResponseWriter, r *http.Request, m proto.Message) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(body) > maxBody {
		a.fail(w, apperr.ErrBadRequest)
		return false
	}
	if len(body) == 0 {
		return true
	}
	if err := unmarshalOpts.Unmarshal(body, m); err != nil {
		a.fail(w, apperr.ErrBadRequest)
		return false
	}
	return true
}

func (a *API) write(w http.ResponseWriter, status int, m proto.Message) {
	b, err := marshalOpts.Marshal(m)
	if err != nil {
		a.log.Error("marshal response", "err", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(b)
}

func (a *API) ok(w http.ResponseWriter, m proto.Message) { a.write(w, http.StatusOK, m) }

func (a *API) fail(w http.ResponseWriter, err error) {
	e := apperr.As(err)
	if e == nil {
		if err != context.Canceled {
			a.log.Error("request failed", "err", err)
		}
		e = apperr.New(http.StatusInternalServerError, "internal_error", "internal error")
	}
	a.write(w, e.Status, &amv1.Error{Code: e.Code, Message: e.Message})
}

// ---- handlers ----

func (a *API) register(w http.ResponseWriter, r *http.Request) {
	req := &amv1.RegisterRequest{}
	if !a.read(w, r, req) {
		return
	}
	token, u, err := a.acct.Register(r.Context(), req)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.sessionResponse(w, r, token, u)
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	req := &amv1.LoginRequest{}
	if !a.read(w, r, req) {
		return
	}
	token, u, err := a.acct.Login(r.Context(), req)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.sessionResponse(w, r, token, u)
}

func (a *API) sessionResponse(w http.ResponseWriter, r *http.Request, token string, u *store.User) {
	me, err := a.conv.UserView(r.Context(), u)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.SessionResponse{Token: token, Me: me})
}

func (a *API) listSessions(w http.ResponseWriter, r *http.Request, sess *store.Session, me *store.User) {
	resp, err := a.acct.ListSessions(r.Context(), me.ID, sess.ID)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, resp)
}

func (a *API) revokeSession(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		a.fail(w, apperr.ErrBadRequest)
		return
	}
	if err := a.acct.RevokeSession(r.Context(), me.ID, id); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) listInvites(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	resp, err := a.acct.ListInvites(r.Context(), me)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, resp)
}

func (a *API) createInvite(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	inv, err := a.acct.CreateInvite(r.Context(), me)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, inv)
}

func (a *API) listFriends(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	resp, err := a.conv.ListFriends(r.Context(), me)
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, resp)
}

func (a *API) requestFriend(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.FriendRequest{}
	if !a.read(w, r, req) {
		return
	}
	if err := a.conv.RequestFriend(r.Context(), me, strings.TrimSpace(req.GetUsername())); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) acceptFriend(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.FriendAccept{}
	if !a.read(w, r, req) {
		return
	}
	if err := a.conv.AcceptFriend(r.Context(), me, req.GetUserId()); err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, &amv1.Empty{})
}

func (a *API) openDM(w http.ResponseWriter, r *http.Request, _ *store.Session, me *store.User) {
	req := &amv1.OpenDMRequest{}
	if !a.read(w, r, req) {
		return
	}
	c, err := a.conv.OpenDM(r.Context(), me, req.GetUserId())
	if err != nil {
		a.fail(w, err)
		return
	}
	a.ok(w, c)
}

// ---- rate limiting ----

// ipLimiter allows `perMinute` requests per IP per clock minute.
// Note: behind frp every request appears to come from the frp client's
// address, so the limit is effectively shared by everyone until real client
// IPs are passed through (proxy protocol, a later stage).
type ipLimiter struct {
	mu        sync.Mutex
	perMinute int
	window    int64
	counts    map[string]int
}

func newIPLimiter(perMinute int) *ipLimiter {
	return &ipLimiter{perMinute: perMinute, counts: make(map[string]int)}
}

func (l *ipLimiter) allow(ip string) bool {
	if l.perMinute <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	w := time.Now().Unix() / 60
	if w != l.window {
		l.window = w
		l.counts = make(map[string]int)
	}
	l.counts[ip]++
	return l.counts[ip] <= l.perMinute
}
