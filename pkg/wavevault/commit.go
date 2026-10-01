// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"context"
	"os"
)

const (
	jarvisName  = "Jarvis"
	jarvisEmail = "jarvis@wave.local"
)

// Commit stages by ownership and produces up to two commits: files Jarvis wrote whose on-disk hash
// is unchanged since it wrote them, authored as Jarvis; then everything else (human/external edits,
// and any Jarvis-written file a human later touched — hash differs), authored under the vault's own
// git identity. Consumers call this at task lifecycle boundaries (label = the boundary); the label
// is the commit message. It holds the vault lock and pokes the sync loop when it committed.
func (v *Vault) Commit(ctx context.Context, label string) error {
	unlock := LockRoot(v.Root)
	committed, err := v.commitLocked(ctx, label)
	unlock()
	if committed {
		Poke()
	}
	return err
}

// commitLocked is Commit for a caller already holding LockRoot(v.Root); it reports whether it
// created a commit.
func (v *Vault) commitLocked(ctx context.Context, label string) (bool, error) {
	committed := false
	v.mu.Lock()
	tracked := make(map[string]string, len(v.machineFiles))
	for p, h := range v.machineFiles {
		tracked[p] = h
	}
	v.mu.Unlock()

	var machinePaths []string
	for p, h := range tracked {
		cur, err := os.ReadFile(p)
		if err != nil {
			continue // deleted / unreadable — let `add -A` handle it in the user commit
		}
		if ContentHash(cur) == h {
			machinePaths = append(machinePaths, p) // unchanged since A wrote it -> Jarvis
		}
	}

	// 1) Jarvis commit: stage only the unchanged machine files.
	if len(machinePaths) > 0 {
		args := append([]string{"add", "--"}, machinePaths...)
		if _, err := runGitErr(ctx, v.Root, args...); err != nil {
			return committed, err
		}
		if v.hasStaged(ctx) {
			if _, err := runGitErr(ctx, v.Root,
				"-c", "user.name="+jarvisName, "-c", "user.email="+jarvisEmail,
				"commit", "-m", label); err != nil {
				return committed, err
			}
			committed = true
		}
	}

	// 2) User commit: stage everything remaining (human edits, external changes, mixed files).
	if _, err := runGitErr(ctx, v.Root, "add", "-A"); err != nil {
		return committed, err
	}
	if v.hasStaged(ctx) {
		if _, err := runGitErr(ctx, v.Root, "commit", "-m", label); err != nil {
			return committed, err
		}
		committed = true
	}

	v.mu.Lock()
	for p := range tracked {
		delete(v.machineFiles, p)
	}
	v.mu.Unlock()
	return committed, nil
}

// hasStaged reports whether there are staged changes. `git diff --cached --quiet` exits 0 with none,
// nonzero with some.
func (v *Vault) hasStaged(ctx context.Context) bool {
	_, err := runGit(ctx, v.Root, "diff", "--cached", "--quiet")
	return err != nil
}
