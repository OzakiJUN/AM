// Package supervisor runs the chat server inside a restartable loop and
// keeps the admin panel up the whole time, so the panel can show start-up
// errors, let the owner fix the settings and restart without touching a
// terminal.
package supervisor

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/OzakiJUN/am/server/internal/admin"
	"github.com/OzakiJUN/am/server/internal/app"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/logx"
	"github.com/OzakiJUN/am/server/internal/tlsutil"
)

// Options configure a Supervisor.
type Options struct {
	ConfigPath string
	Version    string
	Sink       *logx.Sink
	// OnState is called (from any goroutine) whenever the server state
	// changes, e.g. to update the tray icon's status line.
	OnState func(admin.State)
	// Quit is called when the panel asks to stop am-server completely.
	Quit func()
	// OnAdminReady is called once the admin panel accepts connections,
	// with its one-click login URL.
	OnAdminReady func(url string)
}

// Supervisor owns the admin panel listener and the (re)startable chat server.
type Supervisor struct {
	opts      Options
	log       *slog.Logger
	restartCh chan struct{}

	mu       sync.Mutex
	state    admin.State
	errMsg   string
	cfg      *config.Config // config of the running server
	cfgText  string         // file content it was loaded from
	app      *app.App
	fp       []byte
	started  time.Time
	boot     string // bootstrap invite while there are no users
	adminURL string
	adminKey string
}

// New creates a supervisor. Call Run to start everything.
func New(opts Options) *Supervisor {
	return &Supervisor{
		opts:      opts,
		log:       opts.Sink.Logger(),
		restartCh: make(chan struct{}, 1),
		state:     admin.StateStarting,
	}
}

// Logger is the process-wide logger.
func (s *Supervisor) Logger() *slog.Logger { return s.log }

// AdminURL is the panel's one-click login URL (valid after Prepare).
func (s *Supervisor) AdminURL() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.adminURL
}

// LoadBootConfig reads the config for the parts needed before the server
// starts (admin panel address, data folder). If the file is broken the
// defaults are used so the panel can still start and show the error.
func LoadBootConfig(path string) (cfg *config.Config, created bool, err error) {
	cfg, created, err = config.Load(path)
	if err != nil {
		return config.Defaults(), false, err
	}
	return cfg, created, nil
}

// AdminKey returns the panel login key stored in the data folder, creating
// it on first use.
func AdminKey(dataDir string) (string, error) {
	path := filepath.Join(dataDir, "admin_key.txt")
	if b, err := os.ReadFile(path); err == nil {
		if k := strings.TrimSpace(string(b)); len(k) >= 16 {
			return k, nil
		}
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	key := base64.RawURLEncoding.EncodeToString(buf)
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return "", err
	}
	return key, os.WriteFile(path, []byte(key+"\n"), 0o600)
}

// PanelURL builds the browser URL for an admin listen address.
func PanelURL(listen, key string) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return ""
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	u := "http://" + net.JoinHostPort(host, port) + "/"
	if key != "" {
		u += "login?key=" + key
	}
	return u
}

// Run starts the admin panel and the chat server, and restarts the chat
// server whenever Restart is called. It returns when ctx is cancelled, or
// with an error if the admin panel cannot listen.
func (s *Supervisor) Run(ctx context.Context, boot *config.Config) error {
	key, err := AdminKey(boot.Server.DataDir)
	if err != nil {
		return fmt.Errorf("admin key: %w", err)
	}
	adminLn, err := net.Listen("tcp", boot.Admin.Listen)
	if err != nil {
		return fmt.Errorf("admin panel cannot listen on %s: %w", boot.Admin.Listen, err)
	}
	s.mu.Lock()
	s.adminKey = key
	s.adminURL = PanelURL(boot.Admin.Listen, key)
	s.mu.Unlock()

	adminSrv := &http.Server{
		Handler:           admin.New(s, key, boot.Admin.Listen, s.log),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		if err := adminSrv.Serve(adminLn); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.log.Error("admin panel stopped", "err", err)
		}
	}()
	s.log.Info("admin panel ready (login key in data/admin_key.txt, or run: am-server panel)",
		"url", PanelURL(boot.Admin.Listen, ""))
	if s.opts.OnAdminReady != nil {
		s.opts.OnAdminReady(s.AdminURL())
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = adminSrv.Shutdown(c)
	}()

	for {
		stop := s.startServer(ctx)
		select {
		case <-ctx.Done():
			stop()
			return nil
		case <-s.restartCh:
			s.log.Info("restarting server")
			stop()
		}
	}
}

