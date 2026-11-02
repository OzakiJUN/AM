package news

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/OzakiJUN/am/server/internal/apperr"
	"github.com/OzakiJUN/am/server/internal/helper"
	"github.com/OzakiJUN/am/server/internal/store"
)

// Config is the [news] section.
type Config struct {
	Enabled bool
	// OpenAI-compatible model that groups and scores (ai_url "" = no model:
	// every post is its own event, nothing is pushed at once except Steam).
	AIURL, AIKey, AIModel, AIProxy string
	Proxy, CommunityProxy          string
	CheckMinutes                   int
	DailyTime                      string
	WeeklyDay, WeeklyTime          string
	XWeekly                        bool
	XAIKey, XAIModel, XAIProxy     string
	// WeeklyAnyone: everyone may ask for an X report (it costs money); otherwise site admins only.
	WeeklyAnyone bool
	Sources      []string
	PerSource    int
	DigestTop    int
	SteamTop     int
	SteamPush    bool
	SteamCC      string
	Cookies      map[string]string
	MaxPerConv   int
}

// Service is 游戏资讯.
type Service struct {
	cfg   Config
	st    *store.Store
	bot   *helper.Service
	fetch *Fetcher
	log   *slog.Logger
	clock atomic.Pointer[func() time.Time]

	mu        sync.Mutex // one round at a time; guards the state below while it runs
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
}

// New sets up 游戏资讯 and registers its commands with the bot.
func New(cfg Config, st *store.Store, bot *helper.Service, log *slog.Logger) *Service {
	s := &Service{cfg: cfg, st: st, bot: bot, log: log, stop: make(chan struct{}), done: make(chan struct{})}
	s.fetch = &Fetcher{Proxy: cfg.Proxy, CommunityProxy: cfg.CommunityProxy, Cookies: cfg.Cookies, SteamCC: cfg.SteamCC, Now: func() time.Time { return s.now() }}
	bot.Register(s.commands()...)
	return s
}

// SetClock replaces the clock (tests).
func (s *Service) SetClock(now func() time.Time) { s.clock.Store(&now) }

func (s *Service) now() time.Time {
	if f := s.clock.Load(); f != nil {
		return (*f)()
	}
	return time.Now()
}

// SetRewrite points the sites at another server (tests).
func (s *Service) SetRewrite(f func(string) string) { s.fetch.SetRewrite(f) }

// ---- state (news_state rows, JSON) ----

// Kind is what a keyword is: a game or a company, and where it is on Steam.
type Kind struct {
	Kind      string `json:"kind"` // game | company
	Steam     int64  `json:"steam,omitempty"`
	Apps      []App  `json:"apps,omitempty"`
	SteamName string `json:"steam_name,omitempty"`
	EN        string `json:"en,omitempty"`
	Group     string `json:"group,omitempty"`
	GroupAt   int64  `json:"group_at,omitempty"`
	At        int64  `json:"at"`
	Forced    bool   `json:"forced,omitempty"`
}

// Day is what a keyword gathered today.
type Day struct {
	Date   string   `json:"date"`
	Events []Event  `json:"events"`
	Pushed []string `json:"pushed"`
	Steam  []Item   `json:"steam"`
}

type sched struct {
	Daily  string `json:"daily"`
	Weekly string `json:"weekly"`
}

func (s *Service) load(ctx context.Context, name string, v any) {
	data, err := s.st.NewsState(ctx, name)
	if err == nil && data != "" {
		_ = json.Unmarshal([]byte(data), v)
	}
}

func (s *Service) save(ctx context.Context, name string, v any) {
	b, _ := json.Marshal(v)
	if err := s.st.SetNewsState(ctx, name, string(b), s.now().UnixMilli()); err != nil {
		s.log.Warn("news: saving state", "name", name, "err", err)
	}
}

type keyword struct {
	alias   []string
	targets []int64
	manual  int64
}

func (s *Service) keywords(ctx context.Context) (map[string]*keyword, error) {
	subs, err := s.st.NewsSubs(ctx, 0)
	if err != nil {
		return nil, err
	}
	out := map[string]*keyword{}
	for _, sub := range subs {
		k := out[sub.Keyword]
		if k == nil {
			k = &keyword{}
			out[sub.Keyword] = k
		}
		for _, a := range sub.Alias {
			if !slices.Contains(k.alias, a) {
				k.alias = append(k.alias, a)
			}
		}
		k.targets = append(k.targets, sub.ConvID)
		if k.manual == 0 {
			k.manual = sub.ManualSteam
		}
	}
	return out, nil
}

func (s *Service) today() string { return s.now().Format("2006-01-02") }

// ---- game or company ----

