package e2e

import (
	"bytes"
	"strings"
	"testing"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/sdk/go/amclient"
	"github.com/OzakiJUN/am/server/internal/app"
)

// The built-in bot for AIs and site admins (docs/design.md §10 内置 bot):
// an AI has it run a command quietly (answers come back, nothing posted)
// or shown (its answers posted, the command not); the command list; site
// admins edit the bot's profile and page, others can't.
func TestHelperForAI(t *testing.T) {
	forEachDB(t, testHelperForAI)
}

func testHelperForAI(t *testing.T, a *app.App, base string) {
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "admin", "bob")
	admin, bob := us[0], us[1]
	botID := a.Helper.Bot().ID
	ch := must(admin.cli.CreatePublicChannel(ctx, "大家"))
	ai := must(bob.cli.CreateAI(ctx, "小鱼")).User
	aiCli := amclient.New(base, nil)
	aiCli.Token = must(bob.cli.RunAI(ctx, ai.Id, "PC")).Token
	must(admin.cli.InviteMembers(ctx, ch.Id, ai.Id))
	botSaid := func() int {
		n := 0
		evs := must(a.Store.ListEvents(ctx, ch.Id, 0, 200))
		for _, e := range evs {
			if e.SenderID == botID {
				n++
			}
		}
		return n
	}

	// The list, with usage, for the AI's prompt.
	cmds := must(aiCli.HelperCommands(ctx)).Commands
	var names []string
	for _, c := range cmds {
		names = append(names, c.Name)
	}
	if !strings.Contains(strings.Join(names, ","), "资讯,资讯源") || !strings.Contains(strings.Join(names, ","), "投厕") {
		t.Fatalf("commands %v", names)
	}

	// Quietly: the answer comes back, nothing is posted.
	before := botSaid()
	r := must(aiCli.HelperRun(ctx, ch.Id, "/指令 厕所", 0, false))
	if r.Shown || len(r.Texts) != 1 || !strings.Contains(r.Texts[0], "🚽 电子厕所") || botSaid() != before {
		t.Fatalf("quiet run %+v, bot said %d→%d", r, before, botSaid())
	}
	// Not a command: what it may have meant.
	r = must(aiCli.HelperRun(ctx, ch.Id, "/资询", 0, false))
	if len(r.Texts) != 1 || !strings.Contains(r.Texts[0], "/资讯") {
		t.Fatalf("typo %+v", r)
	}
	// Shown: the bot's answer is posted, the command isn't.
	pic := must(bob.cli.Upload(ctx, "p.png", bytes.NewReader(encodePNG(stickerPic(5, 64, 64))))).Id
	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	img := must(bobWS.SendImage(ctx, ch.Id, pic))
	r = must(aiCli.HelperRun(ctx, ch.Id, "/投厕 歪了", img.EventId, true))
	if !r.Shown || len(r.Texts) != 0 || botSaid() != before+1 {
		t.Fatalf("shown run %+v", r)
	}
	if p := must(a.Store.ToiletPits(ctx)); len(p) != 1 || p[0].ByUser != ai.Id || p[0].CulpritID != bob.me.Id {
		t.Fatalf("pit %+v", p)
	}
	// Only where it is a member.
	other := must(admin.cli.CreateGroup(ctx, "私密"))
	_, err := aiCli.HelperRun(ctx, other.Id, "/指令", 0, false)
	wantCode(t, err, "not_member")

	// Site admins edit the bot like an owner edits an AI; others can't.
	name := "大管家"
	if u := must(admin.cli.UpdateAI(ctx, botID, &amv1.UpdateProfileRequest{DisplayName: &name})); u.DisplayName != "大管家" {
		t.Fatalf("renamed %+v", u)
	}
	_, err = bob.cli.UpdateAI(ctx, botID, &amv1.UpdateProfileRequest{DisplayName: &name})
	wantCode(t, err, "user_not_found")
	if !must(admin.cli.GetProfile(ctx, botID)).CanEditLayout || must(bob.cli.GetProfile(ctx, botID)).CanEditLayout {
		t.Fatal("who may edit the bot's page")
	}
}
