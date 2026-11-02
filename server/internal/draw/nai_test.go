package draw

import (
	"archive/zip"
	"bytes"
	"math/rand/v2"
	"reflect"
	"strings"
	"testing"
	"time"
)

func zero(int) int   { return 0 }
func half(n int) int { return n / 2 }

func TestOptions(t *testing.T) {
	o := DrawOptions("横图 *4 精绘 银发 步数40", 8)
	if o.Text != "银发" || o.Orientation != Landscape || !o.Fine || o.N != 4 || o.Steps != 40 {
		t.Fatalf("%+v", o)
	}
	if o := DrawOptions("*12 猫", 8); o.N != 8 || len(o.Notes) != 1 {
		t.Fatalf("cap %+v", o)
	}
	if DrawOptions("步数99 猫", 8).Steps != 50 || DrawOptions("方图猫", 8).Orientation != Square {
		t.Fatal("steps / 方图")
	}
	if o := DrawOptions("*123 猫", 8); o.N != 1 {
		t.Fatal("three digits are not a count", o)
	}
	if s, v := TakeStrength("强度0.8 城市"); s != "城市" || v != 0.8 {
		t.Fatal("strength", s, v)
	}
	if _, v := TakeStrength("强度5 城市"); v != 1 {
		t.Fatal("strength cap")
	}
	if s, raw := TakeRaw("原样，1girl, solo"); !raw || s != "1girl, solo" {
		t.Fatal("raw")
	}
	if _, raw := TakeRaw("1girl"); raw {
		t.Fatal("not raw")
	}
	if s, me := TakeMyAvatar("用我的头像 在海边"); !me || s != "在海边" {
		t.Fatal("my avatar", s, me)
	}
	if !HasCJK("1girl, 猫耳") || HasCJK("1girl, {cat ears}") {
		t.Fatal("cjk")
	}
	if PickRandom("a ||x|y|z|| b", half) != "a y b" {
		t.Fatal("random")
	}
	sec := SplitSections("two girls, park\nchar1: red hair\nchar1 negative: hat\nchar2: blue hair\nNegative: rain", zero)
	if !sec.Sectioned || sec.Text != "two girls, park" || sec.Negative != "rain" || !reflect.DeepEqual(sec.Chars, [][2]string{{"red hair", "hat"}, {"blue hair", ""}}) {
		t.Fatalf("sections %+v", sec)
	}
	if s := SplitSections("角色1：猫娘\n负面：雨", zero); !reflect.DeepEqual(s.Chars, [][2]string{{"猫娘", ""}}) || s.Negative != "雨" {
		t.Fatalf("chinese sections %+v", s)
	}
	if SplitSections("just text", zero).Sectioned {
		t.Fatal("not sectioned")
	}
	rest, tags, _ := StyleSpecs("少女 画师:wlop/Mika_Pikazo 风格:厚涂, 夜晚")
	if tags != "artist:wlop, artist:mika pikazo, impasto, painterly, oil painting (medium)" || !strings.Contains(rest, "少女") || !strings.Contains(rest, "夜晚") || strings.Contains(rest, "画师") {
		t.Fatalf("styles %q %q", rest, tags)
	}
	rest, _, notes := StyleSpecs("猫 风格:蒸汽波")
	if rest != "猫，画风：蒸汽波" || len(notes) != 1 {
		t.Fatalf("unknown style %q %v", rest, notes)
	}
}

func TestRules(t *testing.T) {
	for _, c := range []struct {
		text   string
		nsfwOK bool
		block  []string
		want   string
	}{
		{"loli", true, nil, "未成年"},
		{"萝莉", true, nil, "未成年"},
		{"a minority report?", true, nil, ""},
		{"nude girl", false, nil, "NSFW"},
		{"nude girl", true, nil, ""},
		{"画个狗", true, []string{"狗"}, "屏蔽"},
		{"a dogma", true, []string{"dog"}, ""},
		{"a dog", true, []string{"dog"}, "屏蔽"},
	} {
		got := PromptProblem(c.text, c.nsfwOK, c.block)
		if (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("PromptProblem(%q) = %q", c.text, got)
		}
	}
}

