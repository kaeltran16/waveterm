// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// isLink reports whether path is a reparse point (junction or symlink), never following it.
// A Windows junction reports ModeIrregular rather than ModeSymlink since Go 1.23 defaulted
// winsymlink=1, so a ModeSymlink test alone would miss every link Arc creates on Windows;
// resolving through Readlink is the portable test that covers both.
func isLink(path string) bool {
	fi, err := os.Lstat(path)
	if err != nil {
		return false
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return true
	}
	if fi.Mode()&os.ModeIrregular == 0 {
		return false
	}
	_, err = os.Readlink(path)
	return err == nil
}

// linkTarget resolves what a link points at. Windows junctions read back \\?\-prefixed.
func linkTarget(path string) (string, error) {
	t, err := os.Readlink(path)
	if err != nil {
		return "", err
	}
	return normalizeTarget(t), nil
}

func normalizeTarget(p string) string {
	return filepath.Clean(strings.TrimPrefix(p, `\\?\`))
}

// sameTarget compares two link targets case-insensitively: these paths live on Windows, where the
// filesystem is, and both sides are Arc-generated so the looseness costs nothing.
func sameTarget(a, b string) bool {
	return strings.EqualFold(normalizeTarget(a), normalizeTarget(b))
}

// withinRoot reports whether target lives under root — the test for "this junction is ours".
func withinRoot(target, root string) bool {
	rel, err := filepath.Rel(normalizeTarget(root), normalizeTarget(target))
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// removeLink deletes the link itself and refuses anything that is not one. A recursive delete that
// follows a junction destroys the target's contents — the hazard documented in
// scripts/worktree-junctions.mjs. Never replace this with os.RemoveAll.
func removeLink(path string) error {
	if !isLink(path) {
		return fmt.Errorf("refusing to remove %q: not a link", path)
	}
	return os.Remove(path)
}
