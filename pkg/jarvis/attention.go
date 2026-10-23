// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: assemble the cockpit-wide "needs you" list — blocked dags and held lands, Gatekeeper escalations,
// blocked workers and unverified runs, in that order, oldest first within each kind. This is the single
// definition; the frontend derivations it replaces (railneeds.ts / channelneeds.ts) were deleted, because a
// snapshot of every channel's runs is not live and could never see an item outside the active channel.

package jarvis

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// controllerStatusFn reads a block's live controller status (nil when no controller exists). A var for tests.
var controllerStatusFn = blockcontroller.GetBlockControllerRuntimeStatus

const (
	AttentionEscalation = "escalation"
	AttentionAsk        = "ask"
	// dag items: statuses mirror orchestrate.DagStatus_* but are spelled here because jarvis is the
	// engine's client (orchestrate imports jarvis for run status — importing it back would cycle).
	AttentionDagBlocked = "dag-blocked"
	// run outcome items: a finished run's branch that could not be merged back, and a finished run whose result
	// was not fully verified, which the human acknowledges once read.
	AttentionRunLandHeld   = "run-land-held"
	AttentionRunUnverified = "run-unverified"
)

// mirrors orchestrate.TaskState_*, spelled here for the same reason as the dag statuses above.
const (
	taskStateDone          = "done"
	taskStateSkipped       = "skipped"
	taskStateFailed        = "failed"
	taskStatePending       = "pending"
	taskStateReviewFailed  = "review-failed"
	maxConsecutiveFailures = 3 // mirrors orchestrate.MaxConsecutiveFailures
)

// AttentionChannel is one channel's contribution: its identity plus the rows the builder reads.
type AttentionChannel struct {
	OID      string
	Name     string
	Runs     []*waveobj.Run
	Messages []*waveobj.ChannelMessage
}

// AttentionInput is everything BuildAttention needs, already fetched. The three ask maps are all keyed
// by the ask's BLOCK oref (the pending-ask registry's key), and are produced by GatherAttention:
//   - AskChannel:    block oref -> owning channel oid ("" or missing = a standalone agent)
//   - AskWorker:     block oref -> worker display name
//   - AskWorkerORef: block oref -> the worker's TAB oref, used to find its owning run phase
type AttentionInput struct {
	Channels      []AttentionChannel
	PendingAsks   map[string]agentask.PendingAsk
	AskChannel    map[string]string
	AskWorker     map[string]string
	AskWorkerORef map[string]string
	Dags          []*waveobj.TaskGroup // engine-owned task DAGs (awaiting-review/blocked surface items)
}

// runForWorker finds the run whose phases claim this worker tab oref.
func runForWorker(runs []*waveobj.Run, workerORef string) *waveobj.Run {
	if workerORef == "" {
		return nil
	}
	for _, r := range runs {
		for _, p := range r.Phases {
			for _, wo := range p.WorkerOrefs {
				if wo == workerORef {
					return r
				}
			}
		}
	}
	return nil
}

func runID(run *waveobj.Run) string {
	if run == nil {
		return ""
	}
	return run.ID
}

// findRun locates a run by id across every channel in the input: a dag names its owning run id but not
// which channel holds the row for it.
func findRun(channels []AttentionChannel, id string) *waveobj.Run {
	if id == "" {
		return nil
	}
	for _, ch := range channels {
		for _, r := range ch.Runs {
			if r.ID == id {
				return r
			}
		}
	}
	return nil
}

// attribution is the initiative a waiting thing belongs to, read off the owning run's EffortRef. Both
// halves or neither: a chunk label with no effort oid names something the Brief cannot resolve, and the
// oid is what the frontend joins the title from, so the pair travels together.
func attribution(run *waveobj.Run) (effortOID string, chunkLabel string) {
	if run == nil || run.EffortRef == nil || run.EffortRef.EffortOID == "" {
		return "", ""
	}
	return run.EffortRef.EffortOID, run.EffortRef.ChunkLabel
}

// doneTasks counts the group's finished tasks. Skipped counts as finished — the human decided it, and a
// denominator that kept counting it would report the group as less complete than it is.
func doneTasks(g *waveobj.TaskGroup) int {
	n := 0
	for _, t := range g.Tasks {
		if t.State == taskStateDone || t.State == taskStateSkipped {
			n++
		}
	}
	return n
}

