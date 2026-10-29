//go:build !windows

package desktop

import "errors"

// PanelWindowTitle is the title of the admin panel window.
const PanelWindowTitle = "AM 服务器"

// WindowSupported: the own panel window is Windows-only; elsewhere the
// panel opens in the browser.
func WindowSupported() bool { return false }

// RunPanelWindow is not available outside Windows.
func RunPanelWindow(url string) error { return errors.New("panel window is only available on Windows") }

// FocusPanelWindow is not available outside Windows.
func FocusPanelWindow() bool { return false }