// resolve works out whether a keyword is a game or a company (asked once a week).
func (s *Service) resolve(ctx context.Context, kw string, alias []string, manual int64) *Kind {
	kinds := map[string]*Kind{}
	s.load(ctx, "kinds", &kinds)
	key := strings.ToLower(kw)
	now := s.now().Unix()
	if hit := kinds[key]; hit != nil && (hit.Forced || now-hit.At < 7*86400) {
		// A company whose Steam group wasn't found (the network was down): try again after an hour.
		if hit.Kind == "company" && hit.Group == "" && now-hit.GroupAt > 3600 {
			hit.Group, _ = s.fetch.FindGroup(ctx, append([]string{hit.EN, kw}, alias...))
			hit.GroupAt = now
			s.save(ctx, "kinds", kinds)
		}
		if manual != 0 {
			c := *hit
			c.Kind, c.Steam, c.Apps, c.SteamName = "game", manual, nil, fmt.Sprintf("appid %d", manual)
			return &c
		}
		return hit
	}
	var res *Kind
	if manual != 0 {
		res = &Kind{Kind: "game", Steam: manual, SteamName: fmt.Sprintf("appid %d", manual)}
	} else {
		var d struct {
			Kind string `json:"kind"`
			EN   string `json:"en"`
		}
		kind := "unknown"
		if err := s.ask(ctx, kindPrompt, strings.Join(append([]string{kw}, alias...), " / "), 100, &d); err == nil {
			kind, d.EN = d.Kind, strings.TrimSpace(d.EN)
		} else if !errors.Is(err, errNoModel) {
			s.log.Info("news: game or company?", "kw", kw, "err", err)
		}
		company := func(apps []App) *Kind {
			names := make([]string, 0, 3)
			for _, a := range apps[:min(3, len(apps))] {
				names = append(names, a.Name)
			}
			g, _ := s.fetch.FindGroup(ctx, append([]string{d.EN, kw}, alias...))
			return &Kind{Kind: "company", Apps: apps, EN: d.EN, SteamName: strings.Join(names, "、"), Group: g, GroupAt: now}
		}
		if kind == "company" {
			res = company(s.fetch.CompanyApps(ctx, append([]string{d.EN, kw}, alias...)))
		} else {
			terms := append([]string{kw}, alias...)
			if d.EN != "" {
				terms = append(terms, d.EN)
			}
			app, ok := s.fetch.FindApp(ctx, terms)
			if !ok && kind == "unknown" { // nobody knows: games by that maker on Steam → a company
				if apps := s.fetch.CompanyApps(ctx, append([]string{kw}, alias...)); len(apps) > 0 {
					res = company(apps)
				}
			}
			if res == nil {
				res = &Kind{Kind: "game", EN: d.EN}
				if ok {
					res.Steam, res.SteamName = app.ID, app.Name
				}
			}
		}
	}
	res.At = now
	kinds[key] = res
	s.save(ctx, "kinds", kinds)
	s.log.Info("news: keyword resolved", "kw", kw, "kind", res.Kind, "steam", res.SteamName, "group", res.Group)
	return res
}

func (k *Kind) hasSteam() bool { return k.Steam != 0 || len(k.Apps) > 0 }

func kindName(k *Kind) string {
	if k.Kind == "company" {
		return "厂商"
	}
	return "游戏"
}

// terms: aliases plus the English name.
func terms(kw string, alias []string, k *Kind) []string {
	out := slices.Clone(alias)
	if k.EN != "" && !strings.EqualFold(k.EN, kw) && !slices.Contains(out, k.EN) {
		out = append(out, k.EN)
	}
	return out
}

// ---- Steam ----

type result struct {
	src   string
	items []Item
	err   error
}

func (s *Service) steamJobs(ctx context.Context, k *Kind, days float64) []func() result {
	var jobs []func() result
	if k.Steam != 0 {
		jobs = append(jobs, func() result { it, err := s.fetch.SteamNews(ctx, k.Steam, days, ""); return result{"steam", it, err} })
	}
	for _, a := range k.Apps {
		jobs = append(jobs, func() result { it, err := s.fetch.SteamNews(ctx, a.ID, days, a.Name); return result{"steam", it, err} })
	}
	if k.Group != "" {
		jobs = append(jobs, func() result { it, err := s.fetch.SteamGroup(ctx, k.Group, days); return result{"steam", it, err} })
	}
	return jobs
}

func parallel(jobs []func() result) []result {
	out := make([]result, len(jobs))
	var wg sync.WaitGroup
	for i, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i] = j()
		}()
	}
	wg.Wait()
	return out
}

// steamLatest: the newest Steam posts (official, group, media), any age.
func (s *Service) steamLatest(ctx context.Context, k *Kind, n int) []Item {
	seen := map[string]bool{}
	var items []Item
	for _, r := range parallel(s.steamJobs(ctx, k, 3650)) {
		if r.err != nil {
			s.log.Info("news: steam", "err", r.err)
			continue
		}
		for _, i := range r.items {
			if i.URL != "" && !seen[i.URL] {
				seen[i.URL] = true
				items = append(items, i)
			}
		}
	}
	sort.SliceStable(items, func(a, b int) bool { return items[a].TS > items[b].TS })
	return items[:min(n, len(items))]
}

// steamTranslate adds Chinese titles and summaries (left as they are on errors).
func (s *Service) steamTranslate(ctx context.Context, kw string, items []Item) {
	if len(items) == 0 {
		return
	}
	var b strings.Builder
	for n, i := range items {
		fmt.Fprintf(&b, "%d. %s", n+1, i.Title)
		if i.Body != "" {
			b.WriteString("｜正文：" + cut(i.Body, 300))
		}
		b.WriteByte('\n')
	}
	var d struct {
		Items []struct {
			N       int    `json:"n"`
			Zh      string `json:"zh"`
			Summary string `json:"summary"`
		} `json:"items"`
	}
	if err := s.ask(ctx, fmt.Sprintf(steamPrompt, kw), b.String(), 2000, &d); err != nil {
		if !errors.Is(err, errNoModel) {
			s.log.Info("news: steam translation", "err", err)
		}
		return
	}
	for _, x := range d.Items {
		if k := x.N - 1; k >= 0 && k < len(items) {
			items[k].Zh = cut(strings.TrimSpace(x.Zh), 100)
			items[k].Summary = cut(strings.TrimSpace(x.Summary), 160)
		}
	}
}

// ---- the other sites ----

func (s *Service) sourceOn(src string) bool { return slices.Contains(s.cfg.Sources, src) }

