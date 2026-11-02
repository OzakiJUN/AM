package httpapi

import "github.com/OzakiJUN/am/server/internal/plugin"

// AI plugins run as the server's built-in bot and are managed in the admin
// panel only (docs/plugins.md); ServerInfo.plugins says whether they are on.

// SetPlugins connects the plugin service (nil = plugins aren't available).
func (a *API) SetPlugins(ps *plugin.Service) { a.plugins = ps }
