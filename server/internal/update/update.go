// Package update keeps am-server up to date (docs/release.md, docs/design.md
// §3 更新): it checks GitHub Releases (then the mirrors), verifies
// release.json with the release public key built into am-server, and on a
// click in the admin panel (or by itself at night when update.auto is on)
// downloads the new am-server, checks its SHA-256, puts it in place of the
// running one and restarts. Running a release, it keeps that release's
// client installer so clients can download it from here (pinned
// connection) when GitHub is slow, and tells them (ClientUpdatePush).
//
// It lives beside the supervisor, not inside the chat server, so updating
// works even when the chat server fails to start.
package update

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/OzakiJUN/am/internal/release"
	"github.com/OzakiJUN/am/server/internal/config"
)

// States of the updater, as the panel shows them.
const (
	StateIdle        = "idle"
	StateChecking    = "checking"
	StateDownloading = "downloading"
	StateRestarting  = "restarting"
	StateError       = "error"
)

const (
	maxManifest = 1 << 20
	maxBinary   = 300 << 20
)

// Options configure an Updater.
type Options struct {
	// Version of the running am-server.
	Version string
	// Exe is the running am-server's path (os.Executable at start).
	Exe string
	// Relaunch is called once the new am-server is in place: stop
	// everything and start the new one.
	Relaunch func()
	// OnClient is called when a (new) client installer is ready to serve.
	OnClient func(version string)
	Log      *slog.Logger
}

// Status is what the panel shows.
type Status struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Date      string `json:"date"`
	Notes     string `json:"notes"`
	Newer     bool   `json:"newer"`
	CheckedAt int64  `json:"checked_at"`
	State     string `json:"state"`
	Error     string `json:"error"`
	Done      int64  `json:"done"`
	Total     int64  `json:"total"`
	// CanUpdate: this build can replace itself ("" reason = yes).
	CanUpdate bool   `json:"can_update"`
	Why       string `json:"why"`
	Auto      bool   `json:"auto"`
	AutoAt    string `json:"auto_at"`
	Client    string `json:"client"` // client installer kept here
}

// Updater checks for and installs updates.
type Updater struct {
	opts   Options
	github string // https://github.com (tests point it elsewhere)
	pub    string // release public key ("" = release.PublicKey)
	now    func() time.Time

	mu        sync.Mutex
	cfg       config.Update
	dataDir   string
	latest    *release.Manifest
	raw, sig  []byte // the latest manifest as published
	checkedAt time.Time
	state     string
	errMsg    string
	done      int64
	total     int64
	autoDay   string // the day auto-update last tried
	client    string // version of the kept client installer
	busy      bool
	wake      chan struct{}
}

// New makes an updater; Configure it before Run.
func New(opts Options) *Updater {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	return &Updater{opts: opts, github: "https://github.com", now: time.Now, state: StateIdle,
		cfg: config.Defaults().Update, wake: make(chan struct{}, 1)}
}

// SetGitHub points the updater at another GitHub (tests).
func (u *Updater) SetGitHub(base string) { u.github = strings.TrimRight(base, "/") }

// SetPublicKey replaces the built-in release key (tests).
func (u *Updater) SetPublicKey(pub string) { u.pub = pub }

// Configure takes the [update] settings and the data folder (every time the
// chat server starts, so changes in the panel apply after a restart). The
// first call also loads the client installer kept from before.
func (u *Updater) Configure(c config.Update, dataDir string) {
	u.mu.Lock()
	first := u.dataDir == ""
	u.cfg, u.dataDir = c, dataDir
	u.mu.Unlock()
	if first {
		u.cleanOld()
		u.loadKept()
	}
	select {
	case u.wake <- struct{}{}:
	default:
	}
}

func (u *Updater) config() (config.Update, string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.cfg, u.dataDir
}

// why tells why this build can't replace itself ("" = it can).
func (u *Updater) why() string {
	pub := u.pub
	if pub == "" {
		pub = release.PublicKey
	}
	switch {
	case pub == "":
		return release.ErrNoKey.Error()
	case release.ServerFile(runtime.GOOS, runtime.GOARCH) == "":
		return "这个系统（" + runtime.GOOS + "/" + runtime.GOARCH + "）没有现成的更新包"
	case u.opts.Exe == "" || strings.Contains(u.opts.Exe, "go-build"):
		return "开发时用 go run 运行的，不能自己更新"
	}
	return ""
}

