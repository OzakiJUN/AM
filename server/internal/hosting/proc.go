package hosting

// The host clients: one AM client process per approved AI, started with
// `--host <host.json>` (the AI's login, the owner's providers, its work
// folder, a separate browser data folder) and restarted when it exits.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"
)

const logLines = 200

type endpoint struct {
	Address string `json:"address"`
	Plain   bool   `json:"plain"`
	Pin     string `json:"pin,omitempty"`
}

// HostFile is what the host client reads (--host <file>); it deletes the
// file once read. Field names are the client's (lib/ai/host.ts).
type HostFile struct {
	Version   int             `json:"version"`
	Server    endpoint        `json:"server"`
	AIID      string          `json:"aiId"`
	Token     string          `json:"token"`
	Providers json.RawMessage `json:"providers"`
	WorkDir   string          `json:"workDir"`
	// The client's own browser data (not shared with a normal AM client on this computer).
	DataDir string `json:"dataDir"`
	// The AI may use a browser of its own (hosting.allow_browser), with its
	// profile in BrowserDir; without it the client refuses every browser tool.
	Browser    bool   `json:"browser"`
	BrowserDir string `json:"browserDir,omitempty"`
}

type proc struct {
	ai   int64
	mu   sync.Mutex
	err  string
	logs []string
	// Cancels the current client (it starts again).
	kill context.CancelFunc
	stop context.CancelFunc
	done chan struct{}
}

func (p *proc) logf(format string, a ...any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.logs = append(p.logs, time.Now().Format("15:04:05 ")+fmt.Sprintf(format, a...))
	if len(p.logs) > logLines {
		p.logs = p.logs[len(p.logs)-logLines:]
	}
}

type manager struct {
	s      *Service
	ctx    context.Context
	quit   context.CancelFunc
	syncMu sync.Mutex
	kick   chan struct{}

	mu     sync.Mutex
	procs  map[int64]*proc
	ep     *endpoint
	online func(int64) bool
}

func newManager(s *Service) *manager {
	ctx, quit := context.WithCancel(context.Background())
	m := &manager{s: s, ctx: ctx, quit: quit, kick: make(chan struct{}, 1), procs: map[int64]*proc{}}
	go m.loop()
	return m
}

// SetOnline tells the manager how to see whether an AI is connected (the hub).
func (s *Service) SetOnline(fn func(userID int64) bool) {
	s.mgr.mu.Lock()
	s.mgr.online = fn
	s.mgr.mu.Unlock()
}

func (m *manager) setEndpoint(ep endpoint) {
	m.mu.Lock()
	m.ep = &ep
	m.mu.Unlock()
	m.Sync()
}

// Sync catches up with the database soon.
func (m *manager) Sync() {
	select {
	case m.kick <- struct{}{}:
	default:
	}
}

func (m *manager) loop() {
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-tick.C:
		case <-m.kick:
		}
		if err := m.syncNow(m.ctx); err != nil && m.ctx.Err() == nil {
			m.s.log.Error("hosting: sync", "err", err)
		}
	}
}

// waitStopped catches up now and waits until a stopped AI's client is gone.
func (m *manager) waitStopped(ai int64) {
	_ = m.syncNow(m.ctx)
	m.mu.Lock()
	_, running := m.procs[ai]
	m.mu.Unlock()
	if running {
		m.s.log.Warn("hosting: client still running after stop", "ai", ai)
	}
}

func (m *manager) syncNow(ctx context.Context) error {
	m.syncMu.Lock()
	defer m.syncMu.Unlock()
	want := map[int64]bool{}
	m.mu.Lock()
	ready := m.ep != nil
	m.mu.Unlock()
	if m.s.cfg.Enabled && ready {
		list, err := m.s.st.ApprovedHosting(ctx)
		if err != nil {
			return err
		}
		for _, h := range list {
			want[h.AIID] = true
		}
	}
	m.mu.Lock()
	var stop, start []*proc
	for ai, p := range m.procs {
		if !want[ai] {
			stop = append(stop, p)
			delete(m.procs, ai)
		}
	}
	for ai := range want {
		if m.procs[ai] == nil {
			p := &proc{ai: ai, done: make(chan struct{})}
			m.procs[ai] = p
			start = append(start, p)
		}
	}
	m.mu.Unlock()
	for _, p := range stop {
		p.mu.Lock()
		cancel := p.stop
		p.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		select {
		case <-p.done:
		case <-time.After(15 * time.Second):
		}
		m.s.log.Info("hosting: stopped", "ai", p.ai)
	}
	for _, p := range start {
		m.start(p)
	}
	return nil
}