// startServer loads the config and starts the chat server. Failures are
// recorded as the error state (the panel shows them) instead of returned.
// The returned function stops whatever was started.
func (s *Supervisor) startServer(ctx context.Context) (stop func()) {
	s.setState(admin.StateStarting, "")
	text, err := os.ReadFile(s.opts.ConfigPath)
	var cfg *config.Config
	if err == nil {
		cfg, err = config.Parse(string(text))
	}
	if err != nil {
		s.fail(fmt.Errorf("配置文件 %s 有错误：%w", s.opts.ConfigPath, err))
		return func() {}
	}
	if err := s.opts.Sink.Configure(cfg.Log.Level, cfg.LogPath(), int64(cfg.Log.MaxSizeMB)<<20); err != nil {
		s.log.Warn("cannot open log file", "err", err)
	}
	s.log.Info("starting am-server", "version", s.opts.Version, "config", s.opts.ConfigPath)

	runCtx, cancel := context.WithCancel(ctx)
	a, err := app.New(runCtx, cfg, s.log)
	if err != nil {
		cancel()
		if cfg.Database.Driver == "postgres" {
			err = fmt.Errorf("%w（如果数据库还没建，先运行 postgres_setup_db.bat）", err)
		}
		s.fail(fmt.Errorf("数据库打不开：%w", err))
		return func() {}
	}
	cleanup := func() { cancel(); a.Close() }

	boot, err := a.Account.EnsureBootstrapInvite(runCtx)
	if err != nil {
		cleanup()
		s.fail(err)
		return func() {}
	}
	if boot != "" {
		path := filepath.Join(cfg.Server.DataDir, "bootstrap_invite.txt")
		_ = os.WriteFile(path, []byte(boot+"\n"), 0o600)
		s.log.Info("no users yet - register the first (admin) account with this invite code",
			"invite", boot, "also_saved_to", path)
	}

	srv := &http.Server{Handler: a.Handler, ReadHeaderTimeout: 10 * time.Second}
	var fp []byte
	switch cfg.TLS.Mode {
	case "self_signed", "files":
		var cert tls.Certificate
		if cfg.TLS.Mode == "self_signed" {
			cert, err = tlsutil.LoadOrCreateSelfSigned(filepath.Join(cfg.Server.DataDir, "tls"), cfg.TLS.Hosts)
		} else {
			cert, err = tls.LoadX509KeyPair(cfg.TLS.CertFile, cfg.TLS.KeyFile)
		}
		if err != nil {
			cleanup()
			s.fail(fmt.Errorf("证书加载失败：%w", err))
			return func() {}
		}
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		if cfg.TLS.Mode == "self_signed" {
			sum := sha256.Sum256(cert.Certificate[0])
			fp = sum[:]
			s.log.Info("TLS self-signed certificate - clients pin this fingerprint (it is in the connection code)",
				"fingerprint", tlsutil.Fingerprint(cert))
		}
	}

	ln, err := app.Listen(cfg.Server.Listen, cfg.Server.ProxyProtocol)
	if err != nil {
		cleanup()
		s.fail(fmt.Errorf("无法监听 %s，端口可能被别的程序占用了（%v）", cfg.Server.Listen, err))
		return func() {}
	}
	if cfg.Server.ProxyProtocol {
		s.log.Info("proxy protocol enabled (trusted from localhost only)")
	}
	go a.Janitor.Run(runCtx)

	served := make(chan struct{})
	go func() {
		defer close(served)
		var err error
		if srv.TLSConfig != nil {
			err = srv.ServeTLS(ln, "", "")
		} else {
			err = srv.Serve(ln)
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.fail(fmt.Errorf("服务器意外停止：%w", err))
		}
	}()
	s.log.Info("listening", "addr", cfg.Server.Listen, "tls", cfg.TLS.Mode, "database", cfg.Database.Driver)

	s.mu.Lock()
	s.cfg, s.cfgText, s.app, s.fp, s.boot, s.started = cfg, string(text), a, fp, boot, time.Now()
	s.mu.Unlock()
	s.setState(admin.StateRunning, "")

	return func() {
		s.mu.Lock()
		s.app = nil
		s.mu.Unlock()
		a.Hub.CloseAll()
		c, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancelShutdown()
		_ = srv.Shutdown(c)
		<-served
		cleanup()
		s.setState(admin.StateStopped, "")
		s.log.Info("server stopped")
	}
}

func (s *Supervisor) fail(err error) {
	s.log.Error("server not running", "err", err)
	s.setState(admin.StateError, err.Error())
}

func (s *Supervisor) setState(st admin.State, msg string) {
	s.mu.Lock()
	s.state, s.errMsg = st, msg
	s.mu.Unlock()
	if s.opts.OnState != nil {
		s.opts.OnState(st)
	}
}

// ---- admin.Runtime ----

// Restart asks the loop to restart the chat server (reloading config.toml).
func (s *Supervisor) Restart() {
	select {
	case s.restartCh <- struct{}{}:
	default: // a restart is already pending
	}
}

// Quit stops am-server completely.
func (s *Supervisor) Quit() {
	if s.opts.Quit != nil {
		s.opts.Quit()
	}
}

// Snapshot describes the current server for the admin panel.
func (s *Supervisor) Snapshot() admin.Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return admin.Snapshot{
		State:           s.state,
		Error:           s.errMsg,
		Version:         s.opts.Version,
		ConfigPath:      s.opts.ConfigPath,
		Config:          s.cfg,
		ConfigText:      s.cfgText,
		App:             s.app,
		Fingerprint:     s.fp,
		StartedAt:       s.started,
		BootstrapInvite: s.boot,
		Logs:            s.opts.Sink.Ring(),
	}
}

// ClearBootstrap forgets the bootstrap invite once someone registered.
func (s *Supervisor) ClearBootstrap() {
	s.mu.Lock()
	s.boot = ""
	s.mu.Unlock()
}
