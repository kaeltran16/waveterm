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
// is the commit message.
func (v *Vault) Commit(ctx context.Context, label string) error {
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
			return err
		}
		if v.hasStaged(ctx) {
			if _, err := runGitErr(ctx, v.Root,
				"-c", "user.name="+jarvisName, "-c", "user.email="+jarvisEmail,
				"commit", "-m", label); err != nil {
				return err
			}
		}
	}

	// 2) User commit: stage everything remaining (human edits, external changes, mixed files).
	if _, err := runGitErr(ctx, v.Root, "add", "-A"); err != nil {
		return err
	}
	if v.hasStaged(ctx) {
		if _, err := runGitErr(ctx, v.Root, "commit", "-m", label); err != nil {
			return err
		}
	}

	v.mu.Lock()
	for p := range tracked {
		delete(v.machineFiles, p)
	}
	v.mu.Unlock()
	return nil
}

// hasStaged reports whether there are staged changes. `git diff --cached --quiet` exits 0 with none,
// nonzero with some.
func (v *Vault) hasStaged(ctx context.Context) bool {
	_, err := runGit(ctx, v.Root, "diff", "--cached", "--quiet")
	return err != nil
}

// Flush is the idle/quit safety commit: it commits any pending staged work under a clearly-labelled
// safety message so a crash or a missed boundary never loses writes. Wired to an idle debounce and
// the wavesrv quit hook by the caller; in the common case a consumer already committed at the
// boundary and this is a no-op.
func (v *Vault) Flush(ctx context.Context) error {
	return v.Commit(ctx, "Jarvis: safety flush")
}
