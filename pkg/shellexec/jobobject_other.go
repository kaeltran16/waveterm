//go:build !windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package shellexec

import "os"

// no job objects outside windows; process trees are handled by the pty/session
func attachJobObject(proc *os.Process) (uintptr, error) {
	return 0, nil
}

func killJobTree(job uintptr) {}

func closeJobObject(job uintptr) {}
