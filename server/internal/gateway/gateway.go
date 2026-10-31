// Package gateway keeps one WebSocket connection per online device and
// pushes frames to them. It is the only module that knows who is online.
package gateway

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/account"
	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/conv"
	"github.com/OzakiJUN/am/server/internal/message"
	"github.com/OzakiJUN/am/server/internal/presence"
	"github.com/OzakiJUN/am/server/internal/store"
)

const (
	authTimeout  = 10 * time.Second
	writeTimeout = 10 * time.Second
	pingInterval = 30 * time.Second
	sendBuffer   = 256
	readLimit    = 1 << 20 // 1 MiB per frame
)

// Hub tracks online connections. It implements push.Pusher.
type Hub struct {
	mu     sync.RWMutex
	byUser map[int64]map[uint64]*Conn
	nextID atomic.Uint64
	log    *slog.Logger
}

func NewHub(log *slog.Logger) *Hub {
	return &Hub{byUser: make(map[int64]map[uint64]*Conn), log: log}
}

func (h *Hub) add(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	m := h.byUser[c.userID]
	if m == nil {
		m = make(map[uint64]*Conn)
		h.byUser[c.userID] = m
	}
	m[c.id] = c
}

func (h *Hub) remove(c *Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if m := h.byUser[c.userID]; m != nil {
		delete(m, c.id)
		if len(m) == 0 {
			delete(h.byUser, c.userID)
		}
	}
}

// ToUsers implements push.Pusher.
func (h *Hub) ToUsers(userIDs []int64, frame *amv1.ServerFrame, exceptConn uint64) {
	data, err := proto.Marshal(frame)
	if err != nil {
		h.log.Error("marshal push", "err", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, uid := range userIDs {
		for id, c := range h.byUser[uid] {
			if id != exceptConn {
				c.enqueue(data)
			}
		}
	}
}

// CloseSession implements push.Pusher.
func (h *Hub) CloseSession(sessionID int64) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, m := range h.byUser {
		for _, c := range m {
			if c.sessionID == sessionID {
				c.close(websocket.StatusPolicyViolation, "session revoked")
			}
		}
	}
}

// CloseAll disconnects every client (server restart / shutdown). Clients
// reconnect on their own.
// Broadcast sends a frame to every connection.
func (h *Hub) Broadcast(frame *amv1.ServerFrame) {
	users := h.OnlineUsers()
	ids := make([]int64, 0, len(users))
	for id := range users {
		ids = append(ids, id)
	}
	h.ToUsers(ids, frame, 0)
}

// AddressCounts is how many connections use each address (as the clients
// report it; "" for clients too old to say).
func (h *Hub) AddressCounts() map[string]int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := map[string]int{}
	for _, byID := range h.byUser {
		for _, c := range byID {
			out[c.address]++
		}
	}
	return out
}

func (h *Hub) CloseAll() {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, m := range h.byUser {
		for _, c := range m {
			c.close(websocket.StatusServiceRestart, "server restarting")
		}
	}
}

// OnlineUsers returns the ids of users with at least one open connection.
func (h *Hub) OnlineUsers() map[int64]bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	out := make(map[int64]bool, len(h.byUser))
	for uid := range h.byUser {
		out[uid] = true
	}
	return out
}

// OnlineCount returns the number of open connections (for logs / tests).
func (h *Hub) OnlineCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	n := 0
	for _, m := range h.byUser {
		n += len(m)
	}
	return n
}

// Conn is one device's WebSocket connection.
type Conn struct {
	id        uint64
	userID    int64
	sessionID int64
	// Address the client says it connected to (AuthRequest.address).
	address   string
	user      *store.User
	ws        *websocket.Conn
	out       chan []byte
	cancel    context.CancelFunc
	closeOnce sync.Once
}

// enqueue queues a frame without blocking. A client too slow to keep up
// is disconnected; it will reconnect and catch up with a sync.
func (c *Conn) enqueue(data []byte) {
	select {
	case c.out <- data:
	default:
		c.close(websocket.StatusTryAgainLater, "too slow")
	}
}

func (c *Conn) close(code websocket.StatusCode, reason string) {
	c.closeOnce.Do(func() {
		go c.ws.Close(code, reason) //nolint:errcheck
		c.cancel()
	})
}

// Gateway is the HTTP handler for /ws.
type Gateway struct {
	hub      *Hub
	acct     *account.Service
	conv     *conv.Service
	msg      *message.Service
	presence *presence.Service
	log      *slog.Logger
}

func New(hub *Hub, acct *account.Service, cs *conv.Service, ms *message.Service, ps *presence.Service, log *slog.Logger) *Gateway {
	return &Gateway{hub: hub, acct: acct, conv: cs, msg: ms, presence: ps, log: log}
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Origin is not checked: auth is a token sent in the first frame, not a
	// cookie, so a foreign web page cannot ride on the user's login.
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	ws.SetReadLimit(readLimit)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c, authReq, err := g.authenticate(ctx, ws, cancel)
	if err != nil {
		return
	}
	// The auth response must be the first frame, so queue it before the
	// connection becomes visible to pushes. Events that happen in between
	// are picked up by the sync the client does right after auth; presence
	// is filled in under the presence lock, so no change is missed.
	resp, err := g.authResponse(ctx, c)
	if err != nil {
		g.log.Error("build auth response", "err", err)
		c.close(websocket.StatusInternalError, "internal error")
		return
	}
	g.presence.Connect(c.user, func(snapshot []*amv1.Presence) {
		resp.Presences = snapshot
		c.enqueueFrame(&amv1.ServerFrame{ReqId: authReq.GetReqId(), Msg: &amv1.ServerFrame_Auth{Auth: resp}})
		g.hub.add(c)
	})
	defer g.presence.Disconnect(c.userID, func() { g.hub.remove(c) })
	g.log.Debug("connected", "user", c.userID, "conn", c.id)
	defer g.log.Debug("disconnected", "user", c.userID, "conn", c.id)

	go g.writeLoop(ctx, c)
	g.readLoop(ctx, c)
	c.close(websocket.StatusNormalClosure, "")
}

