//go:build windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package consult

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

var grandchildRe = regexp.MustCompile(`GRANDCHILD (\d+)`)

// alive is whether pid is still running, waiting up to grace for it to go.
func alive(t *testing.T, pid int, grace time.Duration) bool {
	t.Helper()
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	ev, _ := windows.WaitForSingleObject(h, uint32(grace.Milliseconds()))
	return ev != windows.WAIT_OBJECT_0
}

func killPid(pid int) {
	if h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid)); err == nil {
		windows.TerminateProcess(h, 1)
		windows.CloseHandle(h)
	}
}

// runForGrandchild runs the helper in mode and returns the grandchild's pid once it prints it, and the run's result.
func runForGrandchild(t *testing.T, ctx context.Context, mode string) (int, <-chan error) {
	t.Helper()
	bin := buildReaperHelper(t)
	pids := make(chan int, 1)
	done := make(chan error, 1)
	go func() {
		var out strings.Builder
		_, err := Run(ctx, RuntimeSpec{Bin: bin, BaseArgs: []string{mode, "60000"}}, t.TempDir(), "probe", func(chunk string) {
			out.WriteString(chunk)
			if m := grandchildRe.FindStringSubmatch(out.String()); m != nil {
				pid, _ := strconv.Atoi(m[1])
				select {
				case pids <- pid:
				default:
				}
			}
		})
		done <- err
	}()
	select {
	case pid := <-pids:
		t.Cleanup(func() { killPid(pid) })
		return pid, done
	case <-time.After(10 * time.Second):
		t.Fatal("grandchild never spawned")
	}
	return 0, nil
}

// a cancelled run takes down what its CLI started, not only the CLI
func TestRunPipe_cancelEndsDescendants(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pid, done := runForGrandchild(t, ctx, "parent")
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("consult did not return after cancel")
	}
	if alive(t, pid, 3*time.Second) {
		t.Errorf("grandchild %d outlived the cancelled run", pid)
	}
}

// a run that ends normally leaves nothing its CLI started running
func TestRunPipe_finishEndsDescendants(t *testing.T) {
	pid, done := runForGrandchild(t, context.Background(), "quietparent")
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("consult did not return after its CLI exited")
	}
	if alive(t, pid, 3*time.Second) {
		t.Errorf("grandchild %d outlived the finished run", pid)
	}
}
