package e2e

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/config"
)

// A real NoneBot2 running a real plugin (opt-in: it creates a virtualenv and
// installs NoneBot with pip, which needs Python 3.10+ and the internet):
//
//	AM_TEST_NONEBOT=1 go test -run TestPluginsRealNoneBot ./server/internal/e2e
//
// AM_TEST_NONEBOT_DIR keeps the virtualenv between runs (faster).
func TestPluginsRealNoneBot(t *testing.T) {
	if os.Getenv("AM_TEST_NONEBOT") == "" {
		t.Skip("AM_TEST_NONEBOT not set")
	}
	keep := os.Getenv("AM_TEST_NONEBOT_DIR")
	a, base := setup(t, "sqlite", func(c *config.Config) {
		if keep != "" {
			// The data dir holds plugins/venv; reuse it.
			c.Server.DataDir = keep
			_ = os.Remove(filepath.Join(keep, c.Database.SQLiteFile))
			_ = os.Remove(filepath.Join(keep, c.Database.SQLiteFile+"-wal"))
			_ = os.Remove(filepath.Join(keep, c.Database.SQLiteFile+"-shm"))
		}
	})
	ctx := ctxT(t)
	us := newServerUsers(t, a, base, "admin", "bob")
	admin, bob := us[0], us[1]
	ai := must(admin.cli.CreateAI(ctx, "回声机")).User

	const echo = `
from nonebot import get_driver, on_command
from nonebot.adapters.onebot.v11 import GroupMessageEvent, MessageEvent, MessageSegment
from nonebot.plugin import PluginMetadata

__plugin_meta__ = PluginMetadata(name="回声", description="把话说回去", usage="/echo 文字")

_cfg = get_driver().config
PREFIX = getattr(_cfg, "echo_prefix", "回声：")

echo = on_command("echo")


@echo.handle()
async def _(event: MessageEvent):
    text = event.get_plaintext().removeprefix("/echo").strip()
    where = "群" if isinstance(event, GroupMessageEvent) else "私聊"
    await echo.finish(MessageSegment.reply(event.message_id) + f"{PREFIX}{text}（{where}）")
`
	up := must(admin.cli.Upload(ctx, "echo.zip", bytes.NewReader(pluginZip(t, map[string]string{"echo/__init__.py": echo}))))
	p := must(admin.cli.UploadPlugins(ctx, ai.Id, up.Id)).Plugins[0]
	must(admin.cli.UpdatePlugin(ctx, ai.Id, p.Id, nil, `{"echo_prefix":"你 \"说\" #："}`))

	// Installing NoneBot the first time takes a while.
	deadline := time.Now().Add(5 * time.Minute)
	for {
		l := must(admin.cli.ListPlugins(ctx, ai.Id))
		if l.HostState == "running" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("NoneBot did not connect: %s %s\n%v", l.HostState, l.HostError, l.Log)
		}
		time.Sleep(time.Second)
	}

	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	ch := must(bob.cli.CreateGroup(ctx, "测试", ai.Id))
	sent := must(bobWS.SendText(ctx, ch.Id, "/echo 你好"))
	got := waitPushLong(t, bobWS, "NoneBot's reply", 20*time.Second, func(f *amv1.ServerFrame) bool {
		return f.GetEvent().GetEvent().GetSenderId() == ai.Id
	}).GetEvent().GetEvent()
	if got.GetText().GetText() != `你 "说" #：你好（群）` || got.GetText().GetReplyTo() != sent.EventId {
		t.Fatalf("reply %+v\n%v", got, must(admin.cli.ListPlugins(ctx, ai.Id)).Log)
	}
	dm := must(bob.cli.OpenDM(ctx, ai.Id))
	must(bobWS.SendText(ctx, dm.Id, "/echo 悄悄话"))
	got = waitPushLong(t, bobWS, "NoneBot's DM reply", 20*time.Second, func(f *amv1.ServerFrame) bool {
		return f.GetEvent().GetEvent().GetSenderId() == ai.Id && f.GetEvent().GetEvent().GetConvId() == dm.Id
	}).GetEvent().GetEvent()
	if got.GetText().GetText() != `你 "说" #：悄悄话（私聊）` {
		t.Fatalf("dm reply %+v", got)
	}
}
