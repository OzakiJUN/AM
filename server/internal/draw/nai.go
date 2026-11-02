// Package draw is NovelAI drawing as a command of the server's built-in
// bot (docs/design.md §10 内置 bot / 画画), from Weiqi's qqdraw plugin (first
// ported to the client, now on the server with one server NovelAI key).
// nai.go is pure (tested): commands, options, content rules, the request,
// reading answers; images.go handles pictures; service.go runs it.
package draw

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// NovelAI endpoints (relative to Config.API, default https://image.novelai.net).
const (
	PathImage   = "/ai/generate-image"
	PathVibe    = "/ai/encode-vibe"
	PathUpscale = "/ai/upscale"
	PathSub     = "/user/subscription"
	PathSuggest = "/ai/generate-image/suggest-tags"
)

// Orientation of a picture.
type Orientation string

const (
	Portrait  Orientation = "portrait"
	Landscape Orientation = "landscape"
	Square    Orientation = "square"
)

// Sizes of normal pictures (free on Opus) and 精绘 (large, cost Anlas).
var (
	Sizes      = map[Orientation][2]int{Portrait: {832, 1216}, Landscape: {1216, 832}, Square: {1024, 1024}}
	LargeSizes = map[Orientation][2]int{Portrait: {1024, 1536}, Landscape: {1536, 1024}, Square: {1472, 1472}}
)

// MaxSteps is the most steps a picture may take.
const MaxSteps = 50

// Tiers are NovelAI subscription names.
var Tiers = map[int]string{0: "未订阅", 1: "Tablet", 2: "Scroll", 3: "Opus"}

// Settings are the [draw] settings that shape requests.
type Settings struct {
	MaxCount     int
	Steps        int
	Scale        float64
	Sampler      string
	Strength     float64 // img2img
	VibeStrength float64
	RefStrength  float64
	RefFidelity  float64
	Model        string
	V5Model      string
	V5Native     bool // V5 takes Chinese as it is
	Quality      string
	QualityV5    string
	Negative     string
	BlockWords   []string
	AutoNsfw     bool
}

// DefaultSettings are Weiqi's plugin defaults.
func DefaultSettings() Settings {
	return Settings{MaxCount: 8, Steps: 28, Scale: 5, Sampler: "k_euler_ancestral", Strength: 0.6, VibeStrength: 0.6, RefStrength: 1, RefFidelity: 1,
		Model: "nai-diffusion-4-5-full", V5Model: "nai-diffusion-5-full", V5Native: true,
		Quality: "very aesthetic, masterpiece, no text", QualityV5: "very aesthetic, masterpiece, no text, high complexity",
		Negative: "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, bad anatomy, bad proportions, bad hands, wrong hand, wrong fingers, extra digits, fewer digits, extra fingers, missing fingers, fused fingers, too many fingers, malformed hands, mutated hands, deformed hands, extra arms, extra hands, extra legs, missing limb, bad feet, extra toes",
		AutoNsfw: true}
}

// Styles are the presets for 风格:xxx (Weiqi's list).
var Styles = map[string]string{
	"厚涂": "impasto, painterly, oil painting (medium)", "油画": "oil painting (medium), painterly, traditional media",
	"水彩": "watercolor (medium), traditional media", "平涂": "flat color, anime coloring", "赛璐璐": "anime coloring, anime screencap",
	"动画截图": "anime screencap, anime coloring", "像素": "pixel art", "素描": "sketch, monochrome, greyscale, traditional media",
	"线稿": "lineart, monochrome", "Q版": "chibi", "光影": "dramatic lighting, chiaroscuro, rim lighting",
}

// ---- content rules (never off) ----