func TestPayload(t *testing.T) {
	if w, h := SizeFor(Portrait, false); w != 832 || h != 1216 {
		t.Fatal("portrait", w, h)
	}
	if w, h := SizeFor(Square, true); w != 1472 || h != 1472 {
		t.Fatal("large square")
	}
	if OrientationOf(1920, 1080) != Landscape || OrientationOf(1000, 1000) != Square {
		t.Fatal("orientation")
	}
	if w, h := ReferenceCanvas(600, 1000); w != 1024 || h != 1536 {
		t.Fatal("canvas")
	}
	s := DefaultSettings()
	rnd := rand.New(rand.NewPCG(1, 2))
	p := BuildPayload(Request{Prompt: "1girl, nude", Model: s.Model, NsfwOK: true, Seed: -1, N: 1}, s, rnd)
	if p.Input != "nsfw, 1girl, nude, "+s.Quality || p.Action != "generate" {
		t.Fatalf("input %q", p.Input)
	}
	neg := p.Parameters["negative_prompt"].(string)
	if !strings.Contains(neg, "futa") || strings.Contains(neg, "explicit") || !IsFree(p) {
		t.Fatalf("neg %q", neg)
	}
	p = BuildPayload(Request{Prompt: "cat", Model: s.V5Model, Chars: [][2]string{{"red hair", ""}}, N: 3, Steps: 40, Seed: 7}, s, rnd)
	if p.Input != "cat, "+s.QualityV5 || !strings.Contains(p.Parameters["negative_prompt"].(string), "explicit") ||
		p.Parameters["n_samples"] != 3 || p.Parameters["seed"] != int64(7) || len(p.Parameters["characterPrompts"].([]map[string]any)) != 1 || IsFree(p) {
		t.Fatalf("v5 %+v", p)
	}
	p = BuildPayload(Request{Prompt: "cat", Model: s.Model, Image: "AAA", Width: 1216, Height: 832, Seed: -1, N: 1}, s, rnd)
	if p.Action != "img2img" || p.Parameters["width"] != 1216 {
		t.Fatal("img2img")
	}
	p = BuildPayload(Request{Prompt: "cat", Model: s.Model, References: []string{"R"}, Vibes: []Vibe{{"V", 0.6}}, Seed: -1, N: 1}, s, rnd)
	if _, ok := p.Parameters["reference_image_multiple"]; ok || !reflect.DeepEqual(p.Parameters["director_reference_images"], []string{"R"}) {
		t.Fatal("references replace vibes")
	}
}

func TestAnswers(t *testing.T) {
	png := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82}
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	for _, n := range []string{"image_1.png", "image_0.png"} {
		w, _ := zw.Create(n)
		w.Write(png)
	}
	zw.Close()
	if got, err := ExtractPNGs(zb.Bytes()); err != nil || len(got) != 2 {
		t.Fatal("zip", err)
	}
	stream := append(append([]byte{9, 9}, png...), 7)
	if got, err := ExtractPNGs(stream); err != nil || !bytes.Equal(got[0], png) {
		t.Fatal("stream", err)
	}
	if _, err := ExtractPNGs([]byte{1, 2, 3}); err == nil {
		t.Fatal("junk")
	}
	b, _ := ParseSubscription([]byte(`{"tier":3,"expiresAt":1800000000,"trainingStepsLeft":{"fixedTrainingStepsLeft":100,"purchasedTrainingSteps":20},"usage":{"percent":80}}`))
	if b.Anlas != 120 || b.Tier != 3 || b.Expires != 1800000000 || b.Battery != 80 {
		t.Fatalf("%+v", b)
	}
	if txt := BalanceText(b, time.UTC); !strings.Contains(txt, "Opus") || !strings.Contains(txt, "剩余 120 Anlas") || !strings.Contains(txt, "V5 额度 80%") {
		t.Fatal(txt)
	}
	if b, _ := ParseSubscription([]byte(`{"trainingStepsLeft":5}`)); b.Anlas != 5 {
		t.Fatal("plain number")
	}
	a, c := 100, 90
	if CostNote(&a, &c, true) != "剩余 90 Anlas（这次花了 10）" || CostNote(&a, &a, false) != "剩余 100 Anlas" || CostNote(nil, nil, false) != "" {
		t.Fatal("cost")
	}
	if !strings.Contains(ErrorText(401, ""), "token") || !strings.Contains(ErrorText(400, `{"message":"bad size"}`), "bad size") {
		t.Fatal("errors")
	}
	if got := TagsText("mika", false, [][]byte{[]byte(`{"tags":[{"tag":"artist:mika pikazo","count":900,"confidence":0.9},{"tag":"mika","count":50}]}`)}); !strings.Contains(got, "画师:mika pikazo（900 张，把握 90%）") {
		t.Fatal(got)
	}
	if !strings.Contains(TagsText("zz", false, [][]byte{[]byte(`{"tags":[]}`)}), "不认识") {
		t.Fatal("unknown tags")
	}
}
