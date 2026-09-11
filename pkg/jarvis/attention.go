// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure: assemble the cockpit-wide "needs you" list — review gates, Gatekeeper escalations and blocked
// workers, in that order, oldest first within each kind. This is the single definition; the frontend
// derivations it replaces (railneeds.ts / channelneeds.ts) were deleted, because a snapshot of every
// channel's runs is not live and could never see a gate outside the active channel.

package jarvis

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	AttentionGate       = "gate"
	AttentionEscalation = "escalation"
	AttentionAsk        = "ask"
	// dag items: statuses mirror orchestrate.DagStatus_* but are spelled here because jarvis is the
	// engine's client (orchestrate imports jarvis for run status — importing it back would cycle).
	AttentionDagGate    = "dag-gate"
	AttentionDagBlocked = "dag-blocked"
	AttentionPlanGate   = "plan-gate"
	// radar triage is the only kind that names no channel: a scan belongs to a project, not a
	// conversation, so its row addresses the report through ORef instead.
	AttentionRadarTriage = "radar-triage"
)

// mirrors orchestrate.TaskState_Done and the two RadarReport/RadarFinding vocabularies, spelled here
// for the same reason as the dag statuses above.
const (
	taskStateDone        = "done"
	taskStateSkipped     = "skipped"
	radarStatusCompleted = "completed"
	radarStatusPartial   = "partial"
	radarGroupNew        = "new"
	radarGroupRecurring  = "recurring"
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
	// Radar is every scan report, newest-first, as GetRadarReports returns them. radarTriageItems
	// depends on that order to pick the current report per project, so a caller must not re-sort it.
	Radar []*waveobj.RadarReport
}