var (
	minorRe = regexp.MustCompile(`(?i)(?:^|[^a-z])(?:loli|minor)(?:[^a-z]|$)|萝莉|未成年`)
	// NSFWRe finds adult words.
	NSFWRe  = regexp.MustCompile(`(?i)\b(?:nsfw|nude|naked|nudity|topless|bottomless|nipples?|areolae?|pussy|vagina|penis|sex|cum|breasts? out|no (?:bra|panties|clothes)|undressing|r-?18|hentai|explicit|rating:\s*(?:explicit|questionable))\b|裸|色情|涩图|色图|瑟图|做爱|性交|性爱|乳头|乳首|阴部|下体|露点|R18|r18|H图|h图|无码`)
	nsfwTag = regexp.MustCompile(`(?i)\bnsfw\b|rating:explicit`)
	asciiRe = regexp.MustCompile(`^[\x20-\x7e]+$`)
)

const (
	minorNeg = "futa, futanari"
	// NSFWNeg goes into the negative prompt where adult content isn't allowed.
	NSFWNeg = "nsfw, explicit, nude, nipples, pussy, penis, sex"
)

func blockHit(text string, words []string) string {
	low := strings.ToLower(text)
	for _, w := range words {
		w = strings.TrimSpace(w)
		if w == "" {
			continue
		}
		lw := strings.ToLower(w)
		if !asciiRe.MatchString(w) {
			if strings.Contains(low, lw) {
				return w
			}
			continue
		}
		for i := 0; ; {
			j := strings.Index(low[i:], lw)
			if j < 0 {
				break
			}
			at := i + j
			before := at == 0 || !isLetter(low[at-1])
			after := at+len(lw) >= len(low) || !isLetter(low[at+len(lw)])
			if before && after {
				return w
			}
			i = at + 1
		}
	}
	return ""
}

func isLetter(b byte) bool { return b >= 'a' && b <= 'z' }

// PromptProblem says why a prompt can't be drawn here ("" = fine).
func PromptProblem(text string, nsfwOK bool, blockWords []string) string {
	if minorRe.MatchString(text) {
		return "描述里有未成年相关内容，不画。"
	}
	if !nsfwOK {
		if m := NSFWRe.FindString(text); m != "" {
			return fmt.Sprintf("这里没开 NSFW（命中「%s」），不画。服务器管理员可以在管理面板里给这个频道打开。", m)
		}
	}
	if b := blockHit(text, blockWords); b != "" {
		return fmt.Sprintf("描述里有屏蔽的内容（%s），不画。", b)
	}
	return ""
}

// ---- options ----

// Options are what leads a description: 横图 / 方图 / 竖图 / 精绘 / *N, and 步数N anywhere.
type Options struct {
	Text        string
	Orientation Orientation
	Fine        bool
	N           int
	Steps       int // 0 = default
	Notes       []string
}

var (
	reSteps    = regexp.MustCompile(`步数\s*[:：]?\s*(\d{1,2})`)
	reCount    = regexp.MustCompile(`^[*×xX＊]\s*(\d{1,2})(\D|$)`)
	reTrimSep  = regexp.MustCompile(`^[\s，,]+|[\s，,]+$`)
	reLeadSep  = regexp.MustCompile(`^[\s，,]+`)
	reStrength = regexp.MustCompile(`强度\s*[:：]?\s*([0-9]*\.?[0-9]+)`)
	reMyAvatar = regexp.MustCompile(`用我的头像|我的头像当参考|照我的头像`)
)

// DrawOptions reads the options.
func DrawOptions(text string, maxCount int) Options {
	o := Options{Orientation: Portrait, N: 1}
	if m := reSteps.FindStringSubmatchIndex(text); m != nil {
		n, _ := strconv.Atoi(text[m[2]:m[3]])
		o.Steps = max(1, min(MaxSteps, n))
		text = reTrimSep.ReplaceAllString(text[:m[0]]+text[m[1]:], "")
	}
	for changed := true; changed; {
		changed = false
		if m := reCount.FindStringSubmatchIndex(text); m != nil {
			n, _ := strconv.Atoi(text[m[2]:m[3]])
			o.N = max(1, n)
			text = reLeadSep.ReplaceAllString(strings.TrimLeft(text[m[3]:], " "), "")
			changed = true
		}
		for _, kv := range [][2]string{{"横图", "landscape"}, {"方图", "square"}, {"竖图", "portrait"}, {"精绘", "fine"}} {
			if strings.HasPrefix(text, kv[0]) {
				text = reLeadSep.ReplaceAllString(text[len(kv[0]):], "")
				changed = true
				if kv[1] == "fine" {
					o.Fine = true
				} else {
					o.Orientation = Orientation(kv[1])
				}
			}
		}
	}
	if o.N > maxCount {
		o.Notes = append(o.Notes, fmt.Sprintf("一次最多 %d 张，按 %d 张出", maxCount, maxCount))
		o.N = maxCount
	}
	o.Text = strings.TrimSpace(text)
	return o
}

