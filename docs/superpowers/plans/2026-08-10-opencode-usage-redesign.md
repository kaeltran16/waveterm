# OpenCode Usage Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add accurate OpenCode history to Usage, separate harness from upstream provider/model, distinguish reported from estimated cost, and remove the misleading global app-bar gauge.

**Architecture:** The Go scanner emits one wire bucket per `(harness, provider, model, local day)` and parses OpenCode's current assistant-message files directly. Pure TypeScript aggregation filters those buckets by harness and derives dynamic daily series, provider/model groups, reported cost, estimated cost, and pricing coverage. The existing Usage surface consumes those derived values while provider limits remain an independent live-data section.

**Tech Stack:** Go, wshrpc code generation, TypeScript, React 19, Jotai, Visx, Vitest, Go `testing`, CDP scenario harness.

## Global Constraints

- Do not hand-edit generated files; run `task generate` after changing `wshrpc.UsageBucket`.
- Keep source-reported cost and API-equivalent estimates separate; never add them together.
- Treat a reported cost of zero as present data, not as an absent report.
- Unknown-price tokens remain in pricing-coverage denominators and contribute nothing to estimated spend.
- Do not derive OpenCode quota, reset windows, or context percentages.
- Do not add a replacement app-bar fleet metric.
- Preserve last-good Usage data on refresh failure.
- Use theme tokens, not raw color values, in shipping frontend components.
- Do not commit during execution unless the user explicitly approves it. If approved, batch the completed feature, spec, and plan into one commit.

## File Map

- `pkg/usagestats/usagestats.go`: canonical Claude, Codex, and OpenCode historical usage extraction and bucketing.
- `pkg/usagestats/usagestats_test.go`: parser, filtering, deduplication, and bucketing behavior.
- `pkg/agentsessions/agentsessions.go`: current-format OpenCode session model/token/cost extraction.
- `pkg/agentsessions/agentsessions_test.go`: realistic OpenCode storage fixture and session assertions.
- `pkg/wshrpc/wshrpctypes.go`: authoritative `UsageBucket` wire type.
- `pkg/wshrpc/wshserver/wshserver_agents.go`: `usagestats.Bucket` to wire-bucket conversion.
- `frontend/types/gotypes.d.ts`: generated `UsageBucket` TypeScript type.
- `frontend/app/store/wshclientapi.ts`: generated RPC client.
- `pkg/wshrpc/wshclient/wshclient.go`: generated Go RPC client.
- `frontend/app/view/agents/usagepricing.ts`: model pricing and reasoning-token estimate.
- `frontend/app/view/agents/usagestats.ts`: pure harness filtering and Usage derivation.
- `frontend/app/view/agents/usagestore.ts`: raw bucket loading, dev fixture seam, refresh state.
- `frontend/app/view/agents/agents.tsx`: persistent harness filter and derived filtered stats atom.
- `frontend/app/view/agents/dailychart.tsx`: dynamic harness stacks, legend, and tooltip.
- `frontend/app/view/agents/usagesurface.tsx`: provider limits, filters, summary cards, token split, and model groups.
- `frontend/app/cockpit/app-bar.tsx`: remove the global Usage gauge while retaining native controls.
- `scripts/cdp/scenarios.mjs`: deterministic visual/behavior verification.

---

### Task 1: Add Three-Dimensional Backend Usage Records

**Files:**

- Modify: `pkg/usagestats/usagestats.go`
- Test: `pkg/usagestats/usagestats_test.go`

**Interfaces:**

- Produces: `Record{Harness, Provider, Model, Reasoning, ReportedCostUsd}`.
- Produces: `Bucket{Harness, Provider, Model, Reasoning, ReportedCostUsd}`.
- Produces: `extractOpencode(data []byte) (Record, bool)`.
- Produces: `scanRoots(claudeRoot, codexRoot, opencodeRoot string, windowDays int) []Bucket`.
- Consumed later by: `wshserver.usageBucketToWire`, frontend `UsageBucket`, and Task 2's verified storage shape.

- [ ] **Step 1: Add failing identity and bucketing tests**

Extend the existing Claude/Codex assertions and add a bucket-separation test:

```go
func TestExtractorsSetHarnessAndProvider(t *testing.T) {
	claude := extractClaude([]string{`{"type":"assistant","timestamp":"2026-08-10T10:00:00Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-1","usage":{"input_tokens":1}}}`})
	if len(claude) != 1 || claude[0].Harness != "claude" || claude[0].Provider != "anthropic" {
		t.Fatalf("claude identity = %#v", claude)
	}

	codex := extractCodex([]string{
		`{"type":"turn_context","payload":{"model":"gpt-5-codex"}}`,
		`{"type":"event_msg","timestamp":"2026-08-10T10:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}}`,
	})
	if len(codex) != 1 || codex[0].Harness != "codex" || codex[0].Provider != "openai" {
		t.Fatalf("codex identity = %#v", codex)
	}
}

