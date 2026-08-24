// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"bytes"
	"context"
	"log"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
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

// Guards J5: abnormal exit paths must log — a silent outcome is indistinguishable from
// "worker produced nothing". Uses an unknown block id to force the block-load failure branch.
func TestOnWorkerExit_LogsUnreadableBlock(t *testing.T) {
	var buf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(oldOut)

	OnWorkerExit("no-such-block", 0)

	if !strings.Contains(buf.String(), "jarvis onexit") {
		t.Fatalf("expected failure log, got %q", buf.String())
	}
}

// The documented-normal no-transcript path stays silent.
func TestOnWorkerExit_NoTranscriptStaysSilent(t *testing.T) {
	ctx := context.Background()
	blockOID := uuid.NewString()
	if err := wstore.DBInsert(ctx, &waveobj.Block{OID: blockOID, Meta: waveobj.MetaMapType{}}); err != nil {
		t.Fatalf("seed block: %v", err)
	}
	var buf bytes.Buffer
	oldOut := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(oldOut)

	OnWorkerExit(blockOID, 0)

	if strings.Contains(buf.String(), "jarvis onexit") {
		t.Fatalf("normal no-transcript path should not log: %q", buf.String())
	}
}