// TakeStrength reads 强度0.8 anywhere (0.05–1; 0 = not given).
func TakeStrength(text string) (string, float64) {
	m := reStrength.FindStringSubmatchIndex(text)
	if m == nil {
		return text, 0
	}
	v, err := strconv.ParseFloat(text[m[2]:m[3]], 64)
	rest := reTrimSep.ReplaceAllString(text[:m[0]]+text[m[1]:], "")
	if err != nil {
		return rest, 0
	}
	return rest, math.Max(0.05, math.Min(1, v))
}

// TakeMyAvatar reads 「用我的头像」 anywhere: draw with the asker's avatar as
// the character reference (AIs drawing themselves).
func TakeMyAvatar(text string) (string, bool) {
	if !reMyAvatar.MatchString(text) {
		return text, false
	}
	return reTrimSep.ReplaceAllString(strings.Join(strings.Fields(reMyAvatar.ReplaceAllString(text, " ")), " "), ""), true
}

var reRandom = regexp.MustCompile(`(?s)\|\|(.+?)\|\|`)

// PickRandom turns ||a|b|c|| into one of them (the NovelAI site's syntax).
func PickRandom(text string, rnd func(int) int) string {
	return reRandom.ReplaceAllStringFunc(text, func(m string) string {
		var opts []string
		for _, x := range strings.Split(m[2:len(m)-2], "|") {
			if x = strings.TrimSpace(x); x != "" {
				opts = append(opts, x)
			}
		}
		if len(opts) == 0 {
			return ""
		}
		return opts[rnd(len(opts))]
	})
}

// Sections is the sectioned way of writing: the main prompt, then lines
// "char1:" / "char2:" / "Negative:" / "char1 Negative:" (角色1： / 负面：).
type Sections struct {
	Text, Negative string
	Chars          [][2]string // [prompt, negative]
	Sectioned      bool
}

var (
	reSection = regexp.MustCompile(`(?im)^[ \t]*(?:(?:char(?:acter)?|角色)[ \t]*(\d)[ \t]*(negative|neg|uc|负面)?|(negative|neg|uc|负面|反向))[ \t]*[:：]`)
	reNewline = regexp.MustCompile(`\s*\n\s*`)
	reEdgeSep = regexp.MustCompile(`^[,，\s]+|[,，\s]+$`)
)