func TestBucketSeparatesHarnessProviderModelAndDay(t *testing.T) {
	ts := time.Date(2026, 8, 10, 12, 0, 0, 0, time.Local)
	records := []Record{
		{TS: ts, Harness: "claude", Provider: "anthropic", Model: "opus", Input: 1},
		{TS: ts, Harness: "opencode", Provider: "anthropic", Model: "opus", Input: 2},
		{TS: ts, Harness: "opencode", Provider: "openai", Model: "gpt-5.6-sol", Input: 3},
	}
	got := bucket(records)
	if len(got) != 3 {
		t.Fatalf("got %d buckets: %#v", len(got), got)
	}
}
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run:

```powershell
go test ./pkg/usagestats -run "TestExtractorsSetHarnessAndProvider|TestBucketSeparatesHarnessProviderModelAndDay" -count=1
```

Expected: compile failures for missing `Harness` and/or behavioral failures because `Provider` still means harness.

- [ ] **Step 3: Change the record and bucket identities**

Use these exact fields:

```go
type Record struct {
	ID              string
	TS              time.Time
	Harness         string
	Provider        string
	Model           string
	Input           int
	Output          int
	Reasoning       int
	CacheRead       int
	CacheCreate     int
	CacheCreate1h   int
	ReportedCostUsd *float64
}

type Bucket struct {
	Harness         string
	Provider        string
	Model           string
	Day             string
	Input           int
	Output          int
	Reasoning       int
	CacheRead       int
	CacheCreate     int
	CacheCreate1h   int
	ReportedCostUsd *float64
	Msgs            int
}
```

Set Claude to `Harness: "claude", Provider: "anthropic"` and Codex to `Harness: "codex", Provider: "openai"`. Change the bucket key to:

```go
type key struct{ harness, provider, model, day string }
```

When folding reported cost, preserve presence:

```go
if r.ReportedCostUsd != nil {
	if b.ReportedCostUsd == nil {
		b.ReportedCostUsd = new(float64)
	}
	*b.ReportedCostUsd += *r.ReportedCostUsd
}
```

Include `Reasoning` in `sumRecords` and `sumRecordsSinceCutoffs` so all token-total helpers use the same accounting.

- [ ] **Step 4: Re-run the focused identity tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Add failing OpenCode parser tests using the current format**

```go
func TestExtractOpencodeCurrentAssistantMessage(t *testing.T) {
	data := []byte(`{
		"id":"msg_1","role":"assistant",
		"time":{"created":1786356000000},
		"providerID":"openai","modelID":"gpt-5.6-sol","cost":0,
		"tokens":{"input":11,"output":12,"reasoning":13,"cache":{"read":14,"write":15}}
	}`)
	r, ok := extractOpencode(data)
	if !ok {
		t.Fatal("record was not extracted")
	}
	if r.Harness != "opencode" || r.Provider != "openai" || r.Model != "gpt-5.6-sol" {
		t.Fatalf("identity = %#v", r)
	}
	if r.Input != 11 || r.Output != 12 || r.Reasoning != 13 || r.CacheRead != 14 || r.CacheCreate != 15 {
		t.Fatalf("tokens = %#v", r)
	}
	if r.ReportedCostUsd == nil || *r.ReportedCostUsd != 0 {
		t.Fatalf("reported cost = %#v", r.ReportedCostUsd)
	}
}

func TestExtractOpencodeRejectsIncompleteMessages(t *testing.T) {
	cases := [][]byte{
		[]byte(`not json`),
		[]byte(`{"role":"user","time":{"created":1786356000000},"providerID":"openai","modelID":"gpt"}`),
		[]byte(`{"role":"assistant","time":{"created":1786356000000},"modelID":"gpt","tokens":{}}`),
		[]byte(`{"role":"assistant","time":{"created":1786356000000},"providerID":"openai","modelID":"gpt"}`),
	}
	for _, data := range cases {
		if _, ok := extractOpencode(data); ok {
			t.Fatalf("accepted %s", data)
		}
	}
}
```

- [ ] **Step 6: Run the OpenCode parser tests and confirm they fail**

Run:

```powershell
go test ./pkg/usagestats -run "TestExtractOpencode" -count=1
```

Expected: FAIL because `extractOpencode` does not exist.

- [ ] **Step 7: Implement current-format OpenCode extraction**

Implement `extractOpencode(data []byte) (Record, bool)` with a `*float64` JSON field so absent cost differs from zero:

