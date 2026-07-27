// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisproactive is the opt-in S3 proactive-resurfacing evaluator: at a
// Run dispatch it matches the run's goal against past vault work (S1's embedding
// index), gates behind a high cosine bar + one capable-model relevance judgement,
// and returns at most one "related prior work" suggestion. Off by default; a
// missing/failing provider degrades to no suggestion, never an error.
package jarvisproactive

// MetaKeyProactive is the run.Meta key holding the dispatch suggestion (a
// ProactiveSuggestion, or Status:"none" when nothing cleared the bar). Hand-kept
// contract mirrored on the frontend (view/agents/proactive.ts) — keep identical.
const MetaKeyProactive = "jarvis:proactive"

// MetaKeyProactiveDismissed is the run.Meta bool the frontend sets when the human
// dismisses the card; a dismissed suggestion never renders again. Mirrored on the FE.
const MetaKeyProactiveDismissed = "jarvis:proactive:dismissed"

// ProactiveSuggestion is the run.Meta payload. Status is "hit" (fields populated)
// or "none" (a persisted sentinel so a re-view never recomputes). Written by Go,
// read by TS — json tags are the wire contract.
type ProactiveSuggestion struct {
	Status     string `json:"status"`
	NodeID     string `json:"nodeId,omitempty"`
	SourceType string `json:"sourceType,omitempty"`
	Title      string `json:"title,omitempty"`
	Snippet    string `json:"snippet,omitempty"`
	Why        string `json:"why,omitempty"`
}
