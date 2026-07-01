// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvis is the home for the Jarvis manager's acting tiers. This tier (Gatekeeper) watches
// for worker asks on gatekeeper-enabled channels, classifies them with a headless claude, and either
// auto-answers routine ones or escalates genuine forks. Concierge (read+post) is separate for now.
package jarvis

import "github.com/wavetermdev/waveterm/pkg/waveobj"

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
