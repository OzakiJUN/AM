package amclient

import (
	"context"
	"fmt"
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

// HostAI asks for my AI to be hosted on the server, with my model providers (JSON).
func (c *Client) HostAI(ctx context.Context, aiID int64, providersJSON string) (*amv1.AIHosting, error) {
	out := &amv1.AIHosting{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/ai/%d/host", aiID), &amv1.HostAIRequest{ProvidersJson: providersJSON}, out)
}

// UnhostAI takes my AI off the server (or withdraws the request).
func (c *Client) UnhostAI(ctx context.Context, aiID int64) error {
	return c.call(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/ai/%d/host", aiID), nil, nil)
}

// MyAI returns a bot / AI's own settings (logged in as the AI).
func (c *Client) MyAI(ctx context.Context) (*amv1.AIAccount, error) {
	out := &amv1.AIAccount{}
	return out, c.call(ctx, http.MethodGet, "/api/v1/me/ai", nil, out)
}

// PutMyAISettings saves a bot / AI's own settings (logged in as the AI).
func (c *Client) PutMyAISettings(ctx context.Context, settings string, base int64) (*amv1.AIAccount, error) {
	out := &amv1.AIAccount{}
	return out, c.call(ctx, http.MethodPut, "/api/v1/me/ai/settings", &amv1.PutAISettingsRequest{Settings: settings, BaseUpdatedAt: base}, out)
}
