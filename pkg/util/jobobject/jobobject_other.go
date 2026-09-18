//go:build !windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jobobject

import "os"

// no job objects outside windows; process trees are handled by the pty/session
func Attach(proc *os.Process) (uintptr, error) {
	return 0, nil
}

func KillTree(job uintptr) {}

func Close(job uintptr) {}