```go
func extractOpencode(data []byte) (Record, bool) {
	var msg struct {
		Role       string   `json:"role"`
		ProviderID string   `json:"providerID"`
		ModelID    string   `json:"modelID"`
		Cost       *float64 `json:"cost"`
		Time       struct {
			Created int64 `json:"created"`
		} `json:"time"`
		Tokens *struct {
			Input     int `json:"input"`
			Output    int `json:"output"`
			Reasoning int `json:"reasoning"`
			Cache     struct {
				Read  int `json:"read"`
				Write int `json:"write"`
			} `json:"cache"`
		} `json:"tokens"`
	}
	if json.Unmarshal(data, &msg) != nil || msg.Role != "assistant" || msg.Time.Created <= 0 ||
		msg.ProviderID == "" || msg.ModelID == "" || msg.Tokens == nil {
		return Record{}, false
	}
	return Record{
		TS: time.UnixMilli(msg.Time.Created), Harness: "opencode", Provider: msg.ProviderID, Model: msg.ModelID,
		Input: msg.Tokens.Input, Output: msg.Tokens.Output, Reasoning: msg.Tokens.Reasoning,
		CacheRead: msg.Tokens.Cache.Read, CacheCreate: msg.Tokens.Cache.Write, ReportedCostUsd: msg.Cost,
	}, true
}
```

- [ ] **Step 8: Replace the two-format scan flag with a parser kind**

Replace `scanFile.codex bool` with:

```go
type scanKind uint8

const (
	scanClaude scanKind = iota
	scanCodex
	scanOpencode
)

type scanFile struct {
	path   string
	kind   scanKind
	cutoff time.Time
}
```

Claude and Codex walkers continue using modification-time pruning with their existing one-day margin. Add `walkOpencodeFiles(root string, cutoff time.Time)` that walks every `.json` under the message root without calling `inWindow`; it stores the authoritative timestamp cutoff on each `scanFile`.

In `parseFiles`, dispatch by `kind`. For OpenCode, read the whole file, call `extractOpencode`, and keep the record only when `cutoff.IsZero() || !record.TS.Before(cutoff)`.

Change the roots function and exported entry point:

```go
func scanRoots(claudeRoot, codexRoot, opencodeRoot string, windowDays int) []Bucket

func ScanUsage(windowDays int) ([]Bucket, error) {
	home := wavebase.GetHomeDir()
	return scanRoots(
		filepath.Join(home, ".claude", "projects"),
		filepath.Join(home, ".codex", "sessions"),
		filepath.Join(home, ".local", "share", "opencode", "storage", "message"),
		windowDays,
	), nil
}
```

Use an exact window cutoff for OpenCode and retain the one-day-earlier prune cutoff only for Claude/Codex. Update every existing `scanRoots` test call to pass an empty temporary OpenCode message root as its third path argument.

- [ ] **Step 9: Add scanner-window and reported-cost aggregation tests**

Create temporary OpenCode message files on both sides of the timestamp cutoff. Assert that old messages are excluded even when their file modification time is recent. Add two records in one bucket with reported costs `0` and `0.5`; assert the bucket pointer is present and sums to `0.5`.

- [ ] **Step 10: Run the complete scanner package tests**

Run:

```powershell
go test ./pkg/usagestats -count=1
```

Expected: PASS, including all existing Claude/Codex, transcript, subagent, and window-token tests.

---

### Task 2: Correct the Existing OpenCode Session Scanner

**Files:**

- Modify: `pkg/agentsessions/agentsessions.go`
- Test: `pkg/agentsessions/agentsessions_test.go`

**Interfaces:**

- Consumes: the verified current OpenCode assistant-message shape from Task 1.
- Preserves: `extractOpencodeSession(path, sessionID string, lines []string) *SessionInfo`.
- Produces: correct `SessionInfo.Model`, `TokensTotal`, and `CostUsd` without changing the RPC shape.

- [ ] **Step 1: Update the fixture first and confirm the current parser fails**

In `buildOpencodeTree`, replace the nested model message with current top-level fields and put usage on the assistant message:

```json
{
  "id": "msg_2",
  "sessionID": "ses_abc",
  "role": "assistant",
  "providerID": "openai",
  "modelID": "gpt-5.2-codex",
  "time": { "created": 1770000090000 },
  "cost": 0.5,
  "tokens": { "input": 10, "output": 20, "reasoning": 30, "cache": { "read": 40, "write": 50 } }
}
```

Keep text/tool parts for task and lifecycle-event assertions, but remove token/cost fields from the `step-finish` part.

- [ ] **Step 2: Run the OpenCode session tests and confirm they fail**

Run:

```powershell
go test ./pkg/agentsessions -run "TestScanProvider_opencode|TestExtractSession_opencode" -count=1
```

Expected: FAIL because model is empty and usage/cost remain zero.

- [ ] **Step 3: Parse top-level assistant metadata**

Change `opencodeMsg` to include:

```go
type opencodeMsg struct {
	ID         string `json:"id"`
	Role       string `json:"role"`
	ProviderID string `json:"providerID"`
	ModelID    string `json:"modelID"`
	Cost       float64 `json:"cost"`
	Tokens     struct {
		Input     int `json:"input"`
		Output    int `json:"output"`
		Reasoning int `json:"reasoning"`
		Cache     struct {
			Read  int `json:"read"`
			Write int `json:"write"`
		} `json:"cache"`
	} `json:"tokens"`
	Time struct {
		Created int64 `json:"created"`
	} `json:"time"`
}
```

