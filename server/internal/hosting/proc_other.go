//go:build !windows

package hosting

import "os/exec"

func hideWindow(*exec.Cmd) {}
