// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// TaskWorker correlates a dag task node with the child run + worker tab that executes it. Resolved
// is false with an explicit Reason when the task was never dispatched or its recorded session is gone
// — the "Not dispatched yet" / "Worker session unavailable" degradation states.
type TaskWorker struct {
	Run      *waveobj.Run
	PhaseIdx int
	TabId    string
	Resolved bool
	Reason   string
}

// explicit unresolved reasons
const (
	TaskWorkerReasonNotDispatched     = "not-dispatched"     // no child run or the run never had a phase
	TaskWorkerReasonWorkerUnavailable = "worker-unavailable" // run exists but no recordable worker session
)

// ResolveTaskWorker finds the worker tab executing a dag task: task.RunID -> the child run -> the
// first phase with a recorded tab worker. Explicit unresolved outcomes, never a fabricated tab.
func ResolveTaskWorker(ctx context.Context, channelId string, task *waveobj.TaskNode) (*TaskWorker, error) {
	if task.RunID == "" {
		return &TaskWorker{Reason: TaskWorkerReasonNotDispatched}, nil
	}
	run, err := wstore.GetRun(ctx, channelId, task.RunID)
	if err != nil || run == nil {
		return &TaskWorker{Reason: TaskWorkerReasonNotDispatched}, nil
	}
	for pi := range run.Phases {
		for _, oref := range run.Phases[pi].WorkerOrefs {
			if !isTabORef(oref) {
				continue
			}
			return &TaskWorker{Run: run, PhaseIdx: pi, TabId: tabOrefID(oref), Resolved: true}, nil
		}
	}
	return &TaskWorker{Run: run, Reason: TaskWorkerReasonWorkerUnavailable}, nil
}

func isTabORef(s string) bool {
	return len(s) > len("tab:") && s[:len("tab:")] == "tab:"
}

func tabOrefID(s string) string {
	return s[len("tab:"):]
}