// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunningBackgroundTasks(t *testing.T) {
	start := time.Date(2026, 11, 26, 10, 0, 0, 0, time.UTC)
	ts := start.Format(time.RFC3339Nano)
	shell := func(id string) string {
		return fmt.Sprintf(`{"type":"user","timestamp":%q,"toolUseResult":{"backgroundTaskId":%q},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu"}]}}`, ts, id)
	}
	monitor := func(id string, timeoutMs int, persistent bool) string {
		return fmt.Sprintf(`{"type":"user","timestamp":%q,"toolUseResult":{"taskId":%q,"timeoutMs":%d,"persistent":%v},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu"}]}}`, ts, id, timeoutMs, persistent)
	}
	enqueue := func(body string) string {
		return fmt.Sprintf(`{"type":"queue-operation","operation":"enqueue","timestamp":%q,"content":%q}`, ts, body)
	}
	finished := func(id string) string {
		return enqueue("<task-notification>\n<task-id>" + id + "</task-id>\n<status>completed</status>\n</task-notification>")
	}
	tests := []struct {
		name  string
		lines []string
		at    time.Duration // after start
		want  int
	}{
		{"a started shell task runs", []string{shell("b1")}, 0, 1},
		{"its completion notification ends it", []string{shell("b1"), finished("b1")}, 0, 0},
		{"a user-record notification ends it", []string{shell("b1"), fmt.Sprintf(`{"type":"user","timestamp":%q,"message":{"role":"user","content":"<task-notification><task-id>b1</task-id><status>failed</status></task-notification>"}}`, ts)}, 0, 0},
		{"a finish written before its start", []string{finished("b1"), shell("b1")}, 0, 0},
		{"a TaskStop result ends it", []string{shell("b1"), `{"type":"user","toolUseResult":{"task_id":"b1"}}`}, 0, 0},
		{"a dead session's summary ends every task it names", []string{shell("b1"), shell("b2"), shell("b3"), enqueue("<task-notification><status>killed</status><summary>Session ended. Task ids: b1, b2.</summary></task-notification>")}, 0, 1},
		{"a monitor event is not a finish", []string{monitor("m1", 60_000, false), enqueue("<task-notification><task-id>m1</task-id><event>line</event></task-notification>")}, time.Second, 1},
		{"a monitor past its timeout has ended", []string{monitor("m1", 60_000, false)}, 2 * time.Minute, 0},
		{"a persistent monitor never times out", []string{monitor("m1", 60_000, true)}, time.Hour, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "s.jsonl")
			if err := os.WriteFile(path, []byte(strings.Join(tt.lines, "\n")+"\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if got := RunningBackgroundTasks(path, "claude", start.Add(tt.at)); got != tt.want {
				t.Errorf("running = %d, want %d", got, tt.want)
			}
		})
	}
}