// gather fetches every source (Steam too when withSteam) and ranks the
// items; report gets each source's count or error.
func (s *Service) gather(ctx context.Context, kw string, alias []string, k *Kind, withSteam bool, report map[string]string, days float64) []Item {
	all := append([]string{kw}, alias...)
	var jobs []func() result
	for _, src := range s.cfg.Sources {
		if src == "steam" {
			if withSteam && k != nil {
				jobs = append(jobs, s.steamJobs(ctx, k, days)...)
			}
			continue
		}
		fn := map[string]func(context.Context, string, float64) ([]Item, error){
			"bili": s.fetch.Bili, "news": s.fetch.GNews, "bing": s.fetch.Bing, "reddit": s.fetch.Reddit, "youtube": s.fetch.YouTube,
			"weibo": s.fetch.Weibo, "tieba": s.fetch.Tieba, "nga": s.fetch.NGA}[src]
		if fn == nil {
			continue
		}
		use := all[:min(3, len(all))]
		switch src {
		case "reddit", "youtube": // overseas sites: the English name
			use = nil
			for _, t := range all {
				if IsASCII(t) {
					use = []string{t}
					break
				}
			}
			if use == nil {
				use = all[:1]
			}
		case "tieba": // bars are named in Chinese
			use = nil
			for _, t := range all {
				if !IsASCII(t) && len(use) < 2 {
					use = append(use, t)
				}
			}
			if use == nil {
				use = all[:1]
			}
		}
		for _, t := range use {
			jobs = append(jobs, func() result { it, err := fn(ctx, t, days); return result{src, it, err} })
		}
	}
	cutoff := s.now().Unix() - int64(days*86400) - 3600
	seen := map[string]bool{}
	count := map[string]int{}
	var items []Item
	for _, r := range parallel(jobs) {
		if r.err != nil {
			if _, ok := report[r.src]; !ok && report != nil {
				report[r.src] = "失败：" + cut(r.err.Error(), 80)
			}
			continue
		}
		if r.src == "steam" {
			count["steam"] += 0
			count["steamnews"] += 0
		}
		for _, i := range r.items {
			if i.TS != 0 && i.TS < cutoff {
				continue
			}
			if i.URL != "" && i.Title != "" && !seen[i.URL] {
				seen[i.URL] = true
				items = append(items, i)
				count[i.Src]++
			}
		}
	}
	if report != nil {
		for src, n := range count {
			report[src] = strconv.Itoa(n)
		}
	}
	return Rank(items, max(3, s.cfg.PerSource))
}

// cluster asks the model to group the items into events; without a model,
// every item is an event.
func (s *Service) cluster(ctx context.Context, kw string, items []Item, pushed []string, k *Kind) ([]Event, error) {
	if len(items) == 0 {
		return nil, nil
	}
	if s.cfg.AIURL == "" {
		return PlainEvents(items), nil
	}
	scope := fmt.Sprintf(scopeGame, kw)
	if k.Kind == "company" {
		en := ""
		if k.EN != "" {
			en = "（英文名 " + k.EN + "）"
		}
		scope = fmt.Sprintf(scopeCompany, kw, en)
	}
	p := "无"
	if len(pushed) > 0 {
		p = strings.Join(pushed[max(0, len(pushed)-15):], "；")
	}
	var d struct {
		Events []AIEvent `json:"events"`
	}
	if err := s.ask(ctx, fmt.Sprintf(clusterPrompt, kw, scope, s.today(), p), ClusterLines(items, s.now()), 3500, &d); err != nil {
		return nil, err
	}
	return BuildEvents(items, d.Events), nil
}

// mergeDay merges the day's events that are the same thing.
func (s *Service) mergeDay(ctx context.Context, kw string, events []Event) []Event {
	if len(events) < 2 || s.cfg.AIURL == "" {
		return events
	}
	var b strings.Builder
	for n, e := range events {
		fmt.Fprintf(&b, "%d. %s\n", n+1, e.Title)
	}
	var d struct {
		Groups []AIGroup `json:"groups"`
	}
	if err := s.ask(ctx, mergePrompt, "游戏："+kw+"\n"+b.String(), 1500, &d); err != nil {
		s.log.Warn("news: merging the day's events", "err", err)
		return events
	}
	return MergeGroups(events, d.Groups)
}

// ---- rounds ----

// say posts to a conversation; when the bot can't post there any more
// (removed, the channel is gone), its subscriptions there end.
func (s *Service) say(ctx context.Context, convID int64, text string) {
	err := s.bot.Say(ctx, convID, text)
	if err == nil {
		return
	}
	if errors.Is(err, apperr.ErrNotMember) || errors.Is(err, apperr.ErrNotFound) {
		subs, _ := s.st.NewsSubs(ctx, convID)
		for _, sub := range subs {
			_ = s.st.DeleteNewsSub(ctx, convID, sub.Keyword)
		}
		s.log.Info("news: the bot can't post there any more; its subscriptions ended", "conv", convID)
		return
	}
	s.log.Warn("news: posting", "conv", convID, "err", err)
}

