// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisrecall

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvisembed"
	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

func TestClassifyAsk(t *testing.T) {
	cases := []struct {
		query      string
		wantKind   string
		wantWindow bool // windowMs != 0
	}{
		{"what is the status of the ask bridge", AskKindStatus, false},
		{"is anything blocked right now", AskKindStatus, false},
		{"did the ask bridge ship", AskKindHistory, false},
		{"what shipped since 2026-08-01T00:00:00Z", AskKindDelta, true},
		{"what happened last week", AskKindDelta, true},
		{"what happened in the last 3 days", AskKindDelta, true},
		{"why did we choose sqlite over postgres", AskKindProse, false},
		{"statusification of the frontend build", AskKindProse, false}, // substring must not match
		{"how do i cook pasta", AskKindProse, false},
	}
	for _, c := range cases {
		kind, windowMs := ClassifyAsk(c.query)
		if kind != c.wantKind {
			t.Fatalf("ClassifyAsk(%q) kind=%q want %q", c.query, kind, c.wantKind)
		}
		if (windowMs != 0) != c.wantWindow {
			t.Fatalf("ClassifyAsk(%q) windowMs=%d want nonzero=%v", c.query, windowMs, c.wantWindow)
		}
	}
}

// askFixture wires the seams: fixture vault for retrieval, stub judge, stub synthesize. Returns the
// vault so the ledgerFn stub can reference it.
func askFixture(t *testing.T) *wavevault.Vault {
	t.Helper()
	v, _ := seedVault(t)
	restoreV := SetOpenVaultForTest(func(context.Context) (*wavevault.Vault, error) { return v, nil })
	t.Cleanup(func() { SetOpenVaultForTest(restoreV) })
	restoreI := SetOpenIndexForTest(func(context.Context) (*jarvisembed.Index, error) {
		return nil, errors.New("no index in test")
	})
	t.Cleanup(func() { SetOpenIndexForTest(restoreI) })
	return v
}

func TestAskAttachesLedgerFactsForStatus(t *testing.T) {
	askFixture(t)
	var gotKind string
	var gotWindow int64
	ledgerFn := func(_ context.Context, kind string, windowMs int64) ([]LedgerFact, error) {
		gotKind, gotWindow = kind, windowMs
		return []LedgerFact{{SourceType: "status", Title: "the ask bridge", Snippet: "status: executing", NavTarget: "run:r1", Ts: 1}}, nil
	}
	restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
	defer restoreJ()
	restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) {
		return "the ask bridge is executing [1]", nil
	})
	defer SetSynthesizeForTest(restoreS)
	res, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, "what is the status of the ask bridge", ledgerFn)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if gotKind != AskKindStatus || gotWindow != 0 {
		t.Fatalf("ledgerFn kind=%q window=%d want status/0", gotKind, gotWindow)
	}
	if !strings.Contains(res.Answer, "executing") || res.Terminal != "answered" {
		t.Fatalf("res=%+v want synthesize output + answered terminal", res)
	}
	if len(res.Grounding) != 1 || res.Grounding[0].NavTarget != "run:r1" || res.Grounding[0].SourceType != "status" {
		t.Fatalf("grounding=%+v want the ledger fact", res.Grounding)
	}
}

// the ask used to flatten its candidates to {oref, sourcetype, title} on the way out, which left the
// "Drew on" band with no reading to report. Every field the band prints has to survive.
func TestAskGroundingCarriesTheReadingNotJustTheRef(t *testing.T) {
	askFixture(t)
	ledgerFn := func(_ context.Context, _ string, _ int64) ([]LedgerFact, error) {
		return []LedgerFact{{SourceType: "status", Title: "the ask bridge", NavTarget: "run:r1", Ts: time.Now().UnixMilli() - 90_000}}, nil
	}
	restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
	defer restoreJ()
	restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) {
		return "executing [1]", nil
	})
	defer SetSynthesizeForTest(restoreS)
	res, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, "what is the status of the ask bridge", ledgerFn)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if len(res.Grounding) != 1 {
		t.Fatalf("grounding=%+v want one card", res.Grounding)
	}
	card := res.Grounding[0]
	if card.N != 1 {
		t.Errorf("card N=%d want the citation index the prose cites", card.N)
	}
	if card.Freshness == "" {
		t.Errorf("card carries no freshness reading: %+v", card)
	}
	// AgeMs is taken at return, not at retrieval: the synthesis between them can run for tens of seconds
	if card.AgeMs < 90_000 {
		t.Errorf("card AgeMs=%d want at least the fact's own age", card.AgeMs)
	}
}

