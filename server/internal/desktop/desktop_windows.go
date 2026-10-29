//go:build windows

package desktop

import (
	"os"
	"os/exec"
	"strings"
	"syscall"

	"fyne.io/systray"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// SetupConsole makes fmt / log output visible when the GUI build is started
// from a terminal: it attaches to the parent console if stdout is not
// already usable. Returns whether there is a console (or redirect) to write to.
func SetupConsole() bool {
	if usable(os.Stdout) {
		return true
	}
	attach := windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")
	const attachParentProcess = ^uintptr(0) // (DWORD)-1
	if r, _, _ := attach.Call(attachParentProcess); r == 0 {
		return false
	}
	if f := openConsole("CONOUT$", windows.GENERIC_READ|windows.GENERIC_WRITE); f != nil {
		os.Stdout, os.Stderr = f, f
	}
	if f := openConsole("CONIN$", windows.GENERIC_READ|windows.GENERIC_WRITE); f != nil {
		os.Stdin = f
	}
	return true
}

func usable(f *os.File) bool {
	if f == nil {
		return false
	}
	h := windows.Handle(f.Fd())
	if h == 0 || h == windows.InvalidHandle {
		return false
	}
	t, err := windows.GetFileType(h)
	return err == nil && t != windows.FILE_TYPE_UNKNOWN
}

func openConsole(name string, access uint32) *os.File {
	p, _ := windows.UTF16PtrFromString(name)
	h, err := windows.CreateFile(p, access, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil,
		windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return nil
	}
	return os.NewFile(uintptr(h), name)
}

// OpenBrowser opens url in the default browser without flashing a console.
func OpenBrowser(url string) error {
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Start()
}

// MessageBox shows an error dialog (used when the server cannot start and
// there is no console to print to).
func MessageBox(title, text string) {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(text)
	_, _ = windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONERROR)
}

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`
const runValue = "AM Server"

// AutostartSupported reports whether "start with Windows" can be toggled.
func AutostartSupported() bool { return true }

// AutostartEnabled reports whether am-server starts when the user logs in.
func AutostartEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(runValue)
	return err == nil
}

// SetAutostart adds or removes the per-user "Run" entry. The command starts
// this executable with -autostart (no browser window at login).
func SetAutostart(enabled bool, exe string, args []string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !enabled {
		if err := k.DeleteValue(runValue); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	parts := []string{`"` + exe + `"`}
	for _, a := range args {
		if strings.ContainsAny(a, " \t") {
			a = `"` + a + `"`
		}
		parts = append(parts, a)
	}
	return k.SetStringValue(runValue, strings.Join(parts, " "))
}

// TraySupported reports whether RunTray shows an icon on this system.
func TraySupported() bool { return true }

var statusItem *systray.MenuItem

// RunTray shows the tray icon and blocks until QuitTray is called. It must
// run on the main goroutine. onReady runs once the icon is up.
func RunTray(m TrayMenu, onReady func()) {
	systray.Run(func() {
		systray.SetIcon(IconICO)
		systray.SetTooltip(m.Tooltip)
		systray.SetOnTapped(func() { go m.OnOpen() }) // left click opens the panel
		statusItem = systray.AddMenuItem(m.Tooltip, "")
		statusItem.Disable()
		systray.AddSeparator()
		open := systray.AddMenuItem("打开管理面板", "")
		restart := systray.AddMenuItem("重启服务器", "")
		systray.AddSeparator()
		quit := systray.AddMenuItem("退出", "")
		go func() {
			for {
				select {
				case <-open.ClickedCh:
					m.OnOpen()
				case <-restart.ClickedCh:
					m.OnRestart()
				case <-quit.ClickedCh:
					m.OnQuit()
					return
				}
			}
		}()
		if onReady != nil {
			onReady()
		}
	}, nil)
}

// SetTrayStatus updates the status line at the top of the tray menu.
func SetTrayStatus(text string) {
	if statusItem != nil {
		statusItem.SetTitle(text)
		systray.SetTooltip(text)
	}
}

// QuitTray removes the icon and makes RunTray return.
func QuitTray() { systray.Quit() }
