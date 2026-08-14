//go:build windows

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package shellexec

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

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

// powershellEncodedCommand base64-encodes a command as UTF-16LE for -EncodedCommand.
func powershellEncodedCommand(cmd string) string {
	u16 := utf16.Encode([]rune(cmd))
	buf := make([]byte, 0, len(u16)*2)
	for _, v := range u16 {
		buf = append(buf, byte(v), byte(v>>8))
	}
	return base64.StdEncoding.EncodeToString(buf)
}

// TestJobObjectKillsDescendants verifies that killing the job terminates not just the
// direct child but its descendants too — the behavior that prevents orphaned agent
// processes when a block is closed.
func TestJobObjectKillsDescendants(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	// inner powershell writes its own pid then sleeps; outer powershell waits on it
	inner := fmt.Sprintf("$pid | Out-File -Encoding ascii -FilePath '%s'; Start-Sleep -Seconds 60", pidFile)
	outer := fmt.Sprintf("Start-Process -NoNewWindow -Wait powershell -ArgumentList '-NoProfile','-EncodedCommand','%s'; Start-Sleep -Seconds 60", powershellEncodedCommand(inner))
	cmd := exec.Command("powershell", "-NoProfile", "-Command", outer)
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting outer process: %v", err)
	}
	defer func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
	}()

	job, err := attachJobObject(cmd.Process)
	if err != nil {
		t.Fatalf("attachJobObject: %v", err)
	}
	if job == 0 {
		t.Fatal("attachJobObject returned zero handle")
	}
	defer closeJobObject(job)

	// wait for the descendant to write its pid
	var childPid int
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		data, rerr := os.ReadFile(pidFile)
		if rerr == nil {
			pidStr := strings.TrimSpace(string(data))
			if _, serr := fmt.Sscanf(pidStr, "%d", &childPid); serr == nil && childPid > 0 {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if childPid == 0 {
		t.Fatal("descendant never wrote its pid")
	}
	if !processExists(childPid) {
		t.Fatalf("descendant %d not running before job kill", childPid)
	}

	killJobTree(job)

	deadline = time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if !processExists(childPid) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("descendant %d still alive after job kill", childPid)
}
