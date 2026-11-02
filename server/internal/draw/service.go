package draw

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	amv1 "github.com/OzakiJUN/am/gen/go/am/v1"
	"github.com/OzakiJUN/am/server/internal/helper"
	"github.com/OzakiJUN/am/server/internal/media"
	"github.com/OzakiJUN/am/server/internal/message"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Config is the [draw] section.
type Config struct {
	Enabled        bool
	Token, Proxy   string
	API            string
	DailyPerPerson int
	NsfwInDM       bool
	Settings
}

// Service draws for the built-in bot.
type Service struct {
	cfg Config
	st  *store.Store
	ms  *message.Service
	md  *media.Service
	bot *helper.Service
	log *slog.Logger
	now func() time.Time
	rnd *rand.Rand

	nai    sync.Mutex // one NovelAI request at a time (it answers 429 otherwise)
	mu     sync.Mutex
	bal    *Balance
	balAt  time.Time
	vibes  map[string]string
	counts map[int64][2]int // user → [day, pictures]
}

// New registers the drawing commands with the bot.
func New(cfg Config, st *store.Store, ms *message.Service, md *media.Service, bot *helper.Service, log *slog.Logger) *Service {
	s := &Service{cfg: cfg, st: st, ms: ms, md: md, bot: bot, log: log, now: time.Now,
		rnd: rand.New(rand.NewPCG(uint64(time.Now().UnixNano()), 1)), vibes: map[string]string{}, counts: map[int64][2]int{}}
	g := "🖌 画画（NovelAI）"
	bot.Register(
		&helper.Command{Name: "nai", Group: g, Usage: "nai [横图/方图] [*4] [用我的头像] <描述>", Safe: true,
			Help: "NovelAI V4.5 画图（中文会先翻成英文）；带图或回复图 = 在原图上改；写「用我的头像」照你的头像画你自己", Run: s.cmdDraw(false, "draw")},
		&helper.Command{Name: "nai5", Group: g, Usage: "nai5 <描述>", Help: "NovelAI V5，直接写中文", Safe: true, Run: s.cmdDraw(true, "draw")},
		&helper.Command{Name: "nai余额", Aliases: []string{"nai额度"}, Group: g, Usage: "nai余额", Help: "查服务器的 NovelAI 还剩多少 Anlas", Safe: true, Run: s.cmdBalance},
		&helper.Command{Name: "角色参考", Aliases: []string{"角色迁移", "人物参考"}, Group: g, Usage: "角色参考 <新画面> + 回复一张角色图（或写「用我的头像」）",
			Help: "画同一个角色的新画面（换动作、场景、衣服）", Run: s.cmdDraw(false, "charref")},
		&helper.Command{Name: "风格迁移", Aliases: []string{"画风迁移", "vibe"}, Group: g, Usage: "风格迁移 [强度0.8] <要画什么> + 回复一张图",
			Help: "照这张图的画风画新内容", Run: s.cmdDraw(false, "vibe")},
		&helper.Command{Name: "放大", Aliases: []string{"高清放大", "upscale"}, Group: g, Usage: "放大 + 回复一张图", Help: "NovelAI 放大 2 倍（扣 Anlas）", Run: s.cmdUpscale},
		&helper.Command{Name: "查标签", Aliases: []string{"查画师", "标签联想"}, Group: g, Usage: "查画师 <名字>", Help: "查 NovelAI 认不认识这个画师 / 标签", Safe: true, Run: s.cmdTags},
	)
	return s
}

// Said is an answer told as is.
type said = helper.Said

func (s *Service) ready() error {
	if !s.cfg.Enabled {
		return said("这个服务器关掉了画画")
	}
	if s.cfg.Token == "" {
		return said("服务器还没接 NovelAI：服务器管理员在管理面板「设置 → 画画」里填 token")
	}
	return nil
}

func (s *Service) reply(ctx context.Context, c *helper.Call, text string) error {
	return s.bot.Reply(ctx, c.Conv.ID, c.Event.GetEventId(), text)
}

// nsfwOK: adult content allowed here (a channel the admin panel allowed,
// or a DM with the bot when nsfw_in_dm).
func (s *Service) nsfwOK(c *helper.Call) bool {
	if c.DM() {
		return s.cfg.NsfwInDM
	}
	return c.Conv.Nsfw
}

// ---- NovelAI ----

