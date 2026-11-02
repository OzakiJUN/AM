package e2e

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
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
	bob := us[1]
	botID := a.Helper.Bot().ID
	pc := panelFor(t, a)

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
	var up panelPlugins
	pc.do("POST", "/api/plugins/upload", map[string]any{"data": base64.StdEncoding.EncodeToString(pluginZip(t, map[string]string{"echo/__init__.py": echo}))}, &up)
	if len(up.Items) != 1 {
		t.Fatalf("upload %+v", up)
	}
	pc.do("PUT", "/api/plugins/"+up.Items[0].ID, map[string]any{"config_patch": `{"echo_prefix":"你 \"说\" #："}`}, nil)
	status := func() string {
		var l struct {
			HostState string   `json:"host_state"`
			HostError string   `json:"host_error"`
			Log       []string `json:"log"`
		}
		pc.do("GET", "/api/plugins", nil, &l)
		return l.HostState + " " + l.HostError + "\n" + strings.Join(l.Log, "\n")
	}

	// Installing NoneBot the first time takes a while.
	deadline := time.Now().Add(5 * time.Minute)
	for {
		st := status()
		if strings.HasPrefix(st, "running ") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("NoneBot did not connect: %s", st)
		}
		time.Sleep(time.Second)
	}

	bobWS := must(bob.cli.Connect(ctx))
	defer bobWS.Close()
	ch := must(bob.cli.CreateGroup(ctx, "测试"))
	sent := must(bobWS.SendText(ctx, ch.Id, "/echo 你好"))
	got := waitPushLong(t, bobWS, "NoneBot's reply", 20*time.Second, func(f *amv1.ServerFrame) bool {
		return f.GetEvent().GetEvent().GetSenderId() == botID
	}).GetEvent().GetEvent()
	if got.GetText().GetText() != `你 "说" #：你好（群）` || got.GetText().GetReplyTo() != sent.EventId {
		t.Fatalf("reply %+v\n%v", got, status())
	}
	dm := must(bob.cli.OpenDM(ctx, botID))
	must(bobWS.SendText(ctx, dm.Id, "/echo 悄悄话"))
	got = waitPushLong(t, bobWS, "NoneBot's DM reply", 20*time.Second, func(f *amv1.ServerFrame) bool {
		return f.GetEvent().GetEvent().GetSenderId() == botID && f.GetEvent().GetEvent().GetConvId() == dm.Id
	}).GetEvent().GetEvent()
	if got.GetText().GetText() != `你 "说" #：悄悄话（私聊）` {
		t.Fatalf("dm reply %+v", got)
	}
}