// Check runs one round: new Steam posts are pushed at once, the rest is
// grouped and scored, big news pushed, everything kept for the evening.
// only = one keyword (its first round: push false only records what's there).
func (s *Service) Check(ctx context.Context, only string, push bool) (map[string][]Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	kws, err := s.keywords(ctx)
	if err != nil {
		return nil, err
	}
	if only != "" {
		k := kws[only]
		if k == nil {
			k = &keyword{}
		}
		kws = map[string]*keyword{only: k}
	}
	seen := map[string]map[string]int64{}
	steamSeen := map[string][]string{}
	days := map[string]*Day{}
	s.load(ctx, "seen", &seen)
	s.load(ctx, "steam_seen", &steamSeen)
	s.load(ctx, "events", &days)
	today := s.today()
	now := s.now()
	out := map[string][]Event{}
	for _, kw := range sortedKW(kws) {
		info := kws[kw]
		k := s.resolve(ctx, kw, info.alias, info.manual)
		day := days[kw]
		if day == nil {
			day = &Day{Date: today}
			days[kw] = day
		}
		if day.Date != today { // pushed stays a while so tomorrow doesn't push the same thing
			day.Date, day.Events, day.Steam = today, nil, nil
			day.Pushed = day.Pushed[max(0, len(day.Pushed)-30):]
		}
		// Steam: the main source, not filtered by the model; new posts go out at once.
		st := s.steamLatest(ctx, k, 10)
		ss := steamSeen[kw]
		first := len(ss) == 0
		var fresh []Item
		newCount := 0
		for _, i := range st {
			h := Hash(i.URL)
			if slices.Contains(ss, h) {
				continue
			}
			newCount++
			ss = append(ss, h)
			if !first && (i.TS == 0 || now.Unix()-i.TS < 7*86400) {
				fresh = append(fresh, i)
			}
		}
		steamSeen[kw] = ss[max(0, len(ss)-300):]
		if len(fresh) > 0 {
			s.steamTranslate(ctx, kw, fresh)
			day.Steam = append(day.Steam, fresh...)
			if push && s.cfg.SteamPush {
				lines := []string{"📢【" + kw + "】Steam 新消息"}
				for _, i := range fresh {
					lines = append(lines, FormatSteam(i, now))
				}
				for _, t := range info.targets {
					s.say(ctx, t, strings.Join(lines, "\n"))
				}
			}
		}
		if newCount > 0 {
			s.log.Info("news: steam", "kw", kw, "new", newCount, "pushed", len(fresh))
		}
		// The other sites: grouped and scored by the model.
		items := s.gather(ctx, kw, terms(kw, info.alias, k), k, false, nil, 3)
		sk := seen[kw]
		if sk == nil {
			sk = map[string]int64{}
			seen[kw] = sk
		}
		var fresh2 []Item
		for _, i := range items {
			if _, ok := sk[Hash(i.URL)]; !ok {
				fresh2 = append(fresh2, i)
			}
		}
		if len(fresh2) == 0 {
			continue
		}
		events, err := s.cluster(ctx, kw, fresh2, day.Pushed, k)
		if err != nil {
			s.log.Warn("news: grouping", "kw", kw, "err", err)
			continue
		}
		for _, i := range fresh2 {
			sk[Hash(i.URL)] = now.Unix()
		}
		out[kw] = events
		day.Events = append(day.Events, events...)
		var urgent []Event
		for _, e := range events {
			if Urgent(e, now) {
				urgent = append(urgent, e)
			}
		}
		if push && len(urgent) > 0 {
			lines := []string{"⚡【" + kw + "】大事"}
			for _, e := range urgent {
				lines = append(lines, FormatEvent(e, now))
				day.Pushed = append(day.Pushed, e.Title)
			}
			for _, t := range info.targets {
				s.say(ctx, t, strings.Join(lines, "\n"))
			}
		}
		s.log.Info("news: round", "kw", kw, "new", len(fresh2), "events", len(events), "urgent", len(urgent))
	}
	cutoff := now.Unix() - 14*86400
	for kw, m := range seen {
		for h, t := range m {
			if t < cutoff {
				delete(m, h)
			}
		}
		if _, ok := kws[kw]; !ok && only == "" && len(m) == 0 {
			delete(seen, kw)
		}
	}
	s.save(ctx, "seen", seen)
	s.save(ctx, "steam_seen", steamSeen)
	s.save(ctx, "events", days)
	return out, nil
}

func sortedKW(m map[string]*keyword) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Daily posts the evening digest in every conversation that follows something.
func (s *Service) Daily(ctx context.Context) error {
	subs, err := s.st.NewsSubs(ctx, 0)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	days := map[string]*Day{}
	s.load(ctx, "events", &days)
	today := s.today()
	now := s.now()
	digests := map[string][]Event{}
	for kw, d := range days {
		if d.Date == today && len(d.Events) > 0 {
			digests[kw] = PickDigest(s.mergeDay(ctx, kw, d.Events), max(3, s.cfg.DigestTop))
		}
	}
	byConv := map[int64][]string{}
	var convs []int64
	for _, sub := range subs {
		if _, ok := byConv[sub.ConvID]; !ok {
			convs = append(convs, sub.ConvID)
		}
		byConv[sub.ConvID] = append(byConv[sub.ConvID], sub.Keyword)
	}
	for _, c := range convs {
		var parts []string
		for _, kw := range byConv[c] {
			evs := digests[kw]
			var st []Item
			if d := days[kw]; d != nil && d.Date == today {
				st = d.Steam[max(0, len(d.Steam)-10):]
			}
			if len(evs) == 0 && len(st) == 0 {
				continue
			}
			block := "🎮【" + kw + "】今日动态"
			if len(st) > 0 {
				block += "\n📢 Steam 新消息"
				for i := len(st) - 1; i >= 0; i-- {
					block += "\n" + FormatSteam(st[i], now)
				}
			}
			if len(evs) > 0 {
				block += "\n💬 其他平台（按热度）"
				for _, e := range evs {
					block += "\n" + FormatEvent(e, now)
				}
			}
			parts = append(parts, block)
		}
		if len(parts) > 0 {
			s.say(ctx, c, strings.Join(parts, "\n\n"))
		}
	}
	for _, d := range days {
		if d.Date == today {
			d.Events, d.Steam = nil, nil
		}
	}
	s.save(ctx, "events", days)
	return nil
}

// Weekly posts the X report for every keyword where it is followed.
func (s *Service) Weekly(ctx context.Context) error {
	if !s.cfg.XWeekly || s.cfg.XAIKey == "" {
		return nil
	}
	kws, err := s.keywords(ctx)
	if err != nil {
		return err
	}
	for _, kw := range sortedKW(kws) {
		text := s.xWeekly(ctx, kw, kws[kw].alias)
		for _, t := range kws[kw].targets {
			s.say(ctx, t, "📰【"+kw+"】本周 X（推特）圈内动态\n"+text)
		}
	}
	return nil
}

// ---- the schedule ----

