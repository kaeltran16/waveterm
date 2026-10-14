// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/google/uuid"
)

// the storage report (pkg/storagereport) scans and clears what runs leave on disk; the layout knowledge and every
// removal stay here, under treeRemovals, so a clear and the engine never remove the same tree at once

var ErrTreeBusy = errors.New("the engine is removing it")

func WorktreeRoot() string { return worktreeRoot() }

func LegacyWorktreesDir(projectPath string) string {
	return filepath.Join(projectPath, ".waveterm", "worktrees")
}

func FinalShotsRoot() string { return finalShotsRoot() }

func SplitRunKey(key string) (runID, suffix string, ok bool) { return splitRunKey(key) }

func UnlinkReparsePoints(dir string) error { return unlinkReparsePoints(dir) }

// RunKeyForTreeDir maps a folder name under the worktree root to its engine key: a full key as is, a
// <8-char prefix><suffix> name through the prefix's .run marker. ok=false: no marker, or not an engine name.
func RunKeyForTreeDir(root, name string) (string, bool) {
	if _, _, ok := splitRunKey(name); ok {
		return name, true
	}
	if len(name) < runPrefixLen {
		return "", false
	}
	prefix, suffix := name[:runPrefixLen], name[runPrefixLen:]
	if suffix != "" && !strings.HasPrefix(suffix, "-") {
		return "", false
	}
	runMarkerMu.RLock()
	owner, err := os.ReadFile(filepath.Join(root, prefix+runMarkerExt))
	runMarkerMu.RUnlock()
	if err != nil {
		return "", false
	}
	runID := string(owner)
	if _, perr := uuid.Parse(runID); perr != nil || len(runID) != runIDLen || runID[:runPrefixLen] != prefix {
		return "", false
	}
	return runID + suffix, true
}

// RemoveRunWorktreeExclusive removes a run tree and its wave/<key> branch through RemoveRunWorktree, holding
// treeRemovals with TryLock; ErrTreeBusy when the engine holds it. It refuses when worktreeDir(projectPath, key)
// is not wantPath, so it can never remove a tree other than the scanned one. wantPath "" removes the branch only,
// and is refused while the tree is on disk.
func RemoveRunWorktreeExclusive(ctx context.Context, projectPath, key, wantPath string) error {
	tree := worktreeDir(projectPath, key)
	if wantPath == "" {
		if _, err := os.Lstat(tree); err == nil {
			return fmt.Errorf("the branch wave/%s still has its tree %s", key, tree)
		}
	} else if !samePath(tree, wantPath) {
		return fmt.Errorf("wave/%s resolves to %s, not %s", key, tree, wantPath)
	}
	if !treeRemovals.TryLock(tree) {
		return ErrTreeBusy
	}
	defer treeRemovals.Unlock(tree)
	return RemoveRunWorktree(ctx, projectPath, key)
}

// RemoveDirExclusive deletes a folder no git tracks: UnlinkReparsePoints, then os.RemoveAll, under treeRemovals.
func RemoveDirExclusive(path string) error {
	if !treeRemovals.TryLock(path) {
		return ErrTreeBusy
	}
	defer treeRemovals.Unlock(path)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	// before the delete: os.RemoveAll would follow a junction into its target
	if err := unlinkReparsePoints(path); err != nil {
		return fmt.Errorf("removing %s: %w", path, err)
	}
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("removing %s: %w", path, err)
	}
	return nil
}

// LockTreeForTest holds path's tree removal lock, as the engine does while it removes that tree.
func LockTreeForTest(path string) (unlock func()) {
	treeRemovals.Lock(path)
	return func() { treeRemovals.Unlock(path) }
}

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
