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

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Control delivery failure kinds recorded on a lead-control-failed row (spec 7.1). They are visible
// state, never engine state: the persisted cockpit DAG stays authoritative either way.
const (
	ControlFailureUnavailable = "unavailable" // no control directory, or no resolvable lead session
	ControlFailureWrite       = "write"       // the control file could not be written
)

// MaxControlErrEventLen bounds the error text a lead-control-failed row carries.
const MaxControlErrEventLen = 200

// ControlEnvelope is the identity half of a control-file payload. It exists so an acknowledgement
// coming back from the pi watcher can name the exact attempt it processed: without a stable event id
// a superseded control file and the one actually handled are indistinguishable.
type ControlEnvelope struct {
	EventID   string
	ChannelID string
	RunID     string
	TaskID    string // empty for dag-level events (blocked, complete)
	SessionID string
}

// ControlResult reports what one delivery attempt did. Sent is true only for a real file write;
// FailureKind is empty then, and one of the ControlFailure* values otherwise.
type ControlResult struct {
	Envelope    ControlEnvelope
	Sent        bool
	FailureKind string
}

// NewControlEventID mints the id a control attempt is known by, before delivery — the sent row, the
// envelope the watcher reads, and the acknowledgement all carry it.
func NewControlEventID() string { return uuid.NewString() }

// controlFileName mirrors pi/extensions/waveterm-tools.ts (sessionId -> <sessionId>.json).
func controlFileName(sessionID string) string { return sessionID + ".json" }

// controlCmd maps a dag event kind to the command name the pi watcher dispatches on.
var controlCmd = map[string]string{
	DagEventChildDone:   "child_done",
	DagEventGateOpen:    "gate_open",
	DagEventBlocked:     "dag_blocked",
	DagEventComplete:    "dag_complete",
	DagEventTaskSpawned: "task_spawned",
	DagEventChildAsk:    "child_ask",
	DagEventTaskStalled: "child_stalled",
}

// controlMessage builds the control-file payload the pi watcher understands: the cmd/content it
// dispatches on, plus the envelope it echoes back when acknowledging.
func controlMessage(kind, detail string, env ControlEnvelope) string {
	payload := map[string]any{
		"cmd":       controlCmd[kind],
		"content":   detail,
		"ts":        time.Now().UnixMilli(),
		"eventid":   env.EventID,
		"channelid": env.ChannelID,
		"runid":     env.RunID,
		"sessionid": env.SessionID,
	}
	if env.TaskID != "" {
		payload["taskid"] = env.TaskID
	}
	out, _ := json.Marshal(payload)
	return string(out)
}

var notifyLeadFn = NotifyLead

// notifyLeadBestEffort wakes the lead and records the attempt's authoritative outcome. All three
// outcomes are recorded, including "unavailable": a lead nobody could reach is a real gap in the
// timeline's story, and the digest surfaces it as such rather than as silence.
func notifyLeadBestEffort(ctx context.Context, g *waveobj.TaskGroup, kind, detail, taskID string) {
	res, err := notifyLeadFn(ctx, g, kind, detail, taskID)
	// cmd, not the dag event kind: the digest's ControlDigest.Kind is the watcher command name, so
	// storing the same value the envelope carries keeps the row and the file in one vocabulary.
	row := map[string]any{"eventid": res.Envelope.EventID, "cmd": controlCmd[kind], "detail": detail}
	if taskID != "" {
		row["taskid"] = taskID
	}
	if res.Envelope.SessionID != "" {
		row["sessionid"] = res.Envelope.SessionID
	}
	if res.Sent {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindLeadControlSent, nil, row)
		return
	}
	if err != nil {
		log.Printf("dag %s run %s notify lead %s: %v", g.OID, g.RunID, kind, err)
		row["error"] = truncateText(err.Error(), MaxControlErrEventLen)
	}
	row["failure"] = res.FailureKind
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindLeadControlFailed, nil, row)
}

// NotifyLead writes a control event for the lead pi session of the owning run. The lead session id is
// resolved from the run's worker oref; an unresolvable session (or no control directory at all) is
// non-fatal and comes back as an unavailable result, not an error.
func NotifyLead(ctx context.Context, g *waveobj.TaskGroup, kind, detail, taskID string) (ControlResult, error) {
	env := ControlEnvelope{EventID: NewControlEventID(), ChannelID: g.ChannelId, RunID: g.RunID, TaskID: taskID}
	dir := os.Getenv("WAVETERM_PI_CONTROL_DIR")
	if dir == "" {
		return ControlResult{Envelope: env, FailureKind: ControlFailureUnavailable}, nil
	}
	env.SessionID = resolveLeadSessionFn(ctx, g.ChannelId, g.RunID)
	if env.SessionID == "" {
		return ControlResult{Envelope: env, FailureKind: ControlFailureUnavailable}, nil
	}
	path := filepath.Join(dir, controlFileName(env.SessionID))
	if err := os.WriteFile(path, []byte(controlMessage(kind, detail, env)), 0o644); err != nil {
		return ControlResult{Envelope: env, FailureKind: ControlFailureWrite}, err
	}
	return ControlResult{Envelope: env, Sent: true}, nil
}

// resolveLeadSessionFn is the session-resolution seam; tests stub it so a control write can be
// exercised without a live agent-status broker history.
var resolveLeadSessionFn = resolveLeadSessionID

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
func PublishChildAsk(ctx context.Context, g *waveobj.TaskGroup, target AskTarget, question string) {
	detail, _ := json.Marshal(map[string]string{"taskid": target.TaskId, "question": question})
	publishDagEvent(DagEventChildAsk, g, string(detail))
	RecordAskLifecycle(ctx, target, waveobj.RunEventKindChildAsk, question)
	notifyLeadBestEffort(ctx, g, DagEventChildAsk, fmt.Sprintf("%s: %s", target.TaskId, question), target.TaskId)
}

// PublishTaskStalled broadcasts a stalled child (no activity for the stall threshold) and wakes the
// lead with the task id.
func PublishTaskStalled(ctx context.Context, g *waveobj.TaskGroup, taskId string) {
	publishDagEvent(DagEventTaskStalled, g, taskId)
	notifyLeadBestEffort(ctx, g, DagEventTaskStalled, taskId, taskId)
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
