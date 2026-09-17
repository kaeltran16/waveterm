// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package orchestrate

import (
	"context"
	"errors"
	"os"
	"os/exec"

	"github.com/wavetermdev/waveterm/pkg/util/shellutil"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// shellCommand runs a plan command through Git Bash, so a plan's POSIX Verify and Setup lines mean here what
// they mean under sh elsewhere: cmd.exe rejects the inline VAR=value prefix and $(...) that leads write.
// MSYS_NO_PATHCONV stops bash from rewriting a /-leading argument into a Windows path.
func shellCommand(ctx context.Context, command string) (*exec.Cmd, error) {
	fullConfig := wconfig.GetWatcher().GetFullConfig()
	bash := shellutil.FindGitBash(&fullConfig, false)
	if bash == "" {
		return nil, errors.New("plan commands run in Git Bash on Windows, and none was found: install Git for Windows or set term:gitbashpath")
	}
	c := exec.CommandContext(ctx, bash, "-c", command)
	c.Env = append(os.Environ(), "MSYS_NO_PATHCONV=1")
	return c, nil
}