func TestAskRoutingTable(t *testing.T) {
	askFixture(t)
	// The contract under test is the routing rule itself: the ledger closure runs iff the query is
	// status/history/delta-shaped, never for prose or off-topic. Terminal behavior is pinned by the
	// dedicated judge tests below.
	cases := []struct {
		query  string
		wantFn bool
	}{
		{"what is the status of the ask bridge", true},
		{"did the ask bridge ship", true},
		{"what happened last week", true},
		{"why did we choose sqlite", false},
		{"how do i cook pasta", false},
	}
	for _, c := range cases {
		called := false
		ledgerFn := func(_ context.Context, _ string, _ int64) ([]LedgerFact, error) {
			called = true
			return nil, nil
		}
		restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
		restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) { return "x", nil })
		_, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, c.query, ledgerFn)
		restoreJ()
		SetSynthesizeForTest(restoreS)
		if err != nil {
			t.Fatalf("Ask(%q): %v", c.query, err)
		}
		if called != c.wantFn {
			t.Fatalf("Ask(%q) ledgerFn called=%v want %v", c.query, called, c.wantFn)
		}
	}
}

func TestAskJudgeNoneYieldsNotFound(t *testing.T) {
	askFixture(t)
	// Two ledger facts: a singleton shortlist skips the judge, so this needs >= 2 candidates to
	// exercise the "judge removed everything" path deterministically.
	ledgerFn := func(_ context.Context, _ string, _ int64) ([]LedgerFact, error) {
		return []LedgerFact{
			{SourceType: "status", Title: "a", NavTarget: "run:a", Ts: 1},
			{SourceType: "status", Title: "b", NavTarget: "run:b", Ts: 2},
		}, nil
	}
	restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "none", nil })
	defer restoreJ()
	restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) { return "x", nil })
	defer SetSynthesizeForTest(restoreS)
	res, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, "what is the status of the ask bridge", ledgerFn)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.Terminal != "notfound" || res.Answer != notFoundProse {
		t.Fatalf("res=%+v want notfound when the judge removes everything", res)
	}
}

func TestAskJudgeErrorKeepsAll(t *testing.T) {
	askFixture(t)
	ledgerFn := func(_ context.Context, _ string, _ int64) ([]LedgerFact, error) {
		return []LedgerFact{
			{SourceType: "status", Title: "a", NavTarget: "run:a", Ts: 1},
			{SourceType: "status", Title: "b", NavTarget: "run:b", Ts: 2},
		}, nil
	}
	restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "", errors.New("down") })
	defer restoreJ()
	restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) { return "answer [1]", nil })
	defer SetSynthesizeForTest(restoreS)
	res, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, "what is the status of the ask bridge", ledgerFn)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.Answer != "answer [1]" || len(res.Grounding) != 2 {
		t.Fatalf("res=%+v want answer with both ledger facts kept", res)
	}
}

func TestAskNoLedgerFnIsProseOnly(t *testing.T) {
	askFixture(t)
	restoreJ := SetJudgeForTest(func(_ context.Context, _, _ string) (string, error) { return "1", nil })
	defer restoreJ()
	restoreS := SetSynthesizeForTest(func(_ context.Context, _, _ string, _ func(string)) (string, error) { return "prose [1]", nil })
	defer SetSynthesizeForTest(restoreS)
	// "widget" matches the seedVault decision rationale, so prose recall finds one candidate.
	res, err := Ask(context.Background(), ScopeArgs{Mode: "all"}, "why did we choose the widget approach", nil)
	if err != nil {
		t.Fatalf("Ask: %v", err)
	}
	if res.Answer != "prose [1]" {
		t.Fatalf("res=%+v want prose-only answer", res)
	}
}