// firstLine is the first line of a multi-line message, for a row that carries one short sentence.
func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// attentionSourceMaxLen bounds a row's source line. A run's goal can be kilobytes; the row's text is the
// question that needs deciding, and a whole goal in front of it pushes it out of view.
const attentionSourceMaxLen = 80

// goalHeadline is the first line of a goal, cut to attentionSourceMaxLen runes, for a row that names its run.
func goalHeadline(goal string) string {
	line := strings.TrimSpace(firstLine(strings.TrimSpace(goal)))
	if r := []rune(line); len(r) > attentionSourceMaxLen {
		return string(r[:attentionSourceMaxLen-1]) + "…"
	}
	return line
}

// blockedTask is the task a blocked group is stopped on, and whether retrying it is the action: a failed
// review is judged, and a merge git refused or a failed Verify is resolved by hand, so only a failed task
// is retryable.
func blockedTask(g *waveobj.TaskGroup) (string, bool) {
	for _, t := range g.Tasks {
		if t.State == taskStateReviewFailed {
			return t.ID, false
		}
	}
	for _, t := range g.Tasks {
		if t.State == "blocked-merge" || t.State == "verify-failed" {
			return t.ID, false
		}
	}
	for _, t := range g.Tasks {
		if t.State == "failed" {
			return t.ID, true
		}
	}
	return "", false
}

// fixTree names where a blocked merge is fixed: the owner's landing tree, which is not where a human
// looks by default, or else the checkout.
func fixTree(owner *waveobj.Run) string {
	if owner != nil && owner.LandPath != "" {
		return owner.LandPath
	}
	return "the project checkout"
}

// dagBlockedReason says what holds a blocked dag, in the order the engine's digest (buildNext) ranks the
// human's actions: a failed review, a merge, a failed Verify, then failed tasks. At the failure limit the
// count wins over a failed task, because it explains why dispatch stopped. Anything else names each task
// that is not finished or waiting, since the count read "0 consecutive failures" for a state it did not
// cover.
func dagBlockedReason(g *waveobj.TaskGroup, owner *waveobj.Run) (text, why string) {
	done := fmt.Sprintf("%d of %d tasks done.", doneTasks(g), len(g.Tasks))
	name := func(t waveobj.TaskNode) string {
		if t.Label != "" {
			return t.Label
		}
		return t.ID
	}
	for _, t := range g.Tasks {
		if t.State != taskStateReviewFailed {
			continue
		}
		text = fmt.Sprintf("Review of %s failed", name(t))
		if note := firstLine(t.ReviewNote); note != "" {
			text += ": " + note
		}
		return text, fmt.Sprintf("%s The lead was woken to judge it: approve it as it is with `wsh jarvis dag approve %s`, send it back with `wsh jarvis dag sendback %s \"<guidance>\"`, or retry or skip it.", done, t.ID, t.ID)
	}
	for _, t := range g.Tasks {
		if t.State != "blocked-merge" {
			continue
		}
		if t.MergeError != "" {
			return fmt.Sprintf("Merge of %s was refused: %s", name(t), firstLine(t.MergeError)),
				fmt.Sprintf("%s Clear what git refused over, then retry with `wsh jarvis dag merge %s --continue`.", done, t.ID)
		}
		return fmt.Sprintf("Merge of %s is blocked by a conflict and needs resolving.", name(t)),
			fmt.Sprintf("%s Resolve the conflict in %s, `git add` it without committing, then run `wsh jarvis dag merge %s --continue`, which commits the squash.", done, fixTree(owner), t.ID)
	}
	for _, t := range g.Tasks {
		if t.State == "verify-failed" {
			return fmt.Sprintf("Verify failed after %s merged.", name(t)),
				fmt.Sprintf("%s Commit a fix in %s, then re-run Verify with `wsh jarvis dag merge %s --continue`.", done, fixTree(owner), t.ID)
		}
	}
	// mirrors orchestrate.FinalState_Failed; the lead gets the whole detail in its wake
	if g.Final != nil && g.Final.State == "failed" && g.Final.Killed {
		return "A step of the final stage was killed before it finished: " + strings.TrimSuffix(firstLine(g.Final.Detail), ":"),
			fmt.Sprintf("%s It judged nothing, so no fix round follows: rerun the stage with `wsh runs rerun-final %s` once whatever killed it is gone.", done, g.RunID)
	}
	if g.Final != nil && g.Final.State == "failed" {
		return "The final stage failed on the merged result: " + strings.TrimSuffix(firstLine(g.Final.Detail), ":"),
			done + " The lead fixes it in a fix round (`wsh jarvis dag submit --round`); after the last round the call is yours."
	}
	if g.Failures >= maxConsecutiveFailures {
		return fmt.Sprintf("%d consecutive failures — decide retry/skip.", g.Failures),
			done + " The group stays stopped until you retry or skip."
	}
	for _, t := range g.Tasks {
		if t.State != "failed" {
			continue
		}
		text = name(t) + " failed"
		if t.LastFailureKind != "" {
			text += ": " + t.LastFailureKind
		}
		return text, fmt.Sprintf("%s Retry it with `wsh jarvis dag retry %s`, skip it, or escalate it to another model.", done, t.ID)
	}
	var held []string
	for _, t := range g.Tasks {
		if t.State != taskStateDone && t.State != taskStateSkipped && t.State != taskStatePending {
			held = append(held, fmt.Sprintf("%s is %s", name(t), t.State))
		}
	}
	text = "The group is blocked."
	if len(held) > 0 {
		text = "The group is blocked: " + strings.Join(held, ", ")
	}
	return text, done + " `wsh jarvis dag status` lists each task's actions."
}

