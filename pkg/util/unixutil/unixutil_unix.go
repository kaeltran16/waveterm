// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build unix

package unixutil

import (
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func GetSignalName(sig os.Signal) string {
	if sig == nil {
		return ""
	}
	scSig, ok := sig.(syscall.Signal)
	if !ok {
		return sig.String()
	}
	name := unix.SignalName(scSig)
	if name == "" {
		return fmt.Sprintf("%d", int(scSig))
	}
	return name
}

func SignalTerm(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}

func SignalHup(pid int) error {
	return syscall.Kill(pid, syscall.SIGHUP)
}
