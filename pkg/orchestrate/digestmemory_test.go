// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func memoryEvent(kind, taskID, role string, ts int64) waveobj.RunEvent {
	detail, _ := json.Marshal(map[string]any{"taskid": taskID, "role": role, "free": 2_000, "need": 3_000})
	return waveobj.RunEvent{ID: uuid.NewString(), RunID: "run-1", ChannelID: "ch-1", Ts: ts, Kind: kind, Detail: detail}
}

func memoryDigestOf(t *testing.T, state string, events ...waveobj.RunEvent) *wshrpc.DagMemoryState {
	t.Helper()
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": state})
	d := BuildDigest(digestSnapshot(g, nil, nil, events, digestNow))
	return d.Tasks[0].Memory
}

func TestDigestMemoryWaiting(t *testing.T) {
	held := memoryEvent(waveobj.RunEventKindMemoryHeld, "t-0", "worker", 5_000)
	m := memoryDigestOf(t, TaskState_Pending, held)
	if m == nil || m.State != "waiting" || m.Role != "worker" || m.Free != 2_000 || m.Need != 3_000 || m.Ts != 5_000 {
		t.Fatalf("pending worker held at the gate: memory = %+v", m)
	}
	if got := memoryDigestOf(t, TaskState_Running, held); got != nil {
		t.Fatalf("a running task is not waiting for a worker slot: %+v", got)
	}
	reviewer := memoryEvent(waveobj.RunEventKindMemoryHeld, "t-0", "reviewer", 5_000)
	if m := memoryDigestOf(t, TaskState_Reviewing, reviewer); m == nil || m.Role != "reviewer" || m.State != "waiting" {
		t.Fatalf("reviewing task with no reviewer run: memory = %+v", m)
	}
	g := digestGroup(t, false, plainTasks())
	setTaskStates(g, map[string]string{"t-0": TaskState_Reviewing})
	g.Tasks[0].ReviewRunID = "run-rev"
	if d := BuildDigest(digestSnapshot(g, nil, nil, []waveobj.RunEvent{reviewer}, digestNow)); d.Tasks[0].Memory != nil {
		t.Fatalf("a started reviewer is not waiting: %+v", d.Tasks[0].Memory)
	}
	for _, role := range []string{"Verify", "Setup"} {
		ev := memoryEvent(waveobj.RunEventKindMemoryHeld, "t-0", role, 5_000)
		if m := memoryDigestOf(t, TaskState_Verifying, ev); m == nil || m.Role != role {
			t.Fatalf("verifying task held for %s: memory = %+v", role, m)
		}
	}
	other := memoryEvent(waveobj.RunEventKindMemoryHeld, "t-1", "worker", 5_000)
	if got := memoryDigestOf(t, TaskState_Pending, other); got != nil {
		t.Fatalf("another task's hold leaked onto t-0: %+v", got)
	}
}

func TestDigestMemoryAdmittedClears(t *testing.T) {
	held := memoryEvent(waveobj.RunEventKindMemoryHeld, "t-0", "worker", 5_000)
	admitted := memoryEvent(waveobj.RunEventKindMemoryAdmitted, "t-0", "worker", 6_000)
	// the store returns newest first; the digest must not depend on slice order
	for _, events := range [][]waveobj.RunEvent{{held, admitted}, {admitted, held}} {
		if got := memoryDigestOf(t, TaskState_Pending, events...); got != nil {
			t.Fatalf("admitted after held must clear the hold: %+v", got)
		}
	}
	reheld := memoryEvent(waveobj.RunEventKindMemoryHeld, "t-0", "worker", 7_000)
	if m := memoryDigestOf(t, TaskState_Pending, held, admitted, reheld); m == nil || m.Ts != 7_000 {
		t.Fatalf("a later hold must show again: %+v", m)
	}
}

func TestDigestMemoryPaused(t *testing.T) {
	paused := memoryEvent(waveobj.RunEventKindMemoryPaused, "t-0", "worker", 5_000)
	resumed := memoryEvent(waveobj.RunEventKindMemoryResumed, "t-0", "worker", 6_000)
	for _, state := range []string{TaskState_Running, TaskState_Stalled, TaskState_Reviewing} {
		if m := memoryDigestOf(t, state, paused); m == nil || m.State != "paused" || m.Need != 3_000 || m.Ts != 5_000 {
			t.Fatalf("paused task in %s: memory = %+v", state, m)
		}
	}
	for _, events := range [][]waveobj.RunEvent{{paused, resumed}, {resumed, paused}} {
		if got := memoryDigestOf(t, TaskState_Running, events...); got != nil {
			t.Fatalf("resumed after paused must clear the pause: %+v", got)
		}
	}
	if got := memoryDigestOf(t, TaskState_Pending, paused); got != nil {
		t.Fatalf("a pending task cannot be paused: %+v", got)
	}
}

func TestDigestMemoryTerminalTask(t *testing.T) {
	held := memoryEvent(waveobj.RunEventKindMemoryHeld, "t-0", "worker", 5_000)
	paused := memoryEvent(waveobj.RunEventKindMemoryPaused, "t-0", "worker", 5_000)
	for _, state := range []string{TaskState_Done, TaskState_Cancelled, TaskState_Failed, TaskState_Skipped} {
		if got := memoryDigestOf(t, state, held, paused); got != nil {
			t.Fatalf("a %s task has no memory state: %+v", state, got)
		}
	}
}