// SplitSections reads the sectioned way of writing.
func SplitSections(text string, rnd func(int) int) Sections {
	marks := reSection.FindAllStringSubmatchIndex(text, -1)
	if len(marks) == 0 {
		return Sections{Text: PickRandom(text, rnd)}
	}
	tidy := func(t string) string {
		return reEdgeSep.ReplaceAllString(strings.TrimSpace(reNewline.ReplaceAllString(t, " ")), "")
	}
	var neg []string
	chars := map[int]*[2]string{}
	for i, m := range marks {
		end := len(text)
		if i+1 < len(marks) {
			end = marks[i+1][0]
		}
		body := reEdgeSep.ReplaceAllString(strings.TrimSpace(PickRandom(text[m[1]:end], rnd)), "")
		if m[2] >= 0 {
			n, _ := strconv.Atoi(text[m[2]:m[3]])
			c := chars[n]
			if c == nil {
				c = &[2]string{}
				chars[n] = c
			}
			if m[4] >= 0 {
				c[1] = body
			} else {
				c[0] = body
			}
		} else if body != "" {
			neg = append(neg, body)
		}
	}
	keys := make([]int, 0, len(chars))
	for k := range chars {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	s := Sections{Text: tidy(PickRandom(text[:marks[0][0]], rnd)), Negative: tidy(strings.Join(neg, ", ")), Sectioned: true}
	for _, k := range keys {
		if p := tidy(chars[k][0]); p != "" {
			s.Chars = append(s.Chars, [2]string{p, tidy(chars[k][1])})
		}
	}
	return s
}

var (
	reArtist = regexp.MustCompile(`画师[:：]\s*([^,，;；\n]+?)(\s+\S+[:：]|[,，;；\n]|$)`)
	reStyle  = regexp.MustCompile(`(?:风格|画风)[:：]\s*([^\s,，;；]+)`)
	reSpaces = regexp.MustCompile(`\s{2,}`)
	reArtSep = regexp.MustCompile(`[、/|]`)
)

// StyleSpecs turns 画师:wlop / 风格:厚涂 into tags; unknown styles stay in the description.
func StyleSpecs(text string) (rest, tags string, notes []string) {
	var tagList []string
	for {
		m := reArtist.FindStringSubmatchIndex(text)
		if m == nil {
			break
		}
		for _, a := range reArtSep.Split(text[m[2]:m[3]], -1) {
			a = strings.Join(strings.Fields(strings.ReplaceAll(strings.ToLower(strings.TrimSpace(a)), "_", " ")), " ")
			if a != "" {
				tagList = append(tagList, "artist:"+a)
			}
		}
		text = text[:m[0]] + " " + text[m[4]:]
	}
	var keep []string
	text = reStyle.ReplaceAllStringFunc(text, func(s string) string {
		name := reStyle.FindStringSubmatch(s)[1]
		if t, ok := Styles[name]; ok {
			tagList = append(tagList, t)
		} else {
			keep = append(keep, "画风："+name)
			names := make([]string, 0, len(Styles))
			for k := range Styles {
				names = append(names, k)
			}
			sort.Strings(names)
			notes = append(notes, fmt.Sprintf("「%s」不在预设风格里，按描述理解了（预设有：%s）", name, strings.Join(names, "、")))
		}
		return " "
	})
	text = reSpaces.ReplaceAllString(reTrimSep.ReplaceAllString(text, ""), " ")
	if len(keep) > 0 {
		parts := []string{}
		if text != "" {
			parts = append(parts, text)
		}
		text = strings.Join(append(parts, keep...), "，")
	}
	return text, strings.Join(tagList, ", "), notes
}

var reRaw = regexp.MustCompile(`^\s*原样\s*[,，:：]?\s*`)

// TakeRaw: a description starting with 原样 is sent word for word.
func TakeRaw(text string) (string, bool) {
	if m := reRaw.FindString(text); m != "" {
		return text[len(m):], true
	}
	return text, false
}

var reCJK = regexp.MustCompile(`[\x{3040}-\x{30ff}\x{3400}-\x{9fff}]`)

// HasCJK: has Chinese / Japanese characters (V4.5 needs them translated).
func HasCJK(t string) bool { return reCJK.MatchString(t) }

// ---- the request ----

// Request is one generate-image call.
type Request struct {
	Prompt      string
	Model       string
	Orientation Orientation
	Negative    string
	Chars       [][2]string
	Seed        int64 // -1 = random
	Steps       int   // 0 = default
	N           int
	Large       bool
	// Image is for img2img (PNG base64, already fitted to Width × Height).
	Image         string
	Width, Height int
	// Vibes: [encoded vibe, strength].
	Vibes []Vibe
	// References: character reference pictures (PNG base64, already padded).
	References []string
	NsfwOK     bool
}

// Vibe is an encoded vibe and its strength.
type Vibe struct {
	Data     string
	Strength float64
}

func roundUp64(v int) int { return max(64, (v+63)/64*64) }

// SizeFor is the size of a request: normal sizes stay within 1024×1024 pixels.
func SizeFor(o Orientation, large bool) (int, int) {
	if o == "" {
		o = Portrait
	}
	if large {
		s := LargeSizes[o]
		return s[0], s[1]
	}
	w, h := roundUp64(Sizes[o][0]), roundUp64(Sizes[o][1])
	if w*h > 1024*1024 {
		s := math.Sqrt(1024 * 1024 / float64(w*h))
		w, h = int(float64(w)*s)/64*64, int(float64(h)*s)/64*64
	}
	return w, h
}

// OrientationOf is the normal shape nearest a picture's (img2img).
func OrientationOf(w, h int) Orientation {
	r := float64(w) / float64(h)
	switch {
	case r > 1.15:
		return Landscape
	case r < 0.87:
		return Portrait
	}
	return Square
}

// ReferenceCanvas is the canvas a character reference picture is padded into.
func ReferenceCanvas(w, h int) (int, int) {
	switch OrientationOf(w, h) {
	case Landscape:
		return 1536, 1024
	case Portrait:
		return 1024, 1536
	}
	return 1472, 1472
}

var reEdgeComma = regexp.MustCompile(`^[\s,]+|[\s,]+$`)

// Payload is the body of a generate-image request (Weiqi's build_payload).
type Payload struct {
	Input      string         `json:"input"`
	Model      string         `json:"model"`
	Action     string         `json:"action"`
	Parameters map[string]any `json:"parameters"`
}

// BuildPayload makes the request body.
func BuildPayload(r Request, s Settings, rnd *rand.Rand) Payload {
	w, h := r.Width, r.Height
	if r.Image == "" {
		w, h = SizeFor(r.Orientation, r.Large)
	}
	seed := r.Seed
	if seed < 0 {
		seed = rnd.Int64N(4294967288)
	} else {
		seed %= 4294967288
	}
	prompt := reEdgeComma.ReplaceAllString(strings.TrimSpace(r.Prompt), "")
	var chars [][2]string
	for _, c := range r.Chars {
		if p := reEdgeComma.ReplaceAllString(strings.TrimSpace(c[0]), ""); p != "" {
			chars = append(chars, [2]string{p, strings.TrimSpace(c[1])})
		}
	}
	if r.NsfwOK && s.AutoNsfw && NSFWRe.MatchString(prompt) && !nsfwTag.MatchString(prompt) {
		prompt = "nsfw, " + prompt
	}
	q := s.Quality
	if strings.Contains(r.Model, "diffusion-5") {
		q = s.QualityV5
	}
	full := joinNonEmpty(", ", prompt, q)
	var userNeg []string
	for _, b := range s.BlockWords {
		if asciiRe.MatchString(b) {
			userNeg = append(userNeg, b)
		}
	}
	nsfwNeg := NSFWNeg
	if r.NsfwOK {
		nsfwNeg = ""
	}
	neg := joinNonEmpty(", ", s.Negative, r.Negative, minorNeg, strings.Join(userNeg, ", "), nsfwNeg)
	steps := s.Steps
	if r.Steps > 0 {
		steps = r.Steps
	}
	steps = max(1, min(MaxSteps, steps))
	charPrompts := []map[string]any{}
	charCaps := []map[string]any{}
	charNegs := []map[string]any{}
	center := map[string]float64{"x": 0.5, "y": 0.5}
	for _, c := range chars {
		uc := c[1]
		if uc == "" {
			uc = "lowres, aliasing"
		}
		charPrompts = append(charPrompts, map[string]any{"prompt": c[0], "uc": uc, "center": center, "enabled": true})
		charCaps = append(charCaps, map[string]any{"char_caption": c[0], "centers": []any{center}})
		charNegs = append(charNegs, map[string]any{"char_caption": uc, "centers": []any{center}})
	}
	p := map[string]any{
		"params_version": 3, "width": w, "height": h, "scale": s.Scale, "sampler": s.Sampler, "steps": steps,
		"n_samples": max(1, min(4, r.N)), "ucPreset": 4, "qualityToggle": true, "autoSmea": false, "dynamic_thresholding": false,
		"controlnet_strength": 1, "legacy": false, "add_original_image": true, "cfg_rescale": 0, "noise_schedule": "karras", "legacy_v3_extend": false,
		"skip_cfg_above_sigma": nil, "use_coords": false, "legacy_uc": false, "normalize_reference_strength_multiple": true, "seed": seed, "negative_prompt": neg,
		"characterPrompts":   charPrompts,
		"v4_prompt":          map[string]any{"caption": map[string]any{"base_caption": full, "char_captions": charCaps}, "use_coords": false, "use_order": true},
		"v4_negative_prompt": map[string]any{"caption": map[string]any{"base_caption": neg, "char_captions": charNegs}, "legacy_uc": false},
	}
	if s.Sampler == "k_euler_ancestral" {
		p["deliberate_euler_ancestral_bug"] = false
		p["prefer_brownian"] = true
	}
	action := "generate"
	if r.Image != "" {
		p["image"], p["strength"], p["noise"], p["extra_noise_seed"], p["sm"], p["sm_dyn"] = r.Image, s.Strength, 0, seed, false, false
		action = "img2img"
	}
	if len(r.Vibes) > 0 {
		var data []string
		var str []float64
		for _, v := range r.Vibes {
			data, str = append(data, v.Data), append(str, v.Strength)
		}
		p["reference_image_multiple"], p["reference_strength_multiple"] = data, str
	}
	if len(r.References) > 0 {
		delete(p, "reference_image_multiple")
		delete(p, "reference_strength_multiple")
		delete(p, "normalize_reference_strength_multiple")
		var desc []any
		var info, str, fid []float64
		for range r.References {
			desc = append(desc, map[string]any{"caption": map[string]any{"base_caption": "character", "char_captions": []any{}}, "legacy_uc": false})
			info, str, fid = append(info, 1), append(str, s.RefStrength), append(fid, s.RefFidelity)
		}
		p["director_reference_images"] = r.References
		p["director_reference_descriptions"] = desc
		p["director_reference_information_extracted"] = info
		p["director_reference_strength_values"] = str
		p["director_reference_secondary_strength_values"] = fid
	}
	return Payload{Input: full, Model: r.Model, Action: action, Parameters: p}
}

func joinNonEmpty(sep string, parts ...string) string {
	var out []string
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// IsFree: free on an Opus subscription (one normal-size picture, ≤ 28 steps, no picture in).
func IsFree(p Payload) bool {
	q := p.Parameters
	_, img := q["image"]
	_, ref := q["director_reference_images"]
	_, vibe := q["reference_image_multiple"]
	return q["n_samples"].(int) == 1 && q["width"].(int)*q["height"].(int) <= 1024*1024 && q["steps"].(int) <= 28 && !img && !ref && !vibe
}

// ---- answers ----

var pngSig = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}

// ExtractPNGs reads the pictures in a generate-image / upscale answer (a
// zip, or a stream with a PNG inside).
func ExtractPNGs(data []byte) ([][]byte, error) {
	if len(data) > 2 && data[0] == 'P' && data[1] == 'K' {
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, fmt.Errorf("NovelAI 返回的压缩包打不开")
		}
		var names []string
		files := map[string]*zip.File{}
		for _, f := range zr.File {
			if !strings.HasSuffix(f.Name, "/") {
				names = append(names, f.Name)
				files[f.Name] = f
			}
		}
		sort.Strings(names)
		var out [][]byte
		for _, n := range names {
			rc, err := files[n].Open()
			if err != nil {
				return nil, err
			}
			b, err := io.ReadAll(io.LimitReader(rc, 64<<20))
			rc.Close()
			if err != nil {
				return nil, err
			}
			out = append(out, b)
		}
		if len(out) == 0 {
			return nil, fmt.Errorf("NovelAI 返回的压缩包是空的")
		}
		return out, nil
	}
	if i := bytes.LastIndex(data, pngSig); i >= 0 {
		if j := bytes.Index(data[i:], []byte("IEND")); j >= 0 && i+j+8 <= len(data) {
			return [][]byte{data[i : i+j+8]}, nil
		}
	}
	return nil, fmt.Errorf("NovelAI 返回的内容看不懂")
}

