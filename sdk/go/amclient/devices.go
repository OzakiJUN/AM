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