In the existing oldest-first message loop, keep first-user-task extraction from parts. For each assistant message, set the last model from `ProviderID + "/" + ModelID` and sum all five token classes plus `Cost`. Remove token/cost summation from the parts loop; parts remain the source for user text and lifecycle events.

- [ ] **Step 4: Re-run the focused and full package tests**

Run:

```powershell
go test ./pkg/agentsessions -run "TestScanProvider_opencode|TestExtractSession_opencode" -count=1
```

Expected: both commands PASS.

---

### Task 3: Extend and Generate the Usage Wire Contract

**Files:**

- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver_agents.go`
- Generated: `frontend/types/gotypes.d.ts`
- Generated: `frontend/app/store/wshclientapi.ts`
- Generated: `pkg/wshrpc/wshclient/wshclient.go`

**Interfaces:**

- Consumes: `usagestats.Bucket` from Task 1.
- Produces: global TypeScript `UsageBucket` with `harness`, `provider`, `reasoning`, and optional `reportedcostusd`.
- Produces: `usageBucketToWire(b usagestats.Bucket) wshrpc.UsageBucket` used by both usage RPCs.

- [ ] **Step 1: Change the source-of-truth wire type**

Replace `UsageBucket` with:

```go
type UsageBucket struct {
	Harness         string   `json:"harness"`
	Provider        string   `json:"provider"`
	Model           string   `json:"model"`
	Day             string   `json:"day"`
	Input           int      `json:"input"`
	Output          int      `json:"output"`
	Reasoning       int      `json:"reasoning"`
	CacheRead       int      `json:"cacheread"`
	CacheCreate     int      `json:"cachecreate"`
	CacheCreate1h   int      `json:"cachecreate1h"`
	ReportedCostUsd *float64 `json:"reportedcostusd,omitempty"`
	Msgs            int      `json:"msgs"`
}
```

- [ ] **Step 2: Centralize bucket conversion**

Add this local helper in `wshserver_agents.go` and call it from both `GetUsageStatsCommand` and `GetTranscriptUsageCommand`:

```go
func usageBucketToWire(b usagestats.Bucket) wshrpc.UsageBucket {
	return wshrpc.UsageBucket{
		Harness: b.Harness, Provider: b.Provider, Model: b.Model, Day: b.Day,
		Input: b.Input, Output: b.Output, Reasoning: b.Reasoning,
		CacheRead: b.CacheRead, CacheCreate: b.CacheCreate, CacheCreate1h: b.CacheCreate1h,
		ReportedCostUsd: b.ReportedCostUsd, Msgs: b.Msgs,
	}
}
```

- [ ] **Step 3: Run generation**

Run:

```powershell
task generate
```

Expected: exit 0. `frontend/types/gotypes.d.ts` contains:

```ts
type UsageBucket = {
  harness: string;
  provider: string;
  model: string;
  reasoning: number;
  reportedcostusd?: number;
};
```

The generated type will also retain the other existing fields.

- [ ] **Step 4: Inspect generation scope**

Run:

```powershell
git diff --stat
```

Expected: only changes caused by the wire type and normal generator output. Do not revert unrelated pre-existing worktree changes.

- [ ] **Step 5: Compile the affected Go packages**

Run:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/usagestats ./pkg/agentsessions ./pkg/wshrpc/wshserver -run "^$"
```

Expected: compile succeeds with no tests selected.

---

### Task 4: Derive Harness, Cost, and Coverage in Pure TypeScript

**Files:**

- Modify: `frontend/app/view/agents/usagepricing.ts`
- Test: `frontend/app/view/agents/usagepricing.test.ts`
- Modify: `frontend/app/view/agents/usagestats.ts`
- Test: `frontend/app/view/agents/usagestats.test.ts`
- Test: `frontend/app/view/agents/sessionusage.test.ts`

**Interfaces:**

- Produces: `HarnessFilter = "all" | string`.
- Produces: `DailyUsage{day, byHarness}`.
- Produces: `aggregateBuckets(buckets, now, harnessFilter?)`.
- Produces: `availableHarnesses`, reported-cost totals, pricing coverage, and upstream provider groups.
- Consumed by: Tasks 5 and 6.

- [ ] **Step 1: Add reasoning pricing tests**

Extend the `rec` helper with `reasoningTokens: 0` and add:

```ts
it("prices reasoning at the output rate", () => {
  const spend = spendBreakdown(rec({ model: "gpt-5.5", reasoningTokens: 1_000_000 }));
  expect(spend.reasoning).toBe(30);
});
```

- [ ] **Step 2: Run the pricing test and confirm it fails**

Run:

```powershell
npx vitest run frontend/app/view/agents/usagepricing.test.ts
```

