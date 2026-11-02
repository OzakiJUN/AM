package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/OzakiJUN/am/internal/release"
	"github.com/OzakiJUN/am/server/internal/config"
)

const seed = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" // tests only

// fakeGitHub serves one release (latest) at /<repo>/releases/...; when
// broken it answers 500 (a mirror in front of it still works).
type fakeGitHub struct {
	srv          *httptest.Server
	files        map[string][]byte // by name, release.json(.sig) included
	broken       atomic.Bool
	viaMirror    atomic.Int32
	tag, version string
}

func newFake(t *testing.T, version string, server, installer []byte, pub *string) *fakeGitHub {
	f := &fakeGitHub{files: map[string][]byte{}, tag: "v" + version, version: version}
	m := release.Manifest{Version: version, Date: "2026-11-02", Notes: "- 新东西"}
	add := func(name string, b []byte) {
		sum := sha256.Sum256(b)
		f.files[name] = b
		m.Files = append(m.Files, release.File{Name: name, Size: int64(len(b)), SHA256: hex.EncodeToString(sum[:])})
	}
	add(release.ServerFile(runtime.GOOS, runtime.GOARCH), server)
	add(release.ClientInstaller, installer)
	raw, _ := json.Marshal(m)
	sig, p, err := release.Sign(raw, seed)
	if err != nil {
		t.Fatal(err)
	}
	*pub = p
	f.files[release.ManifestName], f.files[release.SignatureName] = raw, []byte(sig)
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if strings.HasPrefix(path, "/mirror/") {
			f.viaMirror.Add(1)
			path = r.URL.Path[len("/mirror/"):]
			path = path[strings.Index(path, "//")+2:]
			path = path[strings.Index(path, "/"):]
		} else if f.broken.Load() {
			http.Error(w, "down", 500)
			return
		}
		for _, prefix := range []string{"/o/am/releases/latest/download/", "/o/am/releases/download/" + f.tag + "/"} {
			if strings.HasPrefix(path, prefix) {
				if b, ok := f.files[path[len(prefix):]]; ok {
					_, _ = w.Write(b)
					return
				}
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func setup(t *testing.T, running string, f *fakeGitHub, pub string) (*Updater, string, *atomic.Int32, *atomic.Value) {
	t.Helper()
	dir := t.TempDir()
	exe := filepath.Join(dir, "am-server")
	if err := os.WriteFile(exe, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	var relaunched atomic.Int32
	var client atomic.Value
	u := New(Options{Version: running, Exe: exe, Relaunch: func() { relaunched.Add(1) }, OnClient: func(v string) { client.Store(v) }})
	u.SetGitHub(f.srv.URL)
	u.SetPublicKey(pub)
	c := config.Defaults().Update
	c.Repo = "o/am"
	c.Mirrors = []string{f.srv.URL + "/mirror"}
	u.Configure(c, filepath.Join(dir, "data"))
	return u, exe, &relaunched, &client
}

func TestCheckAndApply(t *testing.T) {
	if release.ServerFile(runtime.GOOS, runtime.GOARCH) == "" {
		t.Skip("no release build for this platform")
	}
	var pub string
	f := newFake(t, "0.2.0", []byte("new binary"), []byte("installer"), &pub)
	u, exe, relaunched, client := setup(t, "0.1.0", f, pub)
	ctx := context.Background()

	if err := u.Check(ctx); err != nil {
		t.Fatal(err)
	}
	st := u.Status()
	if st.Latest != "0.2.0" || !st.Newer || st.Notes != "- 新东西" || !st.CanUpdate || st.State != StateIdle || st.Client != "" {
		t.Fatalf("status %+v", st)
	}
	// GitHub down: the mirror serves it.
	f.broken.Store(true)
	if err := u.Apply(ctx); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new binary" || f.viaMirror.Load() == 0 {
		t.Fatalf("exe %q, mirror %d", b, f.viaMirror.Load())
	}
	for end := time.Now().Add(2 * time.Second); relaunched.Load() == 0 && time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
	}
	if relaunched.Load() != 1 || u.Status().State != StateRestarting {
		t.Fatalf("relaunched %d, state %s", relaunched.Load(), u.Status().State)
	}

	// The new process (running 0.2.0) keeps the client installer, also after a restart.
	u2, _, _, client2 := setup(t, "0.2.0", f, pub)
	if err := u2.Check(ctx); err != nil {
		t.Fatal(err)
	}
	v, raw, sig, path := u2.Client()
	if v != "0.2.0" || client2.Load() != "0.2.0" || release.Verify(raw, string(sig), pub) != nil {
		t.Fatalf("client %q %v", v, client2.Load())
	}
	if b, _ := os.ReadFile(path); string(b) != "installer" {
		t.Fatalf("installer %q", b)
	}
	_ = client
	u3 := New(Options{Version: "0.2.0", Exe: "/x"})
	u3.SetPublicKey(pub)
	u3.Configure(config.Defaults().Update, filepath.Dir(filepath.Dir(path)))
	if u3.ClientVersion() != "0.2.0" {
		t.Fatal("kept installer not picked up after a restart")
	}
	if err := u2.Apply(ctx); err == nil {
		t.Fatal("updated to the version it runs")
	}
}

func TestBadDownloads(t *testing.T) {
	if release.ServerFile(runtime.GOOS, runtime.GOARCH) == "" {
		t.Skip("no release build for this platform")
	}
	var pub string
	f := newFake(t, "0.2.0", []byte("new binary"), []byte("installer"), &pub)
	ctx := context.Background()

	// A file that doesn't match the manifest (from everywhere): nothing replaced.
	f.files[release.ServerFile(runtime.GOOS, runtime.GOARCH)] = []byte("evil binar")
	u, exe, relaunched, _ := setup(t, "0.1.0", f, pub)
	if err := u.Apply(ctx); err == nil || !strings.Contains(err.Error(), "校验和") {
		t.Fatalf("bad binary: %v", err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old binary" || relaunched.Load() != 0 {
		t.Fatal("replaced by a bad download")
	}
	if st := u.Status(); st.State != StateError || st.Error == "" {
		t.Fatalf("state %+v", st)
	}

	// A manifest signed by someone else (this build trusts another key).
	_, other, _ := release.Sign(nil, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
	u2, _, _, _ := setup(t, "0.1.0", f, other)
	if err := u2.Check(ctx); err == nil || !strings.Contains(err.Error(), "签名") {
		t.Fatalf("foreign signature: %v", err)
	}
	// No key built in.
	u3, _, _, _ := setup(t, "0.1.0", f, "")
	if release.PublicKey == "" {
		if st := u3.Status(); st.CanUpdate || st.Why == "" {
			t.Fatalf("no key: %+v", st)
		}
	}
}

func TestAutoDue(t *testing.T) {
	if release.ServerFile(runtime.GOOS, runtime.GOARCH) == "" {
		t.Skip("no release build for this platform")
	}
	var pub string
	f := newFake(t, "0.2.0", []byte("new"), []byte("i"), &pub)
	u, _, _, _ := setup(t, "0.1.0", f, pub)
	if err := u.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	c := config.Defaults().Update
	c.Repo, c.Auto, c.AutoAt = "o/am", true, "04:00"
	u.Configure(c, "")
	at := func(h, m int) time.Time { return time.Date(2026, 11, 3, h, m, 0, 0, time.Local) }
	u.now = func() time.Time { return at(3, 59) }
	if u.autoDue() {
		t.Fatal("before auto_at")
	}
	u.now = func() time.Time { return at(4, 30) }
	if !u.autoDue() || u.autoDue() {
		t.Fatal("once inside the hour")
	}
	u.now = func() time.Time { return at(5, 1).AddDate(0, 0, 1) }
	if u.autoDue() {
		t.Fatal("after the hour")
	}
}