func BuildAttention(in AttentionInput) []wshrpc.AttentionItem {
	var holds, escalations, asks, unverified []wshrpc.AttentionItem
	// ask orefs already represented by an escalation card — one waiting thing, one item.
	escalated := map[string]bool{}

	for _, ch := range in.Channels {
		for _, run := range ch.Runs {
			if IsBuilderCheck(run) {
				continue
			}
			if it, ok := landHeldItem(ch, run); ok {
				holds = append(holds, it)
			}
			if it, ok := unverifiedItem(ch, run); ok {
				unverified = append(unverified, it)
			}
		}

		for _, m := range ch.Messages {
			if m.Kind != "jarvis-escalation" || m.Data == "" {
				continue
			}
			var card JarvisCardData
			if err := json.Unmarshal([]byte(m.Data), &card); err != nil || card.AskORef == "" {
				continue
			}
			// The registry is authoritative: an escalation whose ask was answered (by Jarvis or the
			// human) had its registry entry claimed and dropped, so it is no longer waiting. The ask id
			// matters because the agent's next ask takes the same oref, and would revive this card.
			if p, pending := in.PendingAsks[card.AskORef]; !pending || p.AskId != card.AskId {
				continue
			}
			escalated[card.AskORef] = true
			name := in.AskWorker[card.AskORef]
			if name == "" {
				name = "worker"
			}
			workerRun := runForWorker(ch.Runs, card.WorkerORef)
			escEffort, escChunk := attribution(workerRun)
			escalations = append(escalations, wshrpc.AttentionItem{
				Kind:         AttentionEscalation,
				Key:          "esc:" + m.ID,
				ChannelId:    ch.OID,
				ChannelName:  ch.Name,
				RunId:        runID(workerRun),
				Source:       name,
				Text:         card.Question,
				Action:       "Decide",
				WaitingSince: m.Ts,
				EffortOID:    escEffort,
				ChunkLabel:   escChunk,
				Why:          fmt.Sprintf("Jarvis escalated this instead of answering it; %s is paused until it is decided.", name),
			})
		}
	}

	for _, g := range in.Dags {
		owner := findRun(in.Channels, g.RunID)
		// a lead can finish its run past a failed final stage, and nothing moves the dag off it then
		if owner != nil && (owner.Status == RunStatus_Done || owner.Status == RunStatus_Cancelled) {
			continue
		}
		// mirrors orchestrate.DagStatus_Blocked (see AttentionDagBlocked)
		if g.Status == "blocked" {
			blockedEffort, blockedChunk := attribution(owner)
			text, why := dagBlockedReason(g, owner)
			taskID, retry := blockedTask(g)
			holds = append(holds, wshrpc.AttentionItem{
				Kind:         AttentionDagBlocked,
				Key:          "dag-blocked:" + g.ID,
				TaskId:       taskID,
				Retry:        retry,
				ChannelId:    g.ChannelId,
				ChannelName:  channelNameFor(in.Channels, g.ChannelId),
				RunId:        g.RunID,
				Source:       dagSource(in.Channels, g),
				Text:         text,
				Action:       "Review",
				WaitingSince: g.UpdatedTs,
				EffortOID:    blockedEffort,
				ChunkLabel:   blockedChunk,
				Why:          why,
			})
		}
	}

	byOID := map[string]AttentionChannel{}
	for _, ch := range in.Channels {
		byOID[ch.OID] = ch
	}
	for oref, p := range in.PendingAsks {
		// a plan task's question is its lead's until the lead forwards it or its deadline passes
		if escalated[oref] || p.Owner == agentask.AskOwner_Lead {
			continue
		}
		chOID := in.AskChannel[oref]
		ch := byOID[chOID]
		name := in.AskWorker[oref]
		if name == "" {
			name = "worker"
		}
		askRun := runForWorker(ch.Runs, in.AskWorkerORef[oref])
		askEffort, askChunk := attribution(askRun)
		asks = append(asks, wshrpc.AttentionItem{
			Kind:         AttentionAsk,
			Key:          "ask:" + oref,
			ChannelId:    ch.OID,
			ChannelName:  ch.Name,
			RunId:        runID(askRun),
			Source:       name,
			Text:         askText(p.Questions),
			Action:       "Answer",
			WaitingSince: p.Ts,
			EffortOID:    askEffort,
			ChunkLabel:   askChunk,
			Why:          fmt.Sprintf("%s is paused until you answer.", name),
		})
	}

	// Kind is the priority claim — a hold blocks a whole run, an ask blocks one worker. Age only
	// breaks ties inside a kind. Key is the final tiebreak so map iteration cannot reorder equal items.
	for _, group := range [][]wshrpc.AttentionItem{holds, escalations, asks, unverified} {
		g := group
		sort.SliceStable(g, func(i, j int) bool {
			if g[i].WaitingSince != g[j].WaitingSince {
				return g[i].WaitingSince < g[j].WaitingSince
			}
			return g[i].Key < g[j].Key
		})
	}

	out := make([]wshrpc.AttentionItem, 0, len(holds)+len(escalations)+len(asks)+len(unverified))
	out = append(out, holds...)
	out = append(out, escalations...)
	out = append(out, asks...)
	// an unverified outcome holds nothing at all: the run is done
	out = append(out, unverified...)
	return out
}

