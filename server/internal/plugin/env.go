package plugin

// The Python environment plugins run in: one virtualenv under
// data/plugins/venv with NoneBot, the OneBot adapter and whatever the
// approved plugins import. Packages are installed once and remembered.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Base packages every plugin host needs.
var basePackages = []string{"nonebot2[websockets]", "nonebot-adapter-onebot"}

type pyEnv struct {
	dir      string // data/plugins/venv
	python   string // configured interpreter ("" = find one)
	pipIndex string
	log      func(string)

	mu        sync.Mutex // held while creating / installing (minutes)
	installed map[string]bool

	statusMu sync.Mutex
	status   string // "" | preparing | ready | error: …
}

func (e *pyEnv) setStatus(s string) {
	e.statusMu.Lock()
	e.status = s
	e.statusMu.Unlock()
}

// Status for the UI (doesn't wait for an install).
func (e *pyEnv) Status() string {
	e.statusMu.Lock()
	defer e.statusMu.Unlock()
	return e.status
}

// findPython returns a command that runs Python 3.10+.
func (e *pyEnv) findPython(ctx context.Context) ([]string, error) {
	var tries [][]string
	if e.python != "" {
		tries = append(tries, strings.Fields(e.python))
	} else {
		tries = [][]string{{"python3"}, {"python"}}
		if runtime.GOOS == "windows" {
			tries = append([][]string{{"py", "-3"}}, tries...)
		}
	}
	for _, t := range tries {
		out, err := command(ctx, t[0], append(t[1:], "-c", "import sys;print(sys.version_info[0]*100+sys.version_info[1])")...).Output()
		if err != nil {
			continue
		}
		var v int
		fmt.Sscan(strings.TrimSpace(string(out)), &v)
		if v >= 310 {
			return t, nil
		}
	}
	if e.python != "" {
		return nil, fmt.Errorf("plugins.python「%s」不能用（需要 Python 3.10 或更新）", e.python)
	}
	return nil, errors.New("这台电脑上没找到 Python 3.10 或更新的版本：装一个（python.org），或者在 config.toml 的 plugins.python 里写它的路径")
}

// Python is the virtualenv's interpreter.
func (e *pyEnv) Python() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(e.dir, "Scripts", "python.exe")
	}
	return filepath.Join(e.dir, "bin", "python")
}

func (e *pyEnv) markerFile() string { return filepath.Join(e.dir, "am-installed.txt") }

// readyFile is written last when the environment was made completely (with pip).
func (e *pyEnv) readyFile() string { return filepath.Join(e.dir, "am-venv-ready") }

// Ensure makes the virtualenv and installs the packages that are missing.
// Packages that fail to install are reported in the returned error but
// don't stop the others.
func (e *pyEnv) Ensure(ctx context.Context, reqs []string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	// Made halfway (stopped while it was being created) or by an older version: make it again.
	if _, err := os.Stat(e.readyFile()); err != nil {
		e.setStatus("preparing")
		py, err := e.findPython(ctx)
		if err != nil {
			e.setStatus("error: " + err.Error())
			return err
		}
		e.log("creating the Python environment for plugins in " + e.dir)
		if err := os.RemoveAll(e.dir); err != nil {
			e.setStatus("error: " + err.Error())
			return err
		}
		fail := func(out []byte, err error) error {
			err = fmt.Errorf("建 Python 环境失败：%v %s", err, lastLines(out, 3))
			e.setStatus("error: " + err.Error())
			return err
		}
		if out, err := command(ctx, py[0], append(py[1:], "-m", "venv", e.dir)...).CombinedOutput(); err != nil {
			return fail(out, err)
		}
		if out, err := command(ctx, e.Python(), "-m", "pip", "--version").CombinedOutput(); err != nil {
			// Debian / Ubuntu: venv without pip unless python3-venv is installed.
			return fail(out, fmt.Errorf("新环境里没有 pip（Linux 上装 python3-venv）: %w", err))
		}
		if err := os.WriteFile(e.readyFile(), []byte("ok\n"), 0o644); err != nil {
			return fail(nil, err)
		}
		e.installed = nil
	}
	if e.installed == nil {
		e.installed = map[string]bool{}
		if b, err := os.ReadFile(e.markerFile()); err == nil {
			for _, l := range strings.Split(string(b), "\n") {
				if l = strings.TrimSpace(l); l != "" {
					e.installed[l] = true
				}
			}
		}
	}
	var missing []string
	for _, r := range append(append([]string{}, basePackages...), reqs...) {
		if !e.installed[r] {
			missing = append(missing, r)
		}
	}
	if len(missing) == 0 {
		e.setStatus("ready")
		return nil
	}
	e.setStatus("preparing")
	sort.Strings(missing)
	var failed []string
	install := func(pkgs []string) error {
		args := []string{"-m", "pip", "install", "--disable-pip-version-check", "-q"}
		if e.pipIndex != "" {
			args = append(args, "-i", e.pipIndex)
		}
		e.log("pip install " + strings.Join(pkgs, " "))
		cctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
		defer cancel()
		out, err := command(cctx, e.Python(), append(args, pkgs...)...).CombinedOutput()
		if err != nil {
			e.log("pip: " + lastLines(out, 5))
		}
		return err
	}
	if install(missing) != nil {
		// Try one by one so one bad package doesn't block the rest.
		for _, p := range missing {
			if install([]string{p}) != nil {
				failed = append(failed, p)
				continue
			}
			e.installed[p] = true
		}
	} else {
		for _, p := range missing {
			e.installed[p] = true
		}
	}
	var lines []string
	for p := range e.installed {
		lines = append(lines, p)
	}
	sort.Strings(lines)
	_ = os.WriteFile(e.markerFile(), []byte(strings.Join(lines, "\n")+"\n"), 0o644)
	if len(failed) > 0 {
		err := fmt.Errorf("这些包没装上：%s（看日志；可以换个 pip 镜像：config.toml 的 plugins.pip_index）", strings.Join(failed, " "))
		e.setStatus("error: " + err.Error())
		return err
	}
	e.setStatus("ready")
	return nil
}

// command is exec.CommandContext without a console window popping up on Windows.
func command(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	return cmd
}

func lastLines(b []byte, n int) string {
	lines := strings.Split(strings.TrimSpace(string(bytes.ToValidUTF8(b, nil))), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}
