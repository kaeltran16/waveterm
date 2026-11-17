// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// cloneTwoAhead returns a clone whose main tracks origin/main and carries two commits the remote lacks.
func cloneTwoAhead(t *testing.T) string {
	t.Helper()
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	seed := t.TempDir()
	git(seed, "init", "-q", "-b", "main")
	git(seed, "commit", "-q", "--allow-empty", "-m", "base")
	bare := filepath.Join(t.TempDir(), "remote.git")
	git(seed, "clone", "-q", "--bare", seed, bare)
	clone := filepath.Join(t.TempDir(), "clone")
	git(seed, "clone", "-q", bare, clone)
	git(clone, "commit", "-q", "--allow-empty", "-m", "one")
	git(clone, "commit", "-q", "--allow-empty", "-m", "two")
	return clone
}

func TestGitChangesRemoteFactsOnlyWhenAsked(t *testing.T) {
	clone := cloneTwoAhead(t)
	ws := &WshServer{}
	ctx := context.Background()

	plain, err := ws.GitChangesCommand(ctx, wshrpc.CommandGitChangesData{Cwd: clone})
	if err != nil {
		t.Fatal(err)
	}
	if plain.HasRemote || plain.Upstream != "" || plain.Ahead != 0 || plain.Behind != 0 {
		t.Fatalf("without remote: %+v, want no remote facts", plain)
	}

	withRemote, err := ws.GitChangesCommand(ctx, wshrpc.CommandGitChangesData{Cwd: clone, Remote: true})
	if err != nil {
		t.Fatal(err)
	}
	if !withRemote.HasRemote || withRemote.Upstream != "origin/main" || withRemote.Ahead != 2 || withRemote.Behind != 0 {
		t.Fatalf("with remote: %+v, want origin/main ahead 2 behind 0", withRemote)
	}
}
