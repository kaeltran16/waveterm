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

// L3's semantic window, fitted 2026-07-27 against the real 424-node corpus (406 memory / 14 tasks /
// 4 decisions) with openai/text-embedding-3-small, over 10 paraphrase queries and 4 off-topic
// controls. Both figures are model-specific: changing jarvis:embedmodel invalidates them.
//
// kSemPerCollection: every measured target ranked #1 or #2 within its own collection, so the
// requirement is >=2. Left at 6 for headroom — on this corpus k is not what bounds admission, the
// floor is, and no measurement distinguishes 3 from 6.
//
// semSeedFloor: the positive and off-topic distributions genuinely overlap (weakest true target
// 0.3442, loudest off-topic hit 0.3595), so no value separates them cleanly and this is a
// cost/benefit pick off the measured sweep rather than a threshold:
//
//	floor   targets kept   off-topic seeds admitted
//	0.300      10/10        9 across 2 of 4 controls
//	0.320      10/10        5 across 2 of 4
//	0.325      10/10        2 across 1 of 4
//	0.340      10/10        1 across 1 of 4
//	0.350       8/10        1 across 1 of 4
//
// 0.325 is the knee: it cuts off-topic noise by ~78% against 0.30 at no measured recall cost. 0.34
// scores marginally better but sits 0.004 under the weakest true positive — fitted to one data
// point. The error is asymmetric (a lost seed is silently missing context; an extra seed is a
// candidate the model can ignore and selectTerminal can report as weak), so the margin is worth
// one extra noise seed.
const (
	kSemPerCollection = 6
	semSeedFloor      = 0.325
)

// openIndex is a seam so tests inject a temp index + mock embedder.
var openIndex = jarvisembed.OpenIndex

// SetOpenIndexForTest swaps the index opener; returns the previous value for restore.
func SetOpenIndexForTest(fn func(context.Context) (*jarvisembed.Index, error)) func(context.Context) (*jarvisembed.Index, error) {
	old := openIndex
	openIndex = fn
	return old
}

// semanticSeeds returns node ids from the embedding index (layer 3) in score order, or nil when
// embeddings are unavailable or error — L3 degrades to L1/L2. The model never searches; this only
// widens the deterministic seed set. Recall's interactive scope is AllScope today (see
// scopeToVault); the physical collection boundary is enforced inside the index.
//
// The window is per-collection, not global. On the real corpus memory notes outnumber everything
// the second brain writes by roughly 23:1, so one global top-k is a near-total memory filter: a
// dossier that is correctly retrieved and correctly scored is still dropped before recall sees it.
// Relevance, not a quota, decides what each collection contributes — a collection holding nothing
// above semSeedFloor contributes nothing, so this widens the seed set without also making every
// unrelated question drag in six arbitrary notes.
func semanticSeeds(ctx context.Context, v *wavevault.Vault, q string) []string {
	ix, err := openIndex(ctx)
	if err != nil || !ix.Available() {
		return nil
	}
	defer ix.Close()
	chunks, err := ix.QueryPerCollection(ctx, v, q, kSemPerCollection, wavevault.AllScope())
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	byColl := map[string][]string{}
	var collOrder []string
	for _, c := range chunks {
		if c.Score < semSeedFloor || seen[c.NodeID] {
			continue
		}
		seen[c.NodeID] = true
		if _, ok := byColl[c.Collection]; !ok {
			collOrder = append(collOrder, c.Collection)
		}
		byColl[c.Collection] = append(byColl[c.Collection], c.NodeID)
	}
	// Round-robin, best-first within each collection. Concatenating the windows by raw score would
	// re-impose the very global ranking the per-collection query removed: memory's depth would fill
	// the head of the seed list and push the other collections past the downstream candidate cap.
	// Collections are visited in order of their single best hit, so the most on-topic one leads.
	var ids []string
	for i := 0; ; i++ {
		before := len(ids)
		for _, coll := range collOrder {
			if i < len(byColl[coll]) {
				ids = append(ids, byColl[coll][i])
			}
		}
		if len(ids) == before {
			return ids
		}
	}
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
	ids := make([]string, 0, len(hits)+kSemPerCollection)
	have := map[string]bool{}
	for _, h := range hits {
		ids = append(ids, h.id)
		have[h.id] = true
	}
	// layer 3: append semantic seeds (deduped, score-ordered). Because ScoredChunk carries no
	// timestamp, semantic hits are appended after the recency-ranked deterministic top-k rather
	// than interleaved by recency — L3 widens the deterministic set, it does not outrank it.
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
// non-ORef nav targets, same as memory:). seedRank is 0 for a node reached only by expansion.
func nodeCandidate(n wavevault.Node, body string, seedRank int) candidate {
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
		project:    n.Scope, // a mirrored hub note is another project's — say so rather than imply it is this one's
		ts:         n.UpdatedTs,
		freshness:  "fresh",
		navTarget:  "vault:" + n.ID,
		snippet:    truncate(strings.TrimSpace(body), 240),
		seedRank:   seedRank,
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
