package news

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/encoding/simplifiedchinese"
)

const (
	ua  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
	mua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	// Steam's age gate, so adult-only games show up in searches.
	ageCookie = "birthtime=470682001; lastagecheckage=1-0-1985; wants_mature_content=1; mature_content=1"
	maxBody   = 8 << 20
)

// Fetcher reads the sites.
type Fetcher struct {
	// Proxy for overseas sites (Google, Reddit, YouTube, Steam): "" = direct.
	Proxy string
	// CommunityProxy for steamcommunity.com: "" = like Proxy, "direct", "system" (environment), or a URL.
	CommunityProxy string
	// Cookies per source (weibo, tieba, nga, bili, steam).
	Cookies map[string]string
	// SteamCC: the Steam store region for searches (US shows adult-only games).
	SteamCC string
	// Rewrite changes every URL before it is fetched (tests point the sites at a fake server).
	Rewrite func(string) string
	Now     func() time.Time
}

type req struct {
	proxy   string // "", "direct", "system" or a URL
	ua      string
	cookie  string
	referer string
	header  map[string]string
	jar     http.CookieJar
	method  string
	body    []byte
	timeout time.Duration
}

func (f *Fetcher) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func (f *Fetcher) cookie(src string) string { return f.Cookies[src] }

// get fetches a URL (query q added) and returns the body.
func (f *Fetcher) get(ctx context.Context, raw string, q url.Values, r req) ([]byte, int, error) {
	if len(q) > 0 {
		raw += "?" + q.Encode()
	}
	if f.Rewrite != nil {
		raw = f.Rewrite(raw)
	}
	method := r.method
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	if r.body != nil {
		body = bytes.NewReader(r.body)
	}
	hr, err := http.NewRequestWithContext(ctx, method, raw, body)
	if err != nil {
		return nil, 0, err
	}
	agent := r.ua
	if agent == "" {
		agent = ua
	}
	hr.Header.Set("User-Agent", agent)
	hr.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6")
	if r.cookie != "" {
		hr.Header.Set("Cookie", r.cookie)
	}
	if r.referer != "" {
		hr.Header.Set("Referer", r.referer)
	}
	for k, v := range r.header {
		hr.Header.Set(k, v)
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	switch p := strings.TrimSpace(r.proxy); strings.ToLower(p) {
	case "", "direct", "none", "直连":
		tr.Proxy = nil
	case "system", "系统":
		tr.Proxy = http.ProxyFromEnvironment
	default:
		u, err := url.Parse(p)
		if err != nil {
			return nil, 0, fmt.Errorf("代理地址不对：%s", p)
		}
		tr.Proxy = http.ProxyURL(u)
	}
	timeout := r.timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	c := &http.Client{Transport: tr, Timeout: timeout, Jar: r.jar}
	res, err := c.Do(hr)
	if err != nil {
		return nil, 0, errors.New(why(err))
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, maxBody))
	return b, res.StatusCode, err
}

// why says what went wrong with a connection in words.
func why(err error) string {
	t := err.Error()
	switch {
	case strings.Contains(strings.ToLower(t), "certificate") || strings.Contains(t, "x509"):
		return "证书不被信任"
	case strings.Contains(t, "Timeout") || strings.Contains(t, "deadline exceeded"):
		return "连接超时"
	case strings.Contains(t, "connection refused") || strings.Contains(t, "no such host") || strings.Contains(t, "proxyconnect"):
		return "连不上（" + cut(t, 80) + "）"
	case strings.Contains(t, "EOF") || strings.Contains(t, "reset"):
		return "连接被对方关闭"
	}
	return cut(t, 100)
}

func (f *Fetcher) getJSON(ctx context.Context, raw string, q url.Values, r req, v any) (int, error) {
	b, code, err := f.get(ctx, raw, q, r)
	if err != nil {
		return code, err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return code, fmt.Errorf("HTTP %d，返回的不是 JSON", code)
	}
	return code, nil
}

// flexNum reads a number that may come as a string.
type flexNum float64

func (n *flexNum) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if v, err := strconv.ParseFloat(s, 64); err == nil {
		*n = flexNum(v)
	} else {
		*n = flexNum(Num(s))
	}
	return nil
}

// ---- the sources ----

