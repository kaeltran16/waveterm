// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func ledgerFixture(ch *waveobj.Channel, runs []*waveobj.Run, attention []wshrpc.AttentionItem, now int64) *LedgerProducer {
	return &LedgerProducer{
		loadChannel:     func(context.Context, string) (*waveobj.Channel, error) { return ch, nil },
		getRuns:         func(context.Context, string) ([]*waveobj.Run, error) { return runs, nil },
		gatherAttention: func(context.Context) ([]wshrpc.AttentionItem, error) { return attention, nil },
		now:             func() int64 { return now },
	}
}

func shippedRun(oid, goal string, completedTs int64, summary string) *waveobj.Run {
	return &waveobj.Run{
		OID: oid, Goal: goal, Status: "done", CompletedTs: completedTs,
		Evidence: &waveobj.RunEvidence{Summary: summary},
	}
}

func tieredChannel(keys ...string) *waveobj.Channel {
	meta := waveobj.MetaMapType{}
	for _, k := range keys {
		meta[k] = true
	}
	return &waveobj.Channel{OID: "ch-1", Meta: meta}
}

// The ladder is the volume knob: a concierge channel (no tier meta) must stay exactly as silent about
// ledger facts as it was before this feature existed.
func TestLedgerSilentOnConciergeChannel(t *testing.T) {
	got, err := ledgerFixture(
		tieredChannel(),
		[]*waveobj.Run{shippedRun("r1", "ask bridge", 1000, "landed")},
		[]wshrpc.AttentionItem{{RunId: "r2", Source: "worker", Action: "Review", Text: "the diff", WaitingSince: 900}},
		2000,
	).Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("concierge channel must volunteer nothing, got %+v", got)
	}
}

// gatekeeper:enabled alone unlocks the register; delegator:enabled also counts (nesting is enforced by
// the writer, the OR is defensive against a future writer that sets only the delegator key).
func TestLedgerSpeaksOnGatekeeperAndDelegatorChannels(t *testing.T) {
	for _, keys := range [][]string{{jarvis.MetaKey_GatekeeperEnabled}, {jarvis.MetaKey_DelegatorEnabled}} {
		got, err := ledgerFixture(
			tieredChannel(keys...),
			[]*waveobj.Run{shippedRun("r1", "ask bridge", 1000, "landed")},
			[]wshrpc.AttentionItem{{RunId: "r1", Source: "worker", Action: "Review", Text: "the diff", WaitingSince: 900}},
			2000,
		).Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"})
		if err != nil {
			t.Fatalf("keys %v: unexpected error: %v", keys, err)
		}
		if len(got) != 2 {
			t.Fatalf("keys %v: want 2 candidates (shipped + attention), got %+v", keys, got)
		}
	}
}

// ID and At come from the FACT, never from emission time — the frontend watermark compares (At, ID)
// pairs, so a re-derived identical fact must carry an identical pair or say-once breaks.
func TestLedgerStampsFromFactsNotNow(t *testing.T) {
	got, _ := ledgerFixture(
		tieredChannel(jarvis.MetaKey_GatekeeperEnabled),
		[]*waveobj.Run{shippedRun("r1", "ask bridge", 1000, "landed")},
		[]wshrpc.AttentionItem{{RunId: "r1", Source: "worker", Action: "Review", Text: "the diff", WaitingSince: 900}},
		2000,
	).Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"})
	if got[0].ID != "shipped:r1" || got[0].At != 1000 {
		t.Fatalf("shipped stamp = (%q, %d), want (\"shipped:r1\", 1000)", got[0].ID, got[0].At)
	}
	if got[1].ID != "attention:r1" || got[1].At != 900 {
		t.Fatalf("attention stamp = (%q, %d), want (\"attention:r1\", 900)", got[1].ID, got[1].At)
	}
	if got[0].At == 2000 || got[1].At == 2000 {
		t.Fatal("At must come from the fact, not time.Now()")
	}
}

// Freshest first: prefilter keeps the first 5 unique ids across all producers, so recency here decides
// which ledger facts even compete for the judge's attention.
func TestLedgerRanksFreshestFirst(t *testing.T) {
	got, _ := ledgerFixture(
		tieredChannel(jarvis.MetaKey_GatekeeperEnabled),
		[]*waveobj.Run{
			shippedRun("old", "migration", 100, "done early"),
			shippedRun("new", "ask bridge", 1000, "landed"),
		},
		nil,
		2000,
	).Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"})
	if got[0].ID != "shipped:new" || got[1].ID != "shipped:old" {
		t.Fatalf("order = [%s, %s], want newest first", got[0].ID, got[1].ID)
	}
}

