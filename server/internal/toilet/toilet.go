package toilet

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/helper"
	"github.com/OzakiJUN/am/server/internal/idgen"
	"github.com/OzakiJUN/am/server/internal/message"
	"github.com/OzakiJUN/am/server/internal/store"
)

const namePrompt = "这张 AI 画崩了的图被扔进了厕所示众。根据它的描述起一个 2~8 个字的中文标题，带点嘲讽和幽默，不要脏话。只输出标题本身。"

// Service is 电子厕所.
type Service struct {
	st  *store.Store
	ids *idgen.Generator
	ms  *message.Service
	bot *helper.Service
	log *slog.Logger
	now func() time.Time
	mu  sync.Mutex
}

// New registers the toilet's commands with the bot.
func New(st *store.Store, ids *idgen.Generator, ms *message.Service, bot *helper.Service, log *slog.Logger) *Service {
	s := &Service{st: st, ids: ids, ms: ms, bot: bot, log: log, now: time.Now}
	g := "🚽 电子厕所"
	bot.Register(
		&helper.Command{Name: "投厕", Aliases: []string{"扔厕所", "丢厕所"}, Group: g, Usage: "投厕 [nsfw] [标题]（回复一张图发）",
			Help: "把一张烂图投进全服务器共用的厕所第 1 坑（16 个坑，满了最老的冲走）。不写标题就让模型起个损名；罪犯自动标上（AI 画的就是让它画的人）", Run: s.cmdThrow},
		&helper.Command{Name: "厕所", Aliases: []string{"电子厕所", "看厕所"}, Group: g, Usage: "厕所 [2]", Help: "看第 1~8 坑 / 第 9~16 坑", Safe: true, Run: s.cmdList},
		&helper.Command{Name: "坑位", Aliases: []string{"看坑位"}, Group: g, Usage: "坑位 <序号>", Help: "单看一坑：谁投的、罪犯、图", Safe: true, Run: s.cmdPit},
		&helper.Command{Name: "捞", Aliases: []string{"捞出来", "捞原图"}, Group: g, Usage: "捞 <序号>", Help: "发那一坑的原图", Safe: true, Run: s.cmdFish},
		&helper.Command{Name: "冲", Aliases: []string{"冲掉", "冲厕所"}, Group: g, Usage: "冲 <序号>", Help: "冲掉一坑（谁都能冲，罪犯本人不能冲自己的）", Run: s.cmdFlush},
	)
	return s
}

// SetClock replaces the clock (tests).
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// nsfwOK: NSFW pictures may be shown here (a DM with the bot, or a channel
// the admin panel allowed NSFW in).
func nsfwOK(c *store.Conversation) bool {
	return c.Kind == int16(amv1.ConvKind_CONV_KIND_DM) || c.Nsfw
}

func (s *Service) name(ctx context.Context, id int64) string {
	if id == 0 {
		return ""
	}
	if u, err := s.st.GetUser(ctx, id); err == nil {
		return u.DisplayName
	}
	return "某人"
}

func (s *Service) reply(ctx context.Context, c *helper.Call, text string) error {
	return s.bot.Reply(ctx, c.Conv.ID, c.Event.GetEventId(), text)
}

func (s *Service) cmdThrow(ctx context.Context, c *helper.Call) error {
	target := c.Event.GetText().GetReplyTo()
	if target == 0 {
		return helper.Said("用法：回复一张图发「/投厕 [标题]」。不写标题就起个损名；罪犯会自动标上")
	}
	ev, err := s.ms.Get(ctx, c.User, c.Conv.ID, target)
	if err != nil {
		return helper.Said("那条消息找不到了")
	}
	img := ev.GetImage()
	if img == nil || ev.GetRedaction() != nil {
		return helper.Said("要回复一张图")
	}
	nsfwMark, typed := ThrowArgs(c.Args)
	nsfw := nsfwMark || img.GetNsfw()
	if nsfw && !nsfwOK(c.Conv) {
		return helper.Said("这里没开 NSFW，这张不能投（服务器管理员在管理面板里按频道开）")
	}
	title, bad := CleanTitle(typed)
	if bad {
		return helper.Said("这个标题不行，换一个")
	}
	// The culprit: who made the picture. An AI's drawing → who asked for it
	// (or the AI itself); someone's own picture → them.
	culprit := ev.GetSenderId()
	if sender, err := s.st.GetUser(ctx, culprit); err == nil && sender.AccountType != int16(amv1.AccountType_ACCOUNT_TYPE_HUMAN) && img.GetMadeFor() != 0 {
		culprit = img.GetMadeFor()
	}
	if title == "" {
		title = "无名烂图"
		if desc := img.GetMadeFrom(); desc != "" && s.bot.HasModel() {
			if t, err := s.bot.Ask(ctx, namePrompt, desc, 30, 0.9); err == nil {
				title = AITitle(t)
				if _, bad := CleanTitle(title); bad {
					title = "无名烂图"
				}
			}
		}
	}
	s.mu.Lock()
	var flushed []string
	err = s.st.InTx(ctx, func(q *store.Queries) error {
		if err := q.InsertToiletPit(ctx, &store.ToiletPit{ID: s.ids.Next(), MediaID: img.GetMediaId(), Title: title, CulpritID: culprit,
			ByUser: c.User.ID, ConvID: c.Conv.ID, NSFW: nsfw, CreatedAt: s.now().UnixMilli()}); err != nil {
			return err
		}
		pits, err := q.ToiletPits(ctx)
		if err != nil {
			return err
		}
		for _, p := range pits[min(len(pits), Pits):] {
			if err := q.DeleteToiletPit(ctx, p.ID); err != nil {
				return err
			}
			flushed = append(flushed, p.Title)
		}
		return nil
	})
	s.mu.Unlock()
	if err != nil {
		return err
	}
	who := "罪犯不明"
	if n := s.name(ctx, culprit); n != "" {
		who = "罪犯：" + n
	}
	tail := ""
	if len(flushed) > 0 {
		tail = "；最老的《" + flushed[0] + "》被冲走了"
	}
	return s.reply(ctx, c, fmt.Sprintf("🚽《%s》已投进电子厕所第 1 坑（%s）%s。发「/厕所」围观", title, who, tail))
}

