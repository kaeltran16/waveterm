# Jarvis Ledger Volunteers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the pet volunteer work-ledger facts — what shipped in the last 7 days and what's waiting on you — gated on the trigger channel's autonomy tier (gatekeeper/delegator only).

**Architecture:** A fourth `Producer` implementation (`LedgerProducer`) in `pkg/jarvisvolunteer`, added to the run-created/run-rest trigger sets. It reads the trigger channel's tier from channel meta, derives shipped facts via the reused pure `jarvisstate.Shipped()` derivation, filters `jarvis.GatherAttention` items to the channel's runs, and emits per-fact candidates stamped from fact timestamps (the existing frontend watermark enforces say-once). The frontend gains one `PetEvent` kind.

**Tech Stack:** Go (backend producer), TypeScript/React (frontend kind), vitest + go test (tests).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-13-jarvis-ledger-volunteers-design.md`. Read it before starting.
- No new wshrpc/waveobj types → **do NOT run `task generate`**, no SQL migration.
- Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`).
- Go tests on this machine need `CGO_CFLAGS="-I$(pwd)/pkg/jarvisembed/csrc"` (bash) or the build fails on sqlite-vec headers.
- Typecheck via `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — plain `npx tsc` stack-overflows. Baseline is clean; any error is yours.
- Tier gate is `ch.Meta.GetBool(jarvis.MetaKey_GatekeeperEnabled, false) || ch.Meta.GetBool(jarvis.MetaKey_DelegatorEnabled, false)`. `SetChannelTierCommand` writes both booleans (delegator implies gatekeeper), the OR is defensive.
- Comments explain "why", never "what". No emojis.
- **Git: NEVER commit without explicit user approval.** All work (including spec + plan docs) goes in ONE commit at the end, after the user approves.
- `ID`/`At` are stamped from the FACT (run `CompletedTs`, attention `WaitingSince`), never `time.Now()`. The frontend watermark dedupes on the (At, ID) pair.
- When appending to an existing test file, append — do not replace the whole file (a whole-file write silently destroys prior tests).

---

### Task 1: LedgerProducer (backend)

**Files:**
- Create: `pkg/jarvisvolunteer/ledger.go`
- Create: `pkg/jarvisvolunteer/ledger_test.go`
- Modify: `pkg/jarvisvolunteer/volunteer.go` (two small edits: class const block ~line 18-25, `producersFor` ~line 39-47)

**Interfaces:**
- Consumes: `jarvisstate.Shipped(runs []*waveobj.Run, windowStartMs int64) []wshrpc.ShippedItem` (returns `{Project, RunOID, Goal, Summary, Files, Verifs, CompletedTs}`); `wstore.GetChannelRuns(ctx, channelId) ([]*waveobj.Run, error)`; `jarvis.GatherAttention(ctx) ([]wshrpc.AttentionItem, error)`; `wstore.GetChannels(ctx) ([]*waveobj.Channel, error)`; `waveobj.MetaMapType.GetBool(key string, def bool) bool`; `utilfn.EllipsisStr(s string, maxLen int) string` (byte-based, appends "...").
- Produces: `ClassLedger` const (`"ledger"`), `LedgerProducer` struct with `NewLedgerProducer()`, `Name() string` (returns `ClassLedger`), `Candidates(ctx context.Context, t *Trigger) ([]Candidate, error)`. `producersFor` includes ledger for `TriggerRunCreated` and `TriggerRunRest` (appended after the existing producer), never for the sweep.

- [ ] **Step 1: Write the failing tests**

Create `pkg/jarvisvolunteer/ledger_test.go`:

```go
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
			[]wshrpc.AttentionItem{{RunId: "r2", Source: "worker", Action: "Review", Text: "the diff", WaitingSince: 900}},
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
		[]wshrpc.AttentionItem{{RunId: "r2", Source: "worker", Action: "Review", Text: "the diff", WaitingSince: 900}},
		2000,
	).Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"})
	if got[0].ID != "shipped:r1" || got[0].At != 1000 {
		t.Fatalf("shipped stamp = (%q, %d), want (\"shipped:r1\", 1000)", got[0].ID, got[0].At)
	}
	if got[1].ID != "attention:r2" || got[1].At != 900 {
		t.Fatalf("attention stamp = (%q, %d), want (\"attention:r2\", 900)", got[1].ID, got[1].At)
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
func TestLedgerWindowFiltersOldRunsKeepsAttention(t *testing.T) {
	got, _ := ledgerFixture(
		tieredChannel(jarvis.MetaKey_GatekeeperEnabled),
		[]*waveobj.Run{shippedRun("old", "migration", 100, "done early")},
		[]wshrpc.AttentionItem{{RunId: "r2", Source: "worker", Action: "Review", Text: "the diff", WaitingSince: 900}},
		2000,
	).Candidates(context.Background(), &Trigger{Kind: TriggerRunCreated, ChannelID: "ch-1"})
	if len(got) != 1 || got[0].ID != "attention:r2" {
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
		[]wshrpc.AttentionItem{{RunId: "r2", Source: "worker", Action: "Review", Text: "the diff", WaitingSince: 0}},
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `CGO_CFLAGS="-I$(pwd)/pkg/jarvisembed/csrc" go test ./pkg/jarvisvolunteer/`
Expected: FAIL to compile — `undefined: ClassLedger`, `undefined: LedgerProducer` (the tests reference types that do not exist yet). A compile failure is the correct red state here.

- [ ] **Step 3: Implement the producer**

Create `pkg/jarvisvolunteer/ledger.go`:

```go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisvolunteer

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/jarvisstate"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// shippedWindowMs is how far back a completed run still counts as "shipped". Same 7-day window the
// landing briefing uses for its Shipped section.
const shippedWindowMs int64 = 7 * 24 * 60 * 60 * 1000

// snippetMax bounds an evidence summary before it reaches the judge prompt: the judge only needs the gist.
const snippetMax = 140

// LedgerProducer volunteers the state of the operator's work: runs shipped in the last 7 days and
// attention items waiting on the human. Tier-gated on the trigger channel (concierge stays silent),
// reading only the two ledger legs it needs and reusing jarvisstate.Shipped as the single source of
// truth for "what counts as shipped".
type LedgerProducer struct {
	loadChannel     func(ctx context.Context, channelID string) (*waveobj.Channel, error)
	getRuns         func(ctx context.Context, channelID string) ([]*waveobj.Run, error)
	gatherAttention func(ctx context.Context) ([]wshrpc.AttentionItem, error)
	now             func() int64
}

func NewLedgerProducer() *LedgerProducer {
	return &LedgerProducer{
		loadChannel:     liveChannel,
		getRuns:         wstore.GetChannelRuns,
		gatherAttention: jarvis.GatherAttention,
		now:             func() int64 { return time.Now().UnixMilli() },
	}
}

// liveChannel finds one channel by id. There is no GetChannel-by-id; the scan mirrors
// jarvisstate/fetch.go's fetchSeams.getChannels pattern.
func liveChannel(ctx context.Context, channelID string) (*waveobj.Channel, error) {
	chans, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("jarvisvolunteer: listing channels: %w", err)
	}
	for _, ch := range chans {
		if ch.OID == channelID {
			return ch, nil
		}
	}
	return nil, nil
}

func (p *LedgerProducer) Name() string { return ClassLedger }

func (p *LedgerProducer) Candidates(ctx context.Context, t *Trigger) ([]Candidate, error) {
	if t == nil || t.ChannelID == "" {
		return nil, nil // run-scoped: only run-created/run-rest triggers carry a channel
	}
	ch, err := p.loadChannel(ctx, t.ChannelID)
	if err != nil {
		return nil, err
	}
	if ch == nil ||
		(!ch.Meta.GetBool(jarvis.MetaKey_GatekeeperEnabled, false) &&
			!ch.Meta.GetBool(jarvis.MetaKey_DelegatorEnabled, false)) {
		return nil, nil // the ladder's volume knob: concierge channels stay quiet about ledger facts
	}
	runs, err := p.getRuns(ctx, t.ChannelID)
	if err != nil {
		return nil, err
	}
	now := p.now()
	var out []Candidate
	for _, s := range jarvisstate.Shipped(runs, now-shippedWindowMs) {
		if s.CompletedTs == 0 {
			continue // undatable: the watermark could never order it
		}
		out = append(out, Candidate{
			Class:      ClassLedger,
			ID:         "shipped:" + s.RunOID,
			At:         s.CompletedTs,
			Title:      "shipped: " + s.Goal,
			Snippet:    utilfn.EllipsisStr(s.Summary, snippetMax),
			SourceType: "run",
			SourceRef:  "run:" + s.RunOID,
		})
	}
	attention, err := p.gatherAttention(ctx)
	if err != nil {
		return nil, err
	}
	runByID := make(map[string]bool, len(runs))
	for _, r := range runs {
		runByID[r.OID] = true
	}
	for _, a := range attention {
		if !runByID[a.RunId] || a.WaitingSince == 0 {
			continue // not this channel's business, or undatable
		}
		out = append(out, Candidate{
			Class:      ClassLedger,
			ID:         "attention:" + a.RunId,
			At:         a.WaitingSince,
			Title:      "needs-you: " + a.Source,
			Snippet:    a.Action + ": " + a.Text,
			SourceType: "run",
			SourceRef:  "run:" + a.RunId,
		})
	}
	// freshest first: prefilter keeps the first 5 unique ids across producers, so recency here decides
	// which ledger facts even compete
	sort.Slice(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out, nil
}
```

Then edit `pkg/jarvisvolunteer/volunteer.go`. First the class block (currently lines ~18-25):

```go
// The three knowledge classes. Each reads an engine that already computes; none adds a retrieval pass.
const (
	ClassRecall     = "recall"     // a relevant past item, already judged at dispatch
	ClassConnection = "connection" // an attribution edge that just formed
	ClassLooseEnd   = "loose-end"  // a dossier going quiet
	ClassLedger     = "ledger"     // the state of your work: shipped runs, needs-you items
)
```

Then `producersFor` (currently lines ~39-47) — append the ledger producer to the run triggers only:

```go
var producersFor = func(t *Trigger) []Producer {
	switch t.Kind {
	case TriggerRunCreated:
		return []Producer{NewRecallProducer(), NewLedgerProducer()}
	case TriggerRunRest:
		return []Producer{NewConnectionProducer(), NewLedgerProducer()}
	default:
		return []Producer{NewLooseEndProducer()}
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `CGO_CFLAGS="-I$(pwd)/pkg/jarvisembed/csrc" go test ./pkg/jarvisvolunteer/`
Expected: PASS — all existing tests plus the 9 new ones (`ok github.com/wavetermdev/waveterm/pkg/jarvisvolunteer`).

Also run `CGO_CFLAGS="-I$(pwd)/pkg/jarvisembed/csrc" go vet ./pkg/jarvisvolunteer/` — expected: clean.

- [ ] **Step 5: (no commit — batched at the end per the git workflow)**

---

### Task 2: Frontend ledger kind

**Files:**
- Modify: `frontend/app/view/jarvis/petjoin.ts:141` — `VOLUNTEER_KINDS`
- Modify: `frontend/app/view/jarvis/petbubble.tsx:~36-44` — `KIND_LABEL`
- Test: `frontend/app/view/jarvis/petjoin.test.ts` (append — never replace the file)

**Interfaces:**
- Consumes: the backend's `VolunteerData.class` now includes `"ledger"` (already in `frontend/types/gotypes.d.ts` as a plain string — no regen needed). `PetEvent["kind"]` is the union including `VolunteerKind`; `KIND_LABEL: Record<PetEvent["kind"], string>` is exhaustive, so TypeScript enforces the petbubble entry.
- Produces: pet events with `kind: "ledger"` flowing through `eventFromVolunteer` → bubble label "Work state".

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/jarvis/petjoin.test.ts` (inside the existing `describe("eventFromVolunteer", ...)` block, after the existing cases):

```ts
    // the ledger register reports the state of your work, so its payload carries a run source
    it("maps the ledger class to an utterance with a run source", () => {
        const ev = eventFromVolunteer({
            class: "ledger",
            id: "shipped:run-1",
            at: 900,
            title: "shipped: ask bridge",
            text: "landed, changed 12 files",
            sourcetype: "run",
            ref: "run:run-1",
        });
        expect(ev?.kind).toBe("ledger");
        expect(ev?.text).toBe("shipped: ask bridge - landed, changed 12 files");
        expect(ev?.sources?.[0].ref).toBe("run:run-1");
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/jarvis/petjoin.test.ts`
Expected: FAIL — `eventFromVolunteer` returns null because `"ledger"` is not in `VOLUNTEER_KINDS` (the class is filtered out at petjoin.ts:153).

- [ ] **Step 3: Implement the two-line change**

Edit `frontend/app/view/jarvis/petjoin.ts:141`:

```ts
const VOLUNTEER_KINDS = ["recall", "connection", "loose-end", "ledger"] as const;
```

Edit `frontend/app/view/jarvis/petbubble.tsx` — add the entry to `KIND_LABEL` (the Record is exhaustive over `PetEvent["kind"]`; this entry is what makes the typecheck pass again after the VOLUNTEER_KINDS change):

```ts
const KIND_LABEL: Record<PetEvent["kind"], string> = {
    resume: "Where we were",
    sweep: "While you were out",
    "distill-batch": "While you were out",
    "bg-agent-done": "While you were out",
    recall: "You have been here before",
    connection: "This just connected",
    "loose-end": "Still open",
    ledger: "Work state",
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/petjoin.test.ts`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0, no errors (baseline is clean; the `KIND_LABEL` entry is what keeps it clean).

- [ ] **Step 5: (no commit — batched at the end per the git workflow)**

---

### Task 3: Full verification and commit

**Files:** none new.

- [ ] **Step 1: Backend suite**

Run: `CGO_CFLAGS="-I$(pwd)/pkg/jarvisembed/csrc" go test ./pkg/jarvisvolunteer/`
Expected: PASS.

- [ ] **Step 2: Frontend suite (full, not just petjoin)**

Run: `npx vitest run`
Expected: PASS.

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0.

- [ ] **Step 3: Self-review the diff**

`git diff --stat` should show exactly: `pkg/jarvisvolunteer/ledger.go` (new), `pkg/jarvisvolunteer/ledger_test.go` (new), `pkg/jarvisvolunteer/volunteer.go` (2 small edits), `frontend/app/view/jarvis/petjoin.ts` (1 line), `frontend/app/view/jarvis/petbubble.tsx` (1 line), `frontend/app/view/jarvis/petjoin.test.ts` (appended test). Nothing else. No debug statements, no commented-out code.

- [ ] **Step 4: Ask the user for commit approval, then commit everything (code + spec + this plan) in one commit**

```bash
git add pkg/jarvisvolunteer/ledger.go pkg/jarvisvolunteer/ledger_test.go pkg/jarvisvolunteer/volunteer.go frontend/app/view/jarvis/petjoin.ts frontend/app/view/jarvis/petbubble.tsx frontend/app/view/jarvis/petjoin.test.ts docs/superpowers/specs/2026-08-13-jarvis-ledger-volunteers-design.md docs/superpowers/plans/2026-08-13-jarvis-ledger-volunteers.md
git commit -m "feat(jarvis): the pet volunteers the work ledger on gatekeeper+ channels"
```

Do NOT run this without the user's explicit go-ahead.
