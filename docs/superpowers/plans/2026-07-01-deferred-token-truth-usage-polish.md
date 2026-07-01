# Deferred cleanup: token truth + usage polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cockpit's fabricated/proxy token and pricing data with real values — real cumulative per-agent tokens (rail), real trailing-window used tokens (usage bars), prettified model ids, and current-generation pricing — closing the in-repo subset of `docs/deferred.md`.

**Architecture:** Two thin new wshrpc commands reuse the existing `pkg/usagestats` transcript parser (`extractClaude`/`extractCodex`/`dedupe`): `GetTranscriptTokensCommand` (whole-file cumulative for one agent) and `GetWindowTokensCommand` (Claude-only trailing-window sum with FE-supplied, reset-anchored cutoffs). Frontend stores load these and feed the rail Tokens row and the usage bars; two pure FE helpers handle model-id prettifying and refreshed pricing.

**Tech Stack:** Go (`pkg/usagestats`, `pkg/wshrpc`), `task generate` codegen, React 19 + jotai frontend, vitest, Go `testing`.

**Spec:** `docs/superpowers/specs/2026-07-01-deferred-token-truth-usage-polish-design.md`

---

## File Structure

**Backend (Go):**
- `pkg/usagestats/usagestats.go` — add `SumTranscript(path)` and `WindowTokens(cutoffs)` (reuse existing parser/dedupe; no new parsing).
- `pkg/usagestats/usagestats_test.go` — tests for both new functions.
- `pkg/wshrpc/wshrpctypes.go` — add 2 interface methods + 4 data structs (hand-edited; source of truth for codegen).
- `pkg/wshrpc/wshserver/wshserver.go` — implement the 2 commands + a small epoch→time helper.
- Generated (DO NOT hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` — produced by `task generate`.

**Frontend:**
- `frontend/app/view/agents/tokenstore.ts` — NEW: focused-agent cumulative token atom + loader (A1).
- `frontend/app/view/agents/windowtokenstore.ts` — NEW: trailing-window used-tokens atom + loader (A2).
- `frontend/app/view/agents/modellabel.ts` — NEW: `prettyModel(id)` pure helper (B1).
- `frontend/app/view/agents/modellabel.test.ts` — NEW: vitest for `prettyModel`.
- `frontend/app/view/agents/agentdetailsrail.tsx` — wire real Tokens (A1) + prettified Model (B1).
- `frontend/app/view/agents/cockpitsurface.tsx` — real window-used in `UsageBar`, delete `FAKE_TOKEN_LIMIT` (A2).
- `frontend/app/view/agents/usagesurface.tsx` — prettified per-model label (B1).
- `frontend/app/view/agents/usagepricing.ts` — refresh pricing + add `fable` family (B2).
- `frontend/app/view/agents/usagepricing.test.ts` — NEW: `priceFor` test for the new family + corrected numbers.

**Docs:**
- `docs/deferred.md` — rewrite the resolved / now-permanent entries.

---

## Task 1: `usagestats.SumTranscript` — whole-file cumulative token sum

**Files:**
- Modify: `pkg/usagestats/usagestats.go`
- Test: `pkg/usagestats/usagestats_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/usagestats/usagestats_test.go`:

```go
func TestSumTranscript(t *testing.T) {
	dir := t.TempDir()

	// Claude file: two assistant lines, second is a streaming re-emit of the first
	// (same message.id + requestId) so dedupe must keep only the larger-output copy.
	claude := filepath.Join(dir, "claude.jsonl")
	lines := "" +
		`{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-06-26T10:00:01.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}` + "\n"
	if err := os.WriteFile(claude, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	// deduped to the output:50 copy → 100+50+1000+200 = 1350
	got, err := SumTranscript(claude)
	if err != nil || got != 1350 {
		t.Fatalf("claude sum = %d, err = %v; want 1350", got, err)
	}

	// Codex file: one token_count with a cumulative total; Input = input - cached.
	codex := filepath.Join(dir, "rollout-x.jsonl")
	codexLines := "" +
		`{"timestamp":"2026-06-26T03:07:50.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}` + "\n" +
		`{"timestamp":"2026-06-26T03:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9458,"cached_input_tokens":7040,"output_tokens":89,"total_tokens":9547}}}}` + "\n"
	if err := os.WriteFile(codex, []byte(codexLines), 0o644); err != nil {
		t.Fatal(err)
	}
	// Input = 9458-7040 = 2418; Output = 89; CacheRead = 7040; CacheCreate = 0 → 9547
	gotCodex, err := SumTranscript(codex)
	if err != nil || gotCodex != 9547 {
		t.Fatalf("codex sum = %d, err = %v; want 9547", gotCodex, err)
	}

	// Missing/unreadable file → 0, no error.
	gotMissing, err := SumTranscript(filepath.Join(dir, "does-not-exist.jsonl"))
	if err != nil || gotMissing != 0 {
		t.Fatalf("missing sum = %d, err = %v; want 0", gotMissing, err)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/usagestats/ -run TestSumTranscript`
Expected: FAIL — `undefined: SumTranscript`.

- [ ] **Step 3: Implement `SumTranscript`**

Add to `pkg/usagestats/usagestats.go` (after `ScanUsage`, before end of file):

```go
// sumRecords totals the four token classes across deduped records.
func sumRecords(records []Record) int {
	total := 0
	for _, r := range dedupe(records) {
		total += r.Input + r.Output + r.CacheRead + r.CacheCreate
	}
	return total
}

// SumTranscript reads one transcript file and returns its deduped cumulative token
// total (Input+Output+CacheRead+CacheCreate), matching the Usage surface's accounting.
// Runs the Claude parser first and falls back to the Codex parser only when the Claude
// parse yields no records (a rollout produces no Claude records and vice versa, so this
// is unambiguous). Empty/unreadable/unknown-shape files return 0.
func SumTranscript(path string) (int, error) {
	lines := readLines(path)
	if len(lines) == 0 {
		return 0, nil
	}
	recs := extractClaude(lines)
	if len(recs) == 0 {
		recs = extractCodex(lines)
	}
	return sumRecords(recs), nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/usagestats/ -run TestSumTranscript`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/usagestats/usagestats.go pkg/usagestats/usagestats_test.go
git commit -m "feat(usagestats): SumTranscript whole-file cumulative token total"
```

---

## Task 2: `usagestats.WindowTokens` — Claude-only trailing-window sum

**Files:**
- Modify: `pkg/usagestats/usagestats.go`
- Test: `pkg/usagestats/usagestats_test.go`

- [ ] **Step 1: Write the failing test**

Append to `pkg/usagestats/usagestats_test.go`:

```go
func TestWindowTokens(t *testing.T) {
	// Two records straddling a cutoff. WindowTokens sums records with TS >= cutoff.
	older := Record{TS: time.Date(2026, 6, 26, 8, 0, 0, 0, time.UTC), Provider: "claude", Model: "claude-opus-4-8", Input: 100, Output: 10}
	newer := Record{TS: time.Date(2026, 6, 26, 12, 0, 0, 0, time.UTC), Provider: "claude", Model: "claude-opus-4-8", Input: 200, Output: 20, CacheRead: 5}
	recs := []Record{older, newer}

	cutoffs := []time.Time{
		time.Date(2026, 6, 26, 10, 0, 0, 0, time.UTC), // excludes older, includes newer
		time.Time{},                                   // all-time: includes both
	}
	got := sumRecordsSinceCutoffs(recs, cutoffs)
	// cutoff[0]: only newer → 200+20+5 = 225 ; cutoff[1]: both → 110 + 225 = 335
	if got[0] != 225 || got[1] != 335 {
		t.Fatalf("window sums = %v; want [225 335]", got)
	}
}
```

Note: this tests the pure inner helper `sumRecordsSinceCutoffs`; `WindowTokens` itself walks the real Claude root (no fixture harness for `wavebase.GetHomeDir()`), so the file-walk path is exercised by Task 3's live/CDP verification, not a unit test. Keeping the summation logic in a pure, tested helper is the point.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/usagestats/ -run TestWindowTokens`
Expected: FAIL — `undefined: sumRecordsSinceCutoffs`.

- [ ] **Step 3: Implement `WindowTokens` + the pure helper**

Add to `pkg/usagestats/usagestats.go`:

```go
// sumRecordsSinceCutoffs returns, per cutoff (positionally), the summed token total of
// records at/after that cutoff. A zero cutoff means all-time (every record counts).
func sumRecordsSinceCutoffs(records []Record, cutoffs []time.Time) []int {
	out := make([]int, len(cutoffs))
	for _, r := range records {
		tokens := r.Input + r.Output + r.CacheRead + r.CacheCreate
		for i, c := range cutoffs {
			if c.IsZero() || !r.TS.Before(c) {
				out[i] += tokens
			}
		}
	}
	return out
}

// WindowTokens sums Claude-only deduped token totals for records at/after each cutoff,
// across the Claude transcript root. Codex is excluded — rate-limit windows are
// Claude.ai-specific. Returns one total per cutoff, positionally.
func WindowTokens(cutoffs []time.Time) ([]int, error) {
	home := wavebase.GetHomeDir()
	claudeRoot := filepath.Join(home, ".claude", "projects")

	var earliest time.Time
	for _, c := range cutoffs {
		if !c.IsZero() && (earliest.IsZero() || c.Before(earliest)) {
			earliest = c
		}
	}
	// prune files by modtime against the earliest cutoff (with the existing 1-day margin)
	var prune time.Time
	if !earliest.IsZero() {
		prune = earliest.AddDate(0, 0, -1)
	}

	var records []Record
	_ = filepath.WalkDir(claudeRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".jsonl") {
			return nil
		}
		if !inWindow(path, prune) {
			return nil
		}
		records = append(records, extractClaude(readLines(path))...)
		return nil
	})
	return sumRecordsSinceCutoffs(dedupe(records), cutoffs), nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/usagestats/`
Expected: PASS (all usagestats tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/usagestats/usagestats.go pkg/usagestats/usagestats_test.go
git commit -m "feat(usagestats): WindowTokens Claude-only trailing-window sum"
```

---

## Task 3: wshrpc commands + codegen

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Regenerated: `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

- [ ] **Step 1: Add the interface methods**

In `pkg/wshrpc/wshrpctypes.go`, in the command interface (near line 100, after `GetRecentSessionsCommand`), add:

```go
	GetTranscriptTokensCommand(ctx context.Context, data CommandGetTranscriptTokensData) (*CommandGetTranscriptTokensRtnData, error)
	GetWindowTokensCommand(ctx context.Context, data CommandGetWindowTokensData) (*CommandGetWindowTokensRtnData, error)
```

- [ ] **Step 2: Add the data structs**

In `pkg/wshrpc/wshrpctypes.go`, near the other `CommandGet…Data` structs (after `CommandGetRecentSessionsRtnData`, ~line 764), add:

```go
type CommandGetTranscriptTokensData struct {
	Path string `json:"path"`
}

type CommandGetTranscriptTokensRtnData struct {
	Tokens int `json:"tokens"`
}

type CommandGetWindowTokensData struct {
	FiveHourCutoff int64 `json:"fivehourcutoff,omitempty"` // epoch seconds; 0 = all-time
	WeekCutoff     int64 `json:"weekcutoff,omitempty"`     // epoch seconds; 0 = all-time
}

type CommandGetWindowTokensRtnData struct {
	FiveHourTokens int `json:"fivehourtokens"`
	WeekTokens     int `json:"weektokens"`
}
```

- [ ] **Step 3: Implement the commands in wshserver**

In `pkg/wshrpc/wshserver/wshserver.go`, after `GetRecentSessionsCommand` (~line 1515), add:

```go
func cutoffFromEpoch(sec int64) time.Time {
	if sec <= 0 {
		return time.Time{}
	}
	return time.Unix(sec, 0)
}

func (ws *WshServer) GetTranscriptTokensCommand(ctx context.Context, data wshrpc.CommandGetTranscriptTokensData) (*wshrpc.CommandGetTranscriptTokensRtnData, error) {
	total, err := usagestats.SumTranscript(data.Path)
	if err != nil {
		return nil, fmt.Errorf("summing transcript tokens: %w", err)
	}
	return &wshrpc.CommandGetTranscriptTokensRtnData{Tokens: total}, nil
}

func (ws *WshServer) GetWindowTokensCommand(ctx context.Context, data wshrpc.CommandGetWindowTokensData) (*wshrpc.CommandGetWindowTokensRtnData, error) {
	cutoffs := []time.Time{cutoffFromEpoch(data.FiveHourCutoff), cutoffFromEpoch(data.WeekCutoff)}
	sums, err := usagestats.WindowTokens(cutoffs)
	if err != nil {
		return nil, fmt.Errorf("summing window tokens: %w", err)
	}
	return &wshrpc.CommandGetWindowTokensRtnData{FiveHourTokens: sums[0], WeekTokens: sums[1]}, nil
}
```

- [ ] **Step 4: Confirm `time` is imported in wshserver.go**

Run: `head -40 pkg/wshrpc/wshserver/wshserver.go`
If `"time"` is not in the import block, add it. (`usagestats` and `fmt` are already imported — they're used by the neighboring commands.)

- [ ] **Step 5: Regenerate bindings**

Run: `task generate`
Expected: updates `pkg/wshrpc/wshclient/wshclient.go` (adds `GetTranscriptTokensCommand` → `"gettranscripttokens"` and `GetWindowTokensCommand` → `"getwindowtokens"`), `frontend/app/store/wshclientapi.ts` (adds both `RpcApi` methods), and `frontend/types/gotypes.d.ts` (adds the 4 types). **Do not hand-edit these.**

- [ ] **Step 6: Verify it builds**

Run: `go build ./... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: Go builds clean; tsc shows only the ~3 pre-existing `frontend/tauri/api.test.ts` baseline errors, nothing new.

- [ ] **Step 7: Commit**

```bash
git add pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
git commit -m "feat(wshrpc): GetTranscriptTokens + GetWindowTokens commands"
```

---

## Task 4: Rail Tokens row → real cumulative (A1)

**Files:**
- Create: `frontend/app/view/agents/tokenstore.ts`
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx`

- [ ] **Step 1: Create the token store**

Create `frontend/app/view/agents/tokenstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Focused-agent cumulative token total: a thin whole-file scan of the agent's transcript
// via GetTranscriptTokensCommand (reuses the Usage surface's deduped accounting). Mirrors
// railstore.ts's stale-load guard so a slow load for a previous focus can't overwrite a newer one.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

export const agentTokensAtom = atom<number | null>(null) as PrimitiveAtom<number | null>;

const current = { id: "" };

export async function loadTokensForAgent(id: string, transcriptPath: string | undefined): Promise<void> {
    current.id = id;
    globalStore.set(agentTokensAtom, null);
    if (!transcriptPath) {
        return;
    }
    try {
        const rtn = await RpcApi.GetTranscriptTokensCommand(TabRpcClient, { path: transcriptPath });
        if (current.id === id) {
            globalStore.set(agentTokensAtom, rtn.tokens ?? 0);
        }
    } catch {
        if (current.id === id) {
            globalStore.set(agentTokensAtom, null);
        }
    }
}
```

- [ ] **Step 2: Wire the loader into the rail effect**

In `frontend/app/view/agents/agentdetailsrail.tsx`, add the import near the other local imports:

```ts
import { agentTokensAtom, loadTokensForAgent } from "./tokenstore";
```

Extend the existing effect (currently at lines 60-62) to also load tokens:

```ts
    useEffect(() => {
        fireAndForget(() => loadRailForAgent(agent.id, agent.transcriptPath, agent.blockId));
        fireAndForget(() => loadTokensForAgent(agent.id, agent.transcriptPath));
    }, [agent.id, agent.transcriptPath, agent.blockId]);
```

- [ ] **Step 3: Read the atom and render the real value**

In `frontend/app/view/agents/agentdetailsrail.tsx`, add near the other `useAtomValue` reads (after line 58):

```ts
    const tokensTotal = useAtomValue(agentTokensAtom);
```

Replace the occupancy-based `tokens` computation (currently lines 80-81):

```ts
    const tokens = tokensTotal != null ? formatTokens(tokensTotal) : "—";
```

- [ ] **Step 4: Remove the now-unused `DefaultContextMax` const**

The occupancy calc was the only consumer of `DefaultContextMax` (line 25). Delete that line:

```ts
const DefaultContextMax = 200000; // fallback when the reporter omits contextmax (mirrors focusview)
```

(The Context-window section renders from `ctxPct` directly, not `contextmax`, so `ctxPct` and `usage` stay.)

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors (baseline `api.test.ts` errors only). In particular, no "DefaultContextMax is declared but never read" and no unused-import errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/tokenstore.ts frontend/app/view/agents/agentdetailsrail.tsx
git commit -m "feat(agents): rail Tokens row shows real cumulative tokens"
```

---

## Task 5: Usage bars → real window-used tokens (A2)

**Files:**
- Create: `frontend/app/view/agents/windowtokenstore.ts`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx`

- [ ] **Step 1: Create the window-token store**

Create `frontend/app/view/agents/windowtokenstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Real "used tokens" for the 5-hour / weekly rate-limit windows. The windows are
// Claude-only (rate_limits are Claude.ai-specific), so the backend sums Claude
// transcripts. Each window is anchored to its real reset (windowStart = reset - duration),
// falling back to now - duration when a reset is nil (API-key auth, or not yet reported).

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

export interface WindowTokens {
    fivehour: number;
    week: number;
}

export const windowTokensAtom = atom<WindowTokens | null>(null) as PrimitiveAtom<WindowTokens | null>;

let loading = false;

// reset args are epoch seconds (matches AgentUsage.fivehourreset/weekreset); undefined -> trailing now.
export async function loadWindowTokens(fivehourReset?: number, weekReset?: number): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    const nowSec = Math.floor(Date.now() / 1000);
    const fivehourcutoff = (fivehourReset ?? nowSec + FIVE_HOUR_SECONDS) - FIVE_HOUR_SECONDS;
    const weekcutoff = (weekReset ?? nowSec + WEEK_SECONDS) - WEEK_SECONDS;
    try {
        const rtn = await RpcApi.GetWindowTokensCommand(TabRpcClient, { fivehourcutoff, weekcutoff });
        globalStore.set(windowTokensAtom, { fivehour: rtn.fivehourtokens ?? 0, week: rtn.weektokens ?? 0 });
    } catch {
        // keep the last-good value
    } finally {
        loading = false;
    }
}
```

Note on the fallback: when a reset is `undefined`, `(nowSec + duration) - duration === nowSec`, i.e. the trailing `now - duration` window start. When a reset is present, the window is anchored to it.

- [ ] **Step 2: Delete `FAKE_TOKEN_LIMIT` and rewrite `UsageBar`**

In `frontend/app/view/agents/cockpitsurface.tsx`, delete the `FAKE_TOKEN_LIMIT` block (lines 83-86, the `PLACEHOLDER` comment + the const).

Replace the `UsageBar` component (lines 88-117) with a version that takes a real `used?: number` and renders it with no denominator:

```tsx
// One plan window as a full-width handoff bar: label + pct + bar + (real used tokens) + reset
// countdown. A null pct (API-key auth, or a window not yet reported) renders nothing. `used` is
// the real Claude-only token sum for the window (windowtokenstore); absent -> no token line.
function UsageBar({
    label,
    pct,
    reset,
    used,
    now,
}: {
    label: string;
    pct?: number;
    reset?: number;
    used?: number;
    now: number;
}) {
    if (pct == null) {
        return null;
    }
    const lvl = usageLevel(pct);
    return (
        <div>
            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="text-[12.5px] font-medium text-secondary">{label}</span>
                <span className={cn("font-mono text-[12px] font-semibold", PLAN_TXT[lvl])}>{Math.round(pct)}%</span>
            </div>
            <div className="h-[7px] overflow-hidden rounded-[4px] bg-surface-raised">
                <div
                    className={cn("h-full rounded-[4px]", PLAN_BAR[lvl])}
                    style={{ width: `${Math.min(100, pct)}%` }}
                />
            </div>
            {used != null || reset ? (
                <div className="mt-[6px] flex justify-between font-mono text-[10.5px] text-muted">
                    <span>{used != null ? `${formatTokens(used)} tok` : ""}</span>
                    {reset ? <span>resets {formatReset(reset, now)}</span> : null}
                </div>
            ) : null}
        </div>
    );
}
```

- [ ] **Step 3: Load window tokens and feed the Claude bars**

In `frontend/app/view/agents/cockpitsurface.tsx`, add the import near the other local imports:

```ts
import { loadWindowTokens, windowTokensAtom } from "./windowtokenstore";
```

After `usageDonuts` is computed (line 182), read the atom and derive the Claude window resets:

```ts
    const windowTokens = useAtomValue(windowTokensAtom);
    const claudeDonut = usageDonuts.find((d) => d.provider === "claude");
```

Add an effect (alongside the other `useEffect`s, e.g. after line 182's block) to refresh window tokens whenever the Claude resets change:

```ts
    useEffect(() => {
        if (claudeDonut == null) {
            return;
        }
        fireAndForget(() => loadWindowTokens(claudeDonut.fivehour.reset, claudeDonut.week.reset));
    }, [claudeDonut?.fivehour.reset, claudeDonut?.week.reset]);
```

(`fireAndForget` and `useAtomValue` are already imported in this file — it uses them elsewhere. If tsc reports either as missing, add the import from `@/util/util` / `jotai` respectively, matching the existing usage in the file.)

- [ ] **Step 4: Pass `used` into the two Claude bars**

In the `usageDonuts.map((d) => ...)` block (lines 698-704), pass `used` only for the Claude provider:

```tsx
                                    <UsageBar
                                        label="5-hour window"
                                        pct={d.fivehour.pct}
                                        reset={d.fivehour.reset}
                                        used={d.provider === "claude" ? windowTokens?.fivehour : undefined}
                                        now={now}
                                    />
                                    <UsageBar
                                        label="Weekly"
                                        pct={d.week.pct}
                                        reset={d.week.reset}
                                        used={d.provider === "claude" ? windowTokens?.week : undefined}
                                        now={now}
                                    />
```

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors. Confirm no remaining reference to `FAKE_TOKEN_LIMIT` (`grep -n FAKE_TOKEN_LIMIT frontend/app/view/agents/cockpitsurface.tsx` → no matches).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/windowtokenstore.ts frontend/app/view/agents/cockpitsurface.tsx
git commit -m "feat(agents): usage bars show real window-used tokens, drop FAKE_TOKEN_LIMIT"
```

---

## Task 6: `prettyModel` helper + wiring (B1)

**Files:**
- Create: `frontend/app/view/agents/modellabel.ts`
- Create: `frontend/app/view/agents/modellabel.test.ts`
- Modify: `frontend/app/view/agents/usagesurface.tsx`
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/modellabel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { prettyModel } from "./modellabel";

describe("prettyModel", () => {
    it("formats claude families with major.minor version", () => {
        expect(prettyModel("claude-opus-4-8")).toBe("Opus 4.8");
        expect(prettyModel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
        expect(prettyModel("claude-haiku-4-5")).toBe("Haiku 4.5");
        expect(prettyModel("claude-fable-5")).toBe("Fable 5");
    });
    it("drops an 8-digit date suffix (not a minor version)", () => {
        expect(prettyModel("claude-opus-4-20250514")).toBe("Opus 4");
    });
    it("labels openai/codex families with fixed names", () => {
        expect(prettyModel("gpt-5.5")).toBe("GPT-5.5");
        expect(prettyModel("gpt-5")).toBe("GPT-5");
        expect(prettyModel("codex-auto-review")).toBe("Codex");
    });
    it("falls back to the raw id for unknown models, and — for empty", () => {
        expect(prettyModel("some-future-model-9")).toBe("some-future-model-9");
        expect(prettyModel("")).toBe("—");
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/modellabel.test.ts`
Expected: FAIL — cannot resolve `./modellabel`.

- [ ] **Step 3: Implement `prettyModel`**

Create `frontend/app/view/agents/modellabel.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Best-effort friendly label for a raw model id (e.g. "claude-opus-4-8" -> "Opus 4.8").
// Version is read from the digits after the family word: the first number is the major, and
// a following 1-2 digit number is the minor (an 8-digit date snapshot is ignored). Unknown
// models fall through to the raw id, so the label is always at least as informative as before.

function versionAfter(m: string, family: string): string {
    const rest = m.slice(m.indexOf(family) + family.length);
    const nums = rest.match(/\d+/g);
    if (!nums || nums.length === 0) {
        return "";
    }
    const major = nums[0];
    const minor = nums[1];
    if (minor != null && minor.length <= 2) {
        return ` ${major}.${minor}`;
    }
    return ` ${major}`;
}

export function prettyModel(id: string): string {
    if (!id) {
        return "—";
    }
    const m = id.toLowerCase();
    if (m.includes("opus")) return `Opus${versionAfter(m, "opus")}`;
    if (m.includes("sonnet")) return `Sonnet${versionAfter(m, "sonnet")}`;
    if (m.includes("haiku")) return `Haiku${versionAfter(m, "haiku")}`;
    if (m.includes("fable")) return `Fable${versionAfter(m, "fable")}`;
    if (m.includes("gpt-5.5")) return "GPT-5.5";
    if (m.includes("codex")) return "Codex";
    if (m.includes("gpt-5")) return "GPT-5";
    return id;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/modellabel.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Wire into the Usage surface per-model bar**

In `frontend/app/view/agents/usagesurface.tsx`, add the import:

```ts
import { prettyModel } from "./modellabel";
```

Replace the raw model label at line 315:

```tsx
                        <span className="font-mono text-[12px] text-secondary" title={m.model}>{prettyModel(m.model)}</span>
```

- [ ] **Step 6: Wire into the rail Model row**

In `frontend/app/view/agents/agentdetailsrail.tsx`, add the import (or extend an existing one):

```ts
import { prettyModel } from "./modellabel";
```

Replace the Model `DetailRow` value (line 102):

```tsx
                    <DetailRow label="Model" value={agent.model ? prettyModel(agent.model) : "—"} />
```

- [ ] **Step 7: Typecheck + full FE test run**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && npx vitest run`
Expected: no new tsc errors; vitest all green (existing suites + new `modellabel` test).

- [ ] **Step 8: Commit**

```bash
git add frontend/app/view/agents/modellabel.ts frontend/app/view/agents/modellabel.test.ts frontend/app/view/agents/usagesurface.tsx frontend/app/view/agents/agentdetailsrail.tsx
git commit -m "feat(agents): prettify raw model ids in usage surface + rail"
```

---

## Task 7: Pricing refresh + `fable` family (B2)

**Files:**
- Modify: `frontend/app/view/agents/usagepricing.ts`
- Test: `frontend/app/view/agents/usagepricing.test.ts` (new)

Authoritative current-generation per-1M pricing (Claude pricing reference, claude-api skill, 2026-07): Fable 5 $10/$50; Opus 4.6/4.7/4.8 $5/$25; Sonnet 5 & 4.6 $3/$15; Haiku 4.5 $1/$5. Cache tiers follow the table's existing convention (cacheRead = 0.1×input, cacheWrite5m = 1.25×input, cacheWrite1h = 2×input). This corrects two stale rows: `opus` was $15/$75 (old Opus-4.0 pricing) and `haiku` was $0.80/$4; `sonnet` at $3/$15 was already current.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/usagepricing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { priceFor } from "./usagepricing";

describe("priceFor", () => {
    it("prices the fable family", () => {
        const p = priceFor("claude-fable-5");
        expect(p?.input).toBe(10);
        expect(p?.output).toBe(50);
    });
    it("uses current-generation opus + haiku pricing", () => {
        expect(priceFor("claude-opus-4-8")?.input).toBe(5);
        expect(priceFor("claude-opus-4-8")?.output).toBe(25);
        expect(priceFor("claude-haiku-4-5")?.input).toBe(1);
        expect(priceFor("claude-haiku-4-5")?.output).toBe(5);
    });
    it("keeps sonnet + codex + returns undefined for unknown", () => {
        expect(priceFor("claude-sonnet-5")?.input).toBe(3);
        expect(priceFor("codex-auto-review")?.input).toBe(1.25);
        expect(priceFor("some-unknown-model")).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/usagepricing.test.ts`
Expected: FAIL — `fable` price is undefined and `opus`/`haiku` numbers are the stale values.

- [ ] **Step 3: Update the pricing table + `priceFor`**

In `frontend/app/view/agents/usagepricing.ts`, update the header note's date/source (the "Sourced from ... 2026-06" line → "2026-07; current-generation pricing") and add a caveat comment:

```ts
// Family-substring pricing loses the model version, so a historical Claude-Opus-4.0 transcript
// (which billed $15/$75) is priced at the current Opus tier ($5/$25). Acceptable: the cockpit's
// spend is an estimate and the bulk of real data is current-generation. Refresh when plans change.
```

Replace the `opus` and `haiku` rows and add `fable` in `MODEL_PRICES`:

```ts
    fable: { input: 10, output: 50, cacheRead: 1.0, cacheWrite5m: 12.5, cacheWrite1h: 20 },
    opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
    haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
    "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
    codex: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
    "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
```

Add the `fable` match in `priceFor` (before the `opus` check — distinct family word, order doesn't collide but keep the Claude families grouped):

```ts
    if (m.includes("fable")) return MODEL_PRICES.fable;
    if (m.includes("opus")) return MODEL_PRICES.opus;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/usagepricing.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/usagepricing.ts frontend/app/view/agents/usagepricing.test.ts
git commit -m "feat(agents): refresh pricing to current-gen rates + add fable family"
```

---

## Task 8: Rewrite the `docs/deferred.md` entries

**Files:**
- Modify: `docs/deferred.md`

- [ ] **Step 1: Mark the rail-Tokens entry resolved**

Replace the "Agent rail 'Tokens' — context occupancy, not cumulative (2026-06-26)" entry body with a resolved note pointing at this work: the rail now reads a real whole-file cumulative total via `GetTranscriptTokensCommand` (`tokenstore.ts`, `usagestats.SumTranscript`), matching the Usage surface's deduped accounting.

- [ ] **Step 2: Mark the usage-bar fabricated-tokens entry resolved**

Replace the "Usage-bar token counts (fabricated)" entry body with a resolved note: `FAKE_TOKEN_LIMIT` is deleted; the 5-hour/Weekly bars now show a real Claude-only window-used token count (no denominator — no honest ceiling exists) via `GetWindowTokensCommand` + `usagestats.WindowTokens`, with each window anchored to its rate-limit reset.

- [ ] **Step 3: Update the Usage-surface deferred entry**

In the "Usage surface — deferred (2026-06-26)" entry:
- Mark **Model-id prettifying** resolved (`prettyModel` in `modellabel.ts`, used in the surface + rail; raw id kept as tooltip).
- Mark **Pricing table** resolved-as-refreshed (current-gen rates + `fable`; note the family-collapse caveat that historical Opus-4.0 is priced at the current tier).
- Mark **Scan bound** resolved/obsolete — the scan runs in the Go backend (`GetUsageStatsCommand`, no file cap); the `SESSION_READ_CAP` text described the old FE scan and is stale.
- Rewrite **Rate-limit window token cap** and **Plan-tier badge** as **permanent limitations** (no honest source: the % is Anthropic's opaque server number, the tier is not carried by the statusLine) rather than open TODOs.
- Leave **Codex/OpenAI token breakdown** as an open item (unchanged; out of scope).

- [ ] **Step 4: Leave out-of-scope entries intact**

Confirm the "Files surface — deferred (v1)", "New Agent → Agent tab: dev-mock handoff", and "Agent (Focus) surface placeholders" entries are unchanged except that the Focus-surface **Tokens (total)** placeholder note may reference the now-resolved rail-Tokens entry.

- [ ] **Step 5: Commit**

```bash
git add docs/deferred.md
git commit -m "docs(deferred): resolve token-truth + usage-polish entries"
```

---

## Self-Review

**Spec coverage:**
- A1 rail cumulative tokens → Tasks 1, 3, 4. ✅
- A2 usage-bar real window-used → Tasks 2, 3, 5. ✅
- B1 model-id prettify → Task 6. ✅
- B2 pricing refresh + fable → Task 7. ✅
- Docs rewrite (resolve #1/#5/#3-prettify/#3-pricing; #3-scan obsolete; #3-ratecap/#3-tier permanent) → Task 8. ✅
- Error handling (missing transcript → 0/"—"; RPC failure → last-good/"—"; unknown model → raw/0) → covered in Task 1 (`SumTranscript` empty→0), Task 4/5 stores (catch → null/last-good), Task 6/7 (fallback to raw id / undefined). ✅
- Tests: Go `SumTranscript` + `sumRecordsSinceCutoffs` (Tasks 1-2), vitest `prettyModel` (Task 6), `priceFor` (Task 7). ✅

**Type consistency:** wire json tags (`path`, `tokens`, `fivehourcutoff`, `weekcutoff`, `fivehourtokens`, `weektokens`) are lowercased in structs (Task 3) and read lowercased on the FE (`rtn.tokens`, `rtn.fivehourtokens`, `rtn.weektokens` in Tasks 4-5). Command names derive to `gettranscripttokens` / `getwindowtokens`. `agentTokensAtom`, `windowTokensAtom`, `loadTokensForAgent`, `loadWindowTokens`, `prettyModel`, `priceFor`, `MODEL_PRICES.fable` are referenced with the same names across tasks. ✅

**Placeholder scan:** every code step shows the actual code; commands have expected output. No TBD/TODO. ✅

**Known judgment call (flag to reviewer):** Task 7 changes `opus` pricing from $15/$75 to $5/$25 and `haiku` from $0.80/$4 to $1/$5. This is the correct current-generation pricing but re-prices historical Opus-4.0 estimates downward (the family-substring table can't distinguish versions). Documented in the code comment and the deferred entry.
