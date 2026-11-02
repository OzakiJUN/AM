package amclient

import (
	"context"
	"fmt"
	"net/http"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
)

// Museum returns a channel's museum.
func (c *Client) Museum(ctx context.Context, convID int64) (*amv1.MuseumView, error) {
	out := &amv1.MuseumView{}
	return out, c.call(ctx, http.MethodGet, fmt.Sprintf("/api/v1/conversations/%d/museum", convID), nil, out)
}

// MuseumHang proposes hanging a chat picture (event_id) or a work (art_id).
func (c *Client) MuseumHang(ctx context.Context, convID int64, req *amv1.MuseumHangRequest) (*amv1.MuseumResult, error) {
	out := &amv1.MuseumResult{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/conversations/%d/museum/hang", convID), req, out)
}

// MuseumRemove proposes taking a work down.
func (c *Client) MuseumRemove(ctx context.Context, convID, artID int64) (*amv1.MuseumResult, error) {
	out := &amv1.MuseumResult{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/conversations/%d/museum/remove", convID), &amv1.MuseumActRequest{ArtId: artID}, out)
}

// MuseumSwap proposes exchanging two first-hall positions.
func (c *Client) MuseumSwap(ctx context.Context, convID int64, a, b int32) (*amv1.MuseumResult, error) {
	out := &amv1.MuseumResult{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/conversations/%d/museum/swap", convID), &amv1.MuseumActRequest{A: a, B: b}, out)
}

// MuseumLike likes (or takes back a like on) a work.
func (c *Client) MuseumLike(ctx context.Context, artID int64, on bool) (*amv1.MuseumArt, error) {
	out := &amv1.MuseumArt{}
	method := http.MethodPost
	if !on {
		method = http.MethodDelete
	}
	return out, c.call(ctx, method, fmt.Sprintf("/api/v1/museum/arts/%d/like", artID), nil, out)
}

// MuseumVote votes on a museum change.
func (c *Client) MuseumVote(ctx context.Context, voteID int64, agree bool) (*amv1.MuseumVote, error) {
	out := &amv1.MuseumVote{}
	return out, c.call(ctx, http.MethodPost, fmt.Sprintf("/api/v1/museum/votes/%d", voteID), &amv1.MuseumVoteRequest{Agree: agree}, out)
}

// SendImageMade sends a picture an AI made (made_with / nsfw are kept only for ai / bot accounts).
func (c *Conn) SendImageMade(ctx context.Context, convID, mediaID int64, madeWith string, nsfw bool) (*amv1.Event, error) {
	return c.send(ctx, &amv1.SendRequest{ConvId: convID, Body: &amv1.SendRequest_Image{Image: &amv1.ImageMsg{MediaId: mediaID, MadeWith: madeWith, Nsfw: nsfw}}})
}

// SendImageFor sends a picture an AI drew for someone (made_for / made_from are kept only for ai / bot accounts).
func (c *Conn) SendImageFor(ctx context.Context, convID, mediaID int64, madeWith string, nsfw bool, madeFor int64, madeFrom string) (*amv1.Event, error) {
	return c.send(ctx, &amv1.SendRequest{ConvId: convID, Body: &amv1.SendRequest_Image{Image: &amv1.ImageMsg{
		MediaId: mediaID, MadeWith: madeWith, Nsfw: nsfw, MadeFor: madeFor, MadeFrom: madeFrom}}})
}

// Reply sends a text that replies to an earlier message.
func (c *Conn) Reply(ctx context.Context, convID, replyTo int64, text string) (*amv1.Event, error) {
	return c.send(ctx, &amv1.SendRequest{ConvId: convID, Body: &amv1.SendRequest_Text{Text: &amv1.TextMsg{Text: text, ReplyTo: replyTo}}})
}
