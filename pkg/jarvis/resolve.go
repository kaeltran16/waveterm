// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvis is the home for the Jarvis manager's acting tiers. This tier (Gatekeeper) watches
// for worker asks on gatekeeper-enabled channels, classifies them with a headless claude, and either
// auto-answers routine ones or escalates genuine forks. Concierge (read+post) is separate for now.
package jarvis

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MetaKey_GatekeeperEnabled is the per-channel bool flag toggling Gatekeeper for that channel.
const MetaKey_GatekeeperEnabled = "gatekeeper:enabled"

// The two autonomy tiers a channel can be set to.
const (
	Tier_Concierge  = "concierge"
	Tier_Gatekeeper = "gatekeeper"
)

// GatekeeperOn reports whether the Gatekeeper judges asks for the channel. It is on unless the channel
// was explicitly set to concierge: a project nobody has configured gets routine asks answered, and
// only an explicit concierge pick sends every ask to you.
func GatekeeperOn(ch *waveobj.Channel) bool {
	return ch.Meta.GetBool(MetaKey_GatekeeperEnabled, true)
}

// GatekeeperForTier maps a tier name to the channel's gatekeeper flag. An unknown tier is an error
// rather than a silent concierge, which would quietly stop the Gatekeeper for that project.
func GatekeeperForTier(tier string) (bool, error) {
	switch tier {
	case Tier_Gatekeeper:
		return true, nil
	case Tier_Concierge:
		return false, nil
	default:
		return false, fmt.Errorf("unknown autonomy tier %q (want %s or %s)", tier, Tier_Concierge, Tier_Gatekeeper)
	}
}

// ResolveGatekeeperChannel returns the gatekeeper-enabled channel that dispatched the worker at
// askingORef ("tab:<id>"), or nil. A channel owns a worker if it has a dispatch/directive message
// whose RefORef equals askingORef. First enabled owner wins (a worker in one channel is the norm).
func ResolveGatekeeperChannel(channels []*waveobj.Channel, askingORef string) *waveobj.Channel {
	for _, ch := range channels {
		if !GatekeeperOn(ch) {
			continue
		}
		for _, m := range ch.Messages {
			if (m.Kind == "dispatch" || m.Kind == "directive") && m.RefORef == askingORef {
				return ch
			}
		}
	}
	return nil
}

// ResolveDispatchChannel returns the channel that dispatched the worker at workerORef ("tab:<id>"),
// or nil. Unlike ResolveGatekeeperChannel it is NOT gated by MetaKey_GatekeeperEnabled: a worker's
// outcome belongs in its channel regardless of the channel's autonomy tier. First dispatch owner wins.
func ResolveDispatchChannel(channels []*waveobj.Channel, workerORef string) *waveobj.Channel {
	for _, ch := range channels {
		for _, m := range ch.Messages {
			if m.Kind == "dispatch" && m.RefORef == workerORef {
				return ch
			}
		}
	}
	return nil
}

// workerTaskFor returns the dispatch text for a worker oref (its task), or "" if not found.
func workerTaskFor(ch *waveobj.Channel, askingORef string) string {
	for _, m := range ch.Messages {
		if m.Kind == "dispatch" && m.RefORef == askingORef {
			return m.Text
		}
	}
	return ""
}

// RunWorkerMatch locates a run phase worker: the channel/run it belongs to and the phase index.
type RunWorkerMatch struct {
	Channel  *waveobj.Channel
	Run      *waveobj.Run
	PhaseIdx int
}

// ResolveRunWorker finds the run phase whose WorkerOrefs contains askingORef, across all channels.
// Unlike ResolveGatekeeperChannel it is NOT gated by the tier: it answers "whose worker is this", and
// handleAsk applies the tier to the channel it returns. Returns nil when no phase owns the oref.
// (Piece 5 can add a descendant/subagent predicate here without changing callers.)
func ResolveRunWorker(channels []*waveobj.Channel, askingORef string) *RunWorkerMatch {
	for _, ch := range channels {
		for ri := range ch.Runs {
			run := &ch.Runs[ri]
			for pi := range run.Phases {
				for _, wo := range run.Phases[pi].WorkerOrefs {
					if wo == askingORef {
						return &RunWorkerMatch{Channel: ch, Run: run, PhaseIdx: pi}
					}
				}
			}
		}
	}
	return nil
}