// Balance is the NovelAI account's state.
type Balance struct {
	Anlas   int
	HasAnl  bool
	Tier    int
	HasTier bool
	Expires int64 // unix seconds, 0 = unknown
	Battery int   // V5 allowance left (%), -1 = unknown
}

// ParseSubscription reads /user/subscription.
func ParseSubscription(data []byte) (Balance, error) {
	var d map[string]any
	if err := json.Unmarshal(data, &d); err != nil {
		return Balance{}, err
	}
	b := Balance{Battery: -1}
	num := func(v any) (float64, bool) {
		f, ok := v.(float64)
		return f, ok
	}
	switch left := d["trainingStepsLeft"].(type) {
	case map[string]any:
		f, _ := num(left["fixedTrainingStepsLeft"])
		p, _ := num(left["purchasedTrainingSteps"])
		b.Anlas, b.HasAnl = int(f+p), true
	case float64:
		b.Anlas, b.HasAnl = int(left), true
	default:
		f, okF := num(d["fixedTrainingStepsLeft"])
		p, okP := num(d["purchasedTrainingSteps"])
		if okF || okP {
			b.Anlas, b.HasAnl = int(f+p), true
		}
	}
	if t, ok := num(d["tier"]); ok {
		b.Tier, b.HasTier = int(t), true
	}
	if e, ok := num(d["expiresAt"]); ok {
		b.Expires = int64(e)
	}
	if u, ok := d["usage"].(map[string]any); ok {
		if p, ok := num(u["percent"]); ok {
			b.Battery = int(p)
		}
	}
	return b, nil
}

