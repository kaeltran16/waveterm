// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !windows

package agentsync

import "os"

func createLink(link, target string) error {
	return os.Symlink(target, link)
}
