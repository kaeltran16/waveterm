// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package orchestrate

import (
	"context"
	"os/exec"
)

func shellCommand(ctx context.Context, command string) (*exec.Cmd, error) {
	return exec.CommandContext(ctx, "sh", "-c", command), nil
}

// runShellCmd just runs c: outside Windows, the process's own group/session handles its
// descendants on cancellation.
func runShellCmd(c *exec.Cmd) error {
	return c.Run()
}
