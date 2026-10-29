// Package amclient is a small Go client for the AM server: HTTP API calls
// plus a WebSocket connection with request/response matching.
// Used by the test client and the end-to-end tests; bots written in Go can
// use it too.
package amclient

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

// APIError is an error returned by the server.
type APIError struct {
	Status  int // HTTP status (0 for WebSocket errors)
	Code    string
	Message string
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

// IsCode reports whether err is an APIError with the given code.
func IsCode(err error, code string) bool {
	var e *APIError
	return errors.As(err, &e) && e.Code == code
}

type Client struct {
	BaseURL string // e.g. "https://1.2.3.4:8443"
	Token   string
	HTTP    *http.Client
}

// New creates a client. tlsCfg may be nil (system roots / plain http).
func New(baseURL string, tlsCfg *tls.Config) *Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = tlsCfg
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Transport: tr, Timeout: 30 * time.Second},
	}
}

func (c *Client) call(ctx context.Context, method, path string, in, out proto.Message) error {
	var body io.Reader
	if in != nil {
		b, err := protojson.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	opts := protojson.UnmarshalOptions{DiscardUnknown: true}
	if resp.StatusCode >= 300 {
		e := &amv1.Error{}
		if opts.Unmarshal(data, e) != nil || e.Code == "" {
			return &APIError{Status: resp.StatusCode, Code: "http_error", Message: strings.TrimSpace(string(data))}
		}
		return &APIError{Status: resp.StatusCode, Code: e.Code, Message: e.Message}
	}
	if out != nil {
		return opts.Unmarshal(data, out)
	}
	return nil
}

func (c *Client) Register(ctx context.Context, req *amv1.RegisterRequest) (*amv1.SessionResponse, error) {
	out := &amv1.SessionResponse{}
	if err := c.call(ctx, http.MethodPost, "/api/v1/register", req, out); err != nil {
		return nil, err
	}
	c.Token = out.Token
	return out, nil
}

func (c *Client) Login(ctx context.Context, req *amv1.LoginRequest) (*amv1.SessionResponse, error) {
	out := &amv1.SessionResponse{}
	if err := c.call(ctx, http.MethodPost, "/api/v1/login", req, out); err != nil {
		return nil, err
	}
	c.Token = out.Token
	return out, nil
}

func (c *Client) ListSessions(ctx context.Context) (*amv1.ListSessionsResponse, error) {
	out := &amv1.ListSessionsResponse{}
	return out, c.call(ctx, http.MethodGet, "/api/v1/sessions", nil, out)
}

func (c *Client) RevokeSession(ctx context.Context, id int64) error {
	return c.call(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/sessions/%d", id), nil, nil)
}

func (c *Client) ListInvites(ctx context.Context) (*amv1.ListInvitesResponse, error) {
	out := &amv1.ListInvitesResponse{}
	return out, c.call(ctx, http.MethodGet, "/api/v1/invites", nil, out)
}

func (c *Client) CreateInvite(ctx context.Context) (*amv1.Invite, error) {
	out := &amv1.Invite{}
	return out, c.call(ctx, http.MethodPost, "/api/v1/invites", nil, out)
}

func (c *Client) ListFriends(ctx context.Context) (*amv1.ListFriendsResponse, error) {
	out := &amv1.ListFriendsResponse{}
	return out, c.call(ctx, http.MethodGet, "/api/v1/friends", nil, out)
}

func (c *Client) RequestFriend(ctx context.Context, username string) error {
	return c.call(ctx, http.MethodPost, "/api/v1/friends/request", &amv1.FriendRequest{Username: username}, nil)
}

func (c *Client) AcceptFriend(ctx context.Context, userID int64) error {
	return c.call(ctx, http.MethodPost, "/api/v1/friends/accept", &amv1.FriendAccept{UserId: userID}, nil)
}

func (c *Client) OpenDM(ctx context.Context, userID int64) (*amv1.Conversation, error) {
	out := &amv1.Conversation{}
	return out, c.call(ctx, http.MethodPost, "/api/v1/dm", &amv1.OpenDMRequest{UserId: userID}, out)
}

// ---- WebSocket ----

// Conn is an authenticated WebSocket connection.
type Conn struct {
	// Auth is the server's answer to the auth frame (profile + conversations).
	Auth *amv1.AuthResponse
	// Pushes receives server-initiated frames (events, conversation and
	// friend changes). It is closed when the connection ends.
	Pushes <-chan *amv1.ServerFrame

	ws      *websocket.Conn
	pushes  chan *amv1.ServerFrame
	nextReq atomic.Uint64
	mu      sync.Mutex
	pending map[uint64]chan *amv1.ServerFrame
	done    chan struct{}
	err     error
}

// Connect opens /ws and authenticates with the client's token.
func (c *Client) Connect(ctx context.Context) (*Conn, error) {
	url := c.BaseURL + "/ws"
	url = strings.Replace(url, "https://", "wss://", 1)
	url = strings.Replace(url, "http://", "ws://", 1)
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: c.HTTP})
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(16 << 20)
	conn := &Conn{
		ws:      ws,
		pushes:  make(chan *amv1.ServerFrame, 1024),
		pending: make(map[uint64]chan *amv1.ServerFrame),
		done:    make(chan struct{}),
	}
	conn.Pushes = conn.pushes
	go conn.readLoop()

	resp, err := conn.Request(ctx, &amv1.ClientFrame{Msg: &amv1.ClientFrame_Auth{Auth: &amv1.AuthRequest{Token: c.Token}}})
	if err != nil {
		conn.Close()
		return nil, err
	}
	conn.Auth = resp.GetAuth()
	return conn, nil
}