// Bili: B站 videos of the last days, by plays.
func (f *Fetcher) Bili(ctx context.Context, q string, days float64) ([]Item, error) {
	now := f.now().Unix()
	jar, _ := cookiejar.New(nil)
	r := req{cookie: f.cookie("bili"), referer: "https://www.bilibili.com/", jar: jar}
	if r.cookie == "" {
		_, _, _ = f.get(ctx, "https://www.bilibili.com/", nil, r) // a guest cookie
	}
	var d struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Data    struct {
			Result []struct {
				Title   string  `json:"title"`
				Bvid    string  `json:"bvid"`
				Play    flexNum `json:"play"`
				Pubdate int64   `json:"pubdate"`
			} `json:"result"`
		} `json:"data"`
	}
	if _, err := f.getJSON(ctx, "https://api.bilibili.com/x/web-interface/search/type", url.Values{
		"search_type": {"video"}, "keyword": {q}, "order": {"click"},
		"pubtime_begin_s": {strconv.FormatInt(now-int64(max(days, 2)*86400), 10)}, "pubtime_end_s": {strconv.FormatInt(now, 10)},
	}, r, &d); err != nil {
		return nil, err
	}
	if d.Code != 0 {
		return nil, fmt.Errorf("B站返回 %d %s", d.Code, d.Message)
	}
	var out []Item
	for _, x := range d.Data.Result {
		out = append(out, newItem("bili", x.Title, "https://www.bilibili.com/video/"+x.Bvid, float64(x.Play), true, false, x.Pubdate))
	}
	return out, nil
}

// GNews: Google News in simplified (mainland) and traditional (Taiwan) Chinese.
func (f *Fetcher) GNews(ctx context.Context, q string, days float64) ([]Item, error) {
	var out []Item
	seen := map[string]bool{}
	var firstErr error
	for _, v := range [][3]string{{"zh-CN", "CN", "CN:zh-Hans"}, {"zh-TW", "TW", "TW:zh-Hant"}} {
		b, _, err := f.get(ctx, "https://news.google.com/rss/search", url.Values{
			"q": {fmt.Sprintf("%s when:%dd", q, max(1, int(days)))}, "hl": {v[0]}, "gl": {v[1]}, "ceid": {v[2]}}, req{proxy: f.Proxy})
		if err != nil {
			firstErr = err
			continue
		}
		for _, it := range ParseRSS(string(b), days, f.now()) {
			if !seen[it.Link] {
				seen[it.Link] = true
				out = append(out, newItem("news", it.Title, it.Link, 0, false, false, it.TS))
			}
		}
	}
	if len(out) == 0 && firstErr != nil {
		return nil, firstErr
	}
	return out, nil
}

// Bing news (RSS), with Bing's redirect taken off the links.
func (f *Fetcher) Bing(ctx context.Context, q string, days float64) ([]Item, error) {
	b, _, err := f.get(ctx, "https://www.bing.com/news/search", url.Values{"q": {q}, "format": {"rss"}, "setlang": {"zh-cn"}}, req{proxy: f.Proxy})
	if err != nil {
		return nil, err
	}
	var out []Item
	for _, it := range ParseRSS(string(b), days, f.now()) {
		link := it.Link
		if u, err := url.Parse(link); err == nil && u.Query().Get("url") != "" {
			link = u.Query().Get("url")
		}
		out = append(out, newItem("bing", it.Title, link, 0, false, false, it.TS))
	}
	return out, nil
}

var (
	reEntry   = regexp.MustCompile(`(?s)<entry>(.*?)</entry>`)
	reHref    = regexp.MustCompile(`<link href="(.*?)"`)
	reUpdated = regexp.MustCompile(`<updated>(.*?)</updated>`)
)