// Status is the panel's view.
func (u *Updater) Status() Status {
	why := u.why()
	u.mu.Lock()
	defer u.mu.Unlock()
	st := Status{Current: u.opts.Version, State: u.state, Error: u.errMsg, Done: u.done, Total: u.total,
		CanUpdate: why == "", Why: why, Auto: u.cfg.Auto, AutoAt: u.cfg.AutoAt, Client: u.client}
	if !u.checkedAt.IsZero() {
		st.CheckedAt = u.checkedAt.UnixMilli()
	}
	if m := u.latest; m != nil {
		st.Latest, st.Date, st.Notes = m.Version, m.Date, m.Notes
		st.Newer = release.Compare(m.Version, u.opts.Version) > 0
	}
	return st
}

// Run checks every update.check_hours and updates by itself at
// update.auto_at when update.auto is on. It returns when ctx ends.
func (u *Updater) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		u.tick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-u.wake:
		}
	}
}

func (u *Updater) tick(ctx context.Context) {
	c, _ := u.config()
	u.mu.Lock()
	due := c.Check && (u.checkedAt.IsZero() || u.now().Sub(u.checkedAt) >= time.Duration(c.CheckHours)*time.Hour)
	u.mu.Unlock()
	if due {
		if err := u.Check(ctx); err != nil {
			u.opts.Log.Warn("update check failed", "err", err)
		}
	}
	if u.autoDue() {
		u.opts.Log.Info("updating by itself (update.auto)")
		if err := u.Apply(ctx); err != nil {
			u.opts.Log.Warn("automatic update failed", "err", err)
		}
	}
}

// autoDue: update.auto, a newer version, inside the hour after auto_at, not
// tried yet today.
func (u *Updater) autoDue() bool {
	st := u.Status()
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.cfg.Auto || !st.Newer || !st.CanUpdate {
		return false
	}
	now := u.now()
	at, err := time.ParseInLocation("15:04", u.cfg.AutoAt, now.Location())
	if err != nil {
		return false
	}
	start := time.Date(now.Year(), now.Month(), now.Day(), at.Hour(), at.Minute(), 0, 0, now.Location())
	day := now.Format("2006-01-02")
	if now.Before(start) || now.Sub(start) >= time.Hour || u.autoDay == day {
		return false
	}
	u.autoDay = day
	return true
}

func (u *Updater) begin(state string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.busy {
		return errors.New("正在检查或更新，等一下")
	}
	u.busy, u.state, u.errMsg, u.done, u.total = true, state, "", 0, 0
	return nil
}

func (u *Updater) end(err error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.busy = false
	if err != nil {
		u.state, u.errMsg = StateError, err.Error()
	} else if u.state != StateRestarting {
		u.state = StateIdle
	}
}

// Check reads the latest release.json (verified). Running that release
// already, it also makes sure its client installer is kept here.
func (u *Updater) Check(ctx context.Context) (err error) {
	if err := u.begin(StateChecking); err != nil {
		return err
	}
	defer func() { u.end(err) }()
	c, _ := u.config()
	base := u.github + "/" + c.Repo + "/releases/latest/download/"
	raw, err := u.fetch(ctx, c, base+release.ManifestName, maxManifest, nil)
	if err != nil {
		return err
	}
	sig, err := u.fetch(ctx, c, base+release.SignatureName, 4096, nil)
	if err != nil {
		return err
	}
	m, err := release.Load(raw, string(sig), u.pub)
	if err != nil {
		return err
	}
	u.mu.Lock()
	u.latest, u.raw, u.sig, u.checkedAt = m, raw, sig, u.now()
	u.mu.Unlock()
	u.opts.Log.Info("update check", "running", u.opts.Version, "latest", m.Version)
	if c.KeepClient && release.Compare(u.opts.Version, m.Version) >= 0 {
		return u.keepClient(ctx, c, m, raw, sig)
	}
	return nil
}

