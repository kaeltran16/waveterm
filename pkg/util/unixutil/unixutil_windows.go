// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package unixutil

import (
	"os"
)

func GetSignalName(sig os.Signal) string {
	if sig == nil {
		return ""
	}
	return sig.String()
}

func SignalTerm(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}

// this is a no-op on windows
func SignalHup(pid int) error {
	return nil
}
