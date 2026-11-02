//go:build !windows

package main

import (
	"os"
	"syscall"
)

// relaunch replaces this process with the updated am-server (same pid, so
// service managers like systemd keep tracking it). Everything was stopped
// first; Go opens files and sockets close-on-exec.
func relaunch(args []string) error {
	return syscall.Exec(exePath, append([]string{exePath}, args...), os.Environ())
}
