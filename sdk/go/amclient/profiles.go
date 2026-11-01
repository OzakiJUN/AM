package amclient

import (
	"context"
	"fmt"
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

// profilePath is a user's profile page, or the server's (userID 0).
func profilePath(userID int64) string {
	if userID == 0 {
		return "/api/v1/profiles/server"
	}
	return fmt.Sprintf("/api/v1/profiles/users/%d", userID)
}

// GetProfile returns a user's profile page (userID 0 = the server's).
func (c *Client) GetProfile(ctx context.Context, userID int64) (*amv1.ProfileView, error) {
	out := &amv1.ProfileView{}
	return out, c.call(ctx, http.MethodGet, profilePath(userID), nil, out)
}

// SaveProfile saves a new layout; baseVersion is the version it was edited from.
func (c *Client) SaveProfile(ctx context.Context, userID int64, layout *amv1.ProfileLayout, baseVersion int64) (*amv1.ProfileView, error) {
	out := &amv1.ProfileView{}
	return out, c.call(ctx, http.MethodPut, profilePath(userID), &amv1.SaveProfileRequest{Layout: layout, BaseVersion: baseVersion}, out)
}

func (c *Client) ListGuestbook(ctx context.Context, userID int64, widgetID string, before int64) (*amv1.ListGuestbookResponse, error) {
	out := &amv1.ListGuestbookResponse{}
	return out, c.call(ctx, http.MethodGet, fmt.Sprintf("%s/guestbook/%s?before=%d", profilePath(userID), widgetID, before), nil, out)
}

func (c *Client) PostGuestbook(ctx context.Context, userID int64, widgetID, text string) (*amv1.GuestbookEntry, error) {
	out := &amv1.GuestbookEntry{}
	return out, c.call(ctx, http.MethodPost, profilePath(userID)+"/guestbook/"+widgetID, &amv1.PostGuestbookRequest{Text: text}, out)
}

func (c *Client) HideGuestbook(ctx context.Context, entryID int64, hidden bool) error {
	return c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/guestbook/%d/hide", entryID), &amv1.HideGuestbookRequest{Hidden: hidden}, nil)
}

func (c *Client) DeleteGuestbook(ctx context.Context, entryID int64, reason string) error {
	return c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/guestbook/%d/delete", entryID), &amv1.DeleteGuestbookRequest{Reason: reason}, nil)
}