// Reddit: top posts (JSON; the RSS feed without votes when JSON is refused).
func (f *Fetcher) Reddit(ctx context.Context, q string, days float64) ([]Item, error) {
	t := "month"
	if days <= 1 {
		t = "day"
	} else if days <= 7 {
		t = "week"
	}
	var d struct {
		Data struct {
			Children []struct {
				Data struct {
					Title       string  `json:"title"`
					Permalink   string  `json:"permalink"`
					Ups         float64 `json:"ups"`
					NumComments float64 `json:"num_comments"`
					Created     float64 `json:"created_utc"`
				} `json:"data"`
			} `json:"children"`
		} `json:"data"`
	}
	code, err := f.getJSON(ctx, "https://www.reddit.com/search.json", url.Values{"q": {q}, "sort": {"top"}, "t": {t}, "limit": {"25"}}, req{proxy: f.Proxy, ua: "am-news/1.0"}, &d)
	if err == nil && code == http.StatusOK {
		var out []Item
		for _, c := range d.Data.Children {
			x := c.Data
			out = append(out, newItem("reddit", x.Title, "https://www.reddit.com"+x.Permalink, x.Ups+2*x.NumComments, true, false, int64(x.Created)))
		}
		return out, nil
	}
	b, code2, err2 := f.get(ctx, "https://www.reddit.com/search.rss", url.Values{"q": {q}, "sort": {"top"}, "t": {t}}, req{proxy: f.Proxy})
	if err2 != nil {
		return nil, err2
	}
	if code2 != http.StatusOK {
		return nil, fmt.Errorf("Reddit HTTP %d/%d", code, code2)
	}
	var out []Item
	for i, e := range reEntry.FindAllStringSubmatch(string(b), -1) {
		if i == 20 {
			break
		}
		tt, lk := reTitle.FindStringSubmatch(e[1]), reHref.FindStringSubmatch(e[1])
		if tt == nil || lk == nil {
			continue
		}
		var ts int64
		if up := reUpdated.FindStringSubmatch(e[1]); up != nil {
			if d, err := time.Parse(time.RFC3339, up[1]); err == nil {
				ts = d.Unix()
			}
		}
		out = append(out, newItem("reddit", html.UnescapeString(tt[1]), lk[1], 0, false, false, ts))
	}
	return out, nil
}

var reYT = regexp.MustCompile(`(?s)var ytInitialData = (\{.*?\});</script>`)

// YouTube: the search page (this week / month), views and dates from ytInitialData.
func (f *Fetcher) YouTube(ctx context.Context, q string, days float64) ([]Item, error) {
	sp := "EgIIAw=="
	if days > 7 {
		sp = "EgIIBA=="
	}
	b, _, err := f.get(ctx, "https://www.youtube.com/results", url.Values{"search_query": {q}, "sp": {sp}}, req{proxy: f.Proxy})
	if err != nil {
		return nil, err
	}
	m := reYT.FindSubmatch(b)
	if m == nil {
		return nil, errors.New("页面里没找到 ytInitialData（可能被要求同意 cookie / 验证）")
	}
	var root any
	if err := json.Unmarshal(m[1], &root); err != nil {
		return nil, err
	}
	var out []Item
	now := f.now()
	var walk func(any)
	walk = func(o any) {
		switch v := o.(type) {
		case map[string]any:
			if vr, ok := v["videoRenderer"].(map[string]any); ok {
				if id, _ := vr["videoId"].(string); id != "" {
					title := ""
					if t, ok := vr["title"].(map[string]any); ok {
						if runs, ok := t["runs"].([]any); ok {
							for _, r := range runs {
								if rm, ok := r.(map[string]any); ok {
									s, _ := rm["text"].(string)
									title += s
								}
							}
						}
					}
					views, when := simpleText(vr["viewCountText"]), simpleText(vr["publishedTimeText"])
					out = append(out, newItem("youtube", title, "https://www.youtube.com/watch?v="+id, Num(views), true, false, Ago(when, now)))
				}
			}
			for _, x := range v {
				walk(x)
			}
		case []any:
			for _, x := range v {
				walk(x)
			}
		}
	}
	walk(root)
	return out, nil
}

func simpleText(o any) string {
	if m, ok := o.(map[string]any); ok {
		s, _ := m["simpleText"].(string)
		return s
	}
	return ""
}

