package orchestrate

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// controlFileName mirrors pi/extensions/waveterm-tools.ts (sessionId -> <sessionId>.json).
func controlFileName(sessionID string) string { return sessionID + ".json" }

// controlMessage builds the control-file payload the pi watcher understands: {"cmd": ..., "content": ...}.
func controlMessage(kind, detail string) string {
	cmd := map[string]string{
		DagEventChildDone:   "child_done",
		DagEventGateOpen:    "gate_open",
		DagEventBlocked:     "dag_blocked",
		DagEventComplete:    "dag_complete",
		DagEventTaskSpawned: "task_spawned",
	}[kind]
	payload := map[string]any{"cmd": cmd, "content": detail, "ts": time.Now().UnixMilli()}
	out, _ := json.Marshal(payload)
	return string(out)
}

// NotifyLead writes a control event for the lead pi session of the owning run. The lead
// session id is resolved from the run's worker oref; unresolvable -> no-op (non-fatal).
func NotifyLead(ctx context.Context, g *waveobj.TaskGroup, kind, detail string) error {
	if dir := os.Getenv("WAVETERM_PI_CONTROL_DIR"); dir == "" {
		return nil
	}
	sessionID := resolveLeadSessionID(ctx, g.RunID)
	if sessionID == "" {
		return nil
	}
	path := filepath.Join(os.Getenv("WAVETERM_PI_CONTROL_DIR"), controlFileName(sessionID))
	return os.WriteFile(path, []byte(controlMessage(kind, detail)), 0o644)
}

// resolveLeadSessionID finds the pi session id of the owning run's lead worker. v1: the
// session id is reported by the pi extension via `wsh agentstatus --session-id` and lands in
// the persisted agent:status events (baseds.AgentStatusData.SessionID, Persist:1 on the
// block's event rail) — reading those back is a follow-up. Returning "" skips the
// notification (non-fatal by design); the cockpit/attention paths work without it.
func resolveLeadSessionID(ctx context.Context, runID string) string {
	return ""
}

// gatedTaskID returns the id of the done, unreleased gate halting the DAG, or "".
func gatedTaskID(g *waveobj.TaskGroup) string {
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if t.Gate && t.State == TaskState_Done && !t.Released {
			return t.ID
		}
	}
	return ""
}