func (s *Service) cmdList(ctx context.Context, c *helper.Call) error {
	page, ok := Page(c.Args)
	if !ok {
		return nil // 「厕所很臭」 is chat
	}
	pits, err := s.st.ToiletPits(ctx)
	if err != nil {
		return err
	}
	var lines []Line
	for i, p := range pits {
		if i/PerPage != page {
			continue
		}
		lines = append(lines, Line{No: i + 1, Title: p.Title, Culprit: s.name(ctx, p.CulpritID), By: s.name(ctx, p.ByUser),
			At: p.CreatedAt, Hidden: p.NSFW && !nsfwOK(c.Conv)})
	}
	return s.reply(ctx, c, List(lines, page, s.now().Location()))
}

// pit finds the pit a command names; nil, nil = not a command (chat).
func (s *Service) pit(ctx context.Context, c *helper.Call, usage string) (*store.ToiletPit, int, error) {
	pits, err := s.st.ToiletPits(ctx)
	if err != nil {
		return nil, 0, err
	}
	n, ok, msg := PitNo(c.Args, len(pits))
	switch {
	case !ok:
		return nil, 0, nil
	case msg != "":
		return nil, 0, helper.Said(msg)
	case n == 0:
		return nil, 0, helper.Said("用法：/" + usage)
	}
	return pits[n-1], n, nil
}

func (s *Service) cmdPit(ctx context.Context, c *helper.Call) error {
	p, n, err := s.pit(ctx, c, "坑位 <序号>")
	if p == nil || err != nil {
		return err
	}
	if p.NSFW && !nsfwOK(c.Conv) {
		return helper.Said("这张是 NSFW，这里没开 NSFW 不显示")
	}
	who := "罪犯不明"
	if name := s.name(ctx, p.CulpritID); name != "" {
		who = "罪犯：" + name
	}
	if err := s.reply(ctx, c, fmt.Sprintf("🚽 第 %d 坑《%s》｜%s｜%s 投的｜%s", n, p.Title, who, s.name(ctx, p.ByUser),
		time.UnixMilli(p.CreatedAt).In(s.now().Location()).Format("2006.01.02"))); err != nil {
		return err
	}
	return s.picture(ctx, c, p)
}

func (s *Service) cmdFish(ctx context.Context, c *helper.Call) error {
	p, _, err := s.pit(ctx, c, "捞 <序号>")
	if p == nil || err != nil {
		return err
	}
	if p.NSFW && !nsfwOK(c.Conv) {
		return helper.Said("这张是 NSFW，这里没开 NSFW 不显示")
	}
	return s.picture(ctx, c, p)
}

func (s *Service) picture(ctx context.Context, c *helper.Call, p *store.ToiletPit) error {
	if err := s.bot.Picture(ctx, c.Conv.ID, p.MediaID); err != nil {
		s.log.Info("toilet: picture", "pit", p.ID, "err", err)
		return helper.Said("原图找不到了")
	}
	return nil
}

func (s *Service) cmdFlush(ctx context.Context, c *helper.Call) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, _, err := s.pit(ctx, c, "冲 <坑位序号>（罪犯本人不能冲自己的）")
	if p == nil || err != nil {
		return err
	}
	if p.CulpritID == c.User.ID {
		return helper.Said("罪犯本人不能冲自己的罪证，好好反省")
	}
	if err := s.st.DeleteToiletPit(ctx, p.ID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return helper.Said("已经被冲走了")
		}
		return err
	}
	return s.reply(ctx, c, "🚽 冲——《"+p.Title+"》被冲走了，后面的坑位往前挪")
}
