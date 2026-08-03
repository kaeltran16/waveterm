// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisproactive

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// Gate tunables. cosThreshold was calibrated 2026-07-27 against the real vault (647 chunks,
// text-embedding-3-small via OpenRouter): across five probe queries the best on-topic hit was 0.4579
// and an off-topic control topped out at 0.2342, so the whole usable range sits near 0.23–0.46. The
// previous 0.82 was set as if comparing a query to a near-paraphrase (which does score ~0.85), but
// retrieval compares a short query against a long chunk and those cosines run about half that — at
// 0.82 the gate admitted nothing at all and the proactive card could never fire.
//
// 0.40 keeps the "deliberately high bar" intent (it fired on 2 of the 5 probe queries) while being
// reachable. It is model-specific: switching jarvis:embedmodel shifts the distribution and this needs
// re-measuring.
//
// queryKPerCollection is per collection, not global: one global window of this size is filled by the
// memory collection alone on a real vault (406 memory / 14 tasks / 4 decisions), which starved
// dossiers and decisions out of the judge's shortlist entirely. It is unfitted, and with the score
// floor and prefilter's round-robin now bounding what reaches the judge, k is not what constrains
// admission. shortlistMax is likewise unfitted.
const (
	queryKPerCollection = 8    // semantic candidates requested from the index, per collection
	cosThreshold        = 0.40 // minimum cosine to survive the pre-filter
	shortlistMax        = 5    // max candidates handed to the model judge
)

type candidate struct {
	NodeID     string
	SourceType string
	Title      string
	Snippet    string
	Score      float32
}

// sourceTypeFor maps a vault collection to the display source type (mirrors
// jarvisrecall.nodeCandidate).
func sourceTypeFor(collection string) string {
	switch collection {
	case wavevault.CollTasks:
		return "dossier"
	case wavevault.CollDecisions:
		return "decision"
	default:
		return "memory"
	}
}

// prefilter keeps chunks scoring >= cosThreshold, drops the dispatching run's own node
// (excludeNodeID), dedupes by node id (a node may chunk into several sections), and caps at
// shortlistMax. Deterministic, no model, no I/O.
//
// Candidates are emitted round-robin across collections, best-first within each. Taking them in raw
// score order would re-impose the global ranking that QueryPerCollection removes one stage earlier:
// memory outnumbers tasks and decisions by more than an order of magnitude on a real vault, so its
// depth would fill every slot handed to the judge. Input order within a collection is already
// score-descending (QueryPerCollection merges that way), so preserving it keeps each collection's
// best hit first. Collections are visited in order of their single best hit, so the most on-topic
// one leads.
func prefilter(chunks []jarvisembed.ScoredChunk, excludeNodeID string) []candidate {
	seen := map[string]bool{}
	byColl := map[string][]candidate{}
	var collOrder []string
	for _, c := range chunks {
		if c.Score < cosThreshold {
			continue
		}
		if c.NodeID == excludeNodeID || seen[c.NodeID] {
			continue
		}
		seen[c.NodeID] = true
		title := strings.TrimSpace(c.SectionHeading)
		if title == "" {
			title = c.NodeID
		}
		if _, ok := byColl[c.Collection]; !ok {
			collOrder = append(collOrder, c.Collection)
		}
		byColl[c.Collection] = append(byColl[c.Collection], candidate{
			NodeID:     c.NodeID,
			SourceType: sourceTypeFor(c.Collection),
			Title:      title,
			Snippet:    strings.TrimSpace(c.Snippet),
			Score:      c.Score,
		})
	}
	var out []candidate
	for i := 0; ; i++ {
		before := len(out)
		for _, coll := range collOrder {
			if i >= len(byColl[coll]) {
				continue
			}
			out = append(out, byColl[coll][i])
			if len(out) >= shortlistMax {
				return out
			}
		}
		if len(out) == before {
			return out
		}
	}
}

// buildJudgePrompt asks the capable model to pick the single most-relevant prior
// item or answer "none". The model judges the given set; it never searches or
// invents (invariant 1). The prefer-none instruction is the noise gate.
func buildJudgePrompt(goal string, cands []candidate) string {
	var b strings.Builder
	b.WriteString("A new task is about to start. Below are candidate items of PAST work that a search flagged as possibly related.\n")
	b.WriteString("Decide whether any candidate is genuinely worth surfacing to someone starting this task — the SAME or a closely-related prior problem, decision, or task, not merely the same topic.\n\n")
	b.WriteString("New task goal:\n")
	b.WriteString(goal)
	b.WriteString("\n\nCandidates:\n")
	for i, c := range cands {
		fmt.Fprintf(&b, "%d. [%s] %s — %s\n", i+1, c.SourceType, c.Title, c.Snippet)
	}
	b.WriteString("\nReply with ONLY the number of the single best candidate (1")
	if len(cands) > 1 {
		fmt.Fprintf(&b, "-%d", len(cands))
	}
	b.WriteString("), or the word \"none\". Prefer \"none\" unless a candidate is clearly worth interrupting for. Do not explain.\n")
	return b.String()
}

var judgeNumRe = regexp.MustCompile(`\d+`)

// parseJudgeReply extracts the chosen 1-based index from the model reply and
// returns it 0-based, or -1 for "none"/empty/out-of-range/unparseable. Fails safe
// to -1 (silence) on any ambiguity.
func parseJudgeReply(reply string, n int) int {
	m := judgeNumRe.FindString(reply)
	if m == "" {
		return -1
	}
	var idx int
	if _, err := fmt.Sscanf(m, "%d", &idx); err != nil {
		return -1
	}
	if idx < 1 || idx > n {
		return -1
	}
	return idx - 1
}
