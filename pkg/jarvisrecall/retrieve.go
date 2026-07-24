// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// Deterministic retrieval bounds (PLACEHOLDER — tune against a populated vault; see docs/deferred.md).
const (
	seedTopK     = 6
	expandDepth  = 2
	expandFanout = 8
)

// kSem bounds how many semantic candidates L3 contributes (PLACEHOLDER — tune
// against a populated vault; see docs/deferred.md).
const kSem = 6

// openIndex is a seam so tests inject a temp index + mock embedder.
var openIndex = jarvisembed.OpenIndex

// SetOpenIndexForTest swaps the index opener; returns the previous value for restore.
func SetOpenIndexForTest(fn func(context.Context) (*jarvisembed.Index, error)) func(context.Context) (*jarvisembed.Index, error) {
	old := openIndex
	openIndex = fn
	return old
}

// semanticSeeds returns up to kSem node ids from the embedding index (layer 3), or
// nil when embeddings are unavailable or error — L3 degrades to L1/L2. The model
// never searches; this only widens the deterministic seed set. Recall's interactive
// scope is AllScope today (see scopeToVault); the physical collection boundary is
// enforced inside Query.
func semanticSeeds(ctx context.Context, v *wavevault.Vault, q string) []string {
	ix, err := openIndex(ctx)
	if err != nil || !ix.Available() {
		return nil
	}
	defer ix.Close()
	chunks, err := ix.Query(ctx, v, q, kSem, wavevault.AllScope())
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var ids []string
	for _, c := range chunks {
		if seen[c.NodeID] {
			continue
		}
		seen[c.NodeID] = true
		ids = append(ids, c.NodeID)
	}
	return ids
}

var (
	queryTicketRe = regexp.MustCompile(`[A-Z][A-Z0-9]+-\d+`)
	queryTokenRe  = regexp.MustCompile(`[a-z0-9]+`)
)

// analyzeQuery pulls structured ticket ids and lowercase keyword tokens (len>=4) from a question.
// This is the deterministic stand-in for model-driven intent classification (deferred with tiering).
func analyzeQuery(q string) (tickets []string, keywords []string) {
	tickets = dedupe(queryTicketRe.FindAllString(q, -1))
	var toks []string
	for _, tok := range queryTokenRe.FindAllString(strings.ToLower(q), -1) {
		if len(tok) >= 4 {
			toks = append(toks, tok)
		}
	}
	return tickets, dedupe(toks)
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// selectSeeds runs layer-1 (structured ticket Query) + layer-2 (full-text Search per keyword),
// merges/dedupes, ranks structured hits first then by recency, and returns the top-k node ids.
func selectSeeds(ctx context.Context, v *wavevault.Vault, r *wavevault.Retriever, q string) ([]string, error) {
	tickets, keywords := analyzeQuery(q)
	type hit struct {
		id         string
		structured bool
		ts         int64
	}
	seen := map[string]hit{}
	order := []string{}
	add := func(id string, structured bool, ts int64) {
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = hit{id, structured, ts}
		order = append(order, id)
	}
	for _, tk := range tickets {
		nodes, err := r.Query(wavevault.Filter{FrontmatterEquals: map[string]string{"ticket": tk}})
		if err != nil {
			return nil, err
		}
		for _, n := range nodes {
			add(n.ID, true, n.UpdatedTs)
		}
	}
	for _, kw := range keywords {
		hits, err := r.Search(kw)
		if err != nil {
			return nil, err
		}
		for _, h := range hits {
			add(h.Node.ID, false, h.Node.UpdatedTs)
		}
	}
	hits := make([]hit, 0, len(order))
	for _, id := range order {
		hits = append(hits, seen[id])
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].structured != hits[j].structured {
			return hits[i].structured
		}
		return hits[i].ts > hits[j].ts
	})
	if len(hits) > seedTopK {
		hits = hits[:seedTopK]
	}
	ids := make([]string, 0, len(hits)+kSem)
	have := map[string]bool{}
	for _, h := range hits {
		ids = append(ids, h.id)
		have[h.id] = true
	}
	// layer 3: append semantic seeds (deduped), bounding the widen at kSem. Because
	// ScoredChunk carries no timestamp, semantic hits are appended after the recency-
	// ranked deterministic top-k rather than interleaved by recency.
	for _, id := range semanticSeeds(ctx, v, q) {
		if have[id] {
			continue
		}
		have[id] = true
		ids = append(ids, id)
	}
	return ids, nil
}

// nodeCandidate maps a vault node + its body into a grounding candidate. Vault nodes are the
// canonical source, so freshness is always "fresh"; nav is a best-effort vault: target (G tolerates
// non-ORef nav targets, same as memory:).
func nodeCandidate(n wavevault.Node, body string) candidate {
	st := "memory"
	switch n.Collection {
	case wavevault.CollTasks:
		st = "dossier"
	case wavevault.CollDecisions:
		st = "decision"
	}
	return candidate{
		sourceType: st,
		title:      nodeTitle(n),
		ts:         n.UpdatedTs,
		freshness:  "fresh",
		navTarget:  "vault:" + n.ID,
		snippet:    truncate(strings.TrimSpace(body), 240),
	}
}

func nodeTitle(n wavevault.Node) string {
	if v, ok := n.Frontmatter["objective"]; ok {
		if s := fmt.Sprintf("%v", v); s != "" && s != "<nil>" {
			return s
		}
	}
	return n.ID
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