// A run completed before the 7-day window is history, not "shipped" — but attention can still speak.
// now is a realistic UnixMilli; the old run finished 8 days before it, outside the 7-day window.
func TestLedgerWindowFiltersOldRunsKeepsAttention(t *testing.T) {
	got, _ := ledgerFixture(
		tieredChannel(jarvis.MetaKey_GatekeeperEnabled),
		[]*waveobj.Run{shippedRun("old", "migration", 1767300000000, "done early")},
		[]wshrpc.AttentionItem{{RunId: "old", Source: "worker", Action: "Review", Text: "the diff", WaitingSince: 1767999000000}},
		1768000000000,
	).Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"})
	if len(got) != 1 || got[0].ID != "attention:old" {
		t.Fatalf("want only the attention candidate, got %+v", got)
	}
}

// An attention item for a run outside this channel is not this channel's business.
func TestLedgerAttentionScopedToChannelRuns(t *testing.T) {
	got, _ := ledgerFixture(
		tieredChannel(jarvis.MetaKey_GatekeeperEnabled),
		[]*waveobj.Run{shippedRun("r1", "ask bridge", 1000, "landed")},
		[]wshrpc.AttentionItem{{RunId: "other-run", Source: "worker", Action: "Review", Text: "elsewhere", WaitingSince: 900}},
		2000,
	).Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"})
	if len(got) != 1 || got[0].ID != "shipped:r1" {
		t.Fatalf("want only the shipped candidate, got %+v", got)
	}
}

// An undatable fact could never advance the watermark and would re-speak forever; drop it at the source.
func TestLedgerDropsUndatableFacts(t *testing.T) {
	got, _ := ledgerFixture(
		tieredChannel(jarvis.MetaKey_GatekeeperEnabled),
		[]*waveobj.Run{shippedRun("r1", "ask bridge", 0, "landed")},
		[]wshrpc.AttentionItem{{RunId: "r1", Source: "worker", Action: "Review", Text: "the diff", WaitingSince: 0}},
		2000,
	).Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"})
	if len(got) != 0 {
		t.Fatalf("undatable facts must be dropped, got %+v", got)
	}
}

// A long evidence summary is bounded before it reaches the judge prompt; the judge only needs the gist.
func TestLedgerTruncatesLongSummary(t *testing.T) {
	long := strings.Repeat("x", 400)
	got, _ := ledgerFixture(
		tieredChannel(jarvis.MetaKey_GatekeeperEnabled),
		[]*waveobj.Run{shippedRun("r1", "ask bridge", 1000, long)},
		nil,
		2000,
	).Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"})
	if len(got[0].Snippet) > 140 {
		t.Fatalf("snippet = %d chars, want <= 140", len(got[0].Snippet))
	}
	if !strings.HasSuffix(got[0].Snippet, "...") {
		t.Fatalf("snippet should end with ellipsis, got %q", got[0].Snippet)
	}
}

// A broken leg is collect()'s business to skip, but the producer must surface it, never panic.
func TestLedgerFetchFailureReturnsError(t *testing.T) {
	p := &LedgerProducer{
		loadChannel:     func(context.Context, string) (*waveobj.Channel, error) { return tieredChannel(jarvis.MetaKey_GatekeeperEnabled), nil },
		getRuns:         func(context.Context, string) ([]*waveobj.Run, error) { return nil, context.DeadlineExceeded },
		gatherAttention: func(context.Context) ([]wshrpc.AttentionItem, error) { return nil, nil },
		now:             func() int64 { return 2000 },
	}
	if _, err := p.Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"}); err == nil {
		t.Fatal("a failed run fetch must surface as an error")
	}
}

// The sweep is unattended cadence with no initiating channel — ledger facts never ride it.
func TestLedgerJoinsRunTriggersOnly(t *testing.T) {
	for _, kind := range []string{TriggerRunCreated, TriggerRunRest} {
		names := map[string]bool{}
		for _, p := range producersFor(&Trigger{Kind: kind}) {
			names[p.Name()] = true
		}
		if !names[ClassLedger] {
			t.Fatalf("%s producers must include ledger, got %v", kind, names)
		}
	}
	for _, p := range producersFor(&Trigger{Kind: TriggerSweep}) {
		if p.Name() == ClassLedger {
			t.Fatal("sweep producers must not include ledger")
		}
	}
}
