package orchestrate

import (
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func latestRetriedDetail(t *testing.T, h *childOutcomeHarness) (taskID, kind string, attempt int) {
	t.Helper()
	events, err := wstore.QueryRunEvents(h.ctx, h.channel, h.runID, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Kind != waveobj.RunEventKindTaskRetried {
			continue
		}
		var detail struct {
			TaskID  string `json:"taskid"`
			Kind    string `json:"kind"`
			Attempt int    `json:"attempt"`
		}
		if err := json.Unmarshal(event.Detail, &detail); err != nil {
			t.Fatal(err)
		}
		return detail.TaskID, detail.Kind, detail.Attempt
	}
	t.Fatal("missing persisted task-retried event")
	return "", "", 0
}

func TestAutoRetryEmitsTaskRetriedEvent(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	if err := HandleChildOutcome(h.ctx, h.workers[0], jarvis.OutcomeData{Status: "failed", Summary: "tool call errored: invalid input", ExitCode: 2}); err != nil {
		t.Fatal(err)
	}
	taskID, kind, attempt := latestRetriedDetail(t, h)
	if taskID != "t-0" || kind != FailureKindToolError || attempt != 1 {
		t.Fatalf("retried event = task %q kind %q attempt %d", taskID, kind, attempt)
	}
}

func TestTerminalBlockEmitsNoTaskRetriedEvent(t *testing.T) {
	h := newChildOutcomeHarness(t, 1)
	if err := HandleChildOutcome(h.ctx, h.workers[0], jarvis.OutcomeData{Status: "failed", Summary: "request timed out", ExitCode: 1}); err != nil {
		t.Fatal(err)
	}
	events, err := wstore.QueryRunEvents(h.ctx, h.channel, h.runID, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range events {
		if event.Kind == waveobj.RunEventKindTaskRetried {
			t.Fatal("non-retryable failure emitted a task-retried event")
		}
	}
	if got := h.loadDag(t); got.Status != DagStatus_Blocked {
		t.Fatalf("dag status = %q, want blocked", got.Status)
	}
}
