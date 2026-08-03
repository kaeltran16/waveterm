// pkg/jarvisattrib/edges.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisattrib is the Jarvis attribution engine (sub-project D): it infers confidence-weighted
// dossier<->Run edges from deterministic signals (layers 2-3), self-heals them, and exposes a unified
// edge read for the recall engine (C). It calls no model.
package jarvisattrib

import (
	"sort"
	"strings"
	"time"
)

// Layer confidence weights — PLACEHOLDER tuning, see docs/deferred.md.
const (
	weightLayer1 = 1.0 // canonical dispatch reference (written by F, read by D)
	weightLayer2 = 0.8 // identifier (ticket) match
	weightLayer3 = 0.3 // structural correlation (same repo + overlapping window)
	weightLayer4 = 0.2 // semantic similarity — always renders "weak" (see BucketFor)
)

// Lifecycle windows in UnixMilli — PLACEHOLDER tuning, see docs/deferred.md.
const (
	probationMs int64 = 24 * 60 * 60 * 1000      // before an inferred edge may harden
	timeBoxMs   int64 = 30 * 24 * 60 * 60 * 1000 // a never-reinforced layer-3 edge older than this decays
)

const (
	provDispatch   = "dispatch"
	provTicket     = "ticket-match"
	provStructural = "structural"
	provAccept     = "human-accept"
	provSemantic   = "semantic"
)

// nowFn is the clock, overridable in tests for probation/time-box coverage (mirrors jarvisdossier).
var nowFn = func() int64 { return time.Now().UnixMilli() }

type EdgeState string

const (
	StateInforming EdgeState = "informing" // inferred, live in traversal, not yet hardened
	StateConfirmed EdgeState = "confirmed" // canonical dispatch ref, deterministic hit past probation, or human-accepted
	StateDetached  EdgeState = "detached"  // human-rejected; suppressed from EdgesFor
)

// AttributedEdge is one dossier->Run attribution. Layers records which signals reinforce it; Confidence
// is the max weight over those layers. (Probation is a computed gate on informing edges — see extract.go —
// not a stored state.)
type AttributedEdge struct {
	DossierID  string
	RunORef    string
	Layers     []int
	Provenance string
	Confidence float64
	State      EdgeState
}

func confidenceFor(layers []int) float64 {
	max := 0.0
	for _, l := range layers {
		w := 0.0
		switch l {
		case 1:
			w = weightLayer1
		case 2:
			w = weightLayer2
		case 3:
			w = weightLayer3
		case 4:
			w = weightLayer4
		}
		if w > max {
			max = w
		}
	}
	return max
}

// strongestLayer returns the lowest layer number present — layer 1 is the strongest signal — or 0
// when there are none.
func strongestLayer(layers []int) int {
	best := 0
	for _, l := range layers {
		if best == 0 || l < best {
			best = l
		}
	}
	return best
}

// provenanceFor maps an edge to the provenance of its strongest (lowest-numbered) firing layer.
func provenanceFor(layers []int) string {
	switch strongestLayer(layers) {
	case 1:
		return provDispatch
	case 2:
		return provTicket
	case 3:
		return provStructural
	default:
		return provSemantic
	}
}

// BucketFor maps an edge's firing layers to its display bucket. It reads the layers rather than the
// confidence float because confidenceFor takes the MAX of four fixed layer weights and never blends
// them: the reachable confidence set is {0.2, 0.3, 0.8, 1.0}, so a float-threshold bucket had a band
// no edge could occupy. One mapping over what actually fires cannot drift out of sync with itself the
// way two coupled constant sets did. No layers means no signal, so the bucket is absent rather than a
// fabricated "weak" — the contract wshrpctypes_jarvis.go documents for a detached edge.
func BucketFor(layers []int) string {
	switch strongestLayer(layers) {
	case 1:
		return "strong" // canonical dispatch reference
	case 2:
		return "medium" // identifier (ticket) match
	case 3, 4:
		return "weak" // structural correlation, semantic similarity
	default:
		return ""
	}
}

func runRef(oid string) string { return "run-" + oid }

func refToRunORef(ref string) (string, bool) {
	if s, ok := strings.CutPrefix(ref, "run-"); ok && s != "" {
		return "run:" + s, true
	}
	return "", false
}

func orefToRunRef(oref string) (string, bool) {
	if s, ok := strings.CutPrefix(oref, "run:"); ok && s != "" {
		return "run-" + s, true
	}
	return "", false
}

func containsLayer(ls []int, x int) bool {
	for _, l := range ls {
		if l == x {
			return true
		}
	}
	return false
}

func dedupSortLayers(ls []int) []int {
	seen := map[int]bool{}
	var out []int
	for _, l := range ls {
		if !seen[l] {
			seen[l] = true
			out = append(out, l)
		}
	}
	sort.Ints(out)
	return out
}
