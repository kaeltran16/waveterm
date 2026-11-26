// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Reasons recorded on a child-ask-cleared row. A clear is not an answer: the question went away
// without one, and the timeline has to say which way.
const (
	AskClearReasonDismissed   = "dismissed"    // a human dismissed the ask in the cockpit
	AskClearReasonWaiterEnded = "waiter-ended" // the asking agent died before an answer arrived
	AskClearReasonResumed     = "resumed"      // the agent moved on without the panel answer (rejected/interrupted in its own terminal)
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

// askRow is the detail every ask lifecycle row starts from, or nil for a target with nothing to attach to.
// The ask id is the registry's, so one id spans the raise, answer and clear rows whichever surface answered.
func askRow(t AskTarget) map[string]any {
	if t.ChannelId == "" || t.RunID == "" || t.TaskId == "" {
		return nil
	}
	d := map[string]any{"taskid": t.TaskId}
	if t.AskId != "" {
		d["askid"] = t.AskId
	}
	return d
}

// RecordAskLifecycle appends one closing ask lifecycle row: child-answered when any path delivers an
// answer, child-ask-cleared when it goes away unanswered, with detail the answer given or the clear reason,
// bounded by MaxAskSummaryLen. The raise records through recordChildAsk. Best-effort: a target with nothing
// to attach to, or a failed append, records nothing and never fails the ask path.
func RecordAskLifecycle(ctx context.Context, t AskTarget, kind, detail string) {
	d := askRow(t)
	if d == nil {
		return
	}
	if detail != "" {
		switch kind {
		case waveobj.RunEventKindChildAskCleared:
			d["reason"] = truncateText(detail, MaxAskSummaryLen)
		case waveobj.RunEventKindChildAnswered:
			d["answer"] = truncateText(detail, MaxAskSummaryLen)
		}
	}
	appendRunEvent(ctx, t.ChannelId, t.RunID, kind, nil, d)
}

// recordChildAsk appends the child-ask row for a raised question: what the lead's answer card draws, the
// task's label and the first question's header and options. Only the first question's options: the card
// matches the first answer against them, so a later question's would mislabel the pick. Previews stay out,
// as the card draws none. Every string is bounded by MaxAskSummaryLen.
func recordChildAsk(ctx context.Context, t AskTarget, label string, q baseds.AgentAskQuestion) {
	d := askRow(t)
	if d == nil {
		return
	}
	setTruncated := func(m map[string]any, key, s string) {
		if s != "" {
			m[key] = truncateText(s, MaxAskSummaryLen)
		}
	}
	setTruncated(d, "question", q.Question)
	setTruncated(d, "label", label)
	setTruncated(d, "header", q.Header)
	if len(q.Options) > 0 {
		opts := make([]map[string]any, 0, len(q.Options))
		for _, o := range q.Options {
			opt := map[string]any{"label": truncateText(o.Label, MaxAskSummaryLen)}
			setTruncated(opt, "description", o.Description)
			opts = append(opts, opt)
		}
		d["options"] = opts
	}
	appendRunEvent(ctx, t.ChannelId, t.RunID, waveobj.RunEventKindChildAsk, nil, d)
}

// PublishAskQueueChanged tells the run's cockpit that a question left its queue, answered or cleared, so its
// question card re-reads `dag asks` instead of going on showing it.
func PublishAskQueueChanged(g *waveobj.TaskGroup, t AskTarget) {
	publishChildAsk(agentask.PendingAsk{DagOID: g.OID, RunId: t.RunID, TaskId: t.TaskId, AskId: t.AskId})
}