func (s *Service) request(ctx context.Context, method, path string, body any, timeout time.Duration) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(s.cfg.API, "/")+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+s.cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	// Like the NovelAI site (the client sent the same before drawing moved here).
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0")
	req.Header.Set("Origin", "https://novelai.net")
	req.Header.Set("Referer", "https://novelai.net")
	req.Header.Set("Accept", "*/*")
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	if p := strings.TrimSpace(s.cfg.Proxy); p != "" {
		u, err := url.Parse(p)
		if err != nil {
			return nil, said("NovelAI 代理地址不对：" + p)
		}
		tr.Proxy = http.ProxyURL(u)
	}
	res, err := (&http.Client{Transport: tr, Timeout: timeout}).Do(req)
	if err != nil {
		return nil, said("连不上 NovelAI（" + cut(err.Error(), 80) + "）")
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 200<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, said("NovelAI：" + ErrorText(res.StatusCode, string(b)))
	}
	return b, nil
}

// serialized runs one NovelAI job at a time.
func (s *Service) serialized(job func() ([]byte, error)) ([]byte, error) {
	s.nai.Lock()
	defer s.nai.Unlock()
	return job()
}

// balance is the account's Anlas (cached 5 minutes; force = ask now).
func (s *Service) balance(ctx context.Context, force bool) *Balance {
	s.mu.Lock()
	if !force && s.bal != nil && s.now().Sub(s.balAt) < 5*time.Minute {
		b := *s.bal
		s.mu.Unlock()
		return &b
	}
	s.mu.Unlock()
	data, err := s.request(ctx, http.MethodGet, PathSub, nil, 20*time.Second)
	if err != nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.bal
	}
	b, err := ParseSubscription(data)
	if err != nil {
		return nil
	}
	s.mu.Lock()
	s.bal, s.balAt = &b, s.now()
	s.mu.Unlock()
	return &b
}

func anlas(b *Balance) *int {
	if b == nil || !b.HasAnl {
		return nil
	}
	v := b.Anlas
	return &v
}

func (s *Service) encodeVibe(ctx context.Context, pic []byte, model string) (string, error) {
	sum := sha256.Sum256(pic)
	key := base64.StdEncoding.EncodeToString(sum[:]) + model
	s.mu.Lock()
	hit, ok := s.vibes[key]
	s.mu.Unlock()
	if ok {
		return hit, nil
	}
	img, err := ShrinkPNG(pic, 1024*1024)
	if err != nil {
		return "", said(err.Error())
	}
	b, err := s.serialized(func() ([]byte, error) {
		return s.request(ctx, http.MethodPost, PathVibe, map[string]any{"image": img.B64, "information_extracted": 1, "model": model}, time.Minute)
	})
	if err != nil {
		return "", err
	}
	v := base64.StdEncoding.EncodeToString(b)
	s.mu.Lock()
	if len(s.vibes) > 100 {
		s.vibes = map[string]string{}
	}
	s.vibes[key] = v
	s.mu.Unlock()
	return v, nil
}

// ---- pictures ----

// read returns a picture's bytes, as user may see it.
func (s *Service) read(ctx context.Context, user *store.User, mediaID int64) ([]byte, error) {
	f, err := s.md.Open(ctx, user, mediaID, false)
	if err != nil {
		return nil, said("那张图拿不到")
	}
	return os.ReadFile(f.Path)
}

