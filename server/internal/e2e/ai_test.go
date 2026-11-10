package e2e

import (
	"bytes"
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
)

// AI accounts: owned by a person, run on one of the owner's devices,
// settings only the owner sees, moods only on AI messages.
func TestAIAccounts(t *testing.T) {
	forEachDB(t, testAIAccounts, func(c *config.Config) { c.Limits.MaxAIPerUser = 2 })
}

func testAIAccounts(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "owner", "bob", "carol")
	owner, bob, carol := us[0], us[1], us[2]

	ai := must(owner.cli.CreateAI(ctx, "小鱼"))
	if ai.User.AccountType != amv1.AccountType_ACCOUNT_TYPE_AI || ai.User.OwnerId != owner.me.Id || ai.User.DisplayName != "小鱼" {
		t.Fatalf("ai account %+v", ai.User)
	}
	must(owner.cli.CreateAI(ctx, "第二个"))
	_, err := owner.cli.CreateAI(ctx, "第三个")
	wantCode(t, err, "ai_limit")
	_, err = owner.cli.CreateAI(ctx, "")
	wantCode(t, err, "invalid_display_name")

	// Settings: owner only, optimistic saves.
	s1 := must(owner.cli.PutAISettings(ctx, ai.User.Id, `{"persona":"开朗"}`, 0))
	_, err = owner.cli.PutAISettings(ctx, ai.User.Id, `{}`, 0)
	wantCode(t, err, "state_conflict")
	_, err = bob.cli.PutAISettings(ctx, ai.User.Id, `{}`, s1.SettingsUpdatedAt)
	wantCode(t, err, "user_not_found")
	list := must(owner.cli.ListAI(ctx)).Ais
	if len(list) != 2 || list[0].Settings != `{"persona":"开朗"}` {
		t.Fatalf("list %+v", list)
	}
	if len(must(bob.cli.ListAI(ctx)).Ais) != 0 {
		t.Fatal("bob sees owner's AIs")
	}
	if u := must(owner.cli.UpdateAI(ctx, ai.User.Id, &amv1.UpdateProfileRequest{Bio: ptr("一条小鱼")})); u.Bio != "一条小鱼" {
		t.Fatal("bio not set")
	}
	// Its profile page is the owner's to edit, not other people's.
	page := &amv1.ProfileLayout{Widgets: []*amv1.Widget{widget("t1", "text", 2, 1, 0, 0, 0, `{"title":"小鱼","text":"喵"}`)}}
	if v := must(owner.cli.SaveProfile(ctx, ai.User.Id, page, 0)); !v.CanEditLayout || v.Layout.Version != 1 {
		t.Fatalf("owner saving the AI's page: %+v", v)
	}
	_, err = bob.cli.SaveProfile(ctx, ai.User.Id, page, 1)
	wantCode(t, err, "no_permission")
	if must(bob.cli.GetProfile(ctx, ai.User.Id)).CanEditLayout {
		t.Fatal("bob may edit the AI's page")
	}

	// Running: a device logs in as the AI; running it on another device ends the first.
	runner := amclient.New(base, nil)
	runner.Token = must(owner.cli.RunAI(ctx, ai.User.Id, "PC")).Token
	ws := must(runner.Connect(ctx))
	second := amclient.New(base, nil)
	second.Token = must(owner.cli.RunAI(ctx, ai.User.Id, "laptop")).Token
	waitClosed(t, ws)
	_, err = runner.ListSessions(ctx)
	wantCode(t, err, "unauthorized")
	// AI accounts don't take the owner's device places, and can't make AIs.
	_, err = second.CreateAI(ctx, "套娃")
	wantCode(t, err, "no_permission")

	// Moods are kept on AI messages and dropped from people's.
	aiWS := must(second.Connect(ctx))
	defer aiWS.Close()
	dm := must(second.OpenDM(ctx, owner.me.Id))
	ownerWS := must(owner.cli.Connect(ctx))
	defer ownerWS.Close()
	if e := must(aiWS.SendMood(ctx, dm.Id, "你好呀", "happy")); e.GetText().GetMood() != "happy" {
		t.Fatal("ai mood dropped")
	}
	if e := must(aiWS.SendMood(ctx, dm.Id, "坏标签", "Bad Mood!")); e.GetText().GetMood() != "" {
		t.Fatal("bad mood kept")
	}
	if e := must(ownerWS.SendMood(ctx, dm.Id, "我不是 AI", "happy")); e.GetText().GetMood() != "" {
		t.Fatal("human message kept a mood")
	}

	// Channels: put in with a normal invite, it can talk there; its owner
	// (and only its owner) can take it out again.
	ch := must(owner.cli.CreateGroup(ctx, "开黑", bob.me.Id))
	if r := must(owner.cli.InviteMembers(ctx, ch.Id, ai.User.Id)); len(r.Added) != 1 {
		t.Fatalf("invite AI: %+v", r)
	}
	must(aiWS.SendText(ctx, ch.Id, "大家好，我是小鱼"))
	err = bob.cli.AILeaveChannel(ctx, ai.User.Id, ch.Id)
	wantCode(t, err, "user_not_found")
	if err := owner.cli.AILeaveChannel(ctx, ai.User.Id, ch.Id); err != nil {
		t.Fatal(err)
	}
	_, err = aiWS.SendText(ctx, ch.Id, "我还在吗")
	if err == nil {
		t.Fatal("AI still talks in a channel it left")
	}

	// Shared room: a private group that belongs to the AI, owner's to make.
	room := must(owner.cli.CreateAIRoom(ctx, ai.User.Id, "", bob.me.Id))
	if room.AiId != ai.User.Id || room.Name != "小鱼和大家" || len(room.Members) != 3 || room.Public {
		t.Fatalf("room: %+v", room)
	}
	if c := must(bob.cli.GetConversation(ctx, room.Id)); c.AiId != ai.User.Id {
		t.Fatal("bob does not see whose room it is")
	}
	must(aiWS.SendText(ctx, room.Id, "大家好"))
	_, err = bob.cli.CreateAIRoom(ctx, ai.User.Id, "偷建")
	wantCode(t, err, "user_not_found")

	// Its own portrait pack: owner's uploads, anyone can read it.
	happy := must(owner.cli.Upload(ctx, "happy.png", bytes.NewReader(encodePNG(testImage(16, 16)))))
	if err := owner.cli.SetPortraits(ctx, ai.User.Id, map[string]int64{"happy": happy.Id}); err != nil {
		t.Fatal(err)
	}
	if p := must(bob.cli.GetPortraits(ctx, ai.User.Id)); p.MediaIds["happy"] != happy.Id {
		t.Fatalf("pack: %+v", p)
	}
	if must(bob.cli.GetConversation(ctx, room.Id)).Members[0].GetId() == 0 {
		t.Fatal("no members")
	}
	wantCode(t, owner.cli.SetPortraits(ctx, ai.User.Id, map[string]int64{"Bad Mood": happy.Id}), "bad_request")
	wantCode(t, bob.cli.SetPortraits(ctx, ai.User.Id, map[string]int64{"sad": happy.Id}), "user_not_found")
	if _, _, err := bob.cli.Download(ctx, "/api/v1/media/"+itoa(happy.Id)); err != nil {
		t.Fatalf("bob cannot see the portrait: %v", err)
	}

	// Asking to talk with it: the owner hears about it and lets carol in (its room).
	ownerPush := must(owner.cli.Connect(ctx))
	defer ownerPush.Close()
	if err := carol.cli.RequestShare(ctx, ai.User.Id); err != nil {
		t.Fatal(err)
	}
	waitPush(t, ownerPush, "share request", func(f *amv1.ServerFrame) bool { return f.GetAiShareRequest().GetUser().GetId() == carol.me.Id })
	if l := must(owner.cli.ListAI(ctx)).Ais; l[0].ShareRequests != 1 {
		t.Fatalf("count: %+v", l[0])
	}
	if r := must(owner.cli.ShareRequests(ctx, ai.User.Id)); len(r.Users) != 1 || r.Users[0].Id != carol.me.Id {
		t.Fatalf("requests: %+v", r)
	}
	wantCode(t, owner.cli.RequestShare(ctx, ai.User.Id), "no_permission") // its own owner
	if c := must(owner.cli.DecideShare(ctx, ai.User.Id, carol.me.Id, true)); c.Id != room.Id {
		t.Fatalf("approved into %d, want the room %d", c.Id, room.Id)
	}
	if c := must(carol.cli.GetConversation(ctx, room.Id)); c.AiId != ai.User.Id {
		t.Fatal("carol is not in the room")
	}
	_, err = owner.cli.DecideShare(ctx, ai.User.Id, carol.me.Id, true)
	wantCode(t, err, "not_found")

	// Someone else's AI on my computer: the server only relays, checking who
	// asks whom; bob's device decides (here: runs it and answers).
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	if err := aiWS.RemoteTool(ctx, "r1", bob.me.Id, "list_dir", `{"path":"D:/"}`); err != nil {
		t.Fatal(err)
	}
	p := waitPush(t, bobWS, "remote tool", func(f *amv1.ServerFrame) bool { return f.GetRemoteTool() != nil }).GetRemoteTool()
	if p.RequestId != "r1" || p.FromAi.GetId() != ai.User.Id || p.FromAi.GetOwnerDisplayName() == "" || p.Tool != "list_dir" {
		t.Fatalf("push: %+v", p)
	}
	if err := bobWS.RemoteToolResult(ctx, &amv1.RemoteToolResult{RequestId: "r1", ToAiId: ai.User.Id, Ok: true, Text: "a.txt"}); err != nil {
		t.Fatal(err)
	}
	r := waitPush(t, aiWS, "remote result", func(f *amv1.ServerFrame) bool { return f.GetRemoteToolResult() != nil }).GetRemoteToolResult()
	if r.FromUserId != bob.me.Id || !r.Ok || r.Text != "a.txt" {
		t.Fatalf("result: %+v", r)
	}
	// People can't ask, AIs can't answer, blocking stops it.
	wantCode(t, bobWS.RemoteTool(ctx, "x", owner.me.Id, "list_dir", "{}"), "no_permission")
	wantCode(t, aiWS.RemoteToolResult(ctx, &amv1.RemoteToolResult{RequestId: "x", ToAiId: ai.User.Id}), "no_permission")
	if err := bob.cli.Block(ctx, owner.me.Id); err != nil {
		t.Fatal(err)
	}
	wantCode(t, aiWS.RemoteTool(ctx, "r2", bob.me.Id, "list_dir", "{}"), "blocked")

	// The owner asks the client running the AI (B站 login and the like):
	// only its owner may ask, the answer goes back to the owner only.
	if err := ownerPush.AIControl(ctx, "c1", ai.User.Id, "bili", `{"action":"status"}`); err != nil {
		t.Fatal(err)
	}
	cp := waitPush(t, aiWS, "ai control", func(f *amv1.ServerFrame) bool { return f.GetAiControl() != nil }).GetAiControl()
	if cp.RequestId != "c1" || cp.FromUserId != owner.me.Id || cp.Action != "bili" || cp.ArgsJson != `{"action":"status"}` {
		t.Fatalf("control push: %+v", cp)
	}
	if err := aiWS.AIControlResult(ctx, &amv1.AIControlResult{RequestId: "c1", Ok: true, Text: `{"login":false}`}); err != nil {
		t.Fatal(err)
	}
	cr := waitPush(t, ownerPush, "ai control result", func(f *amv1.ServerFrame) bool { return f.GetAiControlResult() != nil }).GetAiControlResult()
	if cr.RequestId != "c1" || cr.AiId != ai.User.Id || !cr.Ok || cr.Text != `{"login":false}` {
		t.Fatalf("control result: %+v", cr)
	}
	wantCode(t, bobWS.AIControl(ctx, "c2", ai.User.Id, "bili", "{}"), "no_permission")
	wantCode(t, ownerPush.AIControlResult(ctx, &amv1.AIControlResult{RequestId: "c3"}), "no_permission")

	// Its search history: the AI writes, only its owner reads, newest first, capped.
	for _, e := range [][3]string{{"search", "B 站：猫", ""}, {"open", "https://example.com/a", "和主人的私聊"}, {"watch", "https://www.bilibili.com/video/BV1xx", ""}} {
		if err := second.AddBrowseLog(ctx, e[0], e[1], e[2]); err != nil {
			t.Fatal(err)
		}
	}
	wantCode(t, second.AddBrowseLog(ctx, "delete", "x", ""), "bad_request")
	wantCode(t, owner.cli.AddBrowseLog(ctx, "search", "x", ""), "no_permission")
	log := must(owner.cli.BrowseLog(ctx, ai.User.Id, 0)).Entries
	if len(log) != 3 || log[0].Kind != "watch" || log[2].Text != "B 站：猫" || log[1].Place != "和主人的私聊" {
		t.Fatalf("browse log: %+v", log)
	}
	if older := must(owner.cli.BrowseLog(ctx, ai.User.Id, log[0].Id)).Entries; len(older) != 2 || older[0].Id != log[1].Id {
		t.Fatalf("older page: %+v", older)
	}
	_, err = bob.cli.BrowseLog(ctx, ai.User.Id, 0)
	wantCode(t, err, "user_not_found")
	a.Account.SetBrowseLogLimit(2)
	must(0, second.AddBrowseLog(ctx, "search", "第四条", ""))
	if log := must(owner.cli.BrowseLog(ctx, ai.User.Id, 0)).Entries; len(log) != 2 || log[0].Text != "第四条" {
		t.Fatalf("cap: %+v", log)
	}
	a.Account.SetBrowseLogLimit(1000)

	// Owner banned: the AI stops.
	if err := a.Account.SetBanned(ctx, 0, owner.me.Id, true, "test"); err != nil {
		t.Fatal(err)
	}
	_, err = second.ListSessions(ctx)
	wantCode(t, err, "unauthorized")
	if err := a.Account.SetBanned(ctx, 0, owner.me.Id, false, ""); err != nil {
		t.Fatal(err)
	}

	// Deleting: gone from the list, its sessions end.
	relog := amclient.New(base, nil)
	must(relog.Login(ctx, &amv1.LoginRequest{Username: "owner", Password: "password-owner", DeviceName: "t"}))
	if err := relog.DeleteAI(ctx, ai.User.Id); err != nil {
		t.Fatal(err)
	}
	if len(must(relog.ListAI(ctx)).Ais) != 1 {
		t.Fatal("deleted AI still listed")
	}
	// Old chats still show it, marked gone (clients drop it from their lists).
	for _, u := range must(relog.GetConversation(ctx, dm.Id)).Members {
		if u.Id == ai.User.Id && !u.Gone {
			t.Fatal("deleted AI not marked gone")
		}
	}
	_, err = relog.PutAISettings(ctx, ai.User.Id, `{}`, s1.SettingsUpdatedAt)
	wantCode(t, err, "user_not_found")
}
