// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvis is the home for the Jarvis manager's acting tiers. This tier (Gatekeeper) watches
// for worker asks on gatekeeper-enabled channels, classifies them with a headless claude, and either
// auto-answers routine ones or escalates genuine forks. Concierge (read+post) is separate for now.
package jarvis

import (
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// MetaKey_GatekeeperEnabled is the per-channel bool flag toggling Gatekeeper for that channel.
const MetaKey_GatekeeperEnabled = "gatekeeper:enabled"

// MetaKey_DelegatorEnabled toggles the Delegator (act) tier for a channel; nested above Gatekeeper.
// MetaKey_DelegatorMode is the channel's default dispatch mode ("report" | "manage" | "fanout").
const (
	MetaKey_DelegatorEnabled = "delegator:enabled"
	MetaKey_DelegatorMode    = "delegator:mode"
)

// TierMeta derives the two per-channel autonomy booleans from a tier name. The ladder is nested:
// delegator implies gatekeeper. Any unknown/empty tier falls to the floor (both off = concierge).
func TierMeta(tier string) (gatekeeper bool, delegator bool) {
	switch tier {
	case "delegator":
		return true, true
	case "gatekeeper":
		return true, false
	default:
		return false, false
	}
}

// ResolveGatekeeperChannel returns the gatekeeper-enabled channel that dispatched the worker at
// askingORef ("tab:<id>"), or nil. A channel owns a worker if it has a dispatch/directive message
// whose RefORef equals askingORef. First enabled owner wins (a worker in one channel is the norm).
func ResolveGatekeeperChannel(channels []*waveobj.Channel, askingORef string) *waveobj.Channel {
	for _, ch := range channels {
		if !ch.Meta.GetBool(MetaKey_GatekeeperEnabled, false) {
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
// Unlike ResolveGatekeeperChannel it is NOT gated by MetaKey_GatekeeperEnabled: starting a run is
// itself opting into Jarvis management, so run workers are always gatekept. Returns nil when no phase
// owns the oref. (Piece 5 can add a descendant/subagent predicate here without changing callers.)
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

// runWorkerTask is the classifier "task" context for a run worker: the phase it is executing, framed
// against the run goal. Falls back to the bare goal for an out-of-range index.
func runWorkerTask(run *waveobj.Run, phaseIdx int) string {
	if phaseIdx < 0 || phaseIdx >= len(run.Phases) {
		return run.Goal
	}
	p := run.Phases[phaseIdx]
	skill := p.Skill
	if skill == "" {
		skill = p.Kind
	}
	return fmt.Sprintf("%s phase (%s) of run goal: %s", p.Kind, skill, run.Goal)
}
