//go:build windows

package main

import (
	"os"
	"os/exec"
	"slices"
)

// relaunch starts the updated am-server (the old one has stopped and freed
// its ports) and lets this process end. -autostart keeps it from opening
// another panel window; the open one reconnects.
func relaunch(args []string) error {
	if !slices.Contains(args, "-autostart") {
		args = append(append([]string(nil), args...), "-autostart")
	}
	cmd := exec.Command(exePath, args...)
	cmd.Dir, _ = os.Getwd()
	return cmd.Start()
}
