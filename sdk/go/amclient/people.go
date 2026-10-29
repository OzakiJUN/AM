package amclient

import (
	"context"
	"fmt"
	"net/http"
	"net/url"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

// ListUsers pages through everyone on the server. after = NextAfter of the
// previous page (0 for the first); limit 0 = server default.
func (c *Client) ListUsers(ctx context.Context, query string, after int64, limit int) (*amv1.ListUsersResponse, error) {
	v := url.Values{}
	if query != "" {
		v.Set("query", query)
	}
	if after != 0 {
		v.Set("after", fmt.Sprint(after))
	}
	if limit != 0 {
		v.Set("limit", fmt.Sprint(limit))
	}
	path := "/api/v1/users"
	if len(v) > 0 {
		path += "?" + v.Encode()
	}
	out := &amv1.ListUsersResponse{}
	return out, c.call(ctx, http.MethodGet, path, nil, out)
}

// FindUser returns the account with exactly this username (case-insensitive).
func (c *Client) FindUser(ctx context.Context, username string) (*amv1.User, error) {
	var after int64
	for {
		resp, err := c.ListUsers(ctx, username, after, 200)
		if err != nil {
			return nil, err
		}
		for _, u := range resp.Users {
			if equalFold(u.Username, username) {
				return u, nil
			}
		}
		if resp.NextAfter == 0 {
			return nil, fmt.Errorf("user %q not found", username)
		}
		after = resp.NextAfter
	}
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		x, y := a[i], b[i]
		if 'A' <= x && x <= 'Z' {
			x += 32
		}
		if 'A' <= y && y <= 'Z' {
			y += 32
		}
		if x != y {
			return false
		}
	}
	return true
}

func (c *Client) ListBlocks(ctx context.Context) (*amv1.ListBlocksResponse, error) {
	out := &amv1.ListBlocksResponse{}
	return out, c.call(ctx, http.MethodGet, "/api/v1/blocks", nil, out)
}

func (c *Client) Block(ctx context.Context, userID int64) error {
	return c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/blocks/%d", userID), nil, nil)
}

func (c *Client) Unblock(ctx context.Context, userID int64) error {
	return c.call(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/blocks/%d", userID), nil, nil)
}

// ListChannels returns every public channel.
func (c *Client) ListChannels(ctx context.Context) (*amv1.ListChannelsResponse, error) {
	out := &amv1.ListChannelsResponse{}
	return out, c.call(ctx, http.MethodGet, "/api/v1/channels", nil, out)
}

func (c *Client) JoinChannel(ctx context.Context, convID int64) (*amv1.Conversation, error) {
	out := &amv1.Conversation{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/channels/%d/join", convID), nil, out)
}

// CreatePublicChannel creates a public channel (site admins only).
func (c *Client) CreatePublicChannel(ctx context.Context, name string) (*amv1.Conversation, error) {
	out := &amv1.Conversation{}
	return out, c.call(ctx, http.MethodPost, "/api/v1/groups", &amv1.CreateGroupRequest{Name: name, Public: true}, out)
}
