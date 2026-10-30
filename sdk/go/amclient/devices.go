package amclient

import (
	"context"
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
