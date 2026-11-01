package news

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

var cst = time.FixedZone("CST", 8*3600)
var now = time.Date(2026, 10, 20, 15, 0, 0, 0, cst)

func TestParse(t *testing.T) {
	if Num("1.2万次观看") != 12000 || Num("3,456 views") != 3456 || Num("1.5K") != 1500 || Num("abc") != 0 {
		t.Fatal("Num")
	}
	if got := Ago("Streamed 5 hours ago", now); got != now.Unix()-5*3600 {
		t.Fatal("Ago", got)
	}
	if Ago("昨天", now) != 0 {
		t.Fatal("Ago without a number")
	}
	if Clean("<b>Hi</b> &amp;  there\n") != "Hi & there" {
		t.Fatal("Clean")
	}
	if Plain("[h1]Patch[/h1] notes https://x.y/z <br>{STEAM_CLAN_IMAGE}/a.png done") != "Patch notes done" {
		t.Fatal("Plain", Plain("[h1]Patch[/h1] notes https://x.y/z <br>{STEAM_CLAN_IMAGE}/a.png done"))
	}
	rss := `<rss><item><title><![CDATA[New &amp; patch]]></title><link>https://a/1</link><pubDate>Mon, 19 Oct 2026 10:00:00 +0800</pubDate><description>&lt;p&gt;body&lt;/p&gt;</description></item>
<item><title>Old</title><link>https://a/2</link><pubDate>Mon, 01 Jan 2024 10:00:00 +0800</pubDate></item>
<item><title>No date</title><link>https://a/3</link></item></rss>`
	got := ParseRSS(rss, 3, now)
	if len(got) != 2 || got[0].Title != "New & patch" || got[0].Desc != "<p>body</p>" || got[0].TS == 0 || got[1].Title != "No date" {
		t.Fatalf("ParseRSS %+v", got)
	}
	if WeiboTime("Mon Oct 19 12:00:00 +0800 2026", now) != time.Date(2026, 10, 19, 12, 0, 0, 0, cst).Unix() {
		t.Fatal("WeiboTime full")
	}
	if WeiboTime("刚刚", now) != now.Unix() || WeiboTime("5分钟前", now) != now.Unix()-300 {
		t.Fatal("WeiboTime ago")
	}
	if WeiboTime("昨天 12:00", now) != time.Date(2026, 10, 19, 0, 0, 0, 0, cst).Unix() || WeiboTime("10-12", now) != time.Date(2026, 10, 12, 0, 0, 0, 0, cst).Unix() {
		t.Fatal("WeiboTime days")
	}
	if TiebaTime("12:34", now) != time.Date(2026, 10, 20, 12, 34, 0, 0, cst).Unix() || TiebaTime("12-30", now) != time.Date(2025, 12, 30, 0, 0, 0, 0, cst).Unix() || TiebaTime("2024-05", now) != time.Date(2024, 5, 1, 0, 0, 0, 0, cst).Unix() || TiebaTime("?", now) != 0 {
		t.Fatal("TiebaTime")
	}
	if MD(time.Date(2026, 3, 4, 1, 0, 0, 0, cst).Unix(), now) != "03-04" || MD(time.Date(2024, 3, 4, 1, 0, 0, 0, cst).Unix(), now) != "2024-03-04" || MD(0, now) != "" {
		t.Fatal("MD")
	}
	if Norm("Dota 2: The-Game!") != "dota2thegame" {
		t.Fatal("Norm")
	}
	if c := GroupCandidates([]string{"Mango Party", "芒果派对"}); !reflect.DeepEqual(c, []string{"MangoParty", "Mango_Party", "Mango-Party", "mangoparty"}) {
		t.Fatal("GroupCandidates", c)
	}
	kw, alias, steam := ParseFollow("dota2|刀塔 / DOTA steam:570")
	if kw != "dota2" || !reflect.DeepEqual(alias, []string{"刀塔", "DOTA"}) || steam != 570 {
		t.Fatal("ParseFollow", kw, alias, steam)
	}
	k := ParseKind("芒果派对 厂商 群组:https://steamcommunity.com/groups/MangoParty/ steam:1,2")
	if k.Name != "芒果派对" || k.Kind != "company" || k.Group != "MangoParty" || !reflect.DeepEqual(k.Apps, []int64{1, 2}) {
		t.Fatalf("ParseKind %+v", k)
	}
	if k := ParseKind("dota2"); k.Name != "dota2" || k.Kind != "" {
		t.Fatalf("ParseKind show %+v", k)
	}
	if h, m, err := HM("21：30"); h != 21 || m != 30 || err != nil {
		t.Fatal("HM")
	}
	if _, _, err := HM("25:00"); err == nil {
		t.Fatal("HM range")
	}
	if d, err := Weekday("Sunday"); d != time.Sunday || err != nil {
		t.Fatal("Weekday")
	}
}

