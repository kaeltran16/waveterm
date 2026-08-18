// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wstore

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestAppendAndQueryRunEvents(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "runevent", "/p/one")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	idx := 1
	if _, err := AppendRunEvent(ctx, ch.OID, "run-1", waveobj.RunEventKindPhaseHeld, &idx, map[string]any{"artifact": "plan.md"}); err != nil {
		t.Fatalf("append: %v", err)
	}
	if _, err := AppendRunEvent(ctx, ch.OID, "run-1", waveobj.RunEventKindCreated, nil, map[string]any{"runtime": "claude"}); err != nil {
		t.Fatalf("append: %v", err)
	}
	events, err := QueryRunEvents(ctx, ch.OID, "run-1", 0)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("want 2 events, got %d", len(events))
	}
	// newest-first
	if events[0].Kind != waveobj.RunEventKindCreated {
		t.Fatalf("want newest-first, first kind %q", events[0].Kind)
	}
	if events[1].PhaseIdx == nil || *events[1].PhaseIdx != 1 {
		t.Fatalf("phaseidx not preserved: %v", events[1].PhaseIdx)
	}
	// channel scoping
	if other, err := QueryRunEvents(ctx, "other-channel", "run-1", 0); err != nil || len(other) != 0 {
		t.Fatalf("other channel should be empty (got %d, err %v)", len(other), err)
	}
}

func TestRunEventPrune(t *testing.T) {
	ctx := context.Background()
	ch, err := CreateChannel(ctx, "runevent-prune", "/p/one")
	if err != nil {
		t.Fatalf("create channel: %v", err)
	}
	for i := 0; i < maxRunEventsPerRun+10; i++ {
		if _, err := AppendRunEvent(ctx, ch.OID, "run-2", waveobj.RunEventKindCreated, nil, nil); err != nil {
			t.Fatalf("append: %v", err)
		}
	}
	// the append itself pruned to the newest maxRunEventsPerRun rows; count directly because
	// QueryRunEvents caps at 500 and cannot observe the 1000-row retention bound.
	count, err := WithReadTxRtn(ctx, func(tx *TxWrap) (int, error) {
		return tx.GetInt(`SELECT COUNT(*) FROM db_runevent WHERE runid = ?`, "run-2"), tx.Err
	})
	if err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != maxRunEventsPerRun {
		t.Fatalf("want %d after prune, got %d", maxRunEventsPerRun, count)
	}
	events, err := QueryRunEvents(ctx, ch.OID, "run-2", 500)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(events) != 500 {
		t.Fatalf("want 500 newest rows, got %d", len(events))
	}
}