func (g *Gateway) authenticate(ctx context.Context, ws *websocket.Conn, cancel context.CancelFunc) (*Conn, *amv1.ClientFrame, error) {
	authCtx, done := context.WithTimeout(ctx, authTimeout)
	defer done()
	_, data, err := ws.Read(authCtx)
	if err != nil {
		ws.Close(websocket.StatusPolicyViolation, "auth timeout") //nolint:errcheck
		return nil, nil, err
	}
	frame := &amv1.ClientFrame{}
	if err := proto.Unmarshal(data, frame); err != nil || frame.GetAuth() == nil {
		ws.Close(websocket.StatusPolicyViolation, "first frame must be auth") //nolint:errcheck
		return nil, nil, errors.New("bad auth frame")
	}
	sess, user, err := g.acct.Authenticate(authCtx, frame.GetAuth().GetToken())
	if err != nil {
		// Tell the client why, then close.
		if b, mErr := proto.Marshal(errorFrame(frame.GetReqId(), err, g.log)); mErr == nil {
			_ = ws.Write(authCtx, websocket.MessageBinary, b)
		}
		ws.Close(websocket.StatusPolicyViolation, "unauthorized") //nolint:errcheck
		return nil, nil, err
	}
	c := &Conn{
		id:        g.hub.nextID.Add(1),
		userID:    user.ID,
		sessionID: sess.ID,
		address:   frame.GetAuth().GetAddress(),
		user:      user,
		ws:        ws,
		out:       make(chan []byte, sendBuffer),
		cancel:    cancel,
	}
	return c, frame, nil
}

func (g *Gateway) authResponse(ctx context.Context, c *Conn) (*amv1.AuthResponse, error) {
	me, err := g.conv.UserView(ctx, c.user)
	if err != nil {
		return nil, err
	}
	convs, err := g.conv.ListConversations(ctx, c.userID)
	if err != nil {
		return nil, err
	}
	return &amv1.AuthResponse{Me: me, Conversations: convs, IsSiteAdmin: c.user.IsSiteAdmin, PublicAddress: g.acct.PublicAddress()}, nil
}

func (g *Gateway) writeLoop(ctx context.Context, c *Conn) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case data := <-c.out:
			wctx, done := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Write(wctx, websocket.MessageBinary, data)
			done()
			if err != nil {
				c.close(websocket.StatusGoingAway, "write failed")
				return
			}
		case <-ticker.C:
			pctx, done := context.WithTimeout(ctx, writeTimeout)
			err := c.ws.Ping(pctx)
			done()
			if err != nil {
				c.close(websocket.StatusGoingAway, "ping timeout")
				return
			}
		}
	}
}

func (g *Gateway) readLoop(ctx context.Context, c *Conn) {
	for {
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary {
			continue
		}
		frame := &amv1.ClientFrame{}
		if err := proto.Unmarshal(data, frame); err != nil {
			c.enqueueFrame(errorFrame(0, apperr.ErrBadRequest, g.log))
			continue
		}
		c.enqueueFrame(g.handle(ctx, c, frame))
	}
}

func (c *Conn) enqueueFrame(f *amv1.ServerFrame) {
	if f == nil {
		return
	}
	if b, err := proto.Marshal(f); err == nil {
		c.enqueue(b)
	}
}

// handle runs one request and returns its response frame.
func (g *Gateway) handle(ctx context.Context, c *Conn, f *amv1.ClientFrame) *amv1.ServerFrame {
	id := f.GetReqId()
	var err error
	switch m := f.GetMsg().(type) {
	case *amv1.ClientFrame_Ping:
		return &amv1.ServerFrame{ReqId: id, Msg: &amv1.ServerFrame_Pong{Pong: &amv1.Pong{}}}
	case *amv1.ClientFrame_Send:
		var ev *amv1.Event
		if ev, err = g.msg.Send(ctx, c.user, m.Send, c.id); err == nil {
			return &amv1.ServerFrame{ReqId: id, Msg: &amv1.ServerFrame_Send{Send: &amv1.SendResponse{Event: ev}}}
		}
	case *amv1.ClientFrame_Sync:
		var resp *amv1.SyncResponse
		if resp, err = g.msg.Sync(ctx, c.user, m.Sync); err == nil {
			return &amv1.ServerFrame{ReqId: id, Msg: &amv1.ServerFrame_Sync{Sync: resp}}
		}
	case *amv1.ClientFrame_MarkRead:
		if err = g.msg.MarkRead(ctx, c.user, m.MarkRead); err == nil {
			return &amv1.ServerFrame{ReqId: id, Msg: &amv1.ServerFrame_MarkRead{MarkRead: &amv1.MarkReadResponse{}}}
		}
	case *amv1.ClientFrame_Auth:
		err = apperr.New(http.StatusBadRequest, "already_authenticated", "already authenticated")
	default:
		err = apperr.ErrBadRequest
	}
	return errorFrame(id, err, g.log)
}

func errorFrame(reqID uint64, err error, log *slog.Logger) *amv1.ServerFrame {
	e := apperr.As(err)
	if e == nil {
		log.Error("request failed", "err", err)
		e = apperr.New(http.StatusInternalServerError, "internal_error", "internal error")
	}
	return &amv1.ServerFrame{ReqId: reqID, Msg: &amv1.ServerFrame_Error{Error: &amv1.Error{Code: e.Code, Message: e.Message}}}
}