// Run checks every check_minutes and posts the digest / weekly report on
// time, until Close.
func (s *Service) Run() {
	defer close(s.done)
	if !s.cfg.Enabled {
		<-s.stop
		return
	}
	dh, dm, _ := HM(s.cfg.DailyTime)
	wh, wm, _ := HM(s.cfg.WeeklyTime)
	wd, _ := Weekday(s.cfg.WeeklyDay)
	every := time.Duration(max(15, s.cfg.CheckMinutes)) * time.Minute
	next := s.now().Add(time.Minute) // the first round soon after start
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		now := s.now()
		var sc sched
		s.load(ctx, "sched", &sc)
		today := now.Format("2006-01-02")
		due := func(h, m int) bool {
			at := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, now.Location())
			return !now.Before(at) && now.Sub(at) < 2*time.Hour // not when the server starts late at night
		}
		if subs, _ := s.st.NewsSubs(ctx, 0); len(subs) > 0 {
			switch {
			case sc.Daily != today && due(dh, dm):
				sc.Daily = today
				s.save(ctx, "sched", sc)
				if _, err := s.Check(ctx, "", true); err != nil {
					s.log.Warn("news: round", "err", err)
				}
				if err := s.Daily(ctx); err != nil {
					s.log.Warn("news: digest", "err", err)
				}
				next = s.now().Add(every)
			case s.cfg.XWeekly && sc.Weekly != today && now.Weekday() == wd && due(wh, wm):
				sc.Weekly = today
				s.save(ctx, "sched", sc)
				if err := s.Weekly(ctx); err != nil {
					s.log.Warn("news: weekly", "err", err)
				}
			case !now.Before(next):
				next = now.Add(every)
				if _, err := s.Check(ctx, "", true); err != nil {
					s.log.Warn("news: round", "err", err)
				}
			}
		}
		cancel()
	}
}

// Close stops Run.
func (s *Service) Close() {
	s.closeOnce.Do(func() { close(s.stop) })
	<-s.done
}

// ---- commands ----

func (s *Service) commands() []*helper.Command {
	g := "🎮 游戏资讯"
	return []*helper.Command{
		{Name: "关注游戏", Aliases: []string{"关注关键词", "订阅游戏"}, Group: g, Usage: "关注游戏 dota2|刀塔 [steam:570]",
			Help: "关注一个游戏或厂商（| 后面是别名，一起搜）：大事立刻推到这里，每晚发汇总，每周发 X 周报", Safe: true, Run: s.cmdFollow},
		{Name: "取消关注", Group: g, Usage: "取消关注 <序号或关键词>", Help: "不再关注", Run: s.cmdUnfollow},
		{Name: "关注列表", Group: g, Usage: "关注列表", Help: "这里关注了哪些", Safe: true, Run: s.cmdList},
		{Name: "资讯", Aliases: []string{"游戏资讯"}, Group: g, Usage: "资讯 [关键词]", Help: "马上查一次（不写 = 这里关注的全部）", Safe: true, Run: s.cmdNews},
		{Name: "资讯源", Aliases: []string{"资讯来源"}, Group: g, Usage: "资讯源 [关键词]", Help: "测一遍每个来源通不通、抓到几条", Safe: true, Run: s.cmdSources},
		{Name: "资讯类型", Aliases: []string{"资讯判断"}, Group: g, Usage: "资讯类型 <名字> 厂商|游戏|自动 [群组:xxx] [steam:1,2]",
			Help: "自动判断是游戏还是厂商判断错了时手动改", Run: s.cmdKind},
		{Name: "周报", Aliases: []string{"游戏周报"}, Group: g, Usage: "周报 [关键词]", Help: "马上用 X 搜一次本周动态（按帖子收费，一次约 0.3 美元）", Run: s.cmdWeekly},
	}
}

func (s *Service) off() error {
	if !s.cfg.Enabled {
		return helper.Said("这个服务器关掉了游戏资讯")
	}
	return nil
}

func (s *Service) reply(ctx context.Context, c *helper.Call, text string) error {
	return s.bot.Reply(ctx, c.Conv.ID, c.Event.GetEventId(), text)
}

func (s *Service) cmdFollow(ctx context.Context, c *helper.Call) error {
	if err := s.off(); err != nil {
		return err
	}
	kw, alias, manual := ParseFollow(c.Args)
	if kw == "" {
		return helper.Said("用法：/关注游戏 dota2|刀塔（| 后面是别名，会一起搜）")
	}
	subs, err := s.st.NewsSubs(ctx, c.Conv.ID)
	if err != nil {
		return err
	}
	var old *store.NewsSub
	for _, sub := range subs {
		if strings.EqualFold(sub.Keyword, kw) {
			old = sub
		}
	}
	if old == nil && s.cfg.MaxPerConv > 0 && len(subs) >= s.cfg.MaxPerConv {
		return helper.Said(fmt.Sprintf("这里已经关注了 %d 个，先取消几个", len(subs)))
	}
	if manual != 0 { // a hand-picked Steam id replaces the automatic guess
		kinds := map[string]*Kind{}
		s.load(ctx, "kinds", &kinds)
		delete(kinds, strings.ToLower(kw))
		s.save(ctx, "kinds", kinds)
	}
	sub := &store.NewsSub{ConvID: c.Conv.ID, Keyword: kw, Alias: alias, ManualSteam: manual, CreatedBy: c.User.ID, CreatedAt: s.now().UnixMilli()}
	if old != nil {
		sub.Keyword, sub.CreatedBy, sub.CreatedAt = old.Keyword, old.CreatedBy, old.CreatedAt
		for _, a := range old.Alias {
			if !slices.Contains(sub.Alias, a) {
				sub.Alias = append(sub.Alias, a)
			}
		}
		if sub.ManualSteam == 0 {
			sub.ManualSteam = old.ManualSteam
		}
		kw = old.Keyword
	}
	k := s.resolve(ctx, kw, sub.Alias, sub.ManualSteam)
	if err := s.st.PutNewsSub(ctx, sub); err != nil {
		return err
	}
	msg := "已关注「" + kw + "」"
	if len(sub.Alias) > 0 {
		msg += "（别名：" + strings.Join(sub.Alias, "、") + "）"
	}
	if k.Kind == "company" {
		msg += "，按厂商搜"
		if k.EN != "" {
			msg += "（英文名 " + k.EN + "）"
		}
	} else {
		msg += "，按游戏搜"
	}
	if k.SteamName != "" {
		msg += "，Steam 上找到：" + k.SteamName + "，官方公告和 Steam 收录的媒体报道也会一起看"
	}
	msg += "。大事会即时推送到这里，每晚 " + s.cfg.DailyTime + " 发汇总"
	if s.cfg.XWeekly && s.cfg.XAIKey != "" {
		msg += "，每周发 X 周报"
	}
	if err := s.reply(ctx, c, msg+"。先跑一轮建立基线…"); err != nil {
		return err
	}
	// The first round only records what is there: no old news pushed.
	res, err := s.Check(ctx, kw, false)
	if err != nil {
		return err
	}
	return s.bot.Say(ctx, c.Conv.ID, fmt.Sprintf("「%s」基线建好了，最近的 %d 个事件已放进今晚的汇总。想现在看就发「/资讯 %s」", kw, len(res[kw]), kw))
}

