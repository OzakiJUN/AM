package e2e

import (
	"fmt"
	"io"
	"net/http"
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestMessageReplies(t *testing.T) { forEachDB(t, testMessageReplies) }

func testMessageReplies(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	users := newServerUsers(t, a, base, "alice", "bob", "carol")
	alice, bob, carol := users[0], users[1], users[2]
	group := must(alice.cli.CreateGroup(ctx, "replies", bob.me.Id))
	other := must(alice.cli.CreateGroup(ctx, "other", bob.me.Id))
	ws := must(alice.cli.Connect(ctx))
	defer ws.Close()
	original := must(ws.SendText(ctx, group.Id, "执黑"))
	sendReply := func(conv, target int64) (*amv1.ServerFrame, error) {
		return ws.Request(ctx, &amv1.ClientFrame{Msg: &amv1.ClientFrame_Send{Send: &amv1.SendRequest{
			ConvId: conv, ClientMsgId: amclient.NewClientMsgID(), Body: &amv1.SendRequest_Text{Text: &amv1.TextMsg{Text: "好的", ReplyTo: target}},
		}}})
	}
	reply := must(sendReply(group.Id, original.EventId)).GetSend().GetEvent()
	if reply.GetText().GetReplyTo() != original.EventId {
		t.Fatal("reply target was lost")
	}
	_, err := sendReply(other.Id, original.EventId)
	wantCode(t, err, "not_found")
	_, err = sendReply(group.Id, -1)
	wantCode(t, err, "not_found")
	fetch := func(user *user, conv, id int64) (int, *amv1.Event) {
		t.Helper()
		req := must(http.NewRequestWithContext(ctx, "GET", fmt.Sprintf("%s/api/v1/conversations/%d/messages/%d", base, conv, id), nil))
		req.Header.Set("Authorization", "Bearer "+user.cli.Token)
		res := must(user.cli.HTTP.Do(req))
		defer res.Body.Close()
		data := must(io.ReadAll(res.Body))
		event := &amv1.Event{}
		if res.StatusCode == http.StatusOK {
			if err := protojson.Unmarshal(data, event); err != nil {
				t.Fatal(err)
			}
		}
		return res.StatusCode, event
	}
	status, event := fetch(bob, group.Id, original.EventId)
	if status != http.StatusOK || event.GetText().GetText() != "执黑" {
		t.Fatal("member could not fetch original")
	}
	status, _ = fetch(carol, group.Id, original.EventId)
	if status == http.StatusOK {
		t.Fatal("nonmember could read quoted content")
	}
	status, _ = fetch(bob, other.Id, original.EventId)
	if status != http.StatusNotFound {
		t.Fatal("cross-conversation reference accepted")
	}
	if err := alice.cli.AdminDelete(ctx, original.EventId, "test", false); err != nil {
		t.Fatal(err)
	}
	status, event = fetch(bob, group.Id, original.EventId)
	if status != http.StatusOK || event.Redaction == nil || event.GetText() != nil {
		t.Fatal("deleted quotation leaked original body")
	}
	_, err = sendReply(group.Id, original.EventId)
	wantCode(t, err, "not_found")
}
