//go:build windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"regexp"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func processExists(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	windows.CloseHandle(h)
	return true
}

// TestExecPlanCommandTimeoutKillsTheProcessTree covers the backlog-run failure where a Verify
// timeout killed only the Git Bash launcher, leaving its `go test` grandchild running for 30+
// minutes. The backgrounded sleep here stands in for that grandchild.
func TestExecPlanCommandTimeoutKillsTheProcessTree(t *testing.T) {
	command := `sleep 300 & echo WINPID=$(cat /proc/$!/winpid); wait`
	err := execPlanCommand(context.Background(), t.TempDir(), command, 2*time.Second)

	var pe *planCommandError
	if !errors.As(err, &pe) || pe.timeout == 0 {
		t.Fatalf("want a timeout error, got %v", err)
	}

	m := regexp.MustCompile(`WINPID=(\d+)`).FindStringSubmatch(pe.output)
	if m == nil {
		t.Fatalf("did not find the grandchild's windows pid in output: %q", pe.output)
	}
	pid, convErr := strconv.Atoi(m[1])
	if convErr != nil {
		t.Fatalf("parsing grandchild pid %q: %v", m[1], convErr)
	}
	t.Logf("grandchild windows pid: %d", pid)

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !processExists(pid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("grandchild %d (sleep 300) still alive after execPlanCommand returned", pid)
}