func (s *Service) cmdUnfollow(ctx context.Context, c *helper.Call) error {
	subs, err := s.st.NewsSubs(ctx, c.Conv.ID)
	if err != nil {
		return err
	}
	t := strings.TrimSpace(c.Args)
	idx := -1
	if n, err := strconv.Atoi(t); err == nil {
		idx = n - 1
	} else {
		for i, sub := range subs {
			if strings.EqualFold(sub.Keyword, t) {
				idx = i
			}
		}
	}
	if idx < 0 || idx >= len(subs) {
		return helper.Said("没找到，先发「/关注列表」看序号")
	}
	if err := s.st.DeleteNewsSub(ctx, c.Conv.ID, subs[idx].Keyword); err != nil {
		return err
	}
	return s.reply(ctx, c, "已取消关注「"+subs[idx].Keyword+"」")
}

func (s *Service) cmdList(ctx context.Context, c *helper.Call) error {
	subs, err := s.st.NewsSubs(ctx, c.Conv.ID)
	if err != nil {
		return err
	}
	if len(subs) == 0 {
		return s.reply(ctx, c, "这里还没关注任何关键词。发「/关注游戏 dota2|刀塔」试试")
	}
	kinds := map[string]*Kind{}
	s.load(ctx, "kinds", &kinds)
	lines := []string{"这里关注的关键词："}
	for i, sub := range subs {
		l := fmt.Sprintf("%d. %s", i+1, sub.Keyword)
		if len(sub.Alias) > 0 {
			l += "（" + strings.Join(sub.Alias, "、") + "）"
		}
		if sub.ManualSteam != 0 {
			l += fmt.Sprintf(" [Steam %d]", sub.ManualSteam)
		}
		if k := kinds[strings.ToLower(sub.Keyword)]; k != nil && k.Kind == "company" {
			l += " [厂商]"
		}
		lines = append(lines, l)
	}
	return s.reply(ctx, c, strings.Join(lines, "\n"))
}

func (s *Service) cmdNews(ctx context.Context, c *helper.Call) error {
	if err := s.off(); err != nil {
		return err
	}
	subs, err := s.st.NewsSubs(ctx, c.Conv.ID)
	if err != nil {
		return err
	}
	kw := strings.TrimSpace(c.Args)
	var kws []string
	if kw != "" {
		kws = []string{kw}
	} else {
		for _, sub := range subs {
			kws = append(kws, sub.Keyword)
		}
	}
	if len(kws) == 0 {
		return helper.Said("用法：/资讯 <关键词>，或者先「/关注游戏」几个关键词")
	}
	if err := s.reply(ctx, c, "正在各平台查 "+strings.Join(kws, "、")+"，大约半分钟…"); err != nil {
		return err
	}
	now := s.now()
	var out []string
	for _, k := range kws {
		var alias []string
		var manual int64
		for _, sub := range subs {
			if sub.Keyword == k {
				alias, manual = sub.Alias, sub.ManualSteam
			}
		}
		r := s.resolve(ctx, k, alias, manual)
		how := ""
		if r.Kind == "company" {
			how = "（按厂商搜"
			if r.EN != "" {
				how += "：" + r.EN
			}
			how += "）"
		}
		block := []string{"🎮【" + k + "】" + how}
		st := s.steamLatest(ctx, r, max(1, s.cfg.SteamTop))
		s.steamTranslate(ctx, k, st)
		switch {
		case len(st) > 0:
			lines := []string{"📢 Steam 最新消息"}
			for _, i := range st {
				lines = append(lines, FormatSteam(i, now))
			}
			block = append(block, strings.Join(lines, "\n"))
		case r.hasSteam() || r.Group != "":
			block = append(block, "📢 Steam：暂时没抓到消息（发「/资讯源 "+k+"」看看是不是连不上）")
		default:
			block = append(block, "📢 Steam：没找到对应的游戏或厂商群组（判断错了可以用「/资讯类型」改，厂商可以加 群组:xxx）")
		}
		// The other sites: the last 3 days; nothing → 30 days; still no events → the newest posts.
		var evs []Event
		var items []Item
		span := 3.0
		for _, span = range []float64{3, 30} {
			items = s.gather(ctx, k, terms(k, alias, r), r, false, nil, span)
			if len(items) == 0 {
				continue
			}
			e, err := s.cluster(ctx, k, items, nil, r)
			if err != nil {
				s.log.Warn("news: grouping", "kw", k, "err", err)
			}
			if evs = PickDigest(e, max(3, s.cfg.DigestTop)); len(evs) > 0 {
				break
			}
		}
		switch {
		case len(evs) > 0:
			head := "💬 其他平台（按热度）"
			if span != 3 {
				head = "💬 其他平台最近 3 天没什么动静，这是近 30 天的（按热度）"
			}
			lines := []string{head}
			for _, e := range evs {
				lines = append(lines, FormatEvent(e, now))
			}
			block = append(block, strings.Join(lines, "\n"))
		case len(items) > 0:
			sort.SliceStable(items, func(a, b int) bool { return items[a].TS > items[b].TS })
			lines := []string{"💬 其他平台近 30 天没归出像样的事件，搜到的最新几条："}
			for _, i := range items[:min(6, len(items))] {
				l := "• [" + SrcName[i.Src] + "] " + i.Title
				if i.TS != 0 {
					l += "｜" + MD(i.TS, now)
				}
				lines = append(lines, l+"\n   "+i.URL)
			}
			block = append(block, strings.Join(lines, "\n"))
		case len(st) == 0:
			block = append(block, "💬 其他平台近 30 天也没搜到（名字可能要换个叫法，或者加别名：/关注游戏 "+k+"|英文名）")
		}
		out = append(out, strings.Join(block, "\n"))
	}
	return s.bot.Say(ctx, c.Conv.ID, strings.Join(out, "\n\n"))
}

