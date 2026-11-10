package e2e

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestCrossServerForward(t *testing.T) { forEachDB(t, testCrossServerForward) }
func testCrossServerForward(t *testing.T, destination *app.App, targetBase string) {
	ctx := ctxT(t)
	source, sourceBase := setup(t, "sqlite")
	originUsers := newServerUsers(t, source, sourceBase, "alice", "stranger")
	sourceUser, stranger := originUsers[0], originUsers[1]
	users := newServerUsers(t, destination, targetBase, "carol", "dave")
	sender, recipient := users[0], users[1]
	sourceConv := must(sourceUser.cli.CreateGroup(ctx, "source-only"))
	targetConv := must(sender.cli.CreateGroup(ctx, "destination", recipient.me.Id))
	originWS := must(sourceUser.cli.Connect(ctx))
	defer originWS.Close()
	targetWS := must(sender.cli.Connect(ctx))
	defer targetWS.Close()
	sourceText := must(originWS.SendText(ctx, sourceConv.Id, "hello from Alice"))
	imageData := encodePNG(testImage(32, 32))
	sourceImage := must(sourceUser.cli.Upload(ctx, "image.png", bytes.NewReader(imageData)))
	sourceImageEvent := must(originWS.SendImage(ctx, sourceConv.Id, sourceImage.Id))
	sourceFile := must(sourceUser.cli.Upload(ctx, "report.txt", bytes.NewReader([]byte("report bytes"))))
	sourceFileEvent := must(originWS.SendFile(ctx, sourceConv.Id, sourceFile.Id, "report.txt"))
	export := func(user *user, request *amv1.ForwardRequest) (int, *amv1.ForwardMsg) {
		t.Helper()
		data := must(protojson.Marshal(request))
		req := must(http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("%s/api/v1/conversations/%d/forward-export", sourceBase, sourceConv.Id), bytes.NewReader(data)))
		req.Header.Set("Authorization", "Bearer "+user.cli.Token)
		response := must(user.cli.HTTP.Do(req))
		defer response.Body.Close()
		out := &amv1.ForwardMsg{}
		body := must(io.ReadAll(response.Body))
		if response.StatusCode == http.StatusOK {
			if err := protojson.Unmarshal(body, out); err != nil {
				t.Fatal(err)
			}
		}
		return response.StatusCode, out
	}
	request := &amv1.ForwardRequest{EventIds: []int64{sourceFileEvent.EventId, sourceText.EventId, sourceImageEvent.EventId}}
	if code, _ := export(stranger, request); code == http.StatusOK {
		t.Fatal("nonmember exported private history")
	}
	before := must(source.Store.GetConvForUser(ctx, sourceConv.Id, sourceUser.me.Id)).LastSeq
	status, snapshot := export(sourceUser, request)
	if status != http.StatusOK || len(snapshot.Entries) != 3 {
		t.Fatal("export failed")
	}
	if must(source.Store.GetConvForUser(ctx, sourceConv.Id, sourceUser.me.Id)).LastSeq != before {
		t.Fatal("export posted into the original channel")
	}
	if snapshot.Entries[0].SenderId != sourceUser.me.Id || snapshot.Entries[0].SenderName != "alice" || snapshot.Entries[0].GetText().Text != "hello from Alice" {
		t.Fatal("source metadata or order changed")
	}
	if code, _ := export(sourceUser, &amv1.ForwardRequest{ImportedEntries: snapshot.Entries, SourceServer: sourceBase}); code == http.StatusOK {
		t.Fatal("foreign metadata exported as native")
	}
	// The sender copies bytes over its own two authenticated sessions.
	imported := proto.Clone(snapshot).(*amv1.ForwardMsg)
	for _, entry := range imported.Entries {
		switch body := entry.Body.(type) {
		case *amv1.ForwardEntry_Image:
			data, _, err := sourceUser.cli.Download(ctx, fmt.Sprintf("/api/v1/media/%d", body.Image.MediaId))
			if err != nil {
				t.Fatal(err)
			}
			upload := must(sender.cli.Upload(ctx, "copied.png", bytes.NewReader(data)))
			body.Image.MediaId = upload.Id
			body.Image.Width = 9999
		case *amv1.ForwardEntry_File:
			data, _, err := sourceUser.cli.Download(ctx, fmt.Sprintf("/api/v1/media/%d", body.File.MediaId))
			if err != nil {
				t.Fatal(err)
			}
			upload := must(sender.cli.Upload(ctx, "report.txt", bytes.NewReader(data)))
			body.File.MediaId = upload.Id
			body.File.Size = 9999
			body.File.Name = "../../report.txt"
		}
	}
	// A foreign id can coincide with a native account; provenance must stay foreign.
	imported.Entries[0].SenderId = recipient.me.Id
	imported.Entries[0].GetText().Mentions = []int64{recipient.me.Id}
	imported.Entries[0].GetText().ReplyTo = 123
	send := func(forward *amv1.ForwardRequest, cid string) (*amv1.Event, error) {
		if len(forward.GetImportedEntries()) > 0 {
			reqBody := &amv1.SendRequest{ClientMsgId: cid, Body: &amv1.SendRequest_Forward{Forward: forward}}
			encoded, err := protojson.Marshal(reqBody)
			if err != nil {
				return nil, err
			}
			req, err := http.NewRequestWithContext(ctx, "POST", fmt.Sprintf("%s/api/v1/conversations/%d/forward-import", targetBase, targetConv.Id), bytes.NewReader(encoded))
			if err != nil {
				return nil, err
			}
			req.Header.Set("Authorization", "Bearer "+sender.cli.Token)
			response, err := sender.cli.HTTP.Do(req)
			if err != nil {
				return nil, err
			}
			defer response.Body.Close()
			data, err := io.ReadAll(response.Body)
			if err != nil {
				return nil, err
			}
			if response.StatusCode != 200 {
				apiErr := &amv1.Error{}
				if err := protojson.Unmarshal(data, apiErr); err != nil {
					return nil, err
				}
				return nil, &amclient.APIError{Status: response.StatusCode, Code: apiErr.Code, Message: apiErr.Message}
			}
			result := &amv1.Event{}
			err = protojson.Unmarshal(data, result)
			return result, err
		}
		frame, err := targetWS.Request(ctx, &amv1.ClientFrame{Msg: &amv1.ClientFrame_Send{Send: &amv1.SendRequest{ConvId: targetConv.Id, ClientMsgId: cid, Body: &amv1.SendRequest_Forward{Forward: forward}}}})
		if err != nil {
			return nil, err
		}
		return frame.GetSend().GetEvent(), nil
	}
	forward := &amv1.ForwardRequest{ImportedEntries: imported.Entries, SourceServer: sourceBase}
	cid := amclient.NewClientMsgID()
	sent := must(send(forward, cid))
	if must(send(forward, cid)).EventId != sent.EventId {
		t.Fatal("retry created another forwarded record")
	}
	if sent.SenderId != sender.me.Id {
		t.Fatal("outer sender was forged")
	}
	entries := sent.GetForward().Entries
	for _, entry := range entries {
		if !entry.Imported || entry.SourceServer != sourceBase {
			t.Fatal("foreign provenance was lost")
		}
	}
	if entries[0].SenderName != "alice" || entries[0].SenderId != recipient.me.Id || len(entries[0].GetText().Mentions) != 0 || entries[0].GetText().ReplyTo != 0 {
		t.Fatal("foreign account linked to native reply/mentions")
	}
	if entries[1].GetImage().Width != 32 || entries[2].GetFile().Size != 12 || entries[2].GetFile().Name != "report.txt" {
		t.Fatal("target media metadata was not validated")
	}
	actual, _, err := recipient.cli.Download(ctx, fmt.Sprintf("/api/v1/media/%d", entries[1].GetImage().MediaId))
	if err != nil || !bytes.Equal(actual, imageData) {
		t.Fatal("recipient cannot read copied image", err)
	}
	large := proto.Clone(forward).(*amv1.ForwardRequest)
	for range 24 {
		text := proto.Clone(imported.Entries[0]).(*amv1.ForwardEntry)
		text.GetText().Text = strings.Repeat("x", 4000)
		large.ImportedEntries = append(large.ImportedEntries, text)
	}
	encoded := must(protojson.Marshal(large))
	if len(encoded) < 64<<10 {
		t.Fatal("large import fixture too small")
	}
	must(send(large, amclient.NewClientMsgID()))
	originalTargetMedia := entries[1].GetImage().MediaId
	otherUpload := must(recipient.cli.Upload(ctx, "other.png", bytes.NewReader(encodePNG(testImage(41, 41)))))
	invalid := proto.Clone(forward).(*amv1.ForwardRequest)
	invalid.ImportedEntries[1].GetImage().MediaId = otherUpload.Id
	_, err = send(invalid, amclient.NewClientMsgID())
	wantCode(t, err, "media_not_found")
	invalid = proto.Clone(forward).(*amv1.ForwardRequest)
	invalid.SourceConvId = targetConv.Id
	_, err = send(invalid, amclient.NewClientMsgID())
	wantCode(t, err, "bad_request")
	if err := sourceUser.cli.AdminDelete(ctx, sourceImageEvent.EventId, "test", false); err != nil {
		t.Fatal(err)
	}
	if code, _ := export(sourceUser, request); code == http.StatusOK {
		t.Fatal("deleted source was exported")
	}
	actual, _, err = recipient.cli.Download(ctx, fmt.Sprintf("/api/v1/media/%d", originalTargetMedia))
	if err != nil || !bytes.Equal(actual, imageData) {
		t.Fatal("copy depended on the original server")
	}
	local := must(send(&amv1.ForwardRequest{SourceConvId: targetConv.Id, EventIds: []int64{sent.EventId}}, amclient.NewClientMsgID()))
	if !local.GetForward().Entries[0].Imported || local.GetForward().Entries[0].SourceServer != sourceBase {
		t.Fatal("re-forward removed imported provenance")
	}
}