// reviewGateIdx ports frontend runmodel.reviewGate: the gated phase awaiting approval, or -1. The engine
// halts after a gated phase completes (that phase done, its successor still pending); an orchestrator
// lead instead holds a running phase in place.
func reviewGateIdx(run *waveobj.Run) int {
	if run == nil || run.Status != "awaiting-review" {
		return -1
	}
	for i, p := range run.Phases {
		if p.State == "running" && p.Held {
			return i
		}
	}
	for i, p := range run.Phases {
		if p.Gate && p.State == "done" {
			if i+1 >= len(run.Phases) || run.Phases[i+1].State == "pending" {
				return i
			}
		}
	}
	return -1
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

// plural is a count plus its noun, singular at one. Every why-line is counts, and "1 tasks planned" on
// a surface whose whole promise is that the numbers are derived reads as a bug in the number.
func plural(n int, noun string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", noun)
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// phaseLabel is a phase's written name. A custom phase's kind says nothing, so it is named by the skill
// it runs when it has one.
func phaseLabel(p waveobj.RunPhase) string {
	if p.Kind == "custom" && p.Skill != "" {
		return p.Skill
	}
	if p.Kind == "" {
		return "phase"
	}
	return p.Kind
}

func donePhases(run *waveobj.Run) int {
	n := 0
	for _, p := range run.Phases {
		if p.State == "done" {
			n++
		}
	}
	return n
}

// gateWhy is the sentence Text cannot carry: how much of the run is already behind this gate, and what
// specifically does not start until it clears. Assembled from phase states, so it cannot disagree with
// the run it describes — nothing in a why-line is generated prose.
func gateWhy(run *waveobj.Run, idx int) string {
	done, total := donePhases(run), len(run.Phases)
	cur := run.Phases[idx]
	if cur.State == "running" && cur.Held {
		return fmt.Sprintf("The lead paused itself in the %s phase — %d of %d done. It resumes only when you approve.",
			phaseLabel(cur), done, total)
	}
	if idx+1 < total {
		return fmt.Sprintf("The %s phase finished — %d of %d done. The %s phase starts only when you approve.",
			phaseLabel(cur), done, total, phaseLabel(run.Phases[idx+1]))
	}
	return fmt.Sprintf("The %s phase finished — %d of %d done. The run seals only when you approve.",
		phaseLabel(cur), done, total)
}

// attentionCiteMax bounds a row's citation list. The Brief's rule is that nothing unbounded sits on the
// surface, and an execute phase can record dozens of artifacts.
const attentionCiteMax = 4

// gateCites are the artifacts the gated phase recorded — the concrete things approving it accepts. The
// remainder is counted rather than dropped: a silently truncated list would understate what the approval
// covers.
func gateCites(p waveobj.RunPhase) []string {
	var out []string
	for _, a := range p.Artifacts {
		if a = strings.TrimSpace(a); a != "" {
			out = append(out, a)
		}
	}
	if len(out) > attentionCiteMax {
		rest := len(out) - attentionCiteMax
		out = append(out[:attentionCiteMax:attentionCiteMax], fmt.Sprintf("+%d more", rest))
	}
	return out
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

func BuildAttention(in AttentionInput) []wshrpc.AttentionItem {
	var gates, escalations, asks []wshrpc.AttentionItem
	// ask orefs already represented by an escalation card — one waiting thing, one item.
	escalated := map[string]bool{}

	for _, ch := range in.Channels {
		for _, run := range ch.Runs {
			idx := reviewGateIdx(run)
			if idx < 0 {
				continue
			}
			effortOID, chunkLabel := attribution(run)
			gates = append(gates, wshrpc.AttentionItem{
				Kind:         AttentionGate,
				Key:          "gate:" + run.ID,
				ChannelId:    ch.OID,
				ChannelName:  ch.Name,
				RunId:        run.ID,
				Source:       run.Goal,
				Text:         "Approve before Jarvis proceeds.",
				Action:       "Review",
				PhaseIdx:     idx,
				WaitingSince: run.Phases[idx].DoneTs,
				EffortOID:    effortOID,
				ChunkLabel:   chunkLabel,
				Why:          gateWhy(run, idx),
				Cites:        gateCites(run.Phases[idx]),
			})
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
			// human) had its registry entry claimed and dropped, so it is no longer waiting.
			if _, pending := in.PendingAsks[card.AskORef]; !pending {
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
		// the field pair, not g.Status: orchestrate/dag.go:48 requires every reader of this gate to read
		// PlanGate+PlanApprovedTs so that a status recomputed from task state can never release it. That
		// is also why this is checked BEFORE the status switch — a group whose stored status has drifted
		// must not report a review gate for a plan nobody has approved yet.
		if g.PlanGate && g.PlanApprovedTs == 0 {
			planEffort, planChunk := attribution(findRun(in.Channels, g.RunID))
			gates = append(gates, wshrpc.AttentionItem{
				Kind:        AttentionPlanGate,
				Key:         "plan-gate:" + g.ID,
				ChannelId:   g.ChannelId,
				ChannelName: channelNameFor(in.Channels, g.ChannelId),
				RunId:       g.RunID,
				Source:      dagSource(in.Channels, g),
				Text:        "Approve the plan before any worker starts.",
				Action:      "Review",
				// nothing records when the plan was handed over. UpdatedTs is the closest honest proxy
				// and it bumps when a sent-back plan is redrafted, which is the behaviour you want: the
				// wait restarts when the plan changes. CreatedTs would age a redraft as the original.
				WaitingSince: g.UpdatedTs,
				EffortOID:    planEffort,
				ChunkLabel:   planChunk,
				Why:          fmt.Sprintf("%s planned, none dispatched. Approving is what spawns the first worker.", plural(len(g.Tasks), "task")),
			})
			continue
		}
		// statuses mirror orchestrate.DagStatus_AwaitingReview / DagStatus_Blocked (see AttentionDagGate).
		switch g.Status {
		case "awaiting-review":
			gates = append(gates, dagGateItems(in, g)...)
		case "blocked":
			blockedEffort, blockedChunk := attribution(findRun(in.Channels, g.RunID))
			gates = append(gates, wshrpc.AttentionItem{
				Kind:         AttentionDagBlocked,
				Key:          "dag-blocked:" + g.ID,
				ChannelId:    g.ChannelId,
				ChannelName:  channelNameFor(in.Channels, g.ChannelId),
				RunId:        g.RunID,
				Source:       dagSource(in.Channels, g),
				Text:         fmt.Sprintf("%d consecutive failures — decide retry/skip.", g.Failures),
				Action:       "Review",
				WaitingSince: g.UpdatedTs,
				EffortOID:    blockedEffort,
				ChunkLabel:   blockedChunk,
				Why: fmt.Sprintf("%d of %d tasks done. The group stays stopped until you retry or skip.",
					doneTasks(g), len(g.Tasks)),
			})
		}
	}

	byOID := map[string]AttentionChannel{}
	for _, ch := range in.Channels {
		byOID[ch.OID] = ch
	}
	for oref, p := range in.PendingAsks {
		if escalated[oref] {
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

	// Kind is the priority claim — a gate blocks a whole pipeline, an ask blocks one worker. Age only
	// breaks ties inside a kind. Key is the final tiebreak so map iteration cannot reorder equal items.
	triage := radarTriageItems(in.Radar)
	for _, group := range [][]wshrpc.AttentionItem{gates, escalations, asks, triage} {
		g := group
		sort.SliceStable(g, func(i, j int) bool {
			if g[i].WaitingSince != g[j].WaitingSince {
				return g[i].WaitingSince < g[j].WaitingSince
			}
			return g[i].Key < g[j].Key
		})
	}

	out := make([]wshrpc.AttentionItem, 0, len(gates)+len(escalations)+len(asks)+len(triage))
	out = append(out, gates...)
	out = append(out, escalations...)
	out = append(out, asks...)
	// triage is last because it is the weakest claim in the list: an untriaged finding blocks nothing
	// that is running, where every kind above it is holding a worker or a pipeline in place.
	out = append(out, triage...)
	return out
}

// dagGateItems is one row per task the engine is holding, not one per group: a dag with three gated
// tasks used to render a single row and the human could not tell which task was waiting. The predicate
// is orchestrate's own (control.go:196, digest.go:198, scheduler.go:13).
func dagGateItems(in AttentionInput, g *waveobj.TaskGroup) []wshrpc.AttentionItem {
	var out []wshrpc.AttentionItem
	effortOID, chunkLabel := attribution(findRun(in.Channels, g.RunID))
	done := doneTasks(g)
	for _, t := range g.Tasks {
		if !t.Gate || t.State != taskStateDone || t.Released {
			continue
		}
		label := t.Label
		if label == "" {
			label = t.ID
		}
		// LastActivity is the newest observed child transcript write, so on a finished task it
		// approximates when that task stopped. Unlike the group's UpdatedTs it differs per task, which
		// is what makes oldest-first inside the kind order the rows by how long each has really waited.
		since := t.LastActivity
		if since <= 0 {
			since = g.UpdatedTs
		}
		out = append(out, wshrpc.AttentionItem{
			Kind:         AttentionDagGate,
			Key:          "dag-gate:" + g.ID + ":" + t.ID,
			ChannelId:    g.ChannelId,
			ChannelName:  channelNameFor(in.Channels, g.ChannelId),
			RunId:        g.RunID,
			Source:       dagSource(in.Channels, g),
			Text:         fmt.Sprintf("Approve %s before the DAG proceeds.", label),
			Action:       "Review",
			WaitingSince: since,
			EffortOID:    effortOID,
			ChunkLabel:   chunkLabel,
			Why: fmt.Sprintf("%d of %d tasks done. Everything downstream stays queued until this one is released.",
				done, len(g.Tasks)),
		})
	}
	if len(out) == 0 {
		// the engine says it is holding this dag but no task matches. Rather than drop a gate the human
		// still has to clear, degrade to the group-level row this function replaced.
		out = append(out, wshrpc.AttentionItem{
			Kind:         AttentionDagGate,
			Key:          "dag-gate:" + g.ID,
			ChannelId:    g.ChannelId,
			ChannelName:  channelNameFor(in.Channels, g.ChannelId),
			RunId:        g.RunID,
			Source:       dagSource(in.Channels, g),
			Text:         "Approve the gate before the DAG proceeds.",
			Action:       "Review",
			WaitingSince: g.UpdatedTs,
			EffortOID:    effortOID,
			ChunkLabel:   chunkLabel,
			Why: fmt.Sprintf("%d of %d tasks done. Everything downstream stays queued until the gate is released.",
				done, len(g.Tasks)),
		})
	}
	return out
}

// radarTriageItems is ONE row per project, never one per finding: a scan routinely produces dozens,
// and the Brief's invariant is that nothing unbounded sits on the surface. Only the current report for
// a path counts — scan reconciliation carries an older report's live findings forward into the newer
// one, so counting both would report the same risk twice.
func radarTriageItems(reports []*waveobj.RadarReport) []wshrpc.AttentionItem {
	var out []wshrpc.AttentionItem
	claimed := map[string]bool{}
	for _, r := range reports {
		if r == nil || claimed[r.ProjectPath] {
			continue
		}
		// a scan still collecting has nothing settled to triage, and failed/cancelled has nothing
		// trustworthy. Both are skipped WITHOUT claiming the path, because the findings of the last
		// completed scan are still untriaged and a rescan in flight does not answer them.
		if r.Status != radarStatusCompleted && r.Status != radarStatusPartial {
			continue
		}
		claimed[r.ProjectPath] = true
		fresh, recurring := 0, 0
		for _, f := range r.Findings {
			// nolonger, dismissed and suppressed are already-decided states; a disposition IS the
			// decision. What is left is what nobody has ruled on.
			if f.Disposition != nil {
				continue
			}
			switch f.Group {
			case radarGroupNew:
				fresh++
			case radarGroupRecurring:
				recurring++
			}
		}
		n := fresh + recurring
		if n == 0 {
			continue
		}
		text := fmt.Sprintf("%d findings need triage.", n)
		if n == 1 {
			text = "1 finding needs triage."
		}
		source := r.ProjectName
		if source == "" {
			source = r.ProjectPath
		}
		out = append(out, wshrpc.AttentionItem{
			Kind:         AttentionRadarTriage,
			Key:          "radar:" + r.OID,
			Source:       source,
			Text:         text,
			Action:       "Triage",
			ORef:         waveobj.MakeORef(waveobj.OType_RadarReport, r.OID).String(),
			WaitingSince: r.CompletedTs,
			// the split is what the total cannot say: a recurring finding has already survived one scan
			// without anyone ruling on it, which is a different claim on your time than a new one.
			Why: fmt.Sprintf("%d new and %d recurring, none of them ruled on yet.", fresh, recurring),
		})
	}
	return out
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
		return g.Title
	}
	for _, ch := range channels {
		for _, run := range ch.Runs {
			if run.ID == g.RunID {
				return run.Goal
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
func GatherAttention(ctx context.Context) ([]wshrpc.AttentionItem, error) {
	chans, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing channels: %w", err)
	}
	runsByChannel := make(map[string][]*waveobj.Run, len(chans))
	for _, ch := range chans {
		runs, err := wstore.GetChannelRuns(ctx, ch.OID)
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
		owner, task := ResolveAskOwner(ctx, workerORef)
		if owner != nil {
			in.AskChannel[blockORef] = owner.OID
		}
		if task != "" {
			in.AskWorker[blockORef] = task
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
			if g, gerr := wstore.GetDag(ctx, run.DagORef); gerr == nil {
				in.Dags = append(in.Dags, g)
			}
		}
	}
	// read whole because a triage count comes off a report's findings. A failed read degrades to no
	// triage rows rather than failing the list — same posture as the non-loadable dag above, since a
	// queue missing one kind is still worth showing — but it is logged, not swallowed.
	if reports, rerr := wstore.GetRadarReports(ctx, ""); rerr != nil {
		log.Printf("jarvis attention: radar reports unreadable, triage rows omitted: %v", rerr)
	} else {
		in.Radar = reports
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
// Two ways to be gone, and the second only started mattering once asks became durable: the block
// object is deleted, or the block is job-backed and its job manager has stopped. A restored ask has
// no other retirement path — the daemon that would have sent a clear is the thing that died — so
// without the second check a job that ended between two boots would hold its row forever.
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
			gone, gerr := agentask.DurableAgentGone(ctx, parsed.OID)
			if gerr != nil {
				return nil, fmt.Errorf("checking pending ask agent %s: %w", parsed.OID, gerr)
			}
			if !gone {
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
