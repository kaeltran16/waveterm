// pkg/gitinfo/remote_test.go
package gitinfo

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// cloneOfBare makes a bare remote holding one commit on main and a clone of it whose main tracks
// origin/main. It returns the bare remote's and the clone's directories.
func cloneOfBare(t *testing.T) (string, string) {
	t.Helper()
	seed := t.TempDir()
	gitRun(t, seed, "init", "-q", "-b", "main")
	gitRun(t, seed, "commit", "-q", "--allow-empty", "-m", "base")
	bare := filepath.Join(t.TempDir(), "remote.git")
	gitRun(t, seed, "clone", "-q", "--bare", seed, bare)
	clone := filepath.Join(t.TempDir(), "clone")
	gitRun(t, seed, "clone", "-q", bare, clone)
	return bare, clone
}

// pushFromOther lands one commit on the remote's main from a second clone, so the first clone lacks it.
func pushFromOther(t *testing.T, bare string) {
	t.Helper()
	other := filepath.Join(t.TempDir(), "other")
	gitRun(t, bare, "clone", "-q", bare, other)
	gitRun(t, other, "commit", "-q", "--allow-empty", "-m", "theirs")
	gitRun(t, other, "push", "-q", "origin", "main")
}

func TestPushWithUpstreamMovesRemoteBranch(t *testing.T) {
	bare, clone := cloneOfBare(t)
	gitRun(t, clone, "commit", "-q", "--allow-empty", "-m", "mine")
	tip := gitRun(t, clone, "rev-parse", "HEAD")

	got, err := Push(context.Background(), clone)
	if err != nil {
		t.Fatal(err)
	}
	if got.Failure != nil || !got.IsRepo || got.PushedAt == 0 {
		t.Fatalf("push = %+v (failure %+v), want success", got, got.Failure)
	}
	if remoteTip := gitRun(t, bare, "rev-parse", "main"); remoteTip != tip {
		t.Fatalf("remote main = %s, want local tip %s", remoteTip, tip)
	}
}

func TestPushPublishesBranchWithoutUpstream(t *testing.T) {
	bare, clone := cloneOfBare(t)
	gitRun(t, clone, "switch", "-q", "-c", "feat/x")
	gitRun(t, clone, "commit", "-q", "--allow-empty", "-m", "mine")
	tip := gitRun(t, clone, "rev-parse", "HEAD")

	got, err := Push(context.Background(), clone)
	if err != nil {
		t.Fatal(err)
	}
	if got.Failure != nil || got.PushedAt == 0 {
		t.Fatalf("publish = %+v (failure %+v), want success", got, got.Failure)
	}
	if remoteTip := gitRun(t, bare, "rev-parse", "feat/x"); remoteTip != tip {
		t.Fatalf("remote feat/x = %s, want %s", remoteTip, tip)
	}
	if up := gitRun(t, clone, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"); up != "origin/feat/x" {
		t.Fatalf("upstream = %q, want origin/feat/x", up)
	}
}

func TestPushNonFastForwardIsRejectedNotForced(t *testing.T) {
	bare, clone := cloneOfBare(t)
	pushFromOther(t, bare)
	theirs := gitRun(t, bare, "rev-parse", "main")
	gitRun(t, clone, "commit", "-q", "--allow-empty", "-m", "mine")

	got, err := Push(context.Background(), clone)
	if err != nil {
		t.Fatal(err)
	}
	if got.Failure == nil || !strings.Contains(got.Failure.Stderr, "[rejected]") {
		t.Fatalf("push = %+v (failure %+v), want a [rejected] failure", got, got.Failure)
	}
	if got.PushedAt != 0 {
		t.Fatalf("PushedAt = %d on failure, want 0", got.PushedAt)
	}
	if remoteTip := gitRun(t, bare, "rev-parse", "main"); remoteTip != theirs {
		t.Fatalf("remote main moved to %s, want it left at %s", remoteTip, theirs)
	}
}

func TestPushDetachedHeadFailsWithoutPushing(t *testing.T) {
	bare, clone := cloneOfBare(t)
	before := gitRun(t, bare, "rev-parse", "main")
	gitRun(t, clone, "commit", "-q", "--allow-empty", "-m", "mine")
	gitRun(t, clone, "checkout", "-q", "--detach")

	got, err := Push(context.Background(), clone)
	if err != nil {
		t.Fatal(err)
	}
	if got.Failure == nil || !strings.Contains(got.Failure.Stderr, "detached") || got.PushedAt != 0 {
		t.Fatalf("push = %+v (failure %+v), want a detached-HEAD failure", got, got.Failure)
	}
	if after := gitRun(t, bare, "rev-parse", "main"); after != before {
		t.Fatalf("remote main moved from %s to %s", before, after)
	}
}

func TestPushNotARepo(t *testing.T) {
	got, err := Push(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if got.IsRepo || got.Failure != nil {
		t.Fatalf("push = %+v, want IsRepo false and no failure", got)
	}
}

func TestRemoteStatusAheadBehind(t *testing.T) {
	bare, clone := cloneOfBare(t)
	gitRun(t, clone, "commit", "-q", "--allow-empty", "-m", "one")
	gitRun(t, clone, "commit", "-q", "--allow-empty", "-m", "two")
	ctx := context.Background()

	got, err := RemoteStatus(ctx, clone)
	if err != nil {
		t.Fatal(err)
	}
	want := RemoteFacts{HasRemote: true, Upstream: "origin/main", Ahead: 2, Behind: 0}
	if *got != want {
		t.Fatalf("status = %+v, want %+v", *got, want)
	}

	pushFromOther(t, bare)
	gitRun(t, clone, "fetch", "-q", "origin")
	got, err = RemoteStatus(ctx, clone)
	if err != nil {
		t.Fatal(err)
	}
	want.Behind = 1
	if *got != want {
		t.Fatalf("status after fetch = %+v, want %+v", *got, want)
	}
}

func TestRemoteStatusNoUpstream(t *testing.T) {
	_, clone := cloneOfBare(t)
	gitRun(t, clone, "switch", "-q", "-c", "feat/x")
	got, err := RemoteStatus(context.Background(), clone)
	if err != nil {
		t.Fatal(err)
	}
	if want := (RemoteFacts{HasRemote: true}); *got != want {
		t.Fatalf("status = %+v, want %+v", *got, want)
	}
}

func TestRemoteStatusNoRemote(t *testing.T) {
	dir := t.TempDir()
	gitRun(t, dir, "init", "-q", "-b", "main")
	gitRun(t, dir, "commit", "-q", "--allow-empty", "-m", "base")
	got, err := RemoteStatus(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if *got != (RemoteFacts{}) {
		t.Fatalf("status = %+v, want no remote and no upstream", *got)
	}
}

// the env is the only thing between a network git command and a credential prompt that blocks a
// headless wavesrv until its timeout
func TestNetworkCommandsNeverPrompt(t *testing.T) {
	cmd := networkCmd(context.Background(), t.TempDir(), "push")
	for _, v := range []string{"GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never"} {
		if !slices.Contains(cmd.Env, v) {
			t.Fatalf("network git env lacks %s", v)
		}
	}
}
