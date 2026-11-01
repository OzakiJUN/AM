//go:build windows

package plugin

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps the NoneBot console window from popping up (am-server is a GUI app on Windows).
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