// landHeldItem is a done run whose branch the engine did not merge back, with the reason. The run's work is
// finished and waits only on the human clearing the reason, or dismissing the item.
func landHeldItem(ch AttentionChannel, run *waveobj.Run) (wshrpc.AttentionItem, bool) {
	// mirrors orchestrate.LandState_Held
	if run.Land == nil || run.Land.State != "held" || run.Land.Dismissed {
		return wshrpc.AttentionItem{}, false
	}
	effortOID, chunkLabel := attribution(run)
	why := fmt.Sprintf("The work is on wave/%s. Clear the reason, then run `wsh runs land %s`.", run.ID, run.ID)
	if run.Land.Dirty {
		why = fmt.Sprintf("The work is on wave/%s. It lands by itself once those changes are committed, stashed or moved aside; `wsh runs land %s` tries now.", run.ID, run.ID)
	}
	if run.Land.Busy {
		why = fmt.Sprintf("The work is on wave/%s. It lands by itself once the other landing lets go of the checkout; `wsh runs land %s` tries now.", run.ID, run.ID)
	}
	return wshrpc.AttentionItem{
		Kind:         AttentionRunLandHeld,
		Key:          "run-land-held:" + run.ID,
		ChannelId:    ch.OID,
		ChannelName:  ch.Name,
		RunId:        run.ID,
		Source:       goalHeadline(run.Goal),
		Text:         "The run's branch was not merged back: " + run.Land.Reason,
		Reason:       run.Land.Reason,
		Action:       "Review",
		WaitingSince: run.CompletedTs,
		EffortOID:    effortOID,
		ChunkLabel:   chunkLabel,
		Why:          why,
	}, true
}