func (m *manager) start(p *proc) {
	ctx, cancel := context.WithCancel(m.ctx)
	p.mu.Lock()
	p.stop = cancel
	p.mu.Unlock()
	go func() {
		defer close(p.done)
		delay := 5 * time.Second
		for ctx.Err() == nil {
			started := time.Now()
			err := m.runOnce(ctx, p)
			if ctx.Err() != nil {
				return
			}
			msg := "客户端退出了"
			if err != nil {
				msg = err.Error()
			}
			p.mu.Lock()
			p.err = msg
			p.mu.Unlock()
			p.logf("stopped: %s; starting again in %s", msg, delay)
			if time.Since(started) > 5*time.Minute {
				delay = 5 * time.Second
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			if delay < 5*time.Minute {
				delay *= 3
			}
		}
	}()
}

// restart makes a running client start again (new keys).
func (m *manager) restart(ai int64) {
	m.mu.Lock()
	p := m.procs[ai]
	m.mu.Unlock()
	if p == nil {
		return
	}
	p.mu.Lock()
	kill := p.kill
	p.mu.Unlock()
	if kill != nil {
		kill()
	}
}

func (m *manager) close() {
	m.quit()
	m.mu.Lock()
	procs := make([]*proc, 0, len(m.procs))
	for _, p := range m.procs {
		procs = append(procs, p)
	}
	m.mu.Unlock()
	for _, p := range procs {
		select {
		case <-p.done:
		case <-time.After(15 * time.Second):
		}
	}
}

// status of a hosted AI's client: off | starting | running | error.
func (m *manager) status(ai int64) (state, errText string, logs []string) {
	m.mu.Lock()
	p := m.procs[ai]
	online := m.online
	ready := m.ep != nil
	m.mu.Unlock()
	if p == nil {
		if !ready && m.s.cfg.Enabled {
			return "starting", "", nil
		}
		return "off", "", nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	logs = append([]string(nil), p.logs...)
	switch {
	case online != nil && online(ai):
		return "running", "", logs
	case p.err != "":
		return "error", p.err, logs
	}
	return "starting", "", logs
}

// runOnce writes the host file and runs one client until it exits.
func (m *manager) runOnce(ctx context.Context, p *proc) error {
	h, err := m.s.st.GetHosting(ctx, p.ai)
	if err != nil {
		return err
	}
	providers, err := m.s.providers(h)
	if err != nil {
		return err
	}
	m.mu.Lock()
	ep := *m.ep
	m.mu.Unlock()
	dir := m.s.aiDir(p.ai)
	work := m.s.WorkDir(p.ai)
	if err := os.MkdirAll(work, 0o700); err != nil {
		return err
	}
	client := ""
	if m.s.cfg.Spawn {
		if client, err = findClient(m.s.cfg.ClientPath); err != nil {
			return err
		}
	}
	token, err := m.s.acct.HostSession(ctx, p.ai, RunnerName)
	if err != nil {
		return err
	}
	abs := func(s string) string {
		if a, err := filepath.Abs(s); err == nil {
			return a
		}
		return s
	}
	hf := HostFile{Version: 1, Server: ep, AIID: strconv.FormatInt(p.ai, 10), Token: token, Providers: providers,
		WorkDir: abs(work), DataDir: abs(filepath.Join(dir, "webview")), Browser: m.s.cfg.Browser}
	if hf.Browser {
		hf.BrowserDir = abs(filepath.Join(dir, "browser"))
	}
	b, _ := json.Marshal(hf)
	file := filepath.Join(dir, "host.json")
	if err := os.WriteFile(file, b, 0o600); err != nil {
		return err
	}
	runCtx, kill := context.WithCancel(ctx)
	defer kill()
	p.mu.Lock()
	p.kill, p.err = kill, ""
	p.mu.Unlock()
	if !m.s.cfg.Spawn {
		// Tests play the client themselves (they read host.json).
		p.logf("waiting for a test client")
		<-runCtx.Done()
		_ = os.Remove(file)
		return nil
	}
	p.logf("starting %s", client)
	cmd := exec.CommandContext(runCtx, client, "--host", file)
	cmd.Dir = dir
	hideWindow(cmd)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("客户端启动不了：%w", err)
	}
	go func() {
		sc := bufio.NewScanner(io.LimitReader(out, 64<<20))
		for sc.Scan() {
			p.logf("%s", sc.Text())
		}
	}()
	err = cmd.Wait()
	// The client deletes the file once read; don't leave the token lying around either way.
	_ = os.Remove(file)
	if runCtx.Err() != nil && ctx.Err() == nil {
		return errors.New("重新启动（换了 key）")
	}
	return err
}

// findClient returns the AM client to run: the configured path, or the
// usual places on Windows.
func findClient(configured string) (string, error) {
	if configured != "" {
		if _, err := os.Stat(configured); err != nil {
			return "", fmt.Errorf("hosting.client_path「%s」找不到", configured)
		}
		return configured, nil
	}
	var tries []string
	if exe, err := os.Executable(); err == nil {
		d := filepath.Dir(exe)
		tries = append(tries, filepath.Join(d, "AM.exe"), filepath.Join(d, "am-client.exe"))
	}
	if runtime.GOOS == "windows" {
		for _, base := range []string{os.Getenv("LOCALAPPDATA"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs"), os.Getenv("ProgramFiles")} {
			if base != "" {
				tries = append(tries, filepath.Join(base, "AM", "AM.exe"), filepath.Join(base, "AM", "am-client.exe"))
			}
		}
	}
	for _, t := range tries {
		if st, err := os.Stat(t); err == nil && !st.IsDir() {
			return t, nil
		}
	}
	return "", errors.New("这台电脑上没找到 AM 客户端（AM.exe）：装一个，或者在 config.toml 的 hosting.client_path 里写它的路径")
}
