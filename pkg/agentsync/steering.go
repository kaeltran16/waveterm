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