// unverifiedItem is a done run whose result nothing fully checked: the final stage's unverified reasons, and
// the land's notes (a base that moved under the run). It stays until the human acknowledges it.
func unverifiedItem(ch AttentionChannel, run *waveobj.Run) (wshrpc.AttentionItem, bool) {
	if run.Status != RunStatus_Done || run.VerificationAckTs != 0 {
		return wshrpc.AttentionItem{}, false
	}
	var reasons []string
	// mirrors orchestrate.FinalState_Unverified
	if ev := run.Evidence; ev != nil && ev.Verification != nil && ev.Verification.State == "unverified" {
		reasons = append(reasons, ev.Verification.Reasons...)
	}
	if run.Land != nil {
		reasons = append(reasons, run.Land.Notes...)
	}
	if len(reasons) == 0 {
		return wshrpc.AttentionItem{}, false
	}
	effortOID, chunkLabel := attribution(run)
	return wshrpc.AttentionItem{
		Kind:         AttentionRunUnverified,
		Key:          "run-unverified:" + run.ID,
		ChannelId:    ch.OID,
		ChannelName:  ch.Name,
		RunId:        run.ID,
		Source:       goalHeadline(run.Goal),
		Text:         fmt.Sprintf("Finished, but %d %s not verified.", len(reasons), pluralThings(len(reasons))),
		Action:       "Acknowledge",
		WaitingSince: run.CompletedTs,
		EffortOID:    effortOID,
		ChunkLabel:   chunkLabel,
		Why:          fmt.Sprintf("Not verified: %s. Once read, acknowledge it with `wsh runs ack %s`.", strings.TrimRight(strings.Join(reasons, "; "), "."), run.ID),
	}, true
}

func pluralThings(n int) string {
	if n == 1 {
		return "thing was"
	}
	return "things were"
}

// askQuestionMax bounds the ask row's text. Every other row carries one short sentence, and an agent's
// question can run to a paragraph — a row that wraps to five lines pushes the rest of the queue off the
// screen, which is the opposite of what this list is for.
const askQuestionMax = 140

// askFallbackText is what the row said for every ask before it carried the question. Kept as the
// degraded reading: a malformed ask should still produce a row you can act on.
const askFallbackText = "Waiting on your reply"

// askText is the agent's own question. The registry has carried it all along (PendingAsk.Questions),
// and printing a fixed literal instead meant a queue of three asks said the same thing three times,
// so the human had to open each one to find out which was worth answering.
func askText(qs []baseds.AgentAskQuestion) string {
	if len(qs) == 0 {
		return askFallbackText
	}
	// Fields+Join rather than a newline replace: a question is composed for a terminal picker and can
	// carry hard-wrapped lines and runs of padding, all of which have to collapse for a one-line row.
	q := strings.Join(strings.Fields(qs[0].Question), " ")
	if q == "" {
		return askFallbackText
	}
	if r := []rune(q); len(r) > askQuestionMax {
		// runes, not bytes: a byte slice would cut a multi-byte character in half and emit invalid UTF-8.
		q = string(r[:askQuestionMax]) + "…"
	}
	if len(qs) > 1 {
		// a multi-question ask is one picker sequence, so say the first question is not all of it —
		// otherwise the row understates what answering actually costs.
		q = fmt.Sprintf("%s (+%d more)", q, len(qs)-1)
	}
	return q
}

// dagSource is the attention source line for a dag item: its title, else the owning run's goal.
func dagSource(channels []AttentionChannel, g *waveobj.TaskGroup) string {
	if g.Title != "" {
		return goalHeadline(g.Title)
	}
	for _, ch := range channels {
		for _, run := range ch.Runs {
			if run.ID == g.RunID {
				return goalHeadline(run.Goal)
			}
		}
	}
	return "orchestration dag"
}

func channelNameFor(channels []AttentionChannel, oid string) string {
	for _, ch := range channels {
		if ch.OID == oid {
			return ch.Name
		}
	}
	return ""
}

// attentionMessageWindow bounds the per-channel message read. Only escalation cards are scanned, and a
// card whose ask is no longer pending is dropped by the registry check anyway — recent history suffices.
const attentionMessageWindow = 50

// GatherAttention reads the live inputs and builds the list. Channels and runs come from the store;
// pending asks come from the in-process registry, which is why this list is authoritative for the
// current server lifetime rather than absolutely (a wavesrv restart empties it until agents re-raise).
// The store reads are the Shared ones: the cockpit polls this, and decoding every run, dag and report
// on each poll was most of what wavesrv allocated. Nothing here or in BuildAttention may modify them.
func GatherAttention(ctx context.Context) ([]wshrpc.AttentionItem, error) {
	chans, err := wstore.GetChannelsShared(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing channels: %w", err)
	}
	runsByChannel := make(map[string][]*waveobj.Run, len(chans))
	for _, ch := range chans {
		runs, err := wstore.GetChannelRunsShared(ctx, ch.OID)
		if err != nil {
			return nil, fmt.Errorf("getting runs for channel %s: %w", ch.OID, err)
		}
		runsByChannel[ch.OID] = runs
	}
	return GatherAttentionFromLedger(ctx, chans, runsByChannel)
}

