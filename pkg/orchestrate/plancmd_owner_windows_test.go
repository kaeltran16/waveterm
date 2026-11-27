//go:build windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"golang.org/x/sys/windows"
)

func ownerLive(o jobobject.Owner) bool {
	for _, j := range jobobject.LiveJobs() {
		if j.Owner == o && len(j.Members) > 0 {
			return true
		}
	}
	return false
}

func TestPlanCommandRegistersRunOwner(t *testing.T) {
	want := jobobject.Owner{Kind: jobobject.OwnerKind_RunCmd, Id: "run-1", Cmd: PlanCmd_Verify, Task: "3"}
	ctx := withRunCmdOwner(context.Background(), want.Id, want.Cmd, want.Task)
	done := make(chan error, 1)
	go func() {
		_, err := execPlanCommandEnv(ctx, t.TempDir(), "sleep 2", nil, time.Minute, nil)
		done <- err
	}()

	seen := false
	for !seen {
		select {
		case err := <-done:
			t.Fatalf("the command returned (err %v) before its owner was ever live", err)
		case <-time.After(50 * time.Millisecond):
			seen = ownerLive(want)
		}
	}
	if err := <-done; err != nil {
		t.Fatalf("the command failed: %v", err)
	}
	if ownerLive(want) {
		t.Fatalf("owner %+v is still registered after the command returned", want)
	}
}

func TestPlanCommandPriorityByCommand(t *testing.T) {
	// the class a child of the command reads for itself, so it proves the job's limit reaches later processes
	const probe = `powershell -NoProfile -Command '(Get-Process -Id $PID).PriorityClass'`
	for _, tc := range []struct {
		cmd, want string
	}{
		{PlanCmd_Verify, "BelowNormal"},
		{PlanCmd_Final, childClass(t)},
	} {
		t.Run(tc.cmd, func(t *testing.T) {
			ctx := withRunCmdOwner(context.Background(), "run-1", tc.cmd, "")
			out, err := execPlanCommandEnv(ctx, t.TempDir(), probe, nil, time.Minute, nil)
			if err != nil {
				t.Fatalf("probe failed: %v\n%s", err, out)
			}
			if got := strings.TrimSpace(out); got != tc.want {
				t.Fatalf("%s child ran at %q, want %q", tc.cmd, got, tc.want)
			}
		})
	}
}

// childClass is the priority class a plain child of the test process starts at: Windows passes a parent's class
// on only when it is idle or below normal, so a test run under a lowered Verify still knows what Final's child gets
func childClass(t *testing.T) string {
	class, err := windows.GetPriorityClass(windows.CurrentProcess())
	if err != nil {
		t.Fatalf("reading the test's priority class: %v", err)
	}
	switch class {
	case windows.IDLE_PRIORITY_CLASS:
		return "Idle"
	case windows.BELOW_NORMAL_PRIORITY_CLASS:
		return "BelowNormal"
	}
	return "Normal"
}

// a detached tree's Setup must not show as the command the tree is for: a bisect tree's Setup is not its Verify
func TestDetachedTreeSetupKeepsOwnerAsSetup(t *testing.T) {
	var got jobobject.Owner
	var ok bool
	orig := runPlanCommand
	runPlanCommand = func(ctx context.Context, dir, command string, env []string, _ time.Duration, progress planProgress) (string, error) {
		got, ok = jobobject.OwnerFrom(ctx)
		return "", nil
	}
	t.Cleanup(func() { runPlanCommand = orig })

	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	ctx := withRunCmdOwner(context.Background(), "run-1", PlanCmd_Verify, "3")
	if err := withDetachedTree(ctx, dir, "bisect", "bisect tree", base, "setup", func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	want := jobobject.Owner{Kind: jobobject.OwnerKind_RunCmd, Id: "run-1", Cmd: PlanCmd_Setup, Task: "3"}
	if !ok || got != want {
		t.Fatalf("Setup ran with owner %+v (present %v), want %+v", got, ok, want)
	}
}
