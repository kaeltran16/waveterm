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

// Gate tunables (PLACEHOLDER — a deliberately HIGH bar; tune against a populated,
// embedded vault; see docs/deferred.md).
const (
	queryK       = 8    // semantic candidates requested from the index
	cosThreshold = 0.82 // minimum cosine to survive the pre-filter
	shortlistMax = 5    // max candidates handed to the model judge
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

// prefilter keeps chunks scoring >= cosThreshold, drops the dispatching run's own
// node (excludeNodeID), dedupes by node id (a node may chunk into several
// sections), and caps at shortlistMax. Deterministic, no model, no I/O.
func prefilter(chunks []jarvisembed.ScoredChunk, excludeNodeID string) []candidate {
	seen := map[string]bool{}
	var out []candidate
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
		out = append(out, candidate{
			NodeID:     c.NodeID,
			SourceType: sourceTypeFor(c.Collection),
			Title:      title,
			Snippet:    strings.TrimSpace(c.Snippet),
			Score:      c.Score,
		})
		if len(out) >= shortlistMax {
			break
		}
	}
	return out
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
