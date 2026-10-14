// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package storagereport

import "strings"

// isHeld reports a delete a process blocked by holding the file or folder open; elsewhere only git says so.
func isHeld(err error) bool {
	return strings.Contains(err.Error(), heldByGit)
}
