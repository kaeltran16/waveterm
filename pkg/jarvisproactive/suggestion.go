// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jarvisproactive is the opt-in S3 proactive-resurfacing evaluator: at a
// Run dispatch it matches the run's goal against past vault work (S1's embedding
// index), gates behind a high cosine bar + one capable-model relevance judgement,
// and returns at most one "related prior work" suggestion. Off by default; a
// missing/failing provider degrades to no suggestion, never a failed run — but it
// always records that it ran, and why it found nothing.
package jarvisproactive

// MetaKeyProactive is the run.Meta key holding the dispatch suggestion (a
// ProactiveSuggestion: Status:"pending" while evaluating, "hit", or "none" with a
// Reason when nothing cleared the bar). Hand-kept contract mirrored on the
// frontend (view/agents/proactive.ts) — keep identical.
const MetaKeyProactive = "jarvis:proactive"

// MetaKeyProactiveDismissed is the run.Meta bool the frontend sets when the human
// dismisses the card; a dismissed suggestion never renders again. Mirrored on the FE.
const MetaKeyProactiveDismissed = "jarvis:proactive:dismissed"

// Status values. "pending" is written before evaluation begins so that a run which never reaches a
// verdict — a timeout, a crash — is distinguishable from one that ran and found nothing. Before this,
// six different failure paths all left run.Meta untouched, and absence meant all six.
const (
	StatusPending = "pending"
	StatusHit     = "hit"
	StatusNone    = "none"
)

// Reason explains a "none". Empty on a hit and on the pending marker.
const (
	ReasonNoCandidates  = "no-candidates"
	ReasonJudgeDeclined = "judge-declined"
	ReasonJudgeError    = "judge-error"
	ReasonEmbeddingsOff = "embeddings-off"
	ReasonIndexError    = "index-error"
	ReasonVaultError    = "vault-error"
	ReasonQueryError    = "query-error"
)

// ProactiveSuggestion is the run.Meta payload. Status is "pending" (the marker written before
// evaluation begins), "hit" (fields populated) or "none" (a persisted sentinel so a re-view never
// recomputes). Written by Go, read by TS — json tags are the wire contract.
type ProactiveSuggestion struct {
	Status     string `json:"status"`
	NodeID     string `json:"nodeId,omitempty"`
	SourceType string `json:"sourceType,omitempty"`
	Title      string `json:"title,omitempty"`
	Snippet    string `json:"snippet,omitempty"`
	Why        string `json:"why,omitempty"`
	Reason     string `json:"reason,omitempty"` // why a "none" is a none; empty on a hit
}