// SteamNews: Steam's news for a game (official posts and media reports it
// collects), the announcements RSS when the API can't be reached.
func (f *Fetcher) SteamNews(ctx context.Context, appid int64, days float64, label string) ([]Item, error) {
	var d struct {
		AppNews struct {
			NewsItems []struct {
				Title     string `json:"title"`
				URL       string `json:"url"`
				Contents  string `json:"contents"`
				FeedLabel string `json:"feedlabel"`
				FeedName  string `json:"feedname"`
				FeedType  int    `json:"feed_type"`
				Date      int64  `json:"date"`
			} `json:"newsitems"`
		} `json:"appnews"`
	}
	pre := ""
	if label != "" {
		pre = "《" + label + "》"
	}
	now := f.now().Unix()
	if _, err := f.getJSON(ctx, "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/", url.Values{
		"appid": {strconv.FormatInt(appid, 10)}, "count": {"30"}, "maxlength": {"800"}, "format": {"json"}}, req{proxy: f.Proxy}, &d); err != nil {
		b, _, err2 := f.get(ctx, fmt.Sprintf("https://store.steampowered.com/feeds/news/app/%d/", appid), url.Values{"l": {"schinese"}}, req{proxy: f.Proxy})
		if err2 != nil {
			return nil, err
		}
		var out []Item
		for _, it := range ParseRSS(string(b), max(days, 4), f.now()) {
			out = append(out, newItem("steam", pre+it.Title, it.Link, 0, false, true, it.TS))
			if len(out) == 6 {
				break
			}
		}
		return out, nil
	}
	var out []Item
	for _, n := range d.AppNews.NewsItems {
		if n.Date == 0 || float64(now-n.Date) > max(days, 4)*86400 {
			continue
		}
		official := n.FeedName == "steam_community_announcements" || n.FeedType == 1
		src := "steamnews"
		if official {
			src = "steam"
		}
		it := newItem(src, pre+n.Title, n.URL, 0, false, official, n.Date)
		if !official {
			it.Body = cut(Plain(n.Contents), 400)
			it.Feed = n.FeedLabel
		}
		out = append(out, it)
		if len(out) == 12 {
			break
		}
	}
	return out, nil
}

// groupRSS reads a Steam group's announcements feed.
func (f *Fetcher) groupRSS(ctx context.Context, group string) (string, error) {
	proxy := f.CommunityProxy
	if proxy == "" {
		proxy = f.Proxy
	}
	b, code, err := f.get(ctx, "https://steamcommunity.com/groups/"+url.PathEscape(group)+"/rss/", nil, req{proxy: proxy})
	if err != nil {
		return "", err
	}
	if code != http.StatusOK {
		return "", fmt.Errorf("HTTP %d", code)
	}
	if !strings.Contains(string(b[:min(500, len(b))]), "<rss") {
		return "", errNotFeed
	}
	return string(b), nil
}

var errNotFeed = errors.New("返回的是网页不是公告（群组名不对，或者被要求验证）")

// SteamGroup: a company's own Steam group announcements (new games, sales, events).
func (f *Fetcher) SteamGroup(ctx context.Context, group string, days float64) ([]Item, error) {
	text, err := f.groupRSS(ctx, group)
	if err != nil {
		return nil, fmt.Errorf("群组 %s 的公告读不到：%w", group, err)
	}
	var out []Item
	for _, it := range ParseRSS(text, max(days, 4), f.now()) {
		i := newItem("steam", it.Title, it.Link, 0, false, true, it.TS)
		i.Feed = "群组公告"
		if it.Desc != "" {
			i.Body = cut(Plain(it.Desc), 400)
		}
		out = append(out, i)
		if len(out) == 10 {
			break
		}
	}
	return out, nil
}

// FindGroup guesses a company's Steam group from its English names ("" = none; why says what went wrong).
func (f *Fetcher) FindGroup(ctx context.Context, names []string) (group, whyNot string) {
	var reasons []string
	for _, g := range GroupCandidates(names) {
		_, err := f.groupRSS(ctx, g)
		if err == nil {
			return g, ""
		}
		reasons = append(reasons, g+"："+err.Error())
		if !errors.Is(err, errNotFeed) {
			break // the network itself doesn't work: no use trying the others
		}
	}
	if len(reasons) > 3 {
		reasons = reasons[:3]
	}
	return "", strings.Join(reasons, "；")
}

func (f *Fetcher) cc() string {
	if f.SteamCC == "" {
		return "US"
	}
	return f.SteamCC
}

func (f *Fetcher) steamCookie() string {
	if c := f.cookie("steam"); c != "" {
		return c + "; " + ageCookie
	}
	return ageCookie
}

var reStoreApp = regexp.MustCompile(`(?s)data-ds-appid="(\d+)".*?<span class="title">(.*?)</span>`)

