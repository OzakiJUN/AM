package news

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Prompts, from the qqnews plugin.
const (
	kindPrompt = "判断下面这个名字是「游戏」还是「游戏公司（开发商 / 发行商 / 工作室）」。" +
		`只输出 JSON：{"kind":"game 或 company 或 unknown","en":"它常用的英文名（Steam 上的写法），不知道就空"}`

	steamPrompt = "下面是「%s」在 Steam 上的消息（官方公告 / 厂商群组公告 / 媒体报道）。每条给：\n" +
		"  zh：标题翻成通顺的中文（本来就是中文就原样，游戏名有官方中文名用官方中文名，没有就保留原名）\n" +
		"  summary：有「正文：」的写一两句中文小结，讲清楚是什么事（新作上线 / 更新内容 / 促销活动 / 报道要点），没有正文就空串\n" +
		`只输出 JSON：{"items":[{"n":1,"zh":"","summary":""}]}`

	clusterPrompt = "你是游戏资讯编辑。下面是关键词「%[1]s」在各平台新抓到的内容，每行格式：序号. [平台] 标题 (站内热度0~1)。\n" +
		"请把讲同一件事的内容归成一个事件（不同平台、不同说法的同一件事要合并），每个事件给：\n" +
		"（注意：%[2]s）\n" +
		"  title：中文一句话概括（外文翻译成中文，写清楚是什么事）\n" +
		"  items：属于这个事件的序号列表\n" +
		"  type：official_update(官方更新/公告) / content(新角色新玩法新赛季等新内容) / esports(赛事) / controversy(争议翻车停服) / " +
		"meme(热梗整活) / discussion(玩家讨论) / guide(攻略教学) / ad(广告营销) / irrelevant(和这个游戏无关)\n" +
		"  major：是不是值得立刻告诉玩家的大事（大版本更新、新内容正式公布、重大赛事结果、停服、重大争议），一般很少\n" +
		"  repeat：如果是下面「已推送过的大事」的同一件事或后续，填 true\n" +
		"  summary：事件里有带「正文：」的媒体报道时，用中文写一两句小结（报道了什么、关键信息），没有就填空串\n" +
		"今天是 %[3]s。行尾〔〕里是发布日期；标题或内容明显是在说一周以前的旧事（比如去年的版本、很久以前的公告被翻出来）的，major 一律填 false\n" +
		"已推送过的大事：%[4]s\n" +
		`只输出 JSON：{"events":[{"title":"","items":[1,2],"type":"","major":false,"repeat":false,"summary":""}]}`
	scopeGame    = "只有明确在说「%s」这个游戏的才算，搜索结果里混进来的别的游戏、别的新闻一律归为 irrelevant"
	scopeCompany = "「%s」是一家游戏公司%s。公司本身（人事、财报、裁员、收购、新作公布）和它旗下任何游戏的消息都算相关；" +
		"标题前面的《》是 Steam 上它的哪款游戏。和这家公司无关的才归为 irrelevant"

	mergePrompt = "下面是同一个游戏今天不同时间抓到的事件标题。把讲同一件事的合并成组，每组给一个中文标题。" +
		`只输出 JSON：{"groups":[{"title":"","items":[1,3]}]}，每个序号只能出现一次，单独的也要成组。`

	xPrompt = "搜索 X 上过去 7 天关于「%s」的讨论，挑出玩家圈子里最值得关注的 6 件事" +
		"（官方更新、赛事、争议、热门梗等），每件一行：中文一句话概括，然后换行写原帖链接。不要编造，没有就少写。"
)

// errNoModel: no model is set up ([news] ai_url).
var errNoModel = errors.New("没配置资讯用的模型")

var reJSON = regexp.MustCompile(`(?s)\{.*\}`)

// ask sends one chat request to the OpenAI-compatible model and reads the
// JSON object in its answer into v.
func (s *Service) ask(ctx context.Context, system, user string, maxTokens int, v any) error {
	if s.cfg.AIURL == "" {
		return errNoModel
	}
	body, _ := json.Marshal(map[string]any{
		"model": s.cfg.AIModel, "stream": false, "temperature": 0.2, "max_tokens": maxTokens,
		"messages": []map[string]string{{"role": "system", "content": system}, {"role": "user", "content": user}},
	})
	h := map[string]string{"Content-Type": "application/json"}
	if s.cfg.AIKey != "" {
		h["Authorization"] = "Bearer " + s.cfg.AIKey
	}
	b, code, err := s.fetch.get(ctx, strings.TrimRight(s.cfg.AIURL, "/")+"/chat/completions", nil,
		req{method: http.MethodPost, body: body, header: h, proxy: s.cfg.AIProxy, timeout: 3 * time.Minute})
	if err != nil {
		return err
	}
	if code != http.StatusOK {
		return fmt.Errorf("模型 HTTP %d %s", code, cut(string(b), 100))
	}
	var r struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(b, &r); err != nil || len(r.Choices) == 0 {
		return errors.New("模型的回答看不懂")
	}
	m := reJSON.FindString(r.Choices[0].Message.Content)
	if m == "" {
		return errors.New("模型没有回答 JSON")
	}
	return json.Unmarshal([]byte(m), v)
}

var reCite = regexp.MustCompile(`\s*\[\[\d+\]\]\([^)]*\)`)

// xWeekly asks xAI to search X for this week's talk about a keyword.
// Billed per post fetched (about 60 posts, $0.3 a time in Weiqi's test).
func (s *Service) xWeekly(ctx context.Context, kw string, alias []string) string {
	if s.cfg.XAIKey == "" {
		return "没配置 xAI key，X 周报用不了"
	}
	body, _ := json.Marshal(map[string]any{
		"model": s.cfg.XAIModel, "reasoning": map[string]string{"effort": "low"},
		"tools": []map[string]string{{"type": "x_search"}},
		"input": fmt.Sprintf(xPrompt, strings.Join(append([]string{kw}, alias...), " OR ")),
	})
	proxy := s.cfg.XAIProxy
	if proxy == "" {
		proxy = s.cfg.Proxy
	}
	b, code, err := s.fetch.get(ctx, "https://api.x.ai/v1/responses", nil, req{method: http.MethodPost, body: body, proxy: proxy,
		timeout: 4 * time.Minute, header: map[string]string{"Authorization": "Bearer " + s.cfg.XAIKey, "Content-Type": "application/json"}})
	if err != nil {
		return "X 搜索出错：" + err.Error()
	}
	if code != http.StatusOK {
		return fmt.Sprintf("X 搜索失败：HTTP %d %s", code, cut(string(b), 100))
	}
	var d struct {
		Output []struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
		Usage struct {
			Tools struct {
				Posts int `json:"x_posts_fetched"`
			} `json:"server_side_tool_usage_details"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(b, &d); err != nil {
		return "X 搜索的回答看不懂"
	}
	var text strings.Builder
	for _, o := range d.Output {
		for _, c := range o.Content {
			if c.Type == "output_text" {
				text.WriteString(c.Text)
			}
		}
	}
	out := strings.TrimSpace(reCite.ReplaceAllString(text.String(), ""))
	if out == "" {
		out = "（X 上没搜到什么）"
	}
	return fmt.Sprintf("%s\n（本次抓取 X 帖子 %d 条，约 $%.2f）", out, d.Usage.Tools.Posts, float64(d.Usage.Tools.Posts)*0.005)
}
