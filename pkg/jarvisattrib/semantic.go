// pkg/jarvisattrib/semantic.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvisdossier"
	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Semantic-layer (L4) tuning. semThreshold was calibrated 2026-07-27 against the real corpus
// (text-embedding-3-small via OpenRouter), scoring 14 known dossier→owner-run pairs against 238
// non-pairs. This comparison is doc-to-doc and its distribution is much higher than the query-to-chunk
// one jarvisproactive's gate sees — do not transplant a threshold between the two:
//
//	positive pairs: min 0.719, p50 0.961      negative pairs: p50 0.243, p90 0.416
//	0.50 -> 100% recall,  5.9% false positives
//	0.65 -> 100% recall, ~2.1% false positives   <- chosen
//	0.75 ->  93% recall,  1.7% false positives   (drops a true pair)
//
// 0.65 sits below the worst true pair (0.719) with margin while holding false positives near their
// floor — the FP rate is nearly flat from 0.60 to 0.70, so buying recall headroom there is free.
// Caveat: positives are partly circular, since a dossier objective is seeded from its run's goal, so
// real drifted pairs will score lower than this sample — which is the argument for the lower end of
// that band. Model-specific; re-measure if jarvis:embedmodel changes. semCandidateN is uncalibrated.
const (
	semCandidateN = 20   // most-recent window-overlapping runs considered per orphan dossier
	semThreshold  = 0.65 // cosine floor to propose a semantic edge
)

// openIndex is a seam so tests inject a temp index + mock embedder.
var openIndex = jarvisembed.OpenIndex

// SetOpenIndexForTest swaps the index opener; returns the previous value for restore.
func SetOpenIndexForTest(fn func(context.Context) (*jarvisembed.Index, error)) func(context.Context) (*jarvisembed.Index, error) {
	old := openIndex
	openIndex = fn
	return old
}

// proposeSemanticEdges is L4: for an under-attributed dossier it embeds the dossier fingerprint and each
// window-overlapping candidate run's fingerprint (cached), and proposes a low-confidence informing edge
// wherever cosine >= semThreshold. It reuses layer-3's ticket self-correction. Returns nil (never an error)
// when embeddings are unavailable — the caller degrades to the deterministic edge set.
func proposeSemanticEdges(ctx context.Context, d *jarvisdossier.Dossier, runs []*waveobj.Run, lk edgeLookups, now int64) []AttributedEdge {
	ix, err := openIndex(ctx)
	if err != nil || !ix.Available() {
		return nil
	}
	defer ix.Close()

	dossierVec, err := ix.EmbedCached(ctx, "dossier:"+d.ID, d.Hash, dossierFingerprint(d))
	if err != nil || len(dossierVec) == 0 {
		return nil
	}

	var out []AttributedEdge
	for _, r := range candidateRuns(d, runs, now, semCandidateN) {
		subs := lk.commits(r)
		if contradictsTicket(d.Ticket, subs) {
			continue
		}
		text := runFingerprint(r, subs)
		runVec, err := ix.EmbedCached(ctx, "run:"+r.OID, hashText(text), text)
		if err != nil || len(runVec) == 0 {
			continue
		}
		if jarvisembed.Cosine(dossierVec, runVec) < semThreshold {
			continue
		}
		out = append(out, AttributedEdge{
			DossierID:  d.ID,
			RunORef:    "run:" + r.OID,
			Layers:     []int{4},
			Provenance: provSemantic,
			Confidence: weightLayer4,
			State:      StateInforming,
		})
	}
	return out
}

// dossierFingerprint is the semantic text for a dossier: objective + acceptance criteria.
func dossierFingerprint(d *jarvisdossier.Dossier) string {
	parts := append([]string{d.Objective}, d.Acceptance...)
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// runFingerprint is the semantic text for a run: its goal + commit subjects.
func runFingerprint(r *waveobj.Run, commitSubjects []string) string {
	return strings.TrimSpace(r.Goal + "\n" + strings.Join(commitSubjects, "\n"))
}

// hashText is the cache invalidation key for a fingerprint (a Run has no vault ContentHash).
func hashText(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// candidateRuns keeps window-overlapping runs, most-recent first, capped at n. This is the deterministic
// "never compares against every run" pre-filter, before any embedding.
func candidateRuns(d *jarvisdossier.Dossier, runs []*waveobj.Run, now int64, n int) []*waveobj.Run {
	var cands []*waveobj.Run
	for _, r := range runs {
		if windowsOverlap(d, r, now) {
			cands = append(cands, r)
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].CreatedTs > cands[j].CreatedTs })
	if len(cands) > n {
		cands = cands[:n]
	}
	return cands
}
