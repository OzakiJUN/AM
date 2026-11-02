package e2e

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestChatTools(t *testing.T) { forEachDB(t, testChatTools) }
func testChatTools(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	users := newServerUsers(t, a, base, "alice", "bob", "carol")
	alice, bob, carol := users[0], users[1], users[2]
	source := must(alice.cli.CreateGroup(ctx, "source", bob.me.Id))
	target := must(bob.cli.CreateGroup(ctx, "destination", carol.me.Id))
	aliceWS := must(alice.cli.Connect(ctx))
	defer aliceWS.Close()
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	carolWS := must(carol.cli.Connect(ctx))
	defer carolWS.Close()
	text := must(aliceWS.SendText(ctx, source.Id, "original"))
	info := must(alice.cli.Upload(ctx, "image.png", bytes.NewReader(encodePNG(testImage(32, 32)))))
	image := must(aliceWS.SendImage(ctx, source.Id, info.Id))
	send := func(ws *amclient.Conn, conv int64, body *amv1.SendRequest) (*amv1.Event, error) {
		body.ConvId = conv
		if body.ClientMsgId == "" {
			body.ClientMsgId = amclient.NewClientMsgID()
		}
		frame, err := ws.Request(ctx, &amv1.ClientFrame{Msg: &amv1.ClientFrame_Send{Send: body}})
		if err != nil {
			return nil, err
		}
		return frame.GetSend().GetEvent(), nil
	}
	forward := func(ids ...int64) *amv1.SendRequest {
		return &amv1.SendRequest{Body: &amv1.SendRequest_Forward{Forward: &amv1.ForwardRequest{SourceConvId: source.Id, EventIds: ids}}}
	}
	must(aliceWS.Strike(ctx, source.Id, text.EventId))
	request := forward(image.EventId, text.EventId, text.EventId)
	copied := must(send(bobWS, target.Id, request))
	again := must(send(bobWS, target.Id, request))
	if again.EventId != copied.EventId {
		t.Fatal("forward retry duplicated history")
	}
	entries := copied.GetForward().Entries
	if len(entries) != 2 || entries[0].GetText().Text != "original" || entries[0].SenderId != alice.me.Id || entries[0].SourceName != "source" || !entries[0].Struck {
		t.Fatal("forward lost order or source")
	}
	if entries[1].GetImage().MediaId != info.Id {
		t.Fatal("forward lost picture")
	}
	if _, _, err := carol.cli.Download(ctx, fmt.Sprintf("/api/v1/media/%d", info.Id)); err != nil {
		t.Fatal("recipient cannot read forwarded image", err)
	}
	_, err := send(carolWS, target.Id, forward(text.EventId))
	wantCode(t, err, "not_member")
	if err := alice.cli.AdminDelete(ctx, image.EventId, "test", false); err != nil {
		t.Fatal(err)
	}
	_, err = send(bobWS, target.Id, forward(image.EventId))
	wantCode(t, err, "not_found")
	// The already-forwarded snapshot keeps its media alive independently of the source.
	must(a.Store.PurgeEvidence(ctx, time.Now().AddDate(2, 0, 0).UnixMilli()))
	unref := must(a.Store.UnreferencedMedia(ctx, time.Now().AddDate(2, 0, 0).UnixMilli(), 1000))
	for _, m := range unref {
		if m.ID == info.Id {
			t.Fatal("forwarded image scheduled for GC")
		}
	}
	if err := alice.cli.AdminDelete(ctx, copied.EventId, "test", false); err != nil {
		t.Fatal(err)
	}
	if !must(a.Store.EvidenceHasMedia(ctx, info.Id)) {
		t.Fatal("forwarded media missing from evidence")
	}
	must(a.Store.PurgeEvidence(ctx, time.Now().AddDate(2, 0, 0).UnixMilli()))
	unref = must(a.Store.UnreferencedMedia(ctx, time.Now().AddDate(2, 0, 0).UnixMilli(), 1000))
	found := false
	for _, m := range unref {
		if m.ID == info.Id {
			found = true
		}
	}
	if !found {
		t.Fatal("deleted forwarded media leaked after evidence expiry")
	}
	pin := func(anchor int64, remove int64) *amv1.SendRequest {
		return &amv1.SendRequest{Body: &amv1.SendRequest_EmojiPin{EmojiPin: &amv1.EmojiPinAct{TargetEventId: anchor, RemovePinId: remove, Emoji: "😂", X: 0.4, Y: 12}}}
	}
	anchor := must(bobWS.SendText(ctx, target.Id, "pin here"))
	pinReq := pin(anchor.EventId, 0)
	placed := must(send(bobWS, target.Id, pinReq))
	same := must(send(bobWS, target.Id, pinReq))
	if placed.EventId != same.EventId {
		t.Fatal("pin retry duplicated")
	}
	_, err = send(carolWS, target.Id, pin(0, placed.EventId))
	wantCode(t, err, "no_permission")
	_, err = send(carolWS, target.Id, pin(text.EventId, 0))
	wantCode(t, err, "not_found")
	getPins := func() *amv1.ListEmojiPinsResponse {
		req := must(http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/api/v1/conversations/%d/emoji-pins", base, target.Id), nil))
		req.Header.Set("Authorization", "Bearer "+carol.cli.Token)
		resp := must(carol.cli.HTTP.Do(req))
		defer resp.Body.Close()
		data := must(io.ReadAll(resp.Body))
		if resp.StatusCode != 200 {
			t.Fatal(string(data))
		}
		out := &amv1.ListEmojiPinsResponse{}
		if err := protojson.Unmarshal(data, out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	pins := getPins().Pins
	if len(pins) != 1 || pins[0].Emoji != "😂" || pins[0].TargetEventId != anchor.EventId {
		t.Fatal("new device cannot load pins")
	}
	must(send(bobWS, target.Id, pin(0, placed.EventId)))
	if !getPins().Pins[0].Removed {
		t.Fatal("pin removal not persisted")
	}
	must(send(bobWS, target.Id, pin(0, 0))) // Background placements need no preceding message.
	bubble := pin(anchor.EventId, 0)
	bubble.GetEmojiPin().OnBubble = true
	bubble.GetEmojiPin().Y = 0.5
	placedBubble := must(send(bobWS, target.Id, bubble))
	if !placedBubble.GetEmojiPin().OnBubble {
		t.Fatal("bubble anchor was lost")
	}
	foundBubble := false
	for _, p := range getPins().Pins {
		if p.Id == placedBubble.EventId && p.OnBubble && p.Y == 0.5 {
			foundBubble = true
		}
	}
	if !foundBubble {
		t.Fatal("bubble coordinates were not persisted")
	}
	invalid := pin(anchor.EventId, 0)
	invalid.GetEmojiPin().X = 2
	_, err = send(bobWS, target.Id, invalid)
	wantCode(t, err, "bad_request")
}