// BalanceText is /nai余额's answer.
func BalanceText(b Balance, loc *time.Location) string {
	if !b.HasAnl {
		return "NovelAI：查不到余额"
	}
	tier := ""
	if b.HasTier {
		tier = Tiers[b.Tier]
		if tier == "" {
			tier = strconv.Itoa(b.Tier)
		}
	}
	exp := ""
	if b.Expires > 0 {
		exp = "，到期 " + time.Unix(b.Expires, 0).In(loc).Format("01/02")
	}
	bat := ""
	if b.Battery >= 0 {
		bat = fmt.Sprintf("，V5 额度 %d%%", b.Battery)
	}
	return fmt.Sprintf("NovelAI：%s%s，剩余 %d Anlas%s", tier, exp, b.Anlas, bat)
}

// CostNote is 「剩余 x Anlas（这次花了 y）」 ("" when unknown).
func CostNote(before, after *int, paid bool) string {
	if after == nil {
		return ""
	}
	note := fmt.Sprintf("剩余 %d Anlas", *after)
	if before != nil {
		spent := *before - *after
		if spent > 0 {
			note += fmt.Sprintf("（这次花了 %d）", spent)
		} else if paid && spent == 0 {
			note += "（余额没变：可能这项 Opus 也免费，也可能余额还没刷新）"
		}
	}
	return note
}

