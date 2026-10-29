// am-server is the AM chat server.
//
// Double-click it (Windows) and it runs in the background with a tray icon
// and opens its admin panel in the browser. From a terminal:
//
//	am-server [-config config.toml] [-headless] [-autostart]   run the server
//	am-server panel [-config config.toml]                        print the admin panel login URL
//	am-server setup-db [-config config.toml]                     PostgreSQL only: create the database user and database
//	am-server version
//
// Relative paths in the config (data_dir, ...) are relative to the folder
// of the config file. Without -config, that is the folder of am-server.exe
// on Windows and the current folder elsewhere.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/term"

	"github.com/OzakiJUN/am/server/internal/admin"
	"github.com/OzakiJUN/am/server/internal/config"
	"github.com/OzakiJUN/am/server/internal/desktop"
	"github.com/OzakiJUN/am/server/internal/logx"
	"github.com/OzakiJUN/am/server/internal/supervisor"
)

// Set at build time with -ldflags "-X main.version=...".
var version = "dev"

var hasConsole bool

func main() {
	hasConsole = desktop.SetupConsole()
	if len(os.Args) > 1 && !strings.HasPrefix(os.Args[1], "-") {
		cmd, args := os.Args[1], os.Args[2:]
		var err error
		switch cmd {
		case "setup-db":
			err = setupDB(args)
		case "panel":
			err = printPanel(args)
		case "version":
			fmt.Println(version)
		default:
			err = fmt.Errorf("unknown command %q (use: panel, setup-db, version)", cmd)
		}
		if err != nil {
			fatal(err)
		}
		return
	}
	if err := run(os.Args[1:]); err != nil {
		fatal(err)
	}
}

// fatal reports an error where the user can see it: the terminal, or a
// message box when started by double-click on Windows.
func fatal(err error) {
	if hasConsole {
		fmt.Fprintln(os.Stderr, "error:", err)
	} else {
		desktop.MessageBox("AM 服务器无法启动", err.Error())
	}
	os.Exit(1)
}

// prepare resolves the config path and switches to its folder, so relative
// paths in the config work the same however am-server was started.
func prepare(cfgFlag string, explicit bool) (string, error) {
	path := cfgFlag
	if !explicit && runtime.GOOS == "windows" {
		if exe, err := os.Executable(); err == nil && !strings.Contains(exe, "go-build") {
			path = filepath.Join(filepath.Dir(exe), cfgFlag)
		}
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		return "", err
	}
	if err := os.Chdir(filepath.Dir(abs)); err != nil {
		return "", err
	}
	return abs, nil
}

func parseConfigFlag(fs *flag.FlagSet, args []string) (string, error) {
	cfgPath := fs.String("config", "config.toml", "path to config file")
	_ = fs.Parse(args)
	explicit := false
	fs.Visit(func(f *flag.Flag) { explicit = explicit || f.Name == "config" })
	return prepare(*cfgPath, explicit)
}

