// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Reasons recorded on a child-ask-cleared row. A clear is not an answer: the question went away
// without one, and the timeline has to say which way.
const (
	AskClearReasonDismissed   = "dismissed"    // a human dismissed the ask in the cockpit
	AskClearReasonWaiterEnded = "waiter-ended" // the asking agent died before an answer arrived
)

// AskTarget names the dag child an ask belongs to. Lifecycle rows land on the dag's OWNING run, not
// the child's, so the lead's timeline carries the whole ask conversation in one place.
type AskTarget struct {
	ChannelId string
	RunID     string
	TaskId    string
	AskId     string
}

// ResolveAskTarget maps a dag child's run back to the task and owning run its ask lifecycle belongs
// to, and hands back the group so a caller that also needs to publish or notify does not re-load it.
// ok=false for a run outside a dag — a plain run's asks are not dag lifecycle.
func ResolveAskTarget(ctx context.Context, channelId string, child *waveobj.Run, askId string) (*waveobj.TaskGroup, AskTarget, bool) {
	if channelId == "" || child == nil || child.DagORef == "" {
		return nil, AskTarget{}, false
	}
	g, err := wstore.GetDag(ctx, child.DagORef)
	if err != nil {
		return nil, AskTarget{}, false
	}
	for i := range g.Tasks {
		if g.Tasks[i].RunID != child.ID {
			continue
		}
		return g, AskTarget{ChannelId: g.ChannelId, RunID: g.RunID, TaskId: g.Tasks[i].ID, AskId: askId}, true
	}
	return nil, AskTarget{}, false
}

// RecordAskLifecycle appends one ask lifecycle row: child-ask when the question is raised,
// child-answered when any path delivers an answer, child-ask-cleared when it goes away unanswered.
// detail is the question for a raise and the clear reason for a clear, both bounded by
// MaxAskSummaryLen; the ask id is the registry's, so one id spans the three rows whichever surface
// answered. Best-effort: a target with nothing to attach to, or a failed append, records nothing and
// never fails the ask path.
func RecordAskLifecycle(ctx context.Context, t AskTarget, kind, detail string) {
	if t.ChannelId == "" || t.RunID == "" || t.TaskId == "" {
		return
	}
	d := map[string]any{"taskid": t.TaskId}
	if t.AskId != "" {
		d["askid"] = t.AskId
	}
	if detail != "" {
		switch kind {
		case waveobj.RunEventKindChildAsk:
			d["question"] = truncateText(detail, MaxAskSummaryLen)
		case waveobj.RunEventKindChildAskCleared:
			d["reason"] = truncateText(detail, MaxAskSummaryLen)
		}
	}
	appendRunEvent(ctx, t.ChannelId, t.RunID, kind, nil, d)
}
