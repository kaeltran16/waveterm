// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package orchestrate

import (
	"context"
	"os/exec"
	"syscall"
)

// shellCommand sets the whole command line: /s strips only the outer quotes, so quotes inside a plan
// command reach the program unchanged, which Go's per-argument escaping does not guarantee for cmd.exe.
func shellCommand(ctx context.Context, command string) *exec.Cmd {
	c := exec.CommandContext(ctx, "cmd.exe")
	c.SysProcAttr = &syscall.SysProcAttr{CmdLine: `cmd.exe /d /s /c "` + command + `"`}
	return c
}
