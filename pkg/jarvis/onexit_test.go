// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agentsessions"
)

func TestOutcomeSummary(t *testing.T) {
	t.Run("prefers the last event text", func(t *testing.T) {
		sess := &agentsessions.SessionInfo{
			Task: "the task",
			Events: []agentsessions.SessionEvent{
				{Text: "started"},
				{Text: "finished cleanly"},
			},
		}
		if got := outcomeSummary(sess); got != "finished cleanly" {
			t.Errorf("got %q, want last event text", got)
		}
	})

	t.Run("falls back to the task when there are no events", func(t *testing.T) {
		sess := &agentsessions.SessionInfo{Task: "the task"}
		if got := outcomeSummary(sess); got != "the task" {
			t.Errorf("got %q, want the task", got)
		}
	})

	t.Run("falls back to the task when the last event text is empty", func(t *testing.T) {
		sess := &agentsessions.SessionInfo{
			Task:   "the task",
			Events: []agentsessions.SessionEvent{{Text: "started"}, {Text: ""}},
		}
		if got := outcomeSummary(sess); got != "the task" {
			t.Errorf("got %q, want the task fallback", got)
		}
	})

	t.Run("truncates to 160 chars", func(t *testing.T) {
		long := strings.Repeat("x", 200)
		sess := &agentsessions.SessionInfo{Events: []agentsessions.SessionEvent{{Text: long}}}
		if got := outcomeSummary(sess); len(got) != 160 {
			t.Errorf("got len %d, want 160", len(got))
		}
	})
}