// App is a Steam game.
type App struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// CompanyApps finds a developer's / publisher's games on Steam (newest first, at most 5).
func (f *Fetcher) CompanyApps(ctx context.Context, names []string) []App {
	r := req{proxy: f.Proxy, cookie: f.steamCookie(), referer: "https://store.steampowered.com/"}
	for _, field := range []string{"developer", "publisher"} {
		for _, name := range names {
			if name == "" {
				continue
			}
			var d struct {
				HTML string `json:"results_html"`
			}
			if _, err := f.getJSON(ctx, "https://store.steampowered.com/search/results/", url.Values{
				"term": {""}, field: {name}, "infinite": {"1"}, "count": {"20"}, "sort_by": {"Released_DESC"},
				"category1": {"998"}, "cc": {f.cc()}, "l": {"schinese"}}, r, &d); err != nil {
				continue
			}
			var out []App
			seen := map[int64]bool{}
			for _, m := range reStoreApp.FindAllStringSubmatch(d.HTML, -1) {
				id, _ := strconv.ParseInt(m[1], 10, 64)
				if !seen[id] {
					seen[id] = true
					out = append(out, App{ID: id, Name: html.UnescapeString(m[2])})
				}
			}
			if len(out) > 0 {
				return out[:min(5, len(out))]
			}
		}
	}
	return nil
}

var reNameSplit = regexp.MustCompile(`\s*/\s*`)

// FindApp finds a game on Steam by name (the name has to match, so a
// soundtrack doesn't count).
func (f *Fetcher) FindApp(ctx context.Context, terms []string) (App, bool) {
	r := req{proxy: f.Proxy, cookie: f.steamCookie(), referer: "https://store.steampowered.com/"}
	for _, t := range terms {
		var d struct {
			Items []App `json:"items"`
		}
		if _, err := f.getJSON(ctx, "https://store.steampowered.com/api/storesearch/", url.Values{"term": {t}, "l": {"schinese"}, "cc": {f.cc()}}, r, &d); err != nil {
			continue
		}
		nt := Norm(t)
		for i, it := range d.Items {
			if i == 5 || nt == "" {
				break
			}
			for _, n := range reNameSplit.Split(it.Name, -1) {
				n = Norm(n)
				if nt == n || (len([]rune(nt)) >= 3 && strings.Contains(n, nt) && !strings.Contains(n, "soundtrack") && !strings.Contains(n, "原声")) {
					return it, true
				}
			}
		}
	}
	return App{}, false
}

// Weibo search (m.weibo.cn, newest first); posts without a readable date are skipped.
func (f *Fetcher) Weibo(ctx context.Context, q string, days float64) ([]Item, error) {
	var d struct {
		OK   int    `json:"ok"`
		Msg  string `json:"msg"`
		Data struct {
			Cards []json.RawMessage `json:"cards"`
		} `json:"data"`
	}
	if _, err := f.getJSON(ctx, "https://m.weibo.cn/api/container/getIndex", url.Values{
		"containerid": {"100103type=61&q=" + q}, "page_type": {"searchall"}}, req{ua: mua, cookie: f.cookie("weibo"), referer: "https://m.weibo.cn/"}, &d); err != nil {
		return nil, err
	}
	if d.OK != 1 {
		return nil, fmt.Errorf("微博返回 ok=%d %s（可能要填 weibo cookie）", d.OK, cut(d.Msg, 40))
	}
	type mblog struct {
		ID        string  `json:"id"`
		Text      string  `json:"text"`
		CreatedAt string  `json:"created_at"`
		Likes     float64 `json:"attitudes_count"`
		Comments  float64 `json:"comments_count"`
		Reposts   float64 `json:"reposts_count"`
	}
	type card struct {
		Mblog *mblog `json:"mblog"`
		Group []card `json:"card_group"`
	}
	now := f.now()
	var out []Item
	for _, raw := range d.Data.Cards {
		var c card
		if json.Unmarshal(raw, &c) != nil {
			continue
		}
		group := c.Group
		if len(group) == 0 {
			group = []card{c}
		}
		for _, g := range group {
			mb := g.Mblog
			if mb == nil {
				continue
			}
			ts := WeiboTime(mb.CreatedAt, now)
			if ts == 0 || float64(now.Unix()-ts) > days*86400 {
				continue
			}
			out = append(out, newItem("weibo", mb.Text, "https://m.weibo.cn/detail/"+mb.ID, mb.Likes+2*mb.Comments+3*mb.Reposts, true, false, ts))
		}
	}
	return out, nil
}

var (
	reTiebaLi    = regexp.MustCompile(`(?s)<li class=" j_thread_list[^"]*"(.*?)</li>`)
	reTiebaField = regexp.MustCompile(`(?s)data-field='(.*?)'`)
	reTiebaLink  = regexp.MustCompile(`href="/p/(\d+)"[^>]*title="([^"]*)"`)
	reTiebaTime  = regexp.MustCompile(`is_show_create_time"[^>]*>\s*([^<]+?)\s*<`)
)