func (c *Conn) readLoop() {
	defer func() {
		close(c.done)
		close(c.pushes)
	}()
	for {
		_, data, err := c.ws.Read(context.Background())
		if err != nil {
			c.err = err
			return
		}
		f := &amv1.ServerFrame{}
		if proto.Unmarshal(data, f) != nil {
			continue
		}
		if f.ReqId == 0 {
			select {
			case c.pushes <- f:
			default: // consumer not keeping up; it will resync
			}
			continue
		}
		c.mu.Lock()
		ch := c.pending[f.ReqId]
		delete(c.pending, f.ReqId)
		c.mu.Unlock()
		if ch != nil {
			ch <- f
		}
	}
}

// Request sends a frame and waits for the matching response. An error
// frame is returned as *APIError.
func (c *Conn) Request(ctx context.Context, f *amv1.ClientFrame) (*amv1.ServerFrame, error) {
	id := c.nextReq.Add(1)
	f.ReqId = id
	ch := make(chan *amv1.ServerFrame, 1)
	c.mu.Lock()
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	data, err := proto.Marshal(f)
	if err != nil {
		return nil, err
	}
	if err := c.ws.Write(ctx, websocket.MessageBinary, data); err != nil {
		return nil, err
	}
	select {
	case resp := <-ch:
		if e := resp.GetError(); e != nil {
			return nil, &APIError{Code: e.Code, Message: e.Message}
		}
		return resp, nil
	case <-c.done:
		if c.err != nil {
			return nil, c.err
		}
		return nil, errors.New("connection closed")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Done is closed when the connection ends.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Err returns why the connection ended.
func (c *Conn) Err() error { return c.err }

func (c *Conn) Close() error { return c.ws.Close(websocket.StatusNormalClosure, "") }

// NewClientMsgID returns a random id for SendRequest.client_msg_id.
func NewClientMsgID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (c *Conn) send(ctx context.Context, req *amv1.SendRequest) (*amv1.Event, error) {
	if req.ClientMsgId == "" {
		req.ClientMsgId = NewClientMsgID()
	}
	resp, err := c.Request(ctx, &amv1.ClientFrame{Msg: &amv1.ClientFrame_Send{Send: req}})
	if err != nil {
		return nil, err
	}
	return resp.GetSend().GetEvent(), nil
}

// SendText sends a text message.
func (c *Conn) SendText(ctx context.Context, convID int64, text string) (*amv1.Event, error) {
	return c.send(ctx, &amv1.SendRequest{ConvId: convID, Body: &amv1.SendRequest_Text{Text: &amv1.TextMsg{Text: text}}})
}

// SendTextWithID sends a text message with a fixed client_msg_id (to test resends).
func (c *Conn) SendTextWithID(ctx context.Context, convID int64, text, clientMsgID string) (*amv1.Event, error) {
	return c.send(ctx, &amv1.SendRequest{ConvId: convID, ClientMsgId: clientMsgID,
		Body: &amv1.SendRequest_Text{Text: &amv1.TextMsg{Text: text}}})
}

// Strike strikes through one of your own messages.
func (c *Conn) Strike(ctx context.Context, convID, eventID int64) (*amv1.Event, error) {
	return c.send(ctx, &amv1.SendRequest{ConvId: convID, Body: &amv1.SendRequest_Strike{Strike: &amv1.StrikeAct{TargetEventId: eventID}}})
}

// Sync fetches events after the given seq per conversation.
func (c *Conn) Sync(ctx context.Context, cursors map[int64]int64, limit int32) (*amv1.SyncResponse, error) {
	req := &amv1.SyncRequest{Limit: limit}
	for conv, seq := range cursors {
		req.Cursors = append(req.Cursors, &amv1.SyncCursor{ConvId: conv, AfterSeq: seq})
	}
	resp, err := c.Request(ctx, &amv1.ClientFrame{Msg: &amv1.ClientFrame_Sync{Sync: req}})
	if err != nil {
		return nil, err
	}
	return resp.GetSync(), nil
}

func (c *Conn) MarkRead(ctx context.Context, convID, seq int64) error {
	_, err := c.Request(ctx, &amv1.ClientFrame{Msg: &amv1.ClientFrame_MarkRead{MarkRead: &amv1.MarkReadRequest{ConvId: convID, Seq: seq}}})
	return err
}