func (s *Service) cmdSources(ctx context.Context, c *helper.Call) error {
	if err := s.off(); err != nil {
		return err
	}
	subs, err := s.st.NewsSubs(ctx, c.Conv.ID)
	if err != nil {
		return err
	}
	kw := strings.TrimSpace(c.Args)
	if kw == "" {
		kw = "dota2"
		if len(subs) > 0 {
			kw = subs[0].Keyword
		}
	}
	var alias []string
	var manual int64
	for _, sub := range subs {
		if sub.Keyword == kw {
			alias, manual = sub.Alias, sub.ManualSteam
		}
	}
	r := s.resolve(ctx, kw, alias, manual)
	head := fmt.Sprintf("正在测各个来源（关键词：%s，按%s搜", kw, kindName(r))
	if r.SteamName != "" {
		head += "，Steam：" + r.SteamName
	}
	if r.Group != "" {
		head += "，群组：" + r.Group
	}
	if err := s.reply(ctx, c, head+"）…"); err != nil {
		return err
	}
	report := map[string]string{}
	s.gather(ctx, kw, terms(kw, alias, r), r, true, report, 3)
	count := func(v string) string {
		if _, err := strconv.Atoi(v); err == nil {
			return v + " 条"
		}
		return v
	}
	good := func(v string) bool { n, err := strconv.Atoi(v); return err == nil && n > 0 }
	rows := []string{"📡 资讯来源测试（" + kw + "）"}
	for _, src := range AllSources {
		name := SrcName[src]
		if src == "news" {
			name += "（Google）"
		} else if src == "bing" {
			name += "（必应）"
		}
		v, ok := report[src]
		switch {
		case !s.sourceOn(src):
			rows = append(rows, "⏸ "+name+"：配置里关掉了")
		case src == "steam" && !r.hasSteam() && r.Group == "":
			rows = append(rows, "➖ "+name+"：Steam 上没找到（不在 Steam，或者按厂商没搜到游戏）")
		case src == "steam":
			o, m := report["steam"], report["steamnews"]
			if o == "" {
				o = "0"
			}
			if m == "" {
				m = "0"
			}
			mark := "❌"
			if good(o) || good(m) {
				mark = "✅"
			}
			l := fmt.Sprintf("%s Steam：官方公告 %s，媒体报道 %s", mark, count(o), count(m))
			if r.Group != "" {
				l += "（含群组 " + r.Group + " 的公告）"
			}
			rows = append(rows, l)
		case ok:
			mark := "❌"
			if good(v) {
				mark = "✅"
			}
			rows = append(rows, mark+" "+name+"："+count(v))
		default:
			rows = append(rows, "❌ "+name+"：没有结果")
		}
	}
	rows = append(rows, s.steamConnectivity(ctx, r.Group))
	var ck []string
	for _, src := range []string{"weibo", "tieba", "nga", "steam"} {
		state := "没填"
		if s.cfg.Cookies[src] != "" {
			state = "已填"
		}
		ck = append(ck, SrcName[src]+state)
	}
	cc := s.cfg.SteamCC
	if cc == "" {
		cc = "US"
	}
	rows = append(rows, "cookie："+strings.Join(ck, "，")+"（Steam 商店区："+cc+"）")
	return s.bot.Say(ctx, c.Conv.ID, strings.Join(rows, "\n"))
}

// steamConnectivity tests the Steam community (groups), news API and store.
func (s *Service) steamConnectivity(ctx context.Context, group string) string {
	if group == "" {
		group = "steamworks"
	}
	var out []string
	if _, err := s.fetch.groupRSS(ctx, group); err != nil {
		out = append(out, "社区❌（"+err.Error()+"）")
	} else {
		out = append(out, "社区✅")
	}
	if b, code, err := s.fetch.get(ctx, "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/", map[string][]string{"appid": {"570"}, "count": {"1"}, "format": {"json"}}, req{proxy: s.cfg.Proxy}); err != nil {
		out = append(out, "新闻接口❌（"+err.Error()+"）")
	} else if code != 200 || !strings.Contains(string(b), "appnews") {
		out = append(out, fmt.Sprintf("新闻接口❌（HTTP %d）", code))
	} else {
		out = append(out, "新闻接口✅")
	}
	if _, code, err := s.fetch.get(ctx, "https://store.steampowered.com/api/storesearch/", map[string][]string{"term": {"dota"}, "cc": {s.fetch.cc()}}, req{proxy: s.cfg.Proxy}); err != nil {
		out = append(out, "商店❌（"+err.Error()+"）")
	} else if code != 200 {
		out = append(out, fmt.Sprintf("商店❌（HTTP %d）", code))
	} else {
		out = append(out, "商店✅")
	}
	way := s.cfg.CommunityProxy
	switch strings.ToLower(way) {
	case "direct", "none", "直连":
		way = "直连"
	case "system", "系统":
		way = "系统代理"
	case "":
		way = s.cfg.Proxy
		if way == "" {
			way = "直连"
		}
	}
	return "🔌 Steam 连通性：" + strings.Join(out, "，") + "（社区走：" + way + "）"
}