// Apply downloads the latest am-server, puts it in place and relaunches.
func (u *Updater) Apply(ctx context.Context) (err error) {
	if why := u.why(); why != "" {
		return errors.New(why)
	}
	u.mu.Lock()
	m := u.latest
	u.mu.Unlock()
	if m == nil {
		if err := u.Check(ctx); err != nil {
			return err
		}
		u.mu.Lock()
		m = u.latest
		u.mu.Unlock()
	}
	if release.Compare(m.Version, u.opts.Version) <= 0 {
		return errors.New("已经是最新版了")
	}
	f := m.File(release.ServerFile(runtime.GOOS, runtime.GOARCH))
	if f == nil {
		return fmt.Errorf("%s 里没有这个系统的 am-server", m.Version)
	}
	if err := u.begin(StateDownloading); err != nil {
		return err
	}
	defer func() { u.end(err) }()
	c, _ := u.config()
	tmp := u.opts.Exe + ".new"
	if err := u.download(ctx, c, m, f, tmp); err != nil {
		return err
	}
	if err := replaceExe(u.opts.Exe, tmp); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("替换 am-server 失败（文件夹要能写）：%w", err)
	}
	u.opts.Log.Info("am-server updated, restarting", "from", u.opts.Version, "to", m.Version)
	u.mu.Lock()
	u.state = StateRestarting
	u.mu.Unlock()
	if u.opts.Relaunch != nil {
		go u.opts.Relaunch()
	}
	return nil
}

// ---- the client installer kept here ----

func (u *Updater) keptDir() string {
	_, dir := u.config()
	return filepath.Join(dir, "update")
}

func (u *Updater) keepClient(ctx context.Context, c config.Update, m *release.Manifest, raw, sig []byte) error {
	f := m.File(release.ClientInstaller)
	if f == nil {
		return nil
	}
	u.mu.Lock()
	have := u.client == m.Version
	u.mu.Unlock()
	if have {
		return nil
	}
	dir := u.keptDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	u.mu.Lock()
	u.state = StateDownloading
	u.mu.Unlock()
	path := filepath.Join(dir, release.ClientInstaller)
	if err := u.download(ctx, c, m, f, path+".part"); err != nil {
		return fmt.Errorf("客户端安装包：%w", err)
	}
	if err := os.Rename(path+".part", path); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, release.SignatureName), sig, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, release.ManifestName), raw, 0o644); err != nil {
		return err
	}
	u.setClient(m.Version)
	return nil
}

func (u *Updater) setClient(v string) {
	u.mu.Lock()
	u.client = v
	u.mu.Unlock()
	u.opts.Log.Info("client installer kept for clients", "version", v)
	if u.opts.OnClient != nil {
		u.opts.OnClient(v)
	}
}

// loadKept picks up the installer kept before a restart (checked again).
func (u *Updater) loadKept() {
	dir := u.keptDir()
	raw, err1 := os.ReadFile(filepath.Join(dir, release.ManifestName))
	sig, err2 := os.ReadFile(filepath.Join(dir, release.SignatureName))
	if err1 != nil || err2 != nil {
		return
	}
	m, err := release.Load(raw, string(sig), u.pub)
	if err != nil {
		return
	}
	f := m.File(release.ClientInstaller)
	if f == nil || checkFile(f, filepath.Join(dir, release.ClientInstaller)) != nil {
		return
	}
	u.mu.Lock()
	u.client = m.Version
	u.mu.Unlock()
}

// Client returns the kept installer's version, the manifest and signature
// it was verified with, and its path ("" = none).
func (u *Updater) Client() (version string, raw, sig []byte, path string) {
	u.mu.Lock()
	v := u.client
	u.mu.Unlock()
	if v == "" {
		return "", nil, nil, ""
	}
	dir := u.keptDir()
	raw, err1 := os.ReadFile(filepath.Join(dir, release.ManifestName))
	sig, err2 := os.ReadFile(filepath.Join(dir, release.SignatureName))
	if err1 != nil || err2 != nil {
		return "", nil, nil, ""
	}
	return v, raw, sig, filepath.Join(dir, release.ClientInstaller)
}

// ClientVersion is the kept installer's version ("" = none).
func (u *Updater) ClientVersion() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.client
}

// cleanOld removes the am-server replaced by the last update (Windows can't
// delete a running exe, so it was renamed).
func (u *Updater) cleanOld() {
	if u.opts.Exe != "" {
		_ = os.Remove(u.opts.Exe + ".old")
		_ = os.Remove(u.opts.Exe + ".new")
	}
}

