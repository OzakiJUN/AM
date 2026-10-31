package e2e

import (
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
	us := newServerUsers(t, a, base, "owner", "bob")
	owner, bob := us[0], us[1]

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
	_, err = relog.PutAISettings(ctx, ai.User.Id, `{}`, s1.SettingsUpdatedAt)
	wantCode(t, err, "user_not_found")
}
