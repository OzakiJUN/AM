package amclient

import (
	"context"
	"fmt"
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

// Logout ends this client's session on the server.
func (c *Client) Logout(ctx context.Context) error {
	if err := c.call(ctx, http.MethodPost, "/api/v1/logout", nil, nil); err != nil {
		return err
	}
	c.Token = ""
	return nil
}

// CreatePairTicket makes a one-time ticket that logs in another device of
// mine; bundle (may be nil) is handed to that device.
func (c *Client) CreatePairTicket(ctx context.Context, bundle []byte) (*amv1.PairTicket, error) {
	out := &amv1.PairTicket{}
	return out, c.call(ctx, http.MethodPost, "/api/v1/pair", &amv1.CreatePairTicketRequest{Bundle: bundle}, out)
}

// RedeemPairTicket logs this client in with a pairing ticket.
func (c *Client) RedeemPairTicket(ctx context.Context, ticket, device string) (*amv1.PairRedeemResponse, error) {
	out := &amv1.PairRedeemResponse{}
	if err := c.call(ctx, http.MethodPost, "/api/v1/pair/redeem", &amv1.RedeemPairTicketRequest{Ticket: ticket, DeviceName: device}, out); err != nil {
		return nil, err
	}
	c.Token = out.Token
	return out, nil
}

// ClientState returns the encrypted state my devices share.
func (c *Client) ClientState(ctx context.Context) (*amv1.ClientState, error) {
	out := &amv1.ClientState{}
	return out, c.call(ctx, http.MethodGet, "/api/v1/me/client-state", nil, out)
}

// PutClientState saves it; base is the updated_at it was merged from.
func (c *Client) PutClientState(ctx context.Context, data []byte, base int64) (*amv1.ClientState, error) {
	out := &amv1.ClientState{}
	return out, c.call(ctx, http.MethodPut, "/api/v1/me/client-state", &amv1.PutClientStateRequest{Data: data, BaseUpdatedAt: base}, out)
}

// ListAI returns my AI accounts.
func (c *Client) ListAI(ctx context.Context) (*amv1.ListAIResponse, error) {
	out := &amv1.ListAIResponse{}
	return out, c.call(ctx, http.MethodGet, "/api/v1/ai", nil, out)
}

// CreateAI makes a new AI account owned by me.
func (c *Client) CreateAI(ctx context.Context, name string) (*amv1.AIAccount, error) {
	out := &amv1.AIAccount{}
	return out, c.call(ctx, http.MethodPost, "/api/v1/ai", &amv1.CreateAIRequest{DisplayName: name}, out)
}

// UpdateAI changes my AI's name, avatar or signature.
func (c *Client) UpdateAI(ctx context.Context, id int64, req *amv1.UpdateProfileRequest) (*amv1.User, error) {
	out := &amv1.User{}
	return out, c.call(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/ai/%d", id), req, out)
}

// PutAISettings saves my AI's settings JSON; base is the updated_at it was edited from.
func (c *Client) PutAISettings(ctx context.Context, id int64, settings string, base int64) (*amv1.AIAccount, error) {
	out := &amv1.AIAccount{}
	return out, c.call(ctx, http.MethodPut, fmt.Sprintf("/api/v1/ai/%d/settings", id), &amv1.PutAISettingsRequest{Settings: settings, BaseUpdatedAt: base}, out)
}

// RunAI returns a session token of my AI for this device (which then runs it).
func (c *Client) RunAI(ctx context.Context, id int64, device string) (*amv1.SessionResponse, error) {
	out := &amv1.SessionResponse{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/ai/%d/run", id), &amv1.RunAIRequest{DeviceName: device}, out)
}

// DeleteAI takes my AI off the server.
func (c *Client) DeleteAI(ctx context.Context, id int64) error {
	return c.call(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/ai/%d", id), nil, nil)
}

// AILeaveChannel takes my AI out of a channel.
func (c *Client) AILeaveChannel(ctx context.Context, id, convID int64) error {
	return c.call(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/ai/%d/channels/%d", id, convID), nil, nil)
}

// CreateAIRoom makes a shared room with my AI and the people listed.
func (c *Client) CreateAIRoom(ctx context.Context, aiID int64, name string, memberIDs ...int64) (*amv1.Conversation, error) {
	out := &amv1.Conversation{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/ai/%d/room", aiID), &amv1.CreateAIRoomRequest{Name: name, MemberIds: memberIDs}, out)
}

// GetPortraits returns a bot / AI's own portrait pack (mood -> media id).
func (c *Client) GetPortraits(ctx context.Context, userID int64) (*amv1.PortraitPack, error) {
	out := &amv1.PortraitPack{}
	return out, c.call(ctx, http.MethodGet, fmt.Sprintf("/api/v1/users/%d/portraits", userID), nil, out)
}

// SetPortraits replaces my AI's portrait pack.
func (c *Client) SetPortraits(ctx context.Context, aiID int64, pack map[string]int64) error {
	return c.call(ctx, http.MethodPut, fmt.Sprintf("/api/v1/ai/%d/portraits", aiID), &amv1.PortraitPack{MediaIds: pack}, &amv1.PortraitPack{})
}

// RequestShare asks an AI's owner to let me talk with it.
func (c *Client) RequestShare(ctx context.Context, aiID int64) error {
	return c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/ai/%d/share-request", aiID), &amv1.Empty{}, nil)
}

// ShareRequests lists who asked to talk with my AI.
func (c *Client) ShareRequests(ctx context.Context, aiID int64) (*amv1.ShareRequests, error) {
	out := &amv1.ShareRequests{}
	return out, c.call(ctx, http.MethodGet, fmt.Sprintf("/api/v1/ai/%d/share-requests", aiID), nil, out)
}

// DecideShare answers a request; approved returns the shared room.
func (c *Client) DecideShare(ctx context.Context, aiID, userID int64, approve bool) (*amv1.Conversation, error) {
	out := &amv1.Conversation{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/ai/%d/share-requests/%d", aiID, userID), &amv1.DecideShareRequest{Approve: approve}, out)
}
