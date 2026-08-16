package orchestrate

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
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
		DagEventChildAsk:    "child_ask",
		DagEventTaskStalled: "child_stalled",
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

// resolveLeadSessionID finds the pi session id of the owning run's lead worker so the control file
// (which the lead's pi watcher polls as <sessionId>.json) can be written for it. The session id is
// reported by the pi status extension via `wsh agentstatus --session-id` and lands in the retained
// agent:status events (baseds.AgentStatusData.SessionID, Persist:1) scoped to the lead's block — read
// the latest one back off the broker. Unresolvable -> "" (the notification is skipped, non-fatal).
func resolveLeadSessionID(ctx context.Context, runID string) string {
	channelId := runChannelID(runID)
	if channelId == "" {
		return ""
	}
	run, err := wstore.GetRun(ctx, channelId, runID)
	if err != nil {
		return ""
	}
	for _, p := range run.Phases {
		for _, oref := range p.WorkerOrefs {
			if !strings.HasPrefix(oref, "tab:") {
				continue
			}
			tab, terr := wstore.DBMustGet[*waveobj.Tab](ctx, strings.TrimPrefix(oref, "tab:"))
			if terr != nil || len(tab.BlockIds) == 0 {
				continue
			}
			blockOref := waveobj.MakeORef(waveobj.OType_Block, tab.BlockIds[0]).String()
			for _, scope := range []string{blockOref, waveobj.MakeORef(waveobj.OType_Tab, tab.OID).String()} {
				ev := wps.Broker.ReadEventHistory(wps.Event_AgentStatus, scope, 1)
				if len(ev) == 0 {
					continue
				}
				if data, ok := ev[len(ev)-1].Data.(baseds.AgentStatusData); ok && data.SessionID != "" {
					return data.SessionID
				}
			}
		}
	}
	return ""
}

// runChannelID resolves the channel owning a run by scanning channels for it (runs are channel-scoped
// and the caller here has only the run id). Empty when not found.
func runChannelID(runID string) string {
	ctx := context.Background()
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return ""
	}
	for _, ch := range channels {
		if runs, rerr := wstore.GetChannelRuns(ctx, ch.OID); rerr == nil {
			for _, r := range runs {
				if r.ID == runID {
					return ch.OID
				}
			}
		}
	}
	return ""
}

// PublishChildAsk broadcasts a child's pending ask scoped to the dag and its owning run, and wakes
// the lead. question is the first question's text — children block on one ask at a time.
func PublishChildAsk(ctx context.Context, g *waveobj.TaskGroup, taskId, question string) {
	detail, _ := json.Marshal(map[string]string{"taskid": taskId, "question": question})
	publishDagEvent(DagEventChildAsk, g, string(detail))
	_ = NotifyLead(ctx, g, DagEventChildAsk, fmt.Sprintf("%s: %s", taskId, question))
}

// PublishTaskStalled broadcasts a stalled child (no activity for the stall threshold) and wakes the
// lead with the task id.
func PublishTaskStalled(ctx context.Context, g *waveobj.TaskGroup, taskId string) {
	publishDagEvent(DagEventTaskStalled, g, taskId)
	_ = NotifyLead(ctx, g, DagEventTaskStalled, taskId)
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
