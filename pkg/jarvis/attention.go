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
	"sort"

	"github.com/wavetermdev/waveterm/pkg/agentask"
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

// runIdForWorker finds the run whose phases claim this worker tab oref.
func runIdForWorker(runs []*waveobj.Run, workerORef string) string {
	if workerORef == "" {
		return ""
	}
	for _, r := range runs {
		for _, p := range r.Phases {
			for _, wo := range p.WorkerOrefs {
				if wo == workerORef {
					return r.ID
				}
			}
		}
	}
	return ""
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
			escalations = append(escalations, wshrpc.AttentionItem{
				Kind:         AttentionEscalation,
				Key:          "esc:" + m.ID,
				ChannelId:    ch.OID,
				ChannelName:  ch.Name,
				RunId:        runIdForWorker(ch.Runs, card.WorkerORef),
				Source:       name,
				Text:         card.Question,
				Action:       "Decide",
				WaitingSince: m.Ts,
			})
		}
	}

	for _, g := range in.Dags {
		// statuses mirror orchestrate.DagStatus_AwaitingReview / DagStatus_Blocked (see AttentionDagGate).
		switch g.Status {
		case "awaiting-review":
			gates = append(gates, wshrpc.AttentionItem{
				Kind:         AttentionDagGate,
				Key:          "dag-gate:" + g.ID,
				ChannelId:    g.ChannelId,
				ChannelName:  channelNameFor(in.Channels, g.ChannelId),
				RunId:        g.RunID,
				Source:       dagSource(in.Channels, g),
				Text:         "Approve the gate before the DAG proceeds.",
				Action:       "Review",
				WaitingSince: g.UpdatedTs,
			})
		case "blocked":
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
		asks = append(asks, wshrpc.AttentionItem{
			Kind:         AttentionAsk,
			Key:          "ask:" + oref,
			ChannelId:    ch.OID,
			ChannelName:  ch.Name,
			RunId:        runIdForWorker(ch.Runs, in.AskWorkerORef[oref]),
			Source:       name,
			Text:         "Waiting on your reply",
			Action:       "Answer",
			WaitingSince: p.Ts,
		})
	}

	// Kind is the priority claim — a gate blocks a whole pipeline, an ask blocks one worker. Age only
	// breaks ties inside a kind. Key is the final tiebreak so map iteration cannot reorder equal items.
	for _, group := range [][]wshrpc.AttentionItem{gates, escalations, asks} {
		g := group
		sort.SliceStable(g, func(i, j int) bool {
			if g[i].WaitingSince != g[j].WaitingSince {
				return g[i].WaitingSince < g[j].WaitingSince
			}
			return g[i].Key < g[j].Key
		})
	}

	out := make([]wshrpc.AttentionItem, 0, len(gates)+len(escalations)+len(asks))
	out = append(out, gates...)
	out = append(out, escalations...)
	out = append(out, asks...)
	return out
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

// GatherAttention reads the live inputs and builds the list. Channels, runs and messages come from the
// store; pending asks come from the in-process registry, which is why this list is authoritative for the
// current server lifetime rather than absolutely (a wavesrv restart empties it until agents re-raise).
func GatherAttention(ctx context.Context) ([]wshrpc.AttentionItem, error) {
	chans, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("listing channels: %w", err)
	}
	in := AttentionInput{
		PendingAsks:   agentask.GlobalRegistry.List(),
		AskChannel:    map[string]string{},
		AskWorker:     map[string]string{},
		AskWorkerORef: map[string]string{},
	}
	for _, ch := range chans {
		runs, err := wstore.GetChannelRuns(ctx, ch.OID)
		if err != nil {
			return nil, fmt.Errorf("getting runs for channel %s: %w", ch.OID, err)
		}
		msgs, err := wstore.GetChannelMessages(ctx, ch.OID, 0, 0)
		if err != nil {
			return nil, fmt.Errorf("getting messages for channel %s: %w", ch.OID, err)
		}
		in.Channels = append(in.Channels, AttentionChannel{
			OID: ch.OID, Name: ch.Name, Runs: runs, Messages: msgs,
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
	return BuildAttention(in), nil
}
