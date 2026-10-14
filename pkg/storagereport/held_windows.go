// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build windows

package storagereport

import (
	"errors"
	"strings"

	"golang.org/x/sys/windows"
)

// isHeld reports a delete a process blocked by holding the file or folder open.
func isHeld(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		strings.Contains(err.Error(), heldByGit)
}