func run(args []string) error {
	fs := flag.NewFlagSet("am-server", flag.ExitOnError)
	headless := fs.Bool("headless", false, "no tray icon and no browser window (servers, services)")
	autostart := fs.Bool("autostart", false, "started with Windows: don't open the browser")
	cfgPath, err := parseConfigFlag(fs, args)
	if err != nil {
		return err
	}

	boot, created, bootErr := supervisor.LoadBootConfig(cfgPath)
	var console io.Writer
	if hasConsole {
		console = os.Stdout
	}
	sink := logx.NewSink(console, 2000)
	defer sink.Close()
	_ = sink.Configure(boot.Log.Level, boot.LogPath(), int64(boot.Log.MaxSizeMB)<<20)
	log := sink.Logger()
	if created {
		log.Info("created config.toml with default settings", "path", cfgPath)
	}
	if bootErr != nil {
		log.Error("config has errors - fix it in the admin panel (Settings)", "err", bootErr)
	}

	desktopMode := !*headless && (runtime.GOOS == "windows" || os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "")
	wantBrowser := desktopMode && boot.Admin.OpenBrowser && !*autostart

	// Only one am-server per config: if one is already running, open its panel.
	if alreadyRunning(boot.Admin.Listen) {
		key, _ := supervisor.AdminKey(boot.Server.DataDir)
		url := supervisor.PanelURL(boot.Admin.Listen, key)
		if desktopMode {
			_ = desktop.OpenBrowser(url)
		}
		if hasConsole {
			fmt.Println("am-server is already running. Admin panel:", url)
		}
		return nil
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	wantTray := desktopMode && boot.Admin.Tray && desktop.TraySupported()
	sup := supervisor.New(supervisor.Options{
		ConfigPath: cfgPath,
		Version:    version,
		Sink:       sink,
		Quit:       stop,
		OnState: func(st admin.State) {
			if wantTray {
				desktop.SetTrayStatus(trayText(st))
			}
		},
		OnAdminReady: func(url string) {
			if wantBrowser {
				_ = desktop.OpenBrowser(url)
			}
			if hasConsole {
				fmt.Println("Admin panel:", url)
			}
		},
	})

	done := make(chan error, 1)
	go func() {
		done <- sup.Run(ctx, boot)
		if wantTray {
			desktop.QuitTray()
		}
	}()
	if wantTray {
		desktop.RunTray(desktop.TrayMenu{
			Tooltip:   "AM 服务器",
			OnOpen:    func() { _ = desktop.OpenBrowser(sup.AdminURL()) },
			OnRestart: sup.Restart,
			OnQuit:    stop,
		}, nil)
	}
	return <-done
}

func trayText(st admin.State) string {
	switch st {
	case admin.StateRunning:
		return "AM 服务器：运行中"
	case admin.StateStarting:
		return "AM 服务器：启动中"
	case admin.StateError:
		return "AM 服务器：出错了，打开面板查看"
	default:
		return "AM 服务器：已停止"
	}
}

// alreadyRunning asks the admin address whether an am-server answers there.
func alreadyRunning(listen string) bool {
	url := supervisor.PanelURL(listen, "")
	if url == "" {
		return false
	}
	c := http.Client{Timeout: time.Second}
	resp, err := c.Get(url + "api/ping")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
	return resp.StatusCode == 200 && strings.Contains(string(b), "am-server")
}

func printPanel(args []string) error {
	fs := flag.NewFlagSet("panel", flag.ExitOnError)
	cfgPath, err := parseConfigFlag(fs, args)
	if err != nil {
		return err
	}
	cfg, _, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	key, err := supervisor.AdminKey(cfg.Server.DataDir)
	if err != nil {
		return err
	}
	fmt.Println(supervisor.PanelURL(cfg.Admin.Listen, key))
	fmt.Println("Open it in a browser on the server machine (or through an SSH tunnel).")
	return nil
}

// setupDB creates the database role and database named in database.url,
// using a PostgreSQL superuser account.
func setupDB(args []string) error {
	fs := flag.NewFlagSet("setup-db", flag.ExitOnError)
	adminUser := fs.String("admin-user", "postgres", "PostgreSQL superuser name")
	adminPass := fs.String("admin-password", "", "superuser password (asked interactively if empty; PGPASSWORD also works)")
	cfgPath, err := parseConfigFlag(fs, args)
	if err != nil {
		return err
	}
	cfg, created, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	if created {
		fmt.Println("Created", cfgPath, "with default settings (random database password).")
	}
	if cfg.Database.Driver != "postgres" {
		fmt.Println("database.driver is sqlite: nothing to set up, the database file is created on first start.")
		return nil
	}
	target, err := pgx.ParseConfig(cfg.Database.URL)
	if err != nil {
		return fmt.Errorf("database.url: %w", err)
	}
	if target.User == "" || target.Database == "" {
		return errors.New("database.url must include a user and a database name")
	}

	pass := *adminPass
	if pass == "" {
		pass = os.Getenv("PGPASSWORD")
	}
	if pass == "" {
		fmt.Printf("Password for PostgreSQL user %q (set when you installed PostgreSQL): ", *adminUser)
		pass, err = readPassword()
		fmt.Println()
		if err != nil {
			return err
		}
	}

	adminCfg := target.Copy()
	adminCfg.User = *adminUser
	adminCfg.Password = pass
	adminCfg.Database = "postgres"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, err := pgx.ConnectConfig(ctx, adminCfg)
	if err != nil {
		return fmt.Errorf("connect as %s: %w", *adminUser, err)
	}
	defer conn.Close(ctx)

	role := pgx.Identifier{target.User}.Sanitize()
	pwLiteral := "'" + strings.ReplaceAll(target.Password, "'", "''") + "'"

	var exists bool
	if err := conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$1)`, target.User).Scan(&exists); err != nil {
		return err
	}
	if exists {
		if _, err := conn.Exec(ctx, "ALTER ROLE "+role+" LOGIN PASSWORD "+pwLiteral); err != nil {
			return err
		}
		fmt.Printf("User %s already existed; password updated to match config.\n", target.User)
	} else {
		if _, err := conn.Exec(ctx, "CREATE ROLE "+role+" LOGIN PASSWORD "+pwLiteral); err != nil {
			return err
		}
		fmt.Printf("Created user %s.\n", target.User)
	}

	if err := conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)`, target.Database).Scan(&exists); err != nil {
		return err
	}
	if exists {
		fmt.Printf("Database %s already exists.\n", target.Database)
	} else {
		db := pgx.Identifier{target.Database}.Sanitize()
		if _, err := conn.Exec(ctx, "CREATE DATABASE "+db+" OWNER "+role+" ENCODING 'UTF8' TEMPLATE template0"); err != nil {
			return err
		}
		fmt.Printf("Created database %s.\n", target.Database)
	}
	fmt.Println("Database ready. Now start the server.")
	return nil
}

func readPassword() (string, error) {
	fd := int(os.Stdin.Fd())
	if term.IsTerminal(fd) {
		b, err := term.ReadPassword(fd)
		return string(b), err
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	return strings.TrimRight(line, "\r\n"), err
}
