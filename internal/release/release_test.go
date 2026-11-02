package release

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

const seed = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" // 0..31, tests only

func manifest(version string) []byte {
	return []byte(`{"version":"` + version + `","date":"2026-11-02","notes":"新东西","files":[` +
		`{"name":"AM-setup.exe","size":3,"sha256":"` + strings.Repeat("ab", 32) + `"},` +
		`{"name":"am-server-windows-amd64.exe","size":5,"sha256":"` + strings.Repeat("cd", 32) + `"}]}`)
}

func TestSignVerify(t *testing.T) {
	data := manifest("0.2.0")
	sig, pub, err := Sign(data, seed)
	if err != nil {
		t.Fatal(err)
	}
	m, err := Load(data, sig+"\n", pub)
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != "0.2.0" || m.Tag() != "v0.2.0" || m.File(ClientInstaller).Size != 3 || m.File("nope") != nil {
		t.Fatalf("manifest %+v", m)
	}
	// One byte changed, someone else's key, a broken signature, no key at all.
	if _, err := Load(append([]byte(nil), manifest("0.2.1")...), sig, pub); err == nil {
		t.Fatal("changed manifest accepted")
	}
	_, other, _ := Sign(data, base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err := Verify(data, sig, other); err == nil {
		t.Fatal("wrong key accepted")
	}
	if err := Verify(data, "xx", pub); err == nil {
		t.Fatal("garbage signature accepted")
	}
	if PublicKey == "" {
		if err := Verify(data, sig, ""); err != ErrNoKey {
			t.Fatalf("no key: %v", err)
		}
	}
	if _, _, err := Sign(data, "short"); err == nil {
		t.Fatal("bad seed accepted")
	}
}

func TestParse(t *testing.T) {
	bad := []string{
		`{"version":"v0.2.0","files":[]}`,
		`{"version":"latest","files":[]}`,
		`{"version":"0.2.0","files":[{"name":"../x","size":1,"sha256":"` + strings.Repeat("a", 64) + `"}]}`,
		`{"version":"0.2.0","files":[{"name":"x","size":0,"sha256":"` + strings.Repeat("a", 64) + `"}]}`,
		`{"version":"0.2.0","files":[{"name":"x","size":1,"sha256":"ABC"}]}`,
		`{"version":"0.2.0","files":[{"name":"x","size":1,"sha256":"` + strings.Repeat("a", 64) + `"},{"name":"x","size":1,"sha256":"` + strings.Repeat("a", 64) + `"}]}`,
		`not json`,
	}
	for _, b := range bad {
		if _, err := Parse([]byte(b)); err == nil {
			t.Errorf("accepted %s", b)
		}
	}
	if _, err := Parse([]byte(`{"version":"1.0.0-beta.2","files":[]}`)); err != nil {
		t.Fatal(err)
	}
}

func TestCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.2.0", "0.1.9", 1},
		{"v0.2.0", "0.2.0", 0},
		{"0.10.0", "0.9.9", 1},
		{"1.0.0-beta.1", "1.0.0", -1},
		{"1.0.0-beta.2", "1.0.0-beta.1", 1},
		{"dev", "0.0.1", -1},
		{"main-abc1234", "dev", 0},
		{"0.2.0", "dev", 1},
	}
	for _, c := range cases {
		if got := Compare(c.a, c.b); got != c.want {
			t.Errorf("Compare(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
	if Valid("dev") || !Valid("v1.2.3") {
		t.Fatal("Valid")
	}
}

func TestCheckFile(t *testing.T) {
	sum := sha256.Sum256([]byte("abc"))
	f := &File{Name: "x", Size: 3}
	f.SHA256 = strings.ToLower(strings.TrimSpace(hexOf(sum[:])))
	if err := CheckFile(f, 3, sum[:]); err != nil {
		t.Fatal(err)
	}
	if err := CheckFile(f, 4, sum[:]); err == nil {
		t.Fatal("wrong size accepted")
	}
	other := sha256.Sum256([]byte("abd"))
	if err := CheckFile(f, 3, other[:]); err == nil {
		t.Fatal("wrong sum accepted")
	}
}

func hexOf(b []byte) string {
	const d = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, d[c>>4], d[c&15])
	}
	return string(out)
}

func TestServerFileAndNotes(t *testing.T) {
	if ServerFile("windows", "amd64") != "am-server-windows-amd64.exe" || ServerFile("linux", "amd64") != "am-server-linux-amd64" || ServerFile("darwin", "arm64") != "" {
		t.Fatal("ServerFile")
	}
	log := "# 更新日志\r\n\r\n## 未发布\r\n\r\n- 还没发\r\n\r\n## 0.2.0（2026-11-02）\r\n\r\n### 新东西\r\n\r\n- 自动更新\r\n\r\n## 0.1.0\r\n\r\n- 第一版\r\n"
	if got := Notes(log, "0.2.0"); got != "### 新东西\n\n- 自动更新" {
		t.Fatalf("notes %q", got)
	}
	if got := Notes(log, "0.1.0"); got != "- 第一版" {
		t.Fatalf("notes %q", got)
	}
	if Notes(log, "0.3.0") != "" {
		t.Fatal("missing version has notes")
	}
}
