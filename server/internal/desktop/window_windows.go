//go:build windows

package desktop

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"unsafe"

	"github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
)

// PanelWindowTitle is the title of the admin panel window; also used to find
// an already open window.
const PanelWindowTitle = "AM 服务器"

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	procFindWindowW              = user32.NewProc("FindWindowW")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procIsIconic                 = user32.NewProc("IsIconic")
	procGetSystemMetrics         = user32.NewProc("GetSystemMetrics")
	procGetDpiForSystem          = user32.NewProc("GetDpiForSystem")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procCreateIconFromResourceEx = user32.NewProc("CreateIconFromResourceEx")
)

// WindowSupported reports whether the panel can open in its own window
// (WebView2 runtime installed; it ships with Windows 11 and updated Windows 10).
func WindowSupported() bool {
	v, err := webviewloader.GetInstalledVersion()
	return err == nil && v != ""
}

// RunPanelWindow shows the admin panel in its own window and blocks until
// the window is closed. It runs in a separate am-server process ("window"
// command), so a WebView2 problem can never take the server down.
func RunPanelWindow(url string) error {
	if !WindowSupported() {
		return errors.New("WebView2 runtime not installed")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	scale := 1.0
	if dpi, _, _ := procGetDpiForSystem.Call(); dpi >= 96 {
		scale = float64(dpi) / 96
	}
	sw, _, _ := procGetSystemMetrics.Call(0) // SM_CXSCREEN
	sh, _, _ := procGetSystemMetrics.Call(1) // SM_CYSCREEN
	w, h := clamp(int(1200*scale), int(sw)-60), clamp(int(820*scale), int(sh)-80)

	wv := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  filepath.Join(os.Getenv("LOCALAPPDATA"), "AM", "ServerWindow"),
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title: PanelWindowTitle, Width: uint(w), Height: uint(h), Center: true,
		},
	})
	if wv == nil {
		return errors.New("cannot create the WebView2 window")
	}
	defer wv.Destroy()
	setWindowIcon(uintptr(wv.Window()), scale)
	wv.SetSize(int(820*scale), int(560*scale), webview2.HintMin)
	wv.Navigate(url)
	wv.Run()
	return nil
}

func clamp(v, max int) int {
	if max > 400 && v > max {
		return max
	}
	return v
}

// FocusPanelWindow brings an open panel window to the front. It returns
// false when no panel window is open.
func FocusPanelWindow() bool {
	cls, _ := windows.UTF16PtrFromString("webview")
	title, _ := windows.UTF16PtrFromString(PanelWindowTitle)
	hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cls)), uintptr(unsafe.Pointer(title)))
	if hwnd == 0 {
		return false
	}
	if iconic, _, _ := procIsIconic.Call(hwnd); iconic != 0 {
		_, _, _ = procShowWindow.Call(hwnd, 9) // SW_RESTORE
	} else {
		_, _, _ = procShowWindow.Call(hwnd, 5) // SW_SHOW
	}
	_, _, _ = procSetForegroundWindow.Call(hwnd)
	return true
}

// setWindowIcon gives the window the AM icon from the embedded .ico (works
// even when the exe has no icon resource).
func setWindowIcon(hwnd uintptr, scale float64) {
	for _, s := range []struct {
		which uintptr // ICON_SMALL = 0, ICON_BIG = 1
		size  int
	}{{0, int(16 * scale)}, {1, int(32 * scale)}} {
		data := icoImage(IconICO, s.size)
		if data == nil {
			continue
		}
		icon, _, _ := procCreateIconFromResourceEx.Call(uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)),
			1, 0x00030000, uintptr(s.size), uintptr(s.size), 0)
		if icon != 0 {
			_, _, _ = procSendMessageW.Call(hwnd, 0x0080, s.which, icon) // WM_SETICON
		}
	}
}