func TestRank(t *testing.T) {
	items := []Item{
		{Src: "bili", Title: "a", Heat: 10, HasHeat: true},
		{Src: "bili", Title: "b", Heat: 30, HasHeat: true},
		{Src: "bili", Title: "c", Heat: 20, HasHeat: true},
		{Src: "news", Title: "d"},
		{Src: "steam", Title: "e", Official: true},
		{Src: "reddit", Title: "f", Heat: 1, HasHeat: true},
		{Src: "reddit", Title: "g", Heat: 2, HasHeat: true},
	}
	got := Rank(items, 1)
	var titles []string
	for _, i := range got {
		titles = append(titles, i.Title)
	}
	if !reflect.DeepEqual(titles, []string{"b", "c", "d", "e", "g"}) {
		t.Fatal("Rank keep", titles)
	}
	if got[0].H != 1 || got[1].H != 0.667 || got[2].H != 0.5 || got[3].H != 1 {
		t.Fatalf("Rank heat %+v", got)
	}

	ev := []AIEvent{
		{Title: "大版本更新", Items: []int{1, 2, 99}, Type: "official_update", Major: true},
		{Title: "广告", Items: []int{3}, Type: "ad"},
		{Title: "官方促销", Items: []int{4}, Type: "ad"},
		{Title: "又是它", Items: []int{1}, Type: "meme"},
		{Title: "", Items: []int{5}, Type: "meme"},
	}
	src := []Item{
		{Src: "bili", Title: "x", URL: "u1", H: 0.9, TS: now.Unix() - 3600},
		{Src: "weibo", Title: "y", URL: "u2", H: 0.4},
		{Src: "bili", Title: "z", URL: "u3", H: 0.5},
		{Src: "steam", Title: "sale", URL: "u4", H: 1, Official: true},
		{Src: "nga", Title: "w", URL: "u5", H: 0.2},
	}
	got2 := BuildEvents(src, ev)
	if len(got2) != 2 || got2[0].Title != "大版本更新" || got2[1].Type != "official_update" {
		t.Fatalf("BuildEvents %+v", got2)
	}
	e := got2[0]
	if !reflect.DeepEqual(e.Platforms, []string{"B站", "微博"}) || e.N != 2 || e.URL != "u1" || e.MaxH != 0.9 || e.Score != Score(e) {
		t.Fatalf("event %+v", e)
	}
	if !Urgent(e, now) {
		t.Fatal("should be urgent (2 platforms, major)")
	}
	e.TS = now.Unix() - 8*86400
	if Urgent(e, now) {
		t.Fatal("old news is not urgent")
	}
	if Urgent(Event{Major: true, Type: "meme", Official: true}, now) {
		t.Fatal("memes are not urgent")
	}

	var many []Event
	for i := 0; i < 6; i++ {
		many = append(many, Event{Title: "b", Platforms: []string{"B站"}, Score: float64(20 - i)})
	}
	many = append(many, Event{Title: "w", Platforms: []string{"微博"}, Score: 1})
	pick := PickDigest(many, 4)
	if len(pick) != 3 || pick[2].Title != "w" {
		t.Fatalf("PickDigest %+v", pick)
	}

	merged := MergeGroups([]Event{
		{Title: "a1", Platforms: []string{"B站"}, N: 2, MaxH: 0.5, Score: 5},
		{Title: "a2", Platforms: []string{"微博"}, N: 3, MaxH: 0.9, Major: true, Score: 9},
		{Title: "b", Platforms: []string{"NGA"}, N: 1, Score: 3},
	}, []AIGroup{{Title: "A 事件", Items: []int{1, 2, 2}}})
	if len(merged) != 2 || merged[0].Title != "A 事件" || merged[0].N != 5 || !merged[0].Major || len(merged[0].Platforms) != 2 || merged[1].Title != "b" {
		t.Fatalf("MergeGroups %+v", merged)
	}

	line := FormatEvent(Event{Title: "T", Type: "esports", Platforms: []string{"B站", "微博"}, N: 3, Score: 15, URL: "u", TS: now.Unix(), Summary: "S"}, now)
	if line != "🏆 T\n   🔥🔥🔥 B站·微博｜3 条｜10-20\n   📝 S\n   u" {
		t.Fatalf("FormatEvent %q", line)
	}
	if s := FormatSteam(Item{Title: "Update", Zh: "更新", Official: true, URL: "u", TS: now.Unix()}, now); s != "• 〔10-20〕更新｜官方\n   u" {
		t.Fatalf("FormatSteam %q", s)
	}
	lines := ClusterLines([]Item{{Src: "steamnews", Feed: "PC Gamer", Title: "T", H: 0.5, Body: strings.Repeat("字", 300)}}, now)
	if !strings.HasPrefix(lines, "1. [Steam新闻·PC Gamer] T (0.5)｜正文：") || len([]rune(lines)) > 260 {
		t.Fatalf("ClusterLines %q", lines)
	}
	if p := PlainEvents([]Item{{Src: "steam", Official: true, Title: "o", H: 1}, {Src: "bili", Title: "b", H: 0.2}}); len(p) != 2 || p[0].Type != "official_update" {
		t.Fatalf("PlainEvents %+v", p)
	}
}
