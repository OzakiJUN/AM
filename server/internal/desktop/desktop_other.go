//go:build !windows

package desktop

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

// SetupConsole: other systems always have stdout.
func SetupConsole() bool { return true }

// OpenBrowser opens url in the default browser if there is a desktop.
func OpenBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
			return errors.New("no desktop session")
		}
		return exec.Command("xdg-open", url).Start()
	}
}

// MessageBox prints to stderr (no GUI dialogs outside Windows).
func MessageBox(title, text string) { fmt.Fprintf(os.Stderr, "%s: %s\n", title, text) }

func AutostartSupported() bool { return false }
func AutostartEnabled() bool   { return false }
func SetAutostart(enabled bool, exe string, args []string) error {
	return errors.New("not supported on this system")
}

func TraySupported() bool                { return false }
func RunTray(m TrayMenu, onReady func()) {}
func SetTrayStatus(text string)          {}
func QuitTray()                          {}