Expected: FAIL because `SpendBreakdown.reasoning` and `UsageRecord.reasoningTokens` do not exist.

- [ ] **Step 3: Add reasoning to pricing**

Add `reasoning: number` to `SpendBreakdown`, return zero for it on unknown models, calculate it from `r.reasoningTokens * p.output`, and include it in `spendOf`.

- [ ] **Step 4: Add failing aggregation tests for every new semantic**

Update `bkt` defaults:

```ts
function bkt(over: Partial<UsageBucket>): UsageBucket {
  return {
    harness: "claude",
    provider: "anthropic",
    model: "claude-opus-4-8",
    day: "2026-06-26",
    input: 0,
    output: 0,
    reasoning: 0,
    cacheread: 0,
    cachecreate: 0,
    cachecreate1h: 0,
    msgs: 1,
    ...over,
  };
}
```

Add tests that assert:

```ts
const buckets = [
  bkt({ harness: "claude", provider: "anthropic", input: 100 }),
  bkt({ harness: "opencode", provider: "openai", model: "gpt-5.5", input: 200, reasoning: 50, reportedcostusd: 0 }),
  bkt({ harness: "opencode", provider: "opencode-go", model: "deepseek-v4-pro", input: 700, reportedcostusd: 1.25 }),
];

const all = aggregateBuckets(buckets, now, "all");
expect(all.availableHarnesses).toEqual(["claude", "opencode"]);
expect(all.totals.tokensWindow).toBe(1050);
expect(all.totals.reportedCostWindowUsd).toBe(1.25);
expect(all.totals.reportedCostWindowPresent).toBe(true);
expect(all.totals.reportedCostWindowHarnesses).toEqual(["opencode"]);
expect(all.totals.pricingCoverageWindowPct).toBeCloseTo((350 / 1050) * 100);
expect(all.providers.map((p) => p.provider)).toEqual(["anthropic", "openai", "opencode-go"]);

const openCode = aggregateBuckets(buckets, now, "opencode");
expect(openCode.totals.tokensWindow).toBe(950);
expect(openCode.split.find((s) => s.cls === "reasoning")?.tokens).toBe(50);
expect(openCode.daily[0].byHarness.opencode.tokens).toBe(950);
```

Also test that an empty scope has `pricingCoverageWindowPct: null`, and a reported zero yields `reportedCostWindowPresent: true` with `reportedCostWindowUsd: 0`.

- [ ] **Step 5: Run aggregation tests and confirm they fail**

Run:

```powershell
npx vitest run frontend/app/view/agents/usagestats.test.ts
```

Expected: FAIL on the new type shape and missing aggregation fields.

- [ ] **Step 6: Implement the pure data model**

Use these core types:

```ts
export type HarnessFilter = "all" | string;

export interface DailyHarnessUsage {
  tokens: number;
  spendUsd: number;
}

export interface DailyUsage {
  day: string;
  byHarness: Record<string, DailyHarnessUsage>;
}

export type TokenClass = "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite";
```

Add `harness`, upstream `provider`, and `reasoningTokens` to `UsageRecord`. Include reasoning in `bucketTokens`, class totals, estimated spend, daily totals, and coverage.

Use this fixed class order and existing theme-backed fills:

```ts
export const CLASS_ORDER: TokenClass[] = ["cacheRead", "reasoning", "output", "cacheWrite", "input"];

export const CLASS_LABEL: Record<TokenClass, string> = {
  cacheRead: "Cache read",
  reasoning: "Reasoning",
  output: "Output",
  cacheWrite: "Cache write",
  input: "Input",
};

export const CLASS_FILL: Record<TokenClass, string> = {
  cacheRead: "bg-cacheread",
  reasoning: "bg-accent-300",
  output: "bg-accent",
  cacheWrite: "bg-warning",
  input: "bg-success",
};
```

Keep existing today/week/window totals needed by the surface, and add:

```ts
availableHarnesses: string[];
reportedCostWeekUsd: number;
reportedCostWeekPresent: boolean;
reportedCostWeekHarnesses: string[];
reportedCostWindowUsd: number;
reportedCostWindowPresent: boolean;
reportedCostWindowHarnesses: string[];
pricedTokensWeek: number;
pricedTokensWindow: number;
pricingCoverageWeekPct: number | null;
pricingCoverageWindowPct: number | null;
tokensTodayByHarness: Record<string, number>;
tokensWindowByHarness: Record<string, number>;
```

Derive `availableHarnesses` from the unfiltered input, then filter once at the top of `aggregateBuckets`. Every total, split, daily row, and provider group must consume that same filtered list. Group provider cards by upstream `b.provider`; sort providers by descending token volume with provider name as the deterministic tie-breaker. Sort models by descending token volume.

For coverage, add a bucket's full token count to the denominator. Add it to the numerator only when `priceFor(b.model) != null`. Return `null` when the denominator is zero.