// replaceExe puts next in place of the running exe. Windows lets a running
// exe be renamed (not deleted): exe -> exe.old, next -> exe. Elsewhere a
// rename over it is enough.
func replaceExe(exe, next string) error {
	if err := os.Chmod(next, 0o755); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		return os.Rename(next, exe)
	}
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(next, exe); err != nil {
		_ = os.Rename(old, exe)
		return err
	}
	return nil
}

// ---- downloads ----

// urls: GitHub itself, then every mirror in front of it.
func urls(c config.Update, u string) []string {
	out := []string{u}
	for _, m := range c.Mirrors {
		out = append(out, strings.TrimRight(m, "/")+"/"+u)
	}
	return out
}

func client(c config.Update) *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = http.ProxyFromEnvironment
	if p, err := url.Parse(c.Proxy); err == nil && c.Proxy != "" {
		tr.Proxy = http.ProxyURL(p)
	}
	tr.ResponseHeaderTimeout = 30 * time.Second
	return &http.Client{Transport: tr}
}

// fetch reads a small file from the first source that answers.
func (u *Updater) fetch(ctx context.Context, c config.Update, u0 string, max int64, _ func(int64)) ([]byte, error) {
	var errs []string
	for _, src := range urls(c, u0) {
		var buf strings.Builder
		_, err := u.get(ctx, c, src, max, &buf, nil)
		if err == nil {
			return []byte(buf.String()), nil
		}
		errs = append(errs, err.Error())
	}
	return nil, fmt.Errorf("连不上 GitHub 也连不上镜像：%s", strings.Join(errs, "；"))
}

// download fetches a release file into path and checks it against the
// manifest; a source that fails or sends the wrong bytes is skipped.
func (u *Updater) download(ctx context.Context, c config.Update, m *release.Manifest, f *release.File, path string) error {
	u.mu.Lock()
	u.done, u.total = 0, f.Size
	u.mu.Unlock()
	var errs []string
	for _, src := range urls(c, u.github+"/"+c.Repo+"/releases/download/"+m.Tag()+"/"+f.Name) {
		err := u.downloadFrom(ctx, c, src, f, path)
		if err == nil {
			return nil
		}
		_ = os.Remove(path)
		errs = append(errs, err.Error())
		if ctx.Err() != nil {
			break
		}
	}
	return fmt.Errorf("下载 %s 失败：%s", f.Name, strings.Join(errs, "；"))
}

func (u *Updater) downloadFrom(ctx context.Context, c config.Update, src string, f *release.File, path string) error {
	out, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := u.get(ctx, c, src, min(f.Size, maxBinary), io.MultiWriter(out, h), func(done int64) {
		u.mu.Lock()
		u.done = done
		u.mu.Unlock()
	})
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return release.CheckFile(f, n, h.Sum(nil))
}

// get streams one URL into w (at most max bytes). It gives up when no byte
// arrives for a minute, so a stuck source falls through to the next one.
func (u *Updater) get(ctx context.Context, c config.Update, src string, max int64, w io.Writer, progress func(int64)) (int64, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "am-server/"+u.opts.Version)
	resp, err := client(c).Do(req)
	if err != nil {
		return 0, shortErr(src, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("%s: HTTP %d", host(src), resp.StatusCode)
	}
	stall := time.AfterFunc(time.Minute, cancel)
	defer stall.Stop()
	var n int64
	buf := make([]byte, 64<<10)
	for {
		k, rerr := resp.Body.Read(buf)
		if k > 0 {
			stall.Reset(time.Minute)
			if n+int64(k) > max {
				return n, fmt.Errorf("%s: 文件太大", host(src))
			}
			if _, err := w.Write(buf[:k]); err != nil {
				return n, err
			}
			n += int64(k)
			if progress != nil {
				progress(n)
			}
		}
		if errors.Is(rerr, io.EOF) {
			return n, nil
		}
		if rerr != nil {
			return n, shortErr(src, rerr)
		}
	}
}

func host(src string) string {
	if p, err := url.Parse(src); err == nil {
		return p.Host
	}
	return src
}

func shortErr(src string, err error) error {
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("%s: 太久没有数据", host(src))
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return fmt.Errorf("%s: %v", host(src), err)
}

func checkFile(f *release.File, path string) error {
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	var h hash.Hash = sha256.New()
	n, err := io.Copy(h, in)
	if err != nil {
		return err
	}
	return release.CheckFile(f, n, h.Sum(nil))
}
