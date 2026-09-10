// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Ask routing kinds: the deterministic outcomes of ClassifyAsk.
const (
	AskKindStatus  = "status"
	AskKindHistory = "history"
	AskKindDelta   = "delta"
	AskKindProse   = "prose"
)

// statusWords and historyWords are the ledger-routing word sets. Matching is token-boundary over
// analyzeQuery's keyword output: a keyword equal to a set member counts, substrings do not. A false
// positive only attaches deterministic ledger facts the judge can drop — harmless; a false negative
// silently loses the ledger, so the sets err toward inclusion.
var statusWords = map[string]bool{
	"status": true, "statuses": true, "blocked": true, "blocking": true, "stuck": true,
	"inflight": true, "flight": true, "progress": true, "waiting": true, "needsme": true,
	"ongoing": true, "active": true,
}

var historyWords = map[string]bool{
	"shipped": true, "ship": true, "done": true, "completed": true, "finished": true,
	"landed": true, "released": true, "since": true, "last": true, "week": true, "weeks": true,
	"yesterday": true, "when": true,
}

var windowUnits = map[string]time.Duration{
	"hour": time.Hour, "hours": time.Hour,
	"day": 24 * time.Hour, "days": 24 * time.Hour,
	"week": 7 * 24 * time.Hour, "weeks": 7 * 24 * time.Hour,
	"month": 30 * 24 * time.Hour, "months": 30 * 24 * time.Hour,
}

var (
	// lastWindowRe matches "last week" / "last 3 days" / "last month" on the raw query.
	lastWindowRe = regexp.MustCompile(`(?i)\blast\s+(\d+)?\s*(hour|hours|day|days|week|weeks|month|months)`)
	// sinceDateRe matches "since <RFC3339>" — prose dates ("since monday") are ambiguous and stay
	// history-routed (unbounded window) rather than guessed.
	sinceDateRe = regexp.MustCompile(`(?i)\bsince\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)`)
)

// ClassifyAsk decides the deterministic routing for a stateless ask. "status"/"history" attach
// ledger facts; "delta" attaches the windowed diff but ONLY when the prompt names an explicit time
// window — the stateless ask cannot know "last visit", that cursor is a delivery-axis detail.
// Anything else is prose recall. No model call decides routing.
func ClassifyAsk(q string) (kind string, windowMs int64) {
	_, keywords := analyzeQuery(q)
	tok := map[string]bool{}
	for _, k := range keywords {
		tok[k] = true
	}
	for w := range statusWords {
		if tok[w] {
			return AskKindStatus, 0
		}
	}
	for w := range historyWords {
		if !tok[w] {
			continue
		}
		if m := sinceDateRe.FindStringSubmatch(q); m != nil {
			ts, err := time.Parse(time.RFC3339, strings.Replace(m[1], " ", "T", 1))
			if err == nil {
				return AskKindDelta, ts.UnixMilli()
			}
		}
		if m := lastWindowRe.FindStringSubmatch(q); m != nil {
			n := int64(1)
			if m[1] != "" {
				if parsed, err := strconv.ParseInt(m[1], 10, 64); err == nil && parsed > 0 {
					n = parsed
				}
			}
			unit, ok := windowUnits[strings.ToLower(m[2])]
			if ok {
				return AskKindDelta, time.Now().Add(-unit * time.Duration(n)).UnixMilli()
			}
		}
		if tok["yesterday"] {
			return AskKindDelta, time.Now().Add(-24 * time.Hour).UnixMilli()
		}
		return AskKindHistory, 0
	}
	return AskKindProse, 0
}

// LedgerFact is one deterministic ledger-derived source the ask path attaches (active work, shipped
// items, delta events). AskLedgerFn fetches them; the wshserver handler implements it over
// pkg/jarvisstate so the recall package stays ledger-agnostic.
type LedgerFact struct {
	SourceType string
	Title      string
	Snippet    string
	NavTarget  string
	Ts         int64
}

// AskLedgerFn returns the ledger facts for one routed kind and window (0 = unbounded). A nil
// function means the ask path never attaches ledger facts.
type AskLedgerFn func(ctx context.Context, kind string, windowMs int64) ([]LedgerFact, error)

// AskResult is the stateless answer: prose plus the sources it was grounded on.
//
// Grounding carries the same card the conversation path builds, not the bare {oref, sourcetype, title}
// this used to return. Ask holds each candidate's project, timestamp and freshness the whole way
// through and used to discard all three on the way out, which left the only live feed of the "Drew on"
// band unable to report a reading — so the band had to call every citation unverified. Reusing the one
// card type is also what keeps a second, lossier definition of a source off the wire.
type AskResult struct {
	Answer    string
	Grounding []waveobj.JarvisConvoGroundingCard
	Terminal  string
}

// Ask is the stateless, non-durable ask: classify → attach ledger facts (when routed) → prose
// recall → judge → synthesize. Same retrieval→judge→synthesize core as Converse, minus
// conversation state and with the ledger facts inserted as numbered snippets.
func Ask(ctx context.Context, scope ScopeArgs, prompt string, ledgerFn AskLedgerFn) (AskResult, error) {
	kind, windowMs := ClassifyAsk(prompt)
	cands, err := retrieve(ctx, scope, prompt)
	if err != nil {
		return AskResult{}, err
	}
	if kind != AskKindProse && ledgerFn != nil {
		facts, ferr := ledgerFn(ctx, kind, windowMs)
		if ferr != nil {
			return AskResult{}, ferr
		}
		for _, f := range facts {
			cands = append(cands, candidate{
				sourceType: f.SourceType, title: f.Title, snippet: f.Snippet,
				navTarget: f.NavTarget, ts: f.Ts, freshness: "fresh",
			})
		}
	}
	cands = judgeCandidates(ctx, scopeCwd(scope), prompt, cands)
	if len(cands) == 0 {
		return AskResult{Answer: notFoundProse, Terminal: "notfound"}, nil
	}
	runCtx, cancel := context.WithTimeout(ctx, synthTimeout)
	defer cancel()
	prose, runErr := synthesize(runCtx, scopeCwd(scope), buildPrompt(prompt, cands), func(string) {})
	terminal := "answered"
	if runErr != nil {
		terminal = "weak"
	} else {
		terminal = selectTerminal(len(cands), countCitations(prose, len(cands)))
	}
	// buildCards is the conversation path's own card builder, so an ask's citation and a thread's
	// citation are the same object measured the same way — including AgeMs, which is taken now rather
	// than at retrieval because the synthesis above can run for tens of seconds.
	return AskResult{Answer: prose, Grounding: buildCards(cands, time.Now().UnixMilli()), Terminal: terminal}, runErr
}