// ResolveRunWorkerFromMeta resolves the run/channel/phase owning a worker oref by reading the Phase-1/2
// owner stamp (jarvis:runoref/channeloref) off the worker tab, then loading the run + channel rows — an
// O(1) replacement for the ResolveRunWorker full scan. On any miss (unstamped worker, empty runoref, load
// error) it falls back to the scan so a best-effort stamp gap can never regress resolution. nil = no run.
func ResolveRunWorkerFromMeta(ctx context.Context, askingORef string) *RunWorkerMatch {
	runORef, channelORef, err := wstore.GetWorkerOwner(ctx, askingORef)
	if err != nil || runORef == "" || channelORef == "" {
		return resolveRunWorkerByScan(ctx, askingORef)
	}
	runRef, err1 := waveobj.ParseORef(runORef)
	chRef, err2 := waveobj.ParseORef(channelORef)
	if err1 != nil || err2 != nil {
		return resolveRunWorkerByScan(ctx, askingORef)
	}
	run, err := wstore.GetRun(ctx, chRef.OID, runRef.OID)
	if err != nil || run == nil {
		return resolveRunWorkerByScan(ctx, askingORef)
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, chRef.OID)
	if err != nil || ch == nil {
		return resolveRunWorkerByScan(ctx, askingORef)
	}
	phaseIdx := phaseIdxForWorker(run, askingORef)
	if phaseIdx < 0 {
		// stamp is stale (worker no longer in a phase) — trust the scan
		return resolveRunWorkerByScan(ctx, askingORef)
	}
	return &RunWorkerMatch{Channel: ch, Run: run, PhaseIdx: phaseIdx}
}

func phaseIdxForWorker(run *waveobj.Run, workerORef string) int {
	for pi := range run.Phases {
		for _, wo := range run.Phases[pi].WorkerOrefs {
			if wo == workerORef {
				return pi
			}
		}
	}
	return -1
}

// resolveRunWorkerByScan is the fallback: the old full scan over GetChannels.
func resolveRunWorkerByScan(ctx context.Context, askingORef string) *RunWorkerMatch {
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil
	}
	return ResolveRunWorker(channels, askingORef)
}

// resolveGatekeeperChannelByMeta resolves the gatekeeper-enabled channel that dispatched a concierge
// worker via the channeloref stamp (Task B3), returning the channel + its dispatch task text. Falls back
// to the message scan on a stamp miss. Returns (nil, "") when no gatekeeper-enabled channel owns it.
func resolveGatekeeperChannelByMeta(ctx context.Context, ownerORef string) (*waveobj.Channel, string) {
	_, channelORef, err := wstore.GetWorkerOwner(ctx, ownerORef)
	if err == nil && channelORef != "" {
		if chRef, perr := waveobj.ParseORef(channelORef); perr == nil {
			if ch, gerr := wstore.DBMustGet[*waveobj.Channel](ctx, chRef.OID); gerr == nil && ch != nil {
				if GatekeeperOn(ch) {
					return ch, workerTaskFor(ch, ownerORef)
				}
				return nil, "" // owned by a non-gatekeeper channel: not gatekept (matches old skip)
			}
		}
	}
	// fallback: full scan
	channels, cerr := wstore.GetChannels(ctx)
	if cerr != nil {
		return nil, ""
	}
	ch := ResolveGatekeeperChannel(channels, ownerORef)
	if ch == nil {
		return nil, ""
	}
	return ch, workerTaskFor(ch, ownerORef)
}

// RunOwnsWorker reports whether workerORef ("tab:<id>") is a recorded worker of the run — it appears in
// some phase's WorkerOrefs. Guards per-worker stop actions so only a worker the run actually owns can be
// targeted (never an arbitrary tab).
func RunOwnsWorker(run *waveobj.Run, workerORef string) bool {
	if run == nil {
		return false
	}
	for pi := range run.Phases {
		for _, wo := range run.Phases[pi].WorkerOrefs {
			if wo == workerORef {
				return true
			}
		}
	}
	return false
}

// runWorkerTask is the classifier "task" context for a run worker: the phase it is executing, framed
// against the whole run goal. Falls back to the bare goal for an out-of-range index.
func runWorkerTask(run *waveobj.Run, phaseIdx int) string {
	return runWorkerFrame(run, phaseIdx, run.Goal)
}

// runWorkerSource is the same frame around the goal's headline, for an attention row: the row's text is
// the worker's question, and a whole goal in front of it hides it.
func runWorkerSource(run *waveobj.Run, phaseIdx int) string {
	return runWorkerFrame(run, phaseIdx, goalHeadline(run.Goal))
}

func runWorkerFrame(run *waveobj.Run, phaseIdx int, goal string) string {
	if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
		return goal
	}
	p := run.Phases[phaseIdx]
	skill := p.Skill
	if skill == "" {
		skill = p.Kind
	}
	return fmt.Sprintf("%s phase (%s) of run goal: %s", p.Kind, skill, goal)
}
