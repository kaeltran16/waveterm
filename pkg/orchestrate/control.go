package orchestrate

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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

var notifyLeadFn = NotifyLead

// notifyLeadBestEffort wakes the lead and records whether the control file actually reached it.
// Only a real write is reported as sent: a missing control dir or an unresolvable lead session is a
// silent no-op by design and must not show up in the timeline as a delivered notification.
func notifyLeadBestEffort(ctx context.Context, g *waveobj.TaskGroup, kind, detail string) {
	sent, err := notifyLeadFn(ctx, g, kind, detail)
	if err != nil {
		log.Printf("dag %s run %s notify lead %s: %v", g.OID, g.RunID, kind, err)
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindLeadControlFailed, nil, map[string]any{"kind": kind, "detail": detail, "error": err.Error()})
		return
	}
	if sent {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindLeadControlSent, nil, map[string]any{"kind": kind, "detail": detail})
	}
}

// NotifyLead writes a control event for the lead pi session of the owning run. The lead
// session id is resolved from the run's worker oref; unresolvable -> no-op (non-fatal). The bool
// reports whether a control file was actually written, so callers can tell a delivered notification
// from a configured-away one.
func NotifyLead(ctx context.Context, g *waveobj.TaskGroup, kind, detail string) (bool, error) {
	dir := os.Getenv("WAVETERM_PI_CONTROL_DIR")
	if dir == "" {
		return false, nil
	}
	sessionID := resolveLeadSessionID(ctx, g.ChannelId, g.RunID)
	if sessionID == "" {
		return false, nil
	}
	path := filepath.Join(dir, controlFileName(sessionID))
	if err := os.WriteFile(path, []byte(controlMessage(kind, detail)), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

// resolveLeadSessionID finds the pi session id of the owning run's lead worker so the control file
// (which the lead's pi watcher polls as <sessionId>.json) can be written for it. The session id is
// reported by the pi status extension via `wsh agentstatus --session-id` and lands in the retained
// agent:status events (baseds.AgentStatusData.SessionID, Persist:1) scoped to the lead's block — read
// the latest one back off the broker. Unresolvable -> "" (the notification is skipped, non-fatal).
// channelId comes from the TaskGroup — runs are channel-scoped, no scan needed.
func resolveLeadSessionID(ctx context.Context, channelId, runID string) string {
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

// PublishChildAsk broadcasts a child's pending ask scoped to the dag and its owning run, and wakes
// the lead. question is the first question's text — children block on one ask at a time.
func PublishChildAsk(ctx context.Context, g *waveobj.TaskGroup, taskId, question string) {
	detail, _ := json.Marshal(map[string]string{"taskid": taskId, "question": question})
	publishDagEvent(DagEventChildAsk, g, string(detail))
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindChildAsk, nil, map[string]any{"taskid": taskId, "question": truncateText(question, MaxAskSummaryLen)})
	notifyLeadBestEffort(ctx, g, DagEventChildAsk, fmt.Sprintf("%s: %s", taskId, question))
}

// PublishTaskStalled broadcasts a stalled child (no activity for the stall threshold) and wakes the
// lead with the task id.
func PublishTaskStalled(ctx context.Context, g *waveobj.TaskGroup, taskId string) {
	publishDagEvent(DagEventTaskStalled, g, taskId)
	notifyLeadBestEffort(ctx, g, DagEventTaskStalled, taskId)
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