- [ ] **Step 7: Update all manually constructed Usage buckets and empty stats**

Update `frontend/app/view/agents/sessionusage.test.ts` and every `UsageStats` literal found by TypeScript/Vitest to include the new required fields. Do not alter per-session UI behavior beyond counting reasoning in totals.

- [ ] **Step 8: Run pure frontend tests**

Run:

```powershell
npx vitest run frontend/app/view/agents/usagepricing.test.ts frontend/app/view/agents/usagestats.test.ts frontend/app/view/agents/sessionusage.test.ts
```

Expected: PASS.

---

### Task 5: Store Raw Buckets and Persist the Harness Filter

**Files:**

- Modify: `frontend/app/view/agents/usagestore.ts`
- Test: `frontend/app/view/agents/usagestore.test.ts`
- Modify: `frontend/app/view/agents/agents.tsx`

**Interfaces:**

- Consumes: `aggregateBuckets` and `HarnessFilter` from Task 4.
- Produces: `usageBucketsAtom: PrimitiveAtom<UsageBucket[]>`.
- Produces: `allUsageStatsAtom: Atom<UsageStats>`.
- Produces: `AgentsViewModel.usageHarnessFilterAtom` and `.usageStatsAtom`.
- Produces: dev-only localStorage fixture key `wave:dev-usage-buckets` for Task 7.

- [ ] **Step 1: Rewrite store tests to expect raw bucket retention**

Keep the existing success, failure, and latest-request-wins tests. Change the success assertion from a pre-aggregated primitive atom to:

```ts
expect(globalStore.get(usageBucketsAtom)).toEqual(response.buckets);
expect(globalStore.get(allUsageStatsAtom).totals.tokensWindow).toBe(expectedTokens);
```

Add a test that malformed or absent dev fixture data falls through to the mocked RPC. Do not require `localStorage` in the Node test environment.

- [ ] **Step 2: Run store tests and confirm they fail**

Run:

```powershell
npx vitest run frontend/app/view/agents/usagestore.test.ts
```

Expected: FAIL because `usageBucketsAtom` and `allUsageStatsAtom` do not exist.

- [ ] **Step 3: Store raw buckets and expose all-history stats**

Replace the primitive aggregated atom with:

```ts
export const usageBucketsAtom = atom<UsageBucket[]>([]) as PrimitiveAtom<UsageBucket[]>;
export const allUsageStatsAtom = atom((get) => aggregateBuckets(get(usageBucketsAtom), Date.now(), "all"));
```

`loadUsage` writes `usageBucketsAtom` only after the latest-request check. Error and loaded atoms retain their current behavior.

Add this dev-only fixture boundary:

```ts
const DEV_USAGE_FIXTURE_KEY = "wave:dev-usage-buckets";

function devUsageBuckets(): UsageBucket[] | undefined {
  if (!import.meta.env.DEV || typeof localStorage === "undefined") return undefined;
  const raw = localStorage.getItem(DEV_USAGE_FIXTURE_KEY);
  if (raw == null) return undefined;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
```

Select fixture or RPC buckets explicitly:

```ts
const fixture = devUsageBuckets();
const buckets = fixture ?? (await RpcApi.GetUsageStatsCommand(TabRpcClient, { windowdays: windowDays })).buckets ?? [];
```

This seam is compiled out behaviorally in production because `import.meta.env.DEV` is false.

- [ ] **Step 4: Add persistent filter and derived stats to `AgentsViewModel`**

Add imports for `usageBucketsAtom`, `aggregateBuckets`, and `HarnessFilter`, then add class fields beside Sessions/other surface filters:

```ts
usageHarnessFilterAtom = atom<HarnessFilter>("all");
usageStatsAtom = atom((get) => aggregateBuckets(get(usageBucketsAtom), Date.now(), get(this.usageHarnessFilterAtom)));
```

The atom's lifetime is the long-lived view model, so switching surfaces does not reset it.

- [ ] **Step 5: Run store tests and stack-safe typecheck**

Run:

```powershell
npx vitest run frontend/app/view/agents/usagestore.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: both commands PASS.

---

### Task 6: Generalize the Chart and Redesign the Usage Surface

**Files:**

- Modify: `frontend/app/view/agents/dailychart.tsx`
- Test: `frontend/app/view/agents/dailychart.test.ts`
- Modify: `frontend/app/view/agents/usagesurface.tsx`

**Interfaces:**

- Consumes: dynamic `DailyUsage`, `availableHarnesses`, and filtered `UsageStats` from Tasks 4 and 5.
- Produces: dynamic harness legend, stacks, and tooltip.
- Produces: provider-neutral limits copy, harness filters, deterministic four-card summaries, reasoning split, and upstream provider cards.

- [ ] **Step 1: Write failing dynamic-row chart tests**

Replace the fixed Claude/Codex fixture with:

```ts
const daily: DailyUsage[] = [
  {
    day: "2026-08-10",
    byHarness: {
      claude: { tokens: 10, spendUsd: 1 },
      codex: { tokens: 20, spendUsd: 2 },
      opencode: { tokens: 30, spendUsd: 3 },
    },
  },
];