// GatherAttentionFromLedger builds the attention list from channel/run rows the caller already holds,
// skipping the second full channels+runs read. Callers without them should use GatherAttention.
func GatherAttentionFromLedger(ctx context.Context, chans []*waveobj.Channel, runsByChannel map[string][]*waveobj.Run) ([]wshrpc.AttentionItem, error) {
	pendingAsks, err := livePendingAsks(ctx)
	if err != nil {
		return nil, err
	}
	in := AttentionInput{
		PendingAsks:   pendingAsks,
		AskChannel:    map[string]string{},
		AskWorker:     map[string]string{},
		AskWorkerORef: map[string]string{},
	}
	for _, ch := range chans {
		msgs, err := wstore.GetChannelMessages(ctx, ch.OID, 0, attentionMessageWindow)
		if err != nil {
			return nil, fmt.Errorf("getting messages for channel %s: %w", ch.OID, err)
		}
		in.Channels = append(in.Channels, AttentionChannel{
			OID: ch.OID, Name: ch.Name, Runs: runsByChannel[ch.OID], Messages: msgs,
		})
	}
	for blockORef := range in.PendingAsks {
		workerORef := ChannelOwnerORef(ctx, blockORef)
		in.AskWorkerORef[blockORef] = workerORef
		owner, _, source := ResolveAskOwner(ctx, workerORef)
		if owner != nil {
			in.AskChannel[blockORef] = owner.OID
		}
		if source != "" {
			in.AskWorker[blockORef] = source
		}
	}
	// engine DAGs: load the group of every run carrying a DagORef (children share the owner's oref,
	// so dedupe by dag id); non-loadable groups are skipped — attention degrades gracefully.
	seenDags := map[string]bool{}
	for _, ch := range in.Channels {
		for _, run := range ch.Runs {
			if run.DagORef == "" || seenDags[run.DagORef] {
				continue
			}
			seenDags[run.DagORef] = true
			if g, gerr := wstore.GetDagShared(ctx, run.DagORef); gerr == nil {
				in.Dags = append(in.Dags, g)
			}
		}
	}
	return BuildAttention(in), nil
}

// livePendingAsks is the registry's pending asks minus the ones whose agent is gone. Closing an
// agent's terminal deletes the block but nothing tells the ask registry, so the ask outlived the
// thing that raised it and the attention badge kept counting a question nobody could answer. Pruning
// here rather than off the blockclose event also survives a missed event: every poll re-checks.
// A pruned ask is retired for real — claimed, its --wait caller cancelled, and cleared to the
// frontend — not just filtered out of this one response.
//
// Two ways to be gone: the block object is deleted, or the block is a kept shell whose process ended
// without a clear ever coming.
func livePendingAsks(ctx context.Context) (map[string]agentask.PendingAsk, error) {
	pendingAsks := agentask.GlobalRegistry.List()
	for oref, pending := range pendingAsks {
		parsed, err := waveobj.ParseORef(oref)
		if err != nil || parsed.OType != waveobj.OType_Block {
			continue
		}
		block, err := wstore.DBGet[*waveobj.Block](ctx, parsed.OID)
		if err != nil {
			return nil, fmt.Errorf("checking pending ask block %s: %w", parsed.OID, err)
		}
		if block != nil {
			// a kept block whose process ended has no clear coming: the agent that would send it is gone
			rs := controllerStatusFn(parsed.OID)
			if rs == nil || rs.ShellProcStatus != blockcontroller.Status_Done {
				continue
			}
		}
		delete(pendingAsks, oref)
		claimed, ok := agentask.GlobalRegistry.Claim(oref, pending.AskId)
		if !ok {
			continue
		}
		agentask.GlobalRegistry.ResolveWaiter(claimed.AskId, agentask.WaitResult{Cancelled: true})
		PublishAgentAsk(baseds.AgentAskData{ORef: oref, AskId: claimed.AskId, Cleared: true})
	}
	return pendingAsks, nil
}
