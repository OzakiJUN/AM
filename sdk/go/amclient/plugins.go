package amclient

import (
	"context"
	"fmt"
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

// ListPlugins returns my AI's plugins and the state of its plugin process.
func (c *Client) ListPlugins(ctx context.Context, aiID int64) (*amv1.ListPluginsResponse, error) {
	out := &amv1.ListPluginsResponse{}
	return out, c.call(ctx, http.MethodGet, fmt.Sprintf("/api/v1/ai/%d/plugins", aiID), nil, out)
}

// UploadPlugins adds the plugins in an uploaded zip to my AI.
func (c *Client) UploadPlugins(ctx context.Context, aiID, mediaID int64) (*amv1.ListPluginsResponse, error) {
	out := &amv1.ListPluginsResponse{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/ai/%d/plugins", aiID), &amv1.UploadPluginsRequest{MediaId: mediaID}, out)
}

// UpdatePlugin turns a plugin on / off and patches its settings (JSON object, "" = unchanged).
func (c *Client) UpdatePlugin(ctx context.Context, aiID, id int64, enabled *bool, configPatch string) (*amv1.AIPlugin, error) {
	out := &amv1.AIPlugin{}
	return out, c.call(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/ai/%d/plugins/%d", aiID, id),
		&amv1.UpdatePluginRequest{Enabled: enabled, ConfigJson: configPatch}, out)
}

// DeletePlugin removes a plugin from my AI.
func (c *Client) DeletePlugin(ctx context.Context, aiID, id int64) error {
	return c.call(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/ai/%d/plugins/%d", aiID, id), nil, nil)
}
