//go:build windows

package hosting

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps the client console window from popping up (am-server is a GUI app on Windows).
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
