// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentsync projects the Wave Vault's canonical steering document and skills into every
// installed harness: a delimited region in each harness's home-level steering file, and one
// directory junction per skill in each harness's skills directory. One direction only — nothing is
// harvested back, and no harness's own enable/disable state is ever written.
// See docs/superpowers/specs/2026-09-07-harness-config-sync-design.md.
package agentsync

import "strings"

const (
	steeringBegin     = "<!-- ARC-STEERING:BEGIN (generated — do not edit; managed by Arc) -->"
	steeringEnd       = "<!-- ARC-STEERING:END -->"
	memoryBeginMarker = "<!-- ARC-MEMORY:BEGIN"
)

func renderRegion(body string) string {
	return steeringBegin + "\n" + strings.TrimRight(body, "\n") + "\n" + steeringEnd + "\n"
}

// applyRegion returns existing with the ARC-STEERING region set to body. Content outside the markers
// is untouched. A fresh region is inserted BEFORE any ARC-MEMORY region rather than appended, so the
// preferences are not buried under a memory projection that can run to hundreds of lines.
func applyRegion(existing, body string) string {
	region := renderRegion(body)
	if start := strings.Index(existing, steeringBegin); start >= 0 {
		rest := existing[start:]
		if endIdx := strings.Index(rest, steeringEnd); endIdx >= 0 {
			tail := rest[endIdx+len(steeringEnd):]
			return existing[:start] + region + strings.TrimPrefix(tail, "\n")
		}
	}
	if mem := strings.Index(existing, memoryBeginMarker); mem >= 0 {
		return existing[:mem] + region + "\n" + existing[mem:]
	}
	if strings.TrimSpace(existing) == "" {
		return region
	}
	return strings.TrimRight(existing, "\n") + "\n\n" + region
}

// blockBefore is the hand-written content ahead of any managed region — what adoption folds into the
// canonical document and then replaces.
func blockBefore(existing string) string {
	cut := len(existing)
	for _, marker := range []string{steeringBegin, memoryBeginMarker} {
		if idx := strings.Index(existing, marker); idx >= 0 && idx < cut {
			cut = idx
		}
	}
	return existing[:cut]
}

// memoryRegion is the ARC-MEMORY projection and everything after it. It belongs to pkg/memvault, not
// to this package — the Steering tab shows it folded and read-only so a harness file reads as a whole
// file rather than as the one zone Arc happens to own. Empty when the file carries no memory region.
func memoryRegion(existing string) string {
	if idx := strings.Index(existing, memoryBeginMarker); idx >= 0 {
		return existing[idx:]
	}
	return ""
}

// steeringState reports the harness's region against the shared doc: current when a re-render would
// change nothing, stale when it would, absent when there is no region to compare. Shared by Status
// and ReadHarness so a harness row and its open document can never disagree.
func steeringState(existing, shared string) string {
	if !strings.Contains(existing, steeringBegin) || strings.TrimSpace(shared) == "" {
		return "absent"
	}
	if applyRegion(existing, shared) == existing {
		return "current"
	}
	return "stale"
}

// joinOwn puts a harness's own block back in front of its managed regions, with exactly one blank
// line between them and no stray trailing blank when either side is empty.
func joinOwn(own, tail string) string {
	own = strings.TrimRight(own, "\n")
	tail = strings.TrimLeft(tail, "\n")
	switch {
	case own == "":
		return tail
	case tail == "":
		return own + "\n"
	}
	return own + "\n\n" + tail
}

// regionBody is the managed text inside the ARC-STEERING markers, or "" when the file carries no
// complete region. The inverse of renderRegion, so the shared zone shows exactly what Arc owns and
// nothing the user wrote around it.
func regionBody(existing string) string {
	start := strings.Index(existing, steeringBegin)
	if start < 0 {
		return ""
	}
	rest := existing[start+len(steeringBegin):]
	end := strings.Index(rest, steeringEnd)
	if end < 0 {
		return ""
	}
	return strings.Trim(rest[:end], "\n")
}

// carriedLines returns block's lines that are absent from shared, compared as a trimmed set so
// reordering and whitespace never register as a difference. It is what a fold moves and what the
// harness rows count as "rules of its own".
func carriedLines(block, shared string) []string {
	have := map[string]bool{}
	for _, l := range strings.Split(shared, "\n") {
		have[strings.TrimSpace(l)] = true
	}
	seen := map[string]bool{}
	var out []string
	for _, l := range strings.Split(block, "\n") {
		t := strings.TrimSpace(l)
		if t == "" || have[t] || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}
