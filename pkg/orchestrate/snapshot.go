// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// SnapshotDocs commits spec and plan into the landing tree and returns their repo-relative paths, one per
// path given and "" for an empty one. Every lane is cut from the landing branch, so each task reads the
// version the dag was submitted with, never the lead's live copy, and the docs land with the run. A path
// outside the tree is copied to its repo-relative path first, over an earlier snapshot of it. Content the
// tree already holds commits nothing: a retried submit, or docs the lead committed itself, must not fail
// on an empty commit.
func SnapshotDocs(ctx context.Context, landTree, runID, title string, paths ...string) ([]string, error) {
	rels := make([]string, len(paths))
	var staged []string
	for i, p := range paths {
		if p == "" {
			continue
		}
		rel, err := snapshotInto(ctx, landTree, p)
		if err != nil {
			return nil, fmt.Errorf("snapshotting %s into %s: %w", p, landTree, err)
		}
		rels[i] = rel
		staged = append(staged, rel)
	}
	if len(staged) == 0 {
		return rels, nil
	}
	// --ignored so an ignored doc reaches `git add` and fails there with git's reason, rather than
	// passing as unchanged while no lane ever sees it
	status, err := git(ctx, landTree, append([]string{"status", "--porcelain", "--ignored", "--"}, staged...)...)
	if err != nil {
		return nil, err
	}
	if status == "" {
		return rels, nil
	}
	if _, err := git(ctx, landTree, append([]string{"add", "--"}, staged...)...); err != nil {
		return nil, err
	}
	// the pathspec keeps anything else the lead staged in the tree out of the commit
	args := []string{"commit", "-m", "docs: spec and plan for " + title, "-m", runTrailer + ": " + runID, "--"}
	if _, err := git(ctx, landTree, append(args, staged...)...); err != nil {
		return nil, err
	}
	return rels, nil
}

// snapshotInto puts p in tree, copied when it lives elsewhere in the repository, and returns its
// repo-relative path in slash form.
func snapshotInto(ctx context.Context, tree, p string) (string, error) {
	target, err := treeTarget(ctx, tree, p)
	if err != nil {
		return "", err
	}
	if target != p {
		data, err := os.ReadFile(p)
		if err != nil {
			return "", err
		}
		if existing, err := os.ReadFile(target); err != nil || !bytes.Equal(existing, data) {
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return "", err
			}
			if err := os.WriteFile(target, data, 0o644); err != nil {
				return "", err
			}
		}
	}
	rel, err := filepath.Rel(tree, target)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(rel), nil
}

// treeTarget is where path belongs in tree: path itself when it is inside, else the same repo-relative
// path in tree. A path from another repository has no place there.
func treeTarget(ctx context.Context, tree, path string) (string, error) {
	if rel, err := filepath.Rel(tree, path); err == nil && filepath.IsLocal(rel) {
		return path, nil
	}
	dir := filepath.Dir(path)
	top, err := git(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", err
	}
	src, err := git(ctx, dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return "", err
	}
	dst, err := git(ctx, tree, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return "", err
	}
	if filepath.Clean(src) != filepath.Clean(dst) {
		return "", fmt.Errorf("%s is not in the repository %s belongs to", path, tree)
	}
	rel, err := filepath.Rel(filepath.FromSlash(top), path)
	if err != nil || !filepath.IsLocal(rel) {
		return "", fmt.Errorf("%s is outside its repository root %s", path, top)
	}
	return filepath.Join(tree, rel), nil
}

// DocPath resolves a dag's spec or plan path for a reader working in tree. A branch-landed dag stores
// them repo-relative, committed at submit, so each reader gets the snapshot in its own tree; a
// checkout-landed dag stores them absolute, and every reader shares that one file.
func DocPath(g *waveobj.TaskGroup, tree, p string) string {
	if p == "" || filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(tree, p)
}