func (s *Service) cmdKind(ctx context.Context, c *helper.Call) error {
	if err := s.off(); err != nil {
		return err
	}
	a := ParseKind(c.Args)
	kinds := map[string]*Kind{}
	s.load(ctx, "kinds", &kinds)
	if a.Kind == "" {
		if k := kinds[strings.ToLower(a.Name)]; a.Name != "" && k != nil {
			msg := "「" + a.Name + "」现在按" + kindName(k) + "搜"
			if k.Forced {
				msg += "（手动指定）"
			} else {
				msg += "（自动判断）"
			}
			if k.SteamName != "" {
				msg += "，Steam：" + k.SteamName
			} else {
				msg += "，Steam 上没对上游戏"
			}
			if k.Group != "" {
				msg += "，群组：" + k.Group
			}
			return s.reply(ctx, c, msg)
		}
		return helper.Said("用法：/资讯类型 <名字> 厂商 / 游戏 / 自动（自动判断错了时手动改，改完一直按这个搜）\n" +
			"厂商可以再加：群组:MangoParty（它的 Steam 群组，网址 groups/ 后面那段）、steam:123,456（指定游戏 appid）")
	}
	var alias []string
	if subs, err := s.st.NewsSubs(ctx, c.Conv.ID); err == nil {
		for _, sub := range subs {
			if strings.EqualFold(sub.Keyword, a.Name) {
				alias = sub.Alias
			}
		}
	}
	key := strings.ToLower(a.Name)
	if a.Kind == "auto" {
		delete(kinds, key)
		s.save(ctx, "kinds", kinds)
		r := s.resolve(ctx, a.Name, alias, 0)
		msg := "「" + a.Name + "」重新自动判断：按" + kindName(r) + "搜"
		if r.SteamName != "" {
			msg += "，Steam：" + r.SteamName
		}
		return s.reply(ctx, c, msg)
	}
	var r *Kind
	whyNot := ""
	if a.Kind == "game" {
		r = &Kind{Kind: "game"}
		if len(a.Apps) > 0 {
			r.Steam, r.SteamName = a.Apps[0], fmt.Sprintf("appid %d", a.Apps[0])
		} else if app, ok := s.fetch.FindApp(ctx, append([]string{a.Name}, alias...)); ok {
			r.Steam, r.SteamName = app.ID, app.Name
		}
	} else {
		en := ""
		for _, x := range alias {
			if IsASCII(x) {
				en = x
				break
			}
		}
		if en == "" {
			var d struct {
				EN string `json:"en"`
			}
			if s.ask(ctx, kindPrompt, a.Name, 100, &d) == nil {
				en = strings.TrimSpace(d.EN)
			}
		}
		var apps []App
		if len(a.Apps) > 0 {
			for _, id := range a.Apps {
				apps = append(apps, App{ID: id, Name: fmt.Sprintf("appid %d", id)})
			}
		} else {
			apps = s.fetch.CompanyApps(ctx, append([]string{en, a.Name}, alias...))
		}
		group := a.Group
		if group != "" {
			if _, err := s.fetch.groupRSS(ctx, group); err != nil {
				hint := "检查一下群组名（steamcommunity.com/groups/ 后面那段）"
				if !errors.Is(err, errNotFeed) {
					hint = "服务器连不上 Steam 社区：在 config.toml 的 [news] 里设 steam_community_proxy（比如开了加速器就写 direct）"
				}
				return helper.Said("群组「" + group + "」的公告读不到：" + err.Error() + "。" + hint + "。原来的设置没动")
			}
		} else {
			group, whyNot = s.fetch.FindGroup(ctx, append([]string{en, a.Name}, alias...))
		}
		names := []string{}
		for _, x := range apps[:min(3, len(apps))] {
			names = append(names, x.Name)
		}
		r = &Kind{Kind: "company", Apps: apps, EN: en, Group: group, GroupAt: s.now().Unix(), SteamName: strings.Join(names, "、")}
	}
	r.At, r.Forced = s.now().Unix(), true
	kinds[key] = r
	s.save(ctx, "kinds", kinds)
	tip := ""
	why := ""
	if whyNot != "" {
		why = "（" + whyNot + "）"
	}
	switch {
	case r.Kind == "company" && !r.hasSteam() && r.Group == "":
		tip = "。Steam 上没找到它的游戏和群组" + why + "：可以手动加 群组:xxx（它的 Steam 群组网址 groups/ 后面那段），或者 steam:123,456 指定几款游戏"
	case r.Kind == "company" && r.Group == "":
		tip = "。没找到它的 Steam 群组" + why + "，有的话可以加 群组:xxx，新作和促销公告就能看到"
	case r.Kind == "game" && !r.hasSteam():
		tip = "。Steam 上没对上这个游戏（不在 Steam，或者要用英文名：/关注游戏 名字|英文名；也可以加 steam:appid）"
	}
	msg := "好，「" + a.Name + "」以后按" + kindName(r) + "搜"
	if r.SteamName != "" {
		msg += "，Steam 游戏：" + r.SteamName
	}
	if r.Group != "" {
		msg += "，群组公告：" + r.Group
	}
	return s.reply(ctx, c, msg+tip)
}

func (s *Service) cmdWeekly(ctx context.Context, c *helper.Call) error {
	if err := s.off(); err != nil {
		return err
	}
	if !s.cfg.WeeklyAnyone && !c.User.IsSiteAdmin {
		return helper.Said("X 周报按次收费，只有站点管理员能手动发（每周会自动发一次）")
	}
	if s.cfg.XAIKey == "" {
		return helper.Said("没配置 xAI key，X 周报用不了")
	}
	subs, err := s.st.NewsSubs(ctx, c.Conv.ID)
	if err != nil {
		return err
	}
	type pair struct {
		kw    string
		alias []string
	}
	var pairs []pair
	if kw := strings.TrimSpace(c.Args); kw != "" {
		p := pair{kw: kw}
		for _, sub := range subs {
			if sub.Keyword == kw {
				p.alias = sub.Alias
			}
		}
		pairs = append(pairs, p)
	} else {
		for _, sub := range subs {
			pairs = append(pairs, pair{sub.Keyword, sub.Alias})
		}
	}
	if len(pairs) == 0 {
		return helper.Said("用法：/周报 <关键词>")
	}
	if err := s.reply(ctx, c, fmt.Sprintf("正在用 X 搜本周动态（按帖子收费，每个关键词约 0.3 美元），大约半分钟…")); err != nil {
		return err
	}
	for _, p := range pairs {
		if err := s.bot.Say(ctx, c.Conv.ID, "📰【"+p.kw+"】本周 X（推特）圈内动态\n"+s.xWeekly(ctx, p.kw, p.alias)); err != nil {
			return err
		}
	}
	return nil
}
