package amclient

import (
	"context"
	"fmt"
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

// ListStickers returns my sticker collection, newest first.
func (c *Client) ListStickers(ctx context.Context) (*amv1.ListStickersResponse, error) {
	out := &amv1.ListStickersResponse{}
	return out, c.call(ctx, http.MethodGet, "/api/v1/stickers", nil, out)
}

// AddSticker puts one of my uploaded images into my collection.
func (c *Client) AddSticker(ctx context.Context, mediaID int64, tags ...string) (*amv1.Sticker, error) {
	out := &amv1.Sticker{}
	return out, c.call(ctx, http.MethodPost, "/api/v1/stickers", &amv1.AddStickerRequest{MediaId: mediaID, Tags: tags}, out)
}

// SetStickerTags replaces a sticker's tags.
func (c *Client) SetStickerTags(ctx context.Context, id int64, tags ...string) (*amv1.Sticker, error) {
	out := &amv1.Sticker{}
	return out, c.call(ctx, http.MethodPatch, fmt.Sprintf("/api/v1/stickers/%d", id), &amv1.UpdateStickerRequest{Tags: tags}, out)
}

// DeleteSticker takes a sticker out of my collection.
func (c *Client) DeleteSticker(ctx context.Context, id int64) error {
	return c.call(ctx, http.MethodDelete, fmt.Sprintf("/api/v1/stickers/%d", id), nil, nil)
}

// SendSticker sends one of my stickers (an image with its tags).
func (c *Conn) SendSticker(ctx context.Context, convID, mediaID int64, tags ...string) (*amv1.Event, error) {
	return c.send(ctx, &amv1.SendRequest{ConvId: convID, Body: &amv1.SendRequest_Image{Image: &amv1.ImageMsg{MediaId: mediaID, StickerTags: tags}}})
}

// ResolveMusic reads a NetEase song or playlist link (the cover is copied into my uploads).
func (c *Client) ResolveMusic(ctx context.Context, link string) (*amv1.ResolveMusicResponse, error) {
	out := &amv1.ResolveMusicResponse{}
	return out, c.call(ctx, http.MethodPost, "/api/v1/music/resolve", &amv1.ResolveMusicRequest{Url: link}, out)
}

// RemoteTool (an AI's connection) asks a person's devices to run a computer tool.
func (c *Conn) RemoteTool(ctx context.Context, requestID string, toUserID int64, tool, argsJSON string) error {
	_, err := c.Request(ctx, &amv1.ClientFrame{Msg: &amv1.ClientFrame_RemoteTool{RemoteTool: &amv1.RemoteToolRequest{
		RequestId: requestID, ToUserId: toUserID, Tool: tool, ArgsJson: argsJSON,
	}}})
	return err
}

// RemoteToolResult (a person's connection) answers an AI's request.
func (c *Conn) RemoteToolResult(ctx context.Context, res *amv1.RemoteToolResult) error {
	_, err := c.Request(ctx, &amv1.ClientFrame{Msg: &amv1.ClientFrame_RemoteToolResult{RemoteToolResult: res}})
	return err
}
