package amclient

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

// ---- lookups ----

func (c *Client) GetConversation(ctx context.Context, convID int64) (*amv1.Conversation, error) {
	out := &amv1.Conversation{}
	return out, c.call(ctx, http.MethodGet, fmt.Sprintf("/api/v1/conversations/%d", convID), nil, out)
}

func (c *Client) GetUser(ctx context.Context, userID int64) (*amv1.User, error) {
	out := &amv1.User{}
	return out, c.call(ctx, http.MethodGet, fmt.Sprintf("/api/v1/users/%d", userID), nil, out)
}

// ---- profile ----

func (c *Client) UpdateProfile(ctx context.Context, req *amv1.UpdateProfileRequest) (*amv1.User, error) {
	out := &amv1.User{}
	return out, c.call(ctx, http.MethodPatch, "/api/v1/me", req, out)
}

func (c *Client) ListLogins(ctx context.Context) (*amv1.ListLoginRecordsResponse, error) {
	out := &amv1.ListLoginRecordsResponse{}
	return out, c.call(ctx, http.MethodGet, "/api/v1/me/logins", nil, out)
}

// ---- groups ----

func (c *Client) CreateGroup(ctx context.Context, name string, memberIDs ...int64) (*amv1.Conversation, error) {
	out := &amv1.Conversation{}
	return out, c.call(ctx, http.MethodPost, "/api/v1/groups", &amv1.CreateGroupRequest{Name: name, MemberIds: memberIDs}, out)
}

func (c *Client) UpdateGroup(ctx context.Context, convID int64, req *amv1.UpdateGroupRequest) (*amv1.Conversation, error) {
	out := &amv1.Conversation{}
	return out, c.call(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/groups/%d", convID), req, out)
}

func (c *Client) DissolveGroup(ctx context.Context, convID int64) error {
	return c.call(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/groups/%d", convID), nil, nil)
}

func (c *Client) InviteMembers(ctx context.Context, convID int64, userIDs ...int64) (*amv1.InviteMembersResponse, error) {
	out := &amv1.InviteMembersResponse{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/groups/%d/members", convID),
		&amv1.InviteMembersRequest{UserIds: userIDs}, out)
}

// RemoveMember kicks a member, or leaves when userID is your own id.
func (c *Client) RemoveMember(ctx context.Context, convID, userID int64) error {
	return c.call(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/groups/%d/members/%d", convID, userID), nil, nil)
}

func (c *Client) SetAdmin(ctx context.Context, convID, userID int64, admin bool) error {
	method := http.MethodPost
	if !admin {
		method = http.MethodDelete
	}
	return c.call(ctx, method, fmt.Sprintf("/api/v1/groups/%d/admins/%d", convID, userID), nil, nil)
}

func (c *Client) TransferGroup(ctx context.Context, convID, userID int64) error {
	return c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/groups/%d/transfer", convID),
		&amv1.TransferGroupRequest{UserId: userID}, nil)
}

// Mute mutes a member for seconds (0 = unmute).
func (c *Client) Mute(ctx context.Context, convID, userID, seconds int64) error {
	return c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/groups/%d/mute", convID),
		&amv1.MuteMemberRequest{UserId: userID, DurationSeconds: seconds}, nil)
}

func (c *Client) ListJoinRequests(ctx context.Context, convID int64) (*amv1.ListJoinRequestsResponse, error) {
	out := &amv1.ListJoinRequestsResponse{}
	return out, c.call(ctx, http.MethodGet, fmt.Sprintf("/api/v1/groups/%d/requests", convID), nil, out)
}

func (c *Client) DecideJoinRequest(ctx context.Context, convID, userID int64, approve bool) error {
	action := "reject"
	if approve {
		action = "approve"
	}
	return c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/groups/%d/requests/%d/%s", convID, userID, action), nil, nil)
}

// ---- moderation ----

func (c *Client) AdminDelete(ctx context.Context, eventID int64, reason string, blockMedia bool) error {
	return c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/events/%d/delete", eventID),
		&amv1.AdminDeleteRequest{Reason: reason, BlockMedia: blockMedia}, nil)
}

// ---- media ----

// Upload sends a file and returns its media info.
func (c *Client) Upload(ctx context.Context, name string, data io.Reader) (*amv1.MediaInfo, error) {
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		part, err := mw.CreateFormFile("file", name)
		if err == nil {
			_, err = io.Copy(part, data)
		}
		if err == nil {
			err = mw.Close()
		}
		pw.CloseWithError(err)
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/v1/media", pr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, decodeError(resp.StatusCode, body)
	}
	out := &amv1.MediaInfo{}
	return out, protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(body, out)
}

// Download fetches a media path such as MediaInfo.Url or User.Avatar.
func (c *Client) Download(ctx context.Context, path string) ([]byte, string, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, "", fmt.Errorf("not a server path: %q", path)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+path, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", err
	}
	if resp.StatusCode >= 300 {
		return nil, "", decodeError(resp.StatusCode, body)
	}
	return body, resp.Header.Get("Content-Type"), nil
}

func decodeError(status int, body []byte) error {
	e := &amv1.Error{}
	if protojson.Unmarshal(body, e) != nil || e.Code == "" {
		return &APIError{Status: status, Code: "http_error", Message: string(bytes.TrimSpace(body))}
	}
	return &APIError{Status: status, Code: e.Code, Message: e.Message}
}

// SendImage sends an uploaded image.
func (c *Conn) SendImage(ctx context.Context, convID, mediaID int64) (*amv1.Event, error) {
	return c.send(ctx, &amv1.SendRequest{ConvId: convID, Body: &amv1.SendRequest_Image{Image: &amv1.ImageMsg{MediaId: mediaID}}})
}

// SendFile sends an uploaded file.
func (c *Conn) SendFile(ctx context.Context, convID, mediaID int64, name string) (*amv1.Event, error) {
	return c.send(ctx, &amv1.SendRequest{ConvId: convID, Body: &amv1.SendRequest_File{File: &amv1.FileMsg{MediaId: mediaID, Name: name}}})
}