// ErrorText is an error answer from NovelAI, in words.
func ErrorText(status int, body string) string {
	msg := cut(body, 200)
	var d struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	if json.Unmarshal([]byte(body), &d) == nil {
		if d.Message != "" {
			msg = d.Message
		} else if d.Error != "" {
			msg = d.Error
		}
	}
	switch status {
	case 400:
		return "参数不对：" + msg
	case 401:
		return "token 无效或过期（服务器管理员在管理面板里换一个：NovelAI 网页 → 设置 → Account → Get Persistent API Token）"
	case 402:
		return "Anlas 不够或者订阅不支持：" + msg
	case 403:
		return "被拒绝：" + msg
	case 409:
		return "冲突：" + msg
	case 429:
		return "NovelAI 说同时请求太多了（一个账号同时只能画一张），稍后再试"
	case 500:
		return "NovelAI 服务器出错：" + msg
	}
	return fmt.Sprintf("HTTP %d：%s", status, msg)
}

func cut(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// TagsText turns suggest-tags answers into lines for the chat.
func TagsText(query string, v5 bool, answers [][]byte) string {
	type tag struct {
		Tag        string   `json:"tag"`
		Count      float64  `json:"count"`
		Confidence *float64 `json:"confidence"`
	}
	seen := map[string]bool{}
	var tags []tag
	for _, a := range answers {
		var d struct {
			Tags []tag `json:"tags"`
		}
		if json.Unmarshal(a, &d) != nil {
			continue
		}
		for _, t := range d.Tags {
			if t.Tag != "" && !seen[t.Tag] {
				seen[t.Tag] = true
				tags = append(tags, t)
			}
		}
	}
	if len(tags) == 0 {
		return fmt.Sprintf("NovelAI 不认识「%s」开头的标签，换个拼法试试（画师名用 Danbooru 上的英文写法）", query)
	}
	sort.SliceStable(tags, func(a, b int) bool { return tags[a].Count > tags[b].Count })
	ver := "V4.5"
	if v5 {
		ver = "V5"
	}
	lines := []string{fmt.Sprintf("NovelAI %s 认识的「%s」相关标签（按训练图数量排）：", ver, query)}
	for i, t := range tags {
		if i == 12 {
			break
		}
		var extra []string
		if t.Count > 0 {
			extra = append(extra, fmt.Sprintf("%d 张", int(t.Count)))
		}
		if t.Confidence != nil {
			if *t.Confidence <= 1 {
				extra = append(extra, fmt.Sprintf("把握 %d%%", int(math.Round(*t.Confidence*100))))
			} else {
				extra = append(extra, fmt.Sprintf("把握 %g", *t.Confidence))
			}
		}
		name := t.Tag
		if strings.HasPrefix(name, "artist:") {
			name = "画师:" + name[7:]
		}
		l := "• " + name
		if len(extra) > 0 {
			l += "（" + strings.Join(extra, "，") + "）"
		}
		lines = append(lines, l)
	}
	lines = append(lines, "张数越多越认得、效果越明显；张数很少的填了基本没感觉")
	return strings.Join(lines, "\n")
}

// Usage is the help for a command sent without anything to draw.
func Usage(kind string, maxCount int) string {
	switch kind {
	case "charref":
		return "用法：带一张图（或回复一张图）发「/角色参考 <要画什么>」，照那张图里的角色画新的画面（每张约 5 Anlas）。可以加「强度0.8」、横图 / 方图、*N。写「用我的头像」就拿你自己的头像当参考。"
	case "vibe":
		return "用法：带一张图（或回复一张图）发「/风格迁移 <要画什么>」，照那张图的画风画新内容（新图编码约 2 Anlas）。可以加「强度0.8」（默认 0.6）、*N。"
	case "upscale":
		return "用法：回复一张图发「/放大」，NovelAI 放大 2 倍（不重画，会扣 Anlas）。"
	case "tags":
		return "用法：/查标签 mika（打名字的前几个字母就行），看 NovelAI 认不认识、训练图有多少张；开头加 v5 查 V5 的。"
	}
	return fmt.Sprintf("用法：/nai <描述>（V4.5）或 /nai5 <描述>（V5），例如：/nai5 银发猫耳女孩，夜晚，霓虹街道\n开头可以加：横图 / 方图；精绘（大尺寸，扣 Anlas）；*4（一次出几张，最多 %d）\n分段写法：主提示词后面换行写 char1: / char2: / Negative: / char1 Negative:\n描述里写「步数40」改步数（最多 50，超过 28 扣 Anlas）；开头写「原样」一个字不改；写「用我的头像」照你的头像画你自己\n/nai 的中文会翻成英文；/nai5 直接用中文；可以写 画师:xxx、风格:厚涂\n带一张图（或回复一张图）= 在原图上改（扣 Anlas）。其他：/角色参考 /风格迁移 /放大 /查标签 /nai余额", maxCount)
}

// TranslatePrompt is Weiqi's translation prompt: faithful, keeps NovelAI syntax.
const TranslatePrompt = "You are a translator. Translate the user's text into natural English, faithfully and completely: keep every detail, do not add, remove, soften or censor anything, do not explain. Keep any parts that are already English, and keep special syntax unchanged (e.g. {word}, [word], 1.2::word::, artist:name). Write anime/game character names in their official English romanization. Output only the translation, nothing else."