expect(toRows(daily, "tokens", ["claude", "codex", "opencode"])).toEqual([
  {
    day: "08-10",
    values: { claude: 10, codex: 20, opencode: 30 },
    total: 60,
  },
]);
```

Also assert spend values and absent harnesses default to zero.

- [ ] **Step 2: Run chart tests and confirm they fail**

Run:

```powershell
npx vitest run frontend/app/view/agents/dailychart.test.ts
```

Expected: FAIL because `toRows` has no harness argument and returns fixed fields.

- [ ] **Step 3: Implement dynamic chart rows and series**

Use:

```ts
interface Row {
  day: string;
  values: Record<string, number>;
  total: number;
}

export function toRows(daily: DailyUsage[], metric: "tokens" | "spend", harnesses: string[]): Row[] {
  return daily.map((d) => {
    const values = Object.fromEntries(
      harnesses.map((h) => [h, d.byHarness[h]?.[metric === "tokens" ? "tokens" : "spendUsd"] ?? 0])
    );
    return { day: d.day.slice(5), values, total: Object.values(values).reduce((sum, value) => sum + value, 0) };
  });
}
```

Add a `harnesses: string[]` prop to `DailyChart`. Define stable known-harness metadata using existing theme tokens: Claude accent, Codex success, OpenCode `--color-rt-opencode`. Render legend, tooltip rows, and stacked paths from the ordered harness list. Compute each segment's cumulative y-offset; apply rounded top corners only to the highest non-zero segment. Preserve current brush, reduced-motion behavior, stagger cap, axes, and no-native-title behavior.

- [ ] **Step 4: Re-run chart tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Wire harness filters and reset unavailable selections**

In `UsageSurface`, read:

```ts
const allStats = useAtomValue(allUsageStatsAtom);
const stats = useAtomValue(model.usageStatsAtom);
const [harnessFilter, setHarnessFilter] = useAtom(model.usageHarnessFilterAtom);
```

When a window reload removes the selected harness from `allStats.availableHarnesses`, set the filter back to `"all"`. Render All plus only harnesses present in the loaded window. Filter changes must not affect limit cards.

- [ ] **Step 6: Implement the approved summary-card behavior**

For seven days render exactly:

1. Tokens today, with `tokensTodayByHarness` in secondary text.
2. Tokens over 7 days.
3. Reported cost over 7 days, showing contributing harnesses or `No source reports cost`.
4. API-equivalent estimate over 7 days, showing pricing coverage.

For All time render exactly:

1. Tokens all time, with `tokensWindowByHarness` in secondary text.
2. Daily average over active days.
3. Reported cost all time, showing contributing harnesses or `No source reports cost`.
4. API-equivalent estimate all time, showing pricing coverage.

Do not render the existing busiest-day card. Format reported zero as `$0.00`, not as absent.

- [ ] **Step 7: Update the remaining surface sections**

- Rename `Live limits` to `Provider limits`.
- Replace Claude-specific empty copy with `No provider limit data is currently available.`
- Render only returned limit readings; do not add an OpenCode placeholder card.
- Add Reasoning to `SplitCard` and use a five-column responsive legend.
- Keep split spend labeled `API-equivalent`.
- Pass `harnessFilter === "all" ? allStats.availableHarnesses : [harnessFilter]` into `DailyChart`.
- Group `ModelGroup` cards by upstream provider and show labels as `${provider}/${model}`.
- Keep model ranking based on token volume regardless of the chart metric.
- Update header copy to explain reported versus estimated cost without claiming either is a bill.

- [ ] **Step 8: Run focused frontend tests and typecheck**

Run:

```powershell
npx vitest run frontend/app/view/agents/usagepricing.test.ts frontend/app/view/agents/usagestats.test.ts frontend/app/view/agents/usagestore.test.ts frontend/app/view/agents/dailychart.test.ts frontend/app/view/agents/sessionusage.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: all tests PASS and typecheck exits 0.

---

### Task 7: Remove Global Gauge and Add Deterministic CDP Coverage

**Files:**

- Modify: `frontend/app/cockpit/app-bar.tsx`
- Modify: `scripts/cdp/scenarios.mjs`
- Modify if stale comment remains: `frontend/app/view/agents/agentsviewmodel.ts`

**Interfaces:**

- Consumes: dev fixture key `wave:dev-usage-buckets` from Task 5.
- Produces: app bar with native window controls but no usage signal.
- Produces: deterministic `usage-charts` scenario covering the approved behavior.

- [ ] **Step 1: Remove only usage-specific app-bar code**

Delete `ArcMeter`, rate-limit store, runtime metadata, usage helper, and `cn` imports that become unused. Delete `DONUT_COLOR`, agent/saved/now subscriptions, the `gauges` derivation, and the usage button.

