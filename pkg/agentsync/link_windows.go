// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package agentsync

import (
	"fmt"
	"os/exec"
	"strings"
)

// createLink makes a directory junction. mklink /J needs no privilege, whereas os.Symlink requires
// Developer Mode or SeCreateSymbolicLinkPrivilege and would fail on a stock machine.
func createLink(link, target string) error {
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		return fmt.Errorf("mklink /J %q -> %q: %w (%s)", link, target, err, strings.TrimSpace(string(out)))
	}
	return nil
}