// Tieba: the bar (named like the keyword), new threads by replies.
func (f *Fetcher) Tieba(ctx context.Context, bar string, days float64) ([]Item, error) {
	b, code, err := f.get(ctx, "https://tieba.baidu.com/f", url.Values{"kw": {bar}, "ie": {"utf-8"}, "pn": {"0"}}, req{cookie: f.cookie("tieba"), referer: "https://tieba.baidu.com/"})
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("贴吧 HTTP %d（可能要填 tieba cookie）", code)
	}
	text := string(b)
	if !strings.Contains(text, "j_thread_list") {
		return nil, errors.New("贴吧页面里没有帖子列表（吧不存在 / 要验证 / 要填 tieba cookie）")
	}
	now := f.now()
	var out []Item
	blocks := reTiebaLi.FindAllStringSubmatch(text, 50)
	dated := 0
	for _, m := range blocks {
		block := m[1]
		tl := reTiebaLink.FindStringSubmatch(block)
		if tl == nil || strings.Contains(block[:min(400, len(block))], "置顶") {
			continue
		}
		var ts int64
		if ct := reTiebaTime.FindStringSubmatch(block); ct != nil {
			ts = TiebaTime(ct[1], now)
		}
		if ts != 0 {
			dated++
		}
		if ts == 0 || float64(now.Unix()-ts) > days*86400 {
			continue
		}
		var reply float64
		if df := reTiebaField.FindStringSubmatch(block); df != nil {
			var x struct {
				Reply float64 `json:"reply_num"`
			}
			if json.Unmarshal([]byte(html.UnescapeString(df[1])), &x) == nil {
				reply = x.Reply
			}
		}
		out = append(out, newItem("tieba", html.UnescapeString(tl[2]), "https://tieba.baidu.com/p/"+tl[1], reply, true, false, ts))
	}
	if len(blocks) > 0 && dated == 0 {
		return nil, errors.New("贴吧帖子列表里找不到发帖时间（页面改版了？），为了不推旧帖先跳过")
	}
	return out, nil
}

var reNGA = regexp.MustCompile(`(?s)=\s*(\{.*\})`)

// NGA forum search (needs a logged-in cookie).
func (f *Fetcher) NGA(ctx context.Context, q string, days float64) ([]Item, error) {
	if f.cookie("nga") == "" {
		return nil, errors.New("没填 nga cookie（NGA 必须登录）")
	}
	b, _, err := f.get(ctx, "https://bbs.nga.cn/thread.php", url.Values{"key": {q}, "lite": {"js"}}, req{cookie: f.cookie("nga"), referer: "https://bbs.nga.cn/"})
	if err != nil {
		return nil, err
	}
	if u, err := simplifiedchinese.GBK.NewDecoder().Bytes(b); err == nil {
		b = u
	}
	m := reNGA.FindSubmatch(b)
	if m == nil {
		return nil, errors.New("NGA 返回格式不对")
	}
	var d struct {
		Error map[string]any `json:"error"`
		Data  struct {
			T json.RawMessage `json:"__T"`
		} `json:"data"`
	}
	if err := json.Unmarshal(m[1], &d); err != nil {
		return nil, errors.New("NGA 返回格式不对")
	}
	for _, v := range d.Error {
		return nil, fmt.Errorf("NGA 报错：%v（cookie 可能过期）", v)
	}
	type thread struct {
		Subject  string  `json:"subject"`
		Tid      flexNum `json:"tid"`
		Replies  flexNum `json:"replies"`
		PostDate flexNum `json:"postdate"`
	}
	var list []thread
	var byKey map[string]thread
	if json.Unmarshal(d.Data.T, &byKey) == nil {
		keys := make([]string, 0, len(byKey))
		for k := range byKey {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			list = append(list, byKey[k])
		}
	} else {
		_ = json.Unmarshal(d.Data.T, &list)
	}
	now := f.now().Unix()
	var out []Item
	for _, t := range list {
		ts := int64(t.PostDate)
		if ts == 0 || float64(now-ts) > days*86400 {
			continue
		}
		out = append(out, newItem("nga", t.Subject, fmt.Sprintf("https://bbs.nga.cn/read.php?tid=%d", int64(t.Tid)), float64(t.Replies), true, false, ts))
	}
	return out, nil
}