Keep the right-side wrapper and native controls:

```tsx
<div className="ml-auto flex h-full shrink-0 items-center border-l border-border">
  <button
    onClick={() => win.minimize()}
    aria-label="Minimize"
    className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-hover"
  >
    &#x2013;
  </button>
  <button
    onClick={() => win.toggleMaximize()}
    aria-label="Maximize"
    className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-hover"
  >
    &#x25A1;
  </button>
  <button
    onClick={() => win.close()}
    aria-label="Close"
    className="flex h-8 w-11 cursor-pointer items-center justify-center text-secondary hover:bg-error hover:text-white"
  >
    &#x2715;
  </button>
</div>
```

Remove the fixed `w-[300px]` usage column; `ml-auto` keeps controls flush right at desktop and narrow widths. Update only stale comments that explicitly claim a helper drives the app-bar gauge; do not remove otherwise useful helpers.

- [ ] **Step 2: Seed deterministic Usage data in `usageCharts.arrange`**

Capture the existing `wave:dev-usage-buckets` and `wave:ratelimits` strings in the returned scenario context before changing either key. Set the usage fixture to a JSON array containing:

- Claude/Anthropic/Opus with known pricing.
- Codex/OpenAI/Codex with known pricing.
- OpenCode/OpenAI/GPT-5.5 with reasoning and reported zero.
- OpenCode/OpenCode-Go/DeepSeek with unknown pricing and non-zero reported cost.
- At least 16 days across all entries so All-time renders the brush.

Use the exact generated wire keys: `harness`, `provider`, `model`, `day`, `input`, `output`, `reasoning`, `cacheread`, `cachecreate`, `cachecreate1h`, optional `reportedcostusd`, and `msgs`.

Generate day strings relative to the scenario's current local date so the default seven-day view always has recent records:

```js
const dayAgo = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
};
```

Also set `wave:ratelimits` to a current Claude snapshot with future reset epochs. Reload the page after setting both keys so `savedRateLimitsAtom` initializes from the deterministic snapshot, then navigate to Usage so its mount load consumes the deterministic historical fixture.

- [ ] **Step 3: Replace nondeterministic assertions with approved behavior checks**

Keep existing axes, theme-token, tooltip, no-title, and brush checks. Add assertions that:

- Filter chips include Claude Code, Codex, and OpenCode.
- Selecting OpenCode leaves only OpenCode historical totals/model cards.
- `openai/gpt-5.5` and `opencode-go/deepseek-v4-pro` are visible.
- Reasoning appears in the token-class section.
- Reported cost and API-equivalent estimate are separate labels.
- Pricing coverage is below 100% because DeepSeek is intentionally unpriced.
- Provider limits are unchanged by selecting OpenCode.
- Navigate to another surface and back; OpenCode remains selected.
- No app-bar element links to the Usage surface and no app-bar `--usage-arc` exists.
- Native Minimize, Maximize, and Close controls remain present.

Scope the existing ArcMeter assertion to the Usage surface's Provider limits so removing app-bar rings does not invalidate the intended primitive check.

- [ ] **Step 4: Make teardown restore developer state**

In `teardown`, restore each captured localStorage string exactly; remove a key only when its captured value was `null`. Reload so the original `savedRateLimitsAtom` value returns, then select the 7-day window and return to Cockpit. This must restore a developer's pre-existing quota snapshot rather than deleting it.

- [ ] **Step 5: Run focused unit and UI verification**

Run:

```powershell
npx vitest run frontend/app/view/agents/usagepricing.test.ts frontend/app/view/agents/usagestats.test.ts frontend/app/view/agents/usagestore.test.ts frontend/app/view/agents/dailychart.test.ts frontend/app/view/agents/sessionusage.test.ts
task verify:ui -- usage-charts
```

Expected: Vitest reports all selected tests passing; CDP prints `PASS` for every `usage-charts` step and exits 0.

- [ ] **Step 6: Run full affected verification**

Run from PowerShell:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/usagestats/... ./pkg/agentsessions/...
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
git diff --check
```

Expected: both Go package suites PASS, typecheck exits 0, and `git diff --check` prints no errors.

- [ ] **Step 7: Self-review the complete diff**

Run:

```powershell
git status --short
```

Confirm:

- no generated file was hand-edited;
- no debug output or commented-out implementation remains;
- unrelated pre-existing worktree changes were not modified;
- reported and estimated costs are never summed;
- unknown-price tokens visibly lower coverage;
- harness filters do not alter provider limits; and
- global chrome contains no replacement metric.

- [ ] **Step 8: Ask before committing**

Do not commit automatically. Present the verified diff and ask the user for explicit approval. If approval is granted, inspect `git status`, `git diff`, and `git log --oneline -10`, stage only the intended files, and create one feature commit including the approved spec and plan.