// picturesFor: the picture the command replies to, then pictures the same
// person sent just before it (within 2 minutes).
func (s *Service) picturesFor(ctx context.Context, c *helper.Call, limit int) ([][]byte, error) {
	var ids []int64
	if r := c.Event.GetText().GetReplyTo(); r != 0 {
		if ev, err := s.ms.Get(ctx, c.User, c.Conv.ID, r); err == nil && ev.GetImage() != nil && ev.GetRedaction() == nil {
			ids = append(ids, ev.GetImage().GetMediaId())
		}
	}
	if len(ids) < limit {
		conv, err := s.st.GetConv(ctx, c.Conv.ID)
		if err == nil {
			evs, _ := s.st.ListEvents(ctx, c.Conv.ID, max(0, conv.LastSeq-12), 12)
			now := s.now().UnixMilli()
			for i := len(evs) - 1; i >= 0 && len(ids) < limit; i-- {
				e := evs[i]
				if e.EventID == c.Event.GetEventId() || e.BodyKind == message.KindSysMember || e.BodyKind == message.KindSysConv {
					continue
				}
				if e.SenderID != c.User.ID || now-e.CreatedAt > 2*60_000 {
					break
				}
				if e.BodyKind != message.KindImage || e.MediaID == 0 {
					if e.EventID != c.Event.GetEventId() && e.BodyKind == message.KindText && i < len(evs)-1 {
						break
					}
					continue
				}
				if !containsID(ids, e.MediaID) {
					ids = append(ids, e.MediaID)
				}
			}
		}
	}
	var out [][]byte
	for _, id := range ids[:min(limit, len(ids))] {
		b, err := s.read(ctx, c.User, id)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

func containsID(ids []int64, id int64) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// avatarOf is someone's avatar picture (for 「用我的头像」).
func (s *Service) avatarOf(ctx context.Context, u *store.User) ([]byte, error) {
	fresh, err := s.st.GetUser(ctx, u.ID)
	if err != nil || fresh.AvatarMediaID == 0 {
		return nil, said("你还没有头像，换一个再来（AI 的头像在 AI 设置里换）")
	}
	return s.read(ctx, u, fresh.AvatarMediaID)
}

// send uploads the pictures as the bot and posts them, labelled.
func (s *Service) send(ctx context.Context, c *helper.Call, pngs [][]byte, with string, nsfw bool) error {
	for i, p := range pngs {
		m, err := s.md.Upload(ctx, s.bot.Speaker(ctx).ID, fmt.Sprintf("nai-%d-%d.png", s.now().UnixMilli(), i), bytes.NewReader(p))
		if err != nil {
			return err
		}
		from := c.Event.GetText().GetText()
		if r := []rune(from); len(r) > 200 {
			from = string(r[:200])
		}
		if err := s.bot.PictureMade(ctx, c.Conv.ID, &amv1.ImageMsg{MediaId: m.ID, MadeWith: with, Nsfw: nsfw, MadeFor: c.User.ID, MadeFrom: from}); err != nil {
			return err
		}
	}
	return nil
}

// limit counts a picture for someone (site admins: no limit).
func (s *Service) limit(u *store.User, n int) error {
	if s.cfg.DailyPerPerson == 0 || u.IsSiteAdmin {
		return nil
	}
	day := s.now().YearDay() + s.now().Year()*1000
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.counts[u.ID]
	if c[0] != day {
		c = [2]int{day, 0}
	}
	if c[1]+n > s.cfg.DailyPerPerson {
		return said(fmt.Sprintf("今天画得够多啦（每人每天 %d 张），明天再来～", s.cfg.DailyPerPerson))
	}
	c[1] += n
	s.counts[u.ID] = c
	return nil
}

// english turns a description into what goes to NovelAI: 原样 kept, V5
// Chinese kept (v5_native), V4.5 Chinese translated with the bot's model.
func (s *Service) english(ctx context.Context, text string, v5 bool) (string, error) {
	t, raw := TakeRaw(text)
	t = strings.TrimSpace(t)
	if raw || t == "" || !HasCJK(t) || (v5 && s.cfg.V5Native) {
		return t, nil
	}
	if !s.bot.HasModel() {
		return "", said("没配置模型，中文翻译不了：用 /nai5 直接写中文，或者写英文（服务器管理员在管理面板给小助手配个模型就能翻译）")
	}
	out, err := s.bot.Ask(ctx, TranslatePrompt, t, 1000, 0.2)
	if err != nil {
		return "", said("把描述翻成英文失败（" + cut(err.Error(), 60) + "），没画")
	}
	out = strings.Trim(strings.TrimSpace(out), "\"“”「」")
	if out == "" || float64(len(reHan.FindAllString(out, -1))) > float64(len([]rune(out)))*0.2 {
		return "", said("翻译结果不对劲，没画，再发一次试试")
	}
	return out, nil
}

var reHan = regexp.MustCompile(`[\x{4e00}-\x{9fff}]`)

// ---- commands ----

func (s *Service) cmdBalance(ctx context.Context, c *helper.Call) error {
	if err := s.ready(); err != nil {
		return err
	}
	b := s.balance(ctx, true)
	if b == nil {
		return s.reply(ctx, c, "NovelAI：查不到余额（token 或网络有问题）")
	}
	return s.reply(ctx, c, BalanceText(*b, s.now().Location()))
}

var reV5Prefix = regexp.MustCompile(`(?i)^(?:v5|nai5|5)\s+`)

func (s *Service) cmdTags(ctx context.Context, c *helper.Call) error {
	if err := s.ready(); err != nil {
		return err
	}
	q := strings.TrimSpace(c.Args)
	v5 := false
	if m := reV5Prefix.FindString(q); m != "" {
		v5, q = true, strings.TrimSpace(q[len(m):])
	}
	if q == "" {
		return s.reply(ctx, c, Usage("tags", s.cfg.MaxCount))
	}
	model := s.cfg.Model
	if v5 {
		model = s.cfg.V5Model
	}
	queries := []string{"artist:" + q, q}
	if strings.HasPrefix(strings.ToLower(q), "artist:") {
		queries = []string{q}
	}
	var answers [][]byte
	for _, x := range queries {
		b, err := s.request(ctx, http.MethodGet, PathSuggest+"?model="+url.QueryEscape(model)+"&prompt="+url.QueryEscape(x), nil, 20*time.Second)
		if err != nil {
			return err
		}
		answers = append(answers, b)
	}
	return s.reply(ctx, c, TagsText(q, v5, answers))
}

func (s *Service) cmdUpscale(ctx context.Context, c *helper.Call) error {
	if err := s.ready(); err != nil {
		return err
	}
	pics, err := s.picturesFor(ctx, c, 1)
	if err != nil {
		return err
	}
	if len(pics) == 0 {
		return s.reply(ctx, c, Usage("upscale", s.cfg.MaxCount))
	}
	if err := s.limit(c.User, 1); err != nil {
		return err
	}
	if err := s.reply(ctx, c, "收到，NovelAI 放大中（会扣 Anlas）…"); err != nil {
		return err
	}
	before := anlas(s.balance(ctx, false))
	src, err := ShrinkPNG(pics[0], 1024*1024)
	if err != nil {
		return said(err.Error())
	}
	data, err := s.serialized(func() ([]byte, error) {
		return s.request(ctx, http.MethodPost, PathUpscale, map[string]any{"image": src.B64, "width": src.Width, "height": src.Height, "scale": 2}, 2*time.Minute)
	})
	if err != nil {
		return err
	}
	out, err := ExtractPNGs(data)
	if err != nil {
		return said(err.Error())
	}
	if err := s.send(ctx, c, out, "NovelAI 放大", false); err != nil {
		return err
	}
	return s.bot.Say(ctx, c.Conv.ID, "NovelAI 放大 2 倍，"+CostNote(before, anlas(s.balance(ctx, true)), true))
}

// cmdDraw is /nai, /nai5, /角色参考 and /风格迁移.
func (s *Service) cmdDraw(cmdV5 bool, cmdKind string) func(ctx context.Context, c *helper.Call) error {
	return func(ctx context.Context, c *helper.Call) error {
		v5, kind := cmdV5, cmdKind // this call's own (they change below)
		if err := s.ready(); err != nil {
			return err
		}
		text, me := TakeMyAvatar(c.Args)
		var strength float64
		if kind != "draw" {
			text, strength = TakeStrength(text)
		}
		opt := DrawOptions(text, s.cfg.MaxCount)
		rnd := func(n int) int { return s.rnd.IntN(n) }
		sec := SplitSections(opt.Text, rnd)
		rest, tags, styleNotes := StyleSpecs(sec.Text)
		notes := append(opt.Notes, styleNotes...)
		var pics [][]byte
		var err error
		if me {
			// Its own avatar as the character reference: drawing the asker (an AI drawing itself).
			av, err := s.avatarOf(ctx, c.User)
			if err != nil {
				return err
			}
			pics = [][]byte{av}
			if kind == "draw" {
				kind = "charref"
			}
		} else if pics, err = s.picturesFor(ctx, c, 2); err != nil {
			return err
		}
		if kind != "draw" && len(pics) == 0 {
			return s.reply(ctx, c, Usage(kind, s.cfg.MaxCount))
		}
		if kind != "draw" && v5 {
			v5 = false
			notes = append(notes, "角色参考 / 风格迁移 V5 还不支持，用的是 V4.5")
		}
		if kind == "draw" && rest == "" && tags == "" && len(sec.Chars) == 0 && len(pics) == 0 {
			return s.reply(ctx, c, Usage("draw", s.cfg.MaxCount))
		}
		nsfwOK := s.nsfwOK(c)
		check := func(parts ...string) error {
			if p := PromptProblem(strings.Join(parts, " "), nsfwOK, s.cfg.BlockWords); p != "" {
				return said(p)
			}
			return nil
		}
		all := []string{rest, tags, sec.Negative}
		for _, ch := range sec.Chars {
			all = append(all, ch[0], ch[1])
		}
		if err := check(all...); err != nil {
			return err
		}
		prompt := ""
		if rest != "" {
			if prompt, err = s.english(ctx, rest, v5); err != nil {
				return err
			}
		}
		var chars [][2]string
		for _, ch := range sec.Chars {
			p, err := s.english(ctx, ch[0], v5)
			if err != nil {
				return err
			}
			n := ""
			if ch[1] != "" {
				if n, err = s.english(ctx, ch[1], v5); err != nil {
					return err
				}
			}
			chars = append(chars, [2]string{p, n})
		}
		negative := ""
		if sec.Negative != "" {
			if negative, err = s.english(ctx, sec.Negative, v5); err != nil {
				return err
			}
		}
		prompt = joinNonEmpty(", ", tags, prompt)
		if prompt == "" && len(chars) == 0 {
			prompt = "1girl, solo"
		}
		// The translation may bring words the rules catch only in English.
		all = []string{prompt, negative}
		for _, ch := range chars {
			all = append(all, ch[0], ch[1])
		}
		if err := check(all...); err != nil {
			return err
		}
		if err := s.limit(c.User, opt.N); err != nil {
			return err
		}
		ver := "V4.5"
		if v5 {
			ver = "V5"
		}
		var extra []string
		switch {
		case me:
			extra = append(extra, "照头像画")
		case kind == "draw" && len(pics) > 0:
			extra = append(extra, "带图重绘")
		case kind == "charref":
			extra = append(extra, "角色参考")
		case kind == "vibe":
			extra = append(extra, "风格迁移")
		}
		if opt.Fine {
			extra = append(extra, "精绘")
		}
		if opt.N > 1 {
			extra = append(extra, fmt.Sprintf("%d 张", opt.N))
		}
		if opt.Steps > 0 {
			extra = append(extra, fmt.Sprintf("%d 步", opt.Steps))
		}
		head := "收到，NovelAI " + ver + " 画图中"
		if len(extra) > 0 {
			head += "（" + strings.Join(extra, "，") + "，会扣 Anlas）"
		}
		if err := s.reply(ctx, c, head+"…"); err != nil {
			return err
		}
		model := s.cfg.Model
		if v5 {
			model = s.cfg.V5Model
		}
		r := Request{Prompt: prompt, Model: model, Orientation: opt.Orientation, Negative: negative, Chars: chars, Seed: -1,
			Steps: opt.Steps, Large: opt.Fine, NsfwOK: nsfwOK}
		switch {
		case kind == "charref":
			ref, err := PadReference(pics[0])
			if err != nil {
				return said(err.Error())
			}
			r.References = []string{ref}
		case kind == "vibe":
			str := s.cfg.VibeStrength
			if strength > 0 {
				str = strength
			}
			for _, p := range pics {
				v, err := s.encodeVibe(ctx, p, model)
				if err != nil {
					return err
				}
				r.Vibes = append(r.Vibes, Vibe{v, str})
			}
		case len(pics) > 0:
			fit, err := FitImage(pics[0])
			if err != nil {
				return said(err.Error())
			}
			r.Image, r.Width, r.Height = fit.B64, fit.Width, fit.Height
		}
		before := anlas(s.balance(ctx, false))
		start := s.now()
		var pngs [][]byte
		paid := false
		for left := max(1, opt.N); left > 0; left -= 4 {
			r.N = min(4, left)
			p := BuildPayload(r, s.cfg.Settings, s.rnd)
			paid = paid || !IsFree(p)
			data, err := s.serialized(func() ([]byte, error) {
				return s.request(ctx, http.MethodPost, PathImage, p, time.Duration(120+60*(r.N-1))*time.Second)
			})
			if err != nil {
				return err
			}
			out, err := ExtractPNGs(data)
			if err != nil {
				return said(err.Error())
			}
			pngs = append(pngs, out...)
		}
		nsfw := nsfwOK && NSFWRe.MatchString(strings.Join(all, " "))
		if err := s.send(ctx, c, pngs, "NovelAI "+ver, nsfw); err != nil {
			return err
		}
		note := fmt.Sprintf("NovelAI %s，%d 秒", ver, int(s.now().Sub(start).Seconds()))
		steps := s.cfg.Steps
		if opt.Steps > 0 {
			steps = opt.Steps
		}
		if steps != 28 {
			note += fmt.Sprintf("，%d 步", steps)
		}
		if cost := CostNote(before, anlas(s.balance(ctx, true)), paid); cost != "" {
			note += "，" + cost
		}
		return s.bot.Say(ctx, c.Conv.ID, strings.Join(append(notes, note), "；"))
	}
}
