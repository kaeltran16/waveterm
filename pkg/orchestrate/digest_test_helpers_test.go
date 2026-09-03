// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// digestGroup builds a TaskGroup through the same constructor the engine uses, then pins a version
// (waveobj objects get their version from wstore; fixtures set it explicitly).
func digestGroup(t *testing.T, mergeRequired bool, tasks []waveobj.TaskNode) *waveobj.TaskGroup {
	t.Helper()
	g, err := NewTaskGroup("run-1", "ch-1", "g", 2, mergeRequired, tasks, 1000, nil)
	if err != nil {
		t.Fatal(err)
	}
	g.Version = 7
	return &g
}

// setTaskStates writes the given state per task id and recomputes the derived group status. A running
// or done task gets a matching child run id so duration and correlation fixtures stay consistent.
func setTaskStates(g *waveobj.TaskGroup, states map[string]string) {
	for i := range g.Tasks {
		if s, ok := states[g.Tasks[i].ID]; ok {
			g.Tasks[i].State = s
			switch s {
			case TaskState_Running, TaskState_Done, TaskState_Stalled:
				if g.Tasks[i].RunID == "" {
					g.Tasks[i].RunID = "run-" + g.Tasks[i].ID
				}
			}
		}
	}
	RecomputeDagStatus(g)
}

// digestAsk is one pending child ask for a task. AskId mirrors the registry's generated id that
// DagAsksCommand now carries on DagAskItem.
func digestAsk(taskID, askID string, ts int64) wshrpc.DagAskItem {
	return wshrpc.DagAskItem{TaskId: taskID, Question: "should we ship?", Ts: ts, AskId: askID}
}

// retainedEvent builds one RunEvent row for a task-scoped kind (unused detail omitted).
func retainedEvent(kind, taskID string, ts int64) waveobj.RunEvent {
	var detailJSON []byte
	if taskID != "" {
		detailJSON, _ = json.Marshal(map[string]any{"taskid": taskID, "childrunid": "run-" + taskID})
	}
	return waveobj.RunEvent{
		ID: uuid.NewString(), RunID: "run-1", ChannelID: "ch-1",
		Ts: ts, Kind: kind, Detail: detailJSON,
	}
}

// retainedDagEvent builds one run-scoped terminal event (dag-done / dag-cancelled).
func retainedDagEvent(kind string, ts int64) waveobj.RunEvent {
	return waveobj.RunEvent{
		ID: uuid.NewString(), RunID: "run-1", ChannelID: "ch-1",
		Ts: ts, Kind: kind,
	}
}

// childRun builds the child run a task's RunID points at, with the given phases.
func childRun(id string, phases []waveobj.RunPhase) *waveobj.Run {
	return &waveobj.Run{
		OID: id, ID: id, ChannelOID: "ch-1", Status: "done",
		Phases: phases, Meta: waveobj.MetaMapType{},
	}
}

func phase(kind string, startedTs, doneTs int64) waveobj.RunPhase {
	p := waveobj.RunPhase{Kind: kind, State: "done"}
	if startedTs > 0 {
		p.StartedTs = startedTs
	}
	if doneTs > 0 {
		p.DoneTs = doneTs
	}
	return p
}

// digestSnapshot assembles the explicit snapshot the RPC layer would gather.
func digestSnapshot(g *waveobj.TaskGroup, runs []*waveobj.Run, asks []wshrpc.DagAskItem, retained []waveobj.RunEvent, now time.Time) DagDigestSnapshot {
	return DagDigestSnapshot{Group: g, Runs: runs, Asks: asks, Retained: retained, Now: now}
}

var digestNow = time.UnixMilli(10_000)