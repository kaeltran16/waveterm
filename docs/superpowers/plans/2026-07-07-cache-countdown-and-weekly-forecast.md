# Cache-Expiry Countdown + Weekly Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-agent prompt-cache-expiry countdown to the agent details rail, and a rhythm-aware weekly-quota-exhaustion projection to the Usage surface's Weekly donut.

**Architecture:** Feature 1 (cache countdown) adds one Go function (`LastCacheWrite`) reusing the existing transcript parser, one new wshrpc command mirroring the existing `GetTranscriptTokensCommand` pattern, and a frontend store mirroring `tokenstore.ts`. Feature 2 (weekly forecast) is entirely frontend — a pure function that reuses already-loaded daily-token history (`stats.daily`) to build a day-of-week weight shape, then walks forward from the current rate-limit reading to project when the weekly window will cross 100%.

**Tech Stack:** Go (`pkg/usagestats`, `pkg/wshrpc`), TypeScript/React (`frontend/app/view/agents`), Vitest, Go `testing`.

**Full design reference:** `docs/superpowers/specs/2026-07-07-cache-countdown-and-weekly-forecast-design.md`

---

## Commit policy override (read before starting)

This project's global instructions (`CLAUDE.md`) require: **never commit without explicit approval, and batch into one commit at the end unless told otherwise.** This overrides the generic "commit after every task" pattern from the writing-plans skill template. Concretely:

- **Do not run `git commit` after individual tasks below.** Each task ends with "verify" (tests pass / build succeeds), not "commit."
- **Task 8 is the only commit point.** It shows the full diff and proposed commit message, and waits for explicit user approval (`Awaiting approval. Proceed? (yes/no)`) before committing.
- If executing this plan across multiple sessions, it's fine to `git add` incrementally, but do not `git commit` until Task 8.

---

### Task 1: Go — `LastCacheWrite` in `pkg/usagestats`

**Files:**
- Modify: `pkg/usagestats/usagestats.go` (insert after `SumTranscript`, i.e. after line 307)
- Test: `pkg/usagestats/usagestats_test.go` (insert after `TestSumTranscript`, i.e. after line 197)

- [ ] **Step 1: Write the failing test**

Insert into `pkg/usagestats/usagestats_test.go`, immediately after the closing `}` of `TestSumTranscript` (after line 197, before `func TestWindowTokens`):

```go
func TestLastCacheWrite(t *testing.T) {
	dir := t.TempDir()

	// Two cache-writing assistant messages: an earlier one on the default (5m) bucket, a later
	// one on the extended 1h bucket. LastCacheWrite must report the later one.
	path := filepath.Join(dir, "claude.jsonl")
	lines := "" +
		`{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":200}}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-06-26T10:05:00.000Z","requestId":"r2","message":{"id":"m2","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_1h_input_tokens":300}}}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-06-26T10:02:00.000Z","requestId":"r3","message":{"id":"m3","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5}}}` + "\n" // no cache write, in between -- must not win on TS ordering alone
	if err := os.WriteFile(path, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := LastCacheWrite(path)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got == nil {
		t.Fatal("want non-nil CacheWrite")
	}
	if !got.OneHour {
		t.Errorf("want OneHour=true (the 10:05 write used the extended bucket), got false")
	}
	if !got.TS.Equal(time.Date(2026, 6, 26, 10, 5, 0, 0, time.UTC)) {
		t.Errorf("ts = %v, want 10:05:00", got.TS)
	}

	// No cache-write activity at all -> nil, no error.
	noCache := filepath.Join(dir, "no-cache.jsonl")
	noCacheLine := `{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5}}}`
	if err := os.WriteFile(noCache, []byte(noCacheLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got2, err := LastCacheWrite(noCache)
	if err != nil || got2 != nil {
		t.Fatalf("want nil/no-error for no cache activity, got %+v, err=%v", got2, err)
	}

	// Codex-shaped transcript -> nil (extractClaude yields nothing for it), no error.
	codex := filepath.Join(dir, "rollout-x.jsonl")
	codexLine := `{"timestamp":"2026-06-26T03:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10,"total_tokens":110}}}}`
	if err := os.WriteFile(codex, []byte(codexLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got3, err := LastCacheWrite(codex)
	if err != nil || got3 != nil {
		t.Fatalf("want nil/no-error for codex transcript, got %+v, err=%v", got3, err)
	}

	// Missing file -> nil, no error (mirrors SumTranscript's missing-file behavior).
	got4, err := LastCacheWrite(filepath.Join(dir, "does-not-exist.jsonl"))
	if err != nil || got4 != nil {
		t.Fatalf("want nil/no-error for missing file, got %+v, err=%v", got4, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/usagestats/... -run TestLastCacheWrite -v`
Expected: FAIL — `undefined: LastCacheWrite` (and `CacheWrite`)

- [ ] **Step 3: Write minimal implementation**

Insert into `pkg/usagestats/usagestats.go`, immediately after the closing `}` of `SumTranscript` (after line 307, before the `sumRecordsSinceCutoffs` comment on line 309):

```go
// CacheWrite is the most recent prompt-cache-writing message in a transcript.
type CacheWrite struct {
	TS      time.Time
	OneHour bool // true if this write used the extended 1h TTL bucket (else the default 5m bucket)
}

// LastCacheWrite finds the most recent assistant record with cache-write activity in the
// transcript at path, and reports which TTL bucket it used. Only Claude transcripts carry this
// concept (extractClaude yields nothing for a Codex-shaped file, so this returns nil for those).
// Returns nil (no error) when the transcript has no cache-write activity, is empty, or is missing.
func LastCacheWrite(path string) (*CacheWrite, error) {
	lines := readLines(path)
	if len(lines) == 0 {
		return nil, nil
	}
	var last *Record
	for _, r := range extractClaude(lines) {
		if r.CacheCreate <= 0 {
			continue
		}
		if last == nil || r.TS.After(last.TS) {
			rc := r
			last = &rc
		}
	}
	if last == nil {
		return nil, nil
	}
	return &CacheWrite{TS: last.TS, OneHour: last.CacheCreate1h > 0}, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/usagestats/... -run TestLastCacheWrite -v`
Expected: PASS

- [ ] **Step 5: Run the full package suite to check for regressions**

Run: `go test ./pkg/usagestats/...`
Expected: PASS (all tests, including the pre-existing ones)

---

### Task 2: Go — wire protocol + server implementation for `GetCacheStatusCommand`

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface method after line 103; data types after line 866)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (implementation after line 1550)

This task has no standalone unit test — it's a thin protocol/wiring layer verified by `go build` (the interface method and its implementation must land together, or the build breaks; that's why they're one task/one commit-worthy unit rather than split further).

- [ ] **Step 1: Add the interface method**

In `pkg/wshrpc/wshrpctypes.go`, insert immediately after line 103 (`GetWindowTokensCommand(...)`), before line 104 (`MemoryScanCommand`):

```go
	GetCacheStatusCommand(ctx context.Context, data CommandGetCacheStatusData) (*CommandGetCacheStatusRtnData, error)
```

- [ ] **Step 2: Add the data types**

In the same file, insert immediately after line 866 (the closing `}` of `CommandGetWindowTokensRtnData`), before line 867:

```go

type CommandGetCacheStatusData struct {
	Path string `json:"path"`
}

type CommandGetCacheStatusRtnData struct {
	LastWriteTs int64 `json:"lastwritets,omitempty"` // epoch seconds; absent = no cache-write found
	OneHour     bool  `json:"onehour,omitempty"`
}
```

- [ ] **Step 3: Implement the command**

In `pkg/wshrpc/wshserver/wshserver.go`, insert immediately after line 1550 (the closing `}` of `GetTranscriptTokensCommand`), before line 1552 (`GetWindowTokensCommand`):

```go

func (ws *WshServer) GetCacheStatusCommand(ctx context.Context, data wshrpc.CommandGetCacheStatusData) (*wshrpc.CommandGetCacheStatusRtnData, error) {
	cw, err := usagestats.LastCacheWrite(data.Path)
	if err != nil {
		return nil, fmt.Errorf("checking cache status: %w", err)
	}
	if cw == nil {
		return &wshrpc.CommandGetCacheStatusRtnData{}, nil
	}
	return &wshrpc.CommandGetCacheStatusRtnData{LastWriteTs: cw.TS.Unix(), OneHour: cw.OneHour}, nil
}
```

- [ ] **Step 4: Build to verify**

Run: `go build ./...`
Expected: succeeds with no errors

---

### Task 3: Regenerate TS/Go bindings

**Files:**
- Generated (do not hand-edit): `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`

- [ ] **Step 1: Run the generator**

Run: `task generate`
Expected: exits 0

- [ ] **Step 2: Verify the new command was generated**

Run: `grep -c "GetCacheStatusCommand" frontend/app/store/wshclientapi.ts`
Expected: `1` (or more)

Run: `grep -c "CommandGetCacheStatusRtnData" frontend/types/gotypes.d.ts`
Expected: `1` (or more)

- [ ] **Step 3: Typecheck to confirm nothing else broke**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0 (per this repo's known `npx tsc` stack-overflow gotcha — always use this invocation, never bare `npx tsc`)

---

### Task 4: Frontend — `cachestatusstore.ts`

**Files:**
- Create: `frontend/app/view/agents/cachestatusstore.ts`
- Test: `frontend/app/view/agents/cachestatusstore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/cachestatusstore.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { formatCacheCountdown } from "./cachestatusstore";

describe("formatCacheCountdown", () => {
    test("no status -> em dash", () => {
        expect(formatCacheCountdown(null, 0)).toBe("—");
    });

    test("5-minute bucket, 2 minutes elapsed -> 3m left", () => {
        const status = { lastWriteTs: 1000, oneHour: false };
        expect(formatCacheCountdown(status, (1000 + 120) * 1000)).toBe("3m left");
    });

    test("5-minute bucket, under a minute remaining -> <1m left", () => {
        const status = { lastWriteTs: 1000, oneHour: false };
        expect(formatCacheCountdown(status, (1000 + 299) * 1000)).toBe("<1m left");
    });

    test("5-minute bucket, 6 minutes elapsed -> expired", () => {
        const status = { lastWriteTs: 1000, oneHour: false };
        expect(formatCacheCountdown(status, (1000 + 360) * 1000)).toBe("expired");
    });

    test("1-hour bucket, 30 seconds elapsed -> 59m left", () => {
        const status = { lastWriteTs: 1000, oneHour: true };
        expect(formatCacheCountdown(status, (1000 + 30) * 1000)).toBe("59m left");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/cachestatusstore.test.ts`
Expected: FAIL — cannot find module `./cachestatusstore`

- [ ] **Step 3: Write minimal implementation**

Create `frontend/app/view/agents/cachestatusstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Focused-agent prompt-cache-expiry status: a thin whole-file scan of the agent's transcript via
// GetCacheStatusCommand (reuses the Historical scan's cache-write parsing). Mirrors tokenstore.ts's
// stale-load guard so a slow load for a previous focus can't overwrite a newer one.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";

export interface CacheStatus {
    lastWriteTs: number; // epoch seconds
    oneHour: boolean;
}

export const agentCacheStatusAtom = atom<CacheStatus | null>(null) as PrimitiveAtom<CacheStatus | null>;

const current = { id: "" };

export async function loadCacheStatusForAgent(id: string, transcriptPath: string | undefined): Promise<void> {
    current.id = id;
    globalStore.set(agentCacheStatusAtom, null);
    if (!transcriptPath) {
        return;
    }
    try {
        const rtn = await RpcApi.GetCacheStatusCommand(TabRpcClient, { path: transcriptPath });
        if (current.id !== id) {
            return;
        }
        globalStore.set(agentCacheStatusAtom, rtn.lastwritets ? { lastWriteTs: rtn.lastwritets, oneHour: !!rtn.onehour } : null);
    } catch {
        if (current.id === id) {
            globalStore.set(agentCacheStatusAtom, null);
        }
    }
}

// Pure: ttl = 3600s (extended bucket) or 300s (default bucket) minus elapsed time since the last
// cache write. null -> "—" (no cache activity yet); <=0 remaining -> "expired".
export function formatCacheCountdown(status: CacheStatus | null, nowMs: number): string {
    if (status == null) {
        return "—";
    }
    const ttlSec = status.oneHour ? 3600 : 300;
    const remainingSec = ttlSec - (nowMs / 1000 - status.lastWriteTs);
    if (remainingSec <= 0) {
        return "expired";
    }
    const mins = Math.floor(remainingSec / 60);
    return mins < 1 ? "<1m left" : `${mins}m left`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/cachestatusstore.test.ts`
Expected: PASS (5/5)

---

### Task 5: Frontend — wire the countdown into `AgentDetailsRail`

**Files:**
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx`

- [ ] **Step 1: Add the import**

In `frontend/app/view/agents/agentdetailsrail.tsx`, change line 30 from:

```ts
import { agentTokensAtom, loadTokensForAgent } from "./tokenstore";
```

to:

```ts
import { agentCacheStatusAtom, formatCacheCountdown, loadCacheStatusForAgent } from "./cachestatusstore";
import { agentTokensAtom, loadTokensForAgent } from "./tokenstore";
```

- [ ] **Step 2: Read the atom + tick, load on focus-change**

Change line 63 from:

```ts
    const tokensTotal = useAtomValue(agentTokensAtom);
```

to:

```ts
    const tokensTotal = useAtomValue(agentTokensAtom);
    const cacheStatus = useAtomValue(agentCacheStatusAtom);
    const now = useAtomValue(model.nowAtom);
```

Change lines 65-68 from:

```ts
    useEffect(() => {
        fireAndForget(() => loadRailForAgent(agent.id, agent.transcriptPath, agent.blockId));
        fireAndForget(() => loadTokensForAgent(agent.id, agent.transcriptPath));
    }, [agent.id, agent.transcriptPath, agent.blockId]);
```

to:

```ts
    useEffect(() => {
        fireAndForget(() => loadRailForAgent(agent.id, agent.transcriptPath, agent.blockId));
        fireAndForget(() => loadTokensForAgent(agent.id, agent.transcriptPath));
        fireAndForget(() => loadCacheStatusForAgent(agent.id, agent.transcriptPath));
    }, [agent.id, agent.transcriptPath, agent.blockId]);
```

- [ ] **Step 3: Compute the display string and render the row**

Change line 94 from:

```ts
    const tokens = tokensTotal != null ? formatTokens(tokensTotal) : "—";
```

to:

```ts
    const tokens = tokensTotal != null ? formatTokens(tokensTotal) : "—";
    const cacheCountdown = formatCacheCountdown(cacheStatus, now);
    const isClaude = (agent.agent || "claude") === "claude";
```

Change lines 121-122 from:

```tsx
                        <DetailRow label="Tokens" value={tokens} />
                        <DetailRow label="Cost" value={cost} />
```

to:

```tsx
                        <DetailRow label="Tokens" value={tokens} />
                        <DetailRow label="Cost" value={cost} />
                        {isClaude ? <DetailRow label="Cache expires" value={cacheCountdown} /> : null}
```

- [ ] **Step 4: Typecheck to verify**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

There's no jsdom/render-test harness for the cockpit (per this repo's testing constraints) — if you want to visually confirm the row renders correctly on a focused Claude agent, use the CDP screenshot flow (`node scripts/cdp-shot.mjs`) against a running `task dev` session. This is optional manual verification, not a blocking step.

---

### Task 6: Frontend — `weeklyforecast.ts`

**Files:**
- Create: `frontend/app/view/agents/weeklyforecast.ts`
- Test: `frontend/app/view/agents/weeklyforecast.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/agents/weeklyforecast.test.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { buildDayOfWeekShape, formatProjectedDate, projectWeeklyExhaustion } from "./weeklyforecast";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

describe("buildDayOfWeekShape", () => {
    test("returns null with fewer than 4 distinct days", () => {
        const anchor = new Date(2026, 0, 5, 12, 0, 0);
        const daily = [0, 1, 2].map((i) => {
            const d = new Date(anchor);
            d.setDate(d.getDate() - i);
            return { day: dayKey(d), tokens: 100 };
        });
        expect(buildDayOfWeekShape(daily)).toBeNull();
    });

    test("normalizes so sampled weekdays average to 1; unsampled weekdays default to 1", () => {
        const anchor = new Date(2026, 0, 5, 12, 0, 0);
        const tokensByOffset = [700, 100, 100, 100]; // offset 0 = anchor day, 1 = day before, ...
        const daily = tokensByOffset.map((tokens, i) => {
            const d = new Date(anchor);
            d.setDate(d.getDate() - i);
            return { day: dayKey(d), tokens };
        });
        const mean = (700 + 100 + 100 + 100) / 4;
        const expected = new Array(7).fill(1);
        tokensByOffset.forEach((tokens, i) => {
            const d = new Date(anchor);
            d.setDate(d.getDate() - i);
            expected[d.getDay()] = tokens / mean;
        });

        const shape = buildDayOfWeekShape(daily);
        expect(shape).not.toBeNull();
        shape!.forEach((w, dow) => expect(w).toBeCloseTo(expected[dow], 5));
    });
});

describe("projectWeeklyExhaustion", () => {
    test("returns null with insufficient history", () => {
        const anchor = new Date(2026, 0, 5, 12, 0, 0);
        const daily = [0, 1, 2].map((i) => {
            const d = new Date(anchor);
            d.setDate(d.getDate() - i);
            return { day: dayKey(d), tokens: 100 };
        });
        const now = anchor.getTime();
        const weekreset = (now + DAY_MS) / 1000;
        expect(projectWeeklyExhaustion(daily, 50, weekreset, now)).toBeNull();
    });

    test("uniform shape extrapolates the observed pace linearly", () => {
        // 4 uniform days -> shape is flat (every weekday weight 1), so this reduces to naive linear
        // extrapolation: a hand-verifiable sanity check that the weighting doesn't distort a flat shape.
        // Elapsed is chosen as 40h (not e.g. 42h) so the pace (50/40 = 1.25) is an exact binary
        // fraction -- repeated floating-point summation lands on exactly 50.0 at the crossing step,
        // with no rounding-error risk of tripping the >= comparison onto the wrong side.
        const weekStart = new Date(2026, 0, 1, 0, 0, 0);
        const weekreset = (weekStart.getTime() + 7 * DAY_MS) / 1000;
        const now = weekStart.getTime() + 40 * 60 * 60 * 1000; // 40h elapsed of the 168h window
        const daily = [0, 1, 2, 3].map((i) => {
            const d = new Date(weekStart);
            d.setDate(d.getDate() - i - 1);
            return { day: dayKey(d), tokens: 100 };
        });
        // 50% used in 40h elapsed -> pace of 1.25%/hour -> the remaining 50% takes exactly 40 more
        // hours at the same pace.
        const got = projectWeeklyExhaustion(daily, 50, weekreset, now);
        expect(got).toBe(now + 40 * 60 * 60 * 1000);
    });

    test("a pace that wouldn't exhaust before reset returns null", () => {
        const weekStart = new Date(2026, 0, 1, 0, 0, 0);
        const weekreset = (weekStart.getTime() + 7 * DAY_MS) / 1000;
        const now = weekStart.getTime() + 140 * 60 * 60 * 1000; // 140h elapsed of 168h
        const daily = [0, 1, 2, 3].map((i) => {
            const d = new Date(weekStart);
            d.setDate(d.getDate() - i - 1);
            return { day: dayKey(d), tokens: 100 };
        });
        // 5% used in 140h -> over the remaining 28h at the same pace, +1% -> nowhere near 100%.
        expect(projectWeeklyExhaustion(daily, 5, weekreset, now)).toBeNull();
    });

    test("a heavier near-term weekday shape projects exhaustion no later than a lighter one", () => {
        const weekStart = new Date(2026, 0, 1, 0, 0, 0);
        const weekreset = (weekStart.getTime() + 7 * DAY_MS) / 1000;
        const now = weekStart.getTime() + 6.5 * DAY_MS; // 12h before reset -> the forward walk is
        // dominated by the next day or two, so a large swing in that bucket's weight should reliably
        // move the projection in the expected direction despite the shared normalization.

        const buildDaily = (nearTermTokens: number) => {
            const days = [];
            for (let i = 0; i < 6; i++) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                days.push({ day: dayKey(d), tokens: i === 0 ? nearTermTokens : 100 });
            }
            return days;
        };

        // 300 (not 50): the near-term day's weight is calibrated against both the elapsed-pace
        // denominator and the forward-walk numerator, so a too-light near-term value can fail to
        // accumulate the remaining budget within this 12h window at all (a legitimate null, per the
        // "pace that wouldn't exhaust before reset" case above) -- 300 sits above that crossing
        // threshold while staying well below heavy's 1000.
        const heavy = projectWeeklyExhaustion(buildDaily(1000), 90, weekreset, now);
        const light = projectWeeklyExhaustion(buildDaily(300), 90, weekreset, now);

        expect(heavy).not.toBeNull();
        expect(light).not.toBeNull();
        expect(heavy as number).toBeLessThanOrEqual(light as number);
    });
});

describe("formatProjectedDate", () => {
    test("formats weekday + 12-hour time", () => {
        const d = new Date(2026, 0, 1, 15, 0, 0);
        expect(formatProjectedDate(d.getTime())).toBe(`${WEEKDAY[d.getDay()]} 3pm`);
    });

    test("midnight -> 12am, noon -> 12pm", () => {
        const midnight = new Date(2026, 0, 1, 0, 0, 0);
        const noon = new Date(2026, 0, 1, 12, 0, 0);
        expect(formatProjectedDate(midnight.getTime())).toBe(`${WEEKDAY[midnight.getDay()]} 12am`);
        expect(formatProjectedDate(noon.getTime())).toBe(`${WEEKDAY[noon.getDay()]} 12pm`);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/weeklyforecast.test.ts`
Expected: FAIL — cannot find module `./weeklyforecast`

- [ ] **Step 3: Write the implementation**

Create `frontend/app/view/agents/weeklyforecast.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Rhythm-aware weekly-quota-exhaustion projection for the Usage surface's Weekly donut. Anthropic's
// weekpct is an opaque, cost-weighted percentage -- there's no exposed tokens<->% conversion, so this
// borrows the *relative shape* of daily token history (already loaded, already on disk, no cold
// start) as a day-of-week pace multiplier, rather than trying to log a %-time-series from scratch.
// See docs/superpowers/specs/2026-07-07-cache-countdown-and-weekly-forecast-design.md.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const STEP_MS = 60 * 60 * 1000; // 1 hour walk resolution
const MIN_HISTORY_DAYS = 4;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface DailyTokens {
    day: string; // "YYYY-MM-DD", local timezone (matches usagestats.ts's DailyUsage.day)
    tokens: number;
}

// Builds a normalized day-of-week weight (mean of sampled weekdays = 1) from daily token history.
// A weekday with no samples defaults to weight 1 (uniform -- no signal either way). Returns null
// when history is thinner than MIN_HISTORY_DAYS distinct days: too few samples for a shape to mean
// anything, and this is a nice-to-have signal, not core functionality needing a degraded state.
export function buildDayOfWeekShape(daily: DailyTokens[]): number[] | null {
    if (daily.length < MIN_HISTORY_DAYS) {
        return null;
    }
    const sums = new Array(7).fill(0);
    const counts = new Array(7).fill(0);
    for (const d of daily) {
        const [y, m, dd] = d.day.split("-").map(Number);
        const dow = new Date(y, m - 1, dd).getDay();
        sums[dow] += d.tokens;
        counts[dow] += 1;
    }
    const avgs: (number | null)[] = sums.map((s, i) => (counts[i] > 0 ? s / counts[i] : null));
    const sampled = avgs.filter((a): a is number => a != null);
    const overallMean = sampled.reduce((a, b) => a + b, 0) / sampled.length;
    if (overallMean <= 0) {
        return null; // no signal to weight by
    }
    return avgs.map((a) => (a != null ? a / overallMean : 1));
}

function weightedHours(startMs: number, endMs: number, shape: number[]): number {
    let total = 0;
    for (let t = startMs; t < endMs; t += STEP_MS) {
        const stepMs = Math.min(STEP_MS, endMs - t);
        total += shape[new Date(t).getDay()] * (stepMs / STEP_MS);
    }
    return total;
}

// Projects when the weekly rate-limit window will cross 100%, using the OBSERVED pace so far
// (weekpct consumed over the weighted-hours elapsed since window start) extrapolated forward with
// the same day-of-week shape. Returns epoch ms of the projected crossing, or null when there's
// insufficient history, or the observed pace wouldn't cross 100% before weekreset.
export function projectWeeklyExhaustion(
    daily: DailyTokens[],
    weekpct: number,
    weekreset: number, // epoch seconds
    now: number // epoch ms
): number | null {
    const shape = buildDayOfWeekShape(daily);
    if (shape == null) {
        return null;
    }
    const resetMs = weekreset * 1000;
    const windowStartMs = resetMs - WEEK_MS;
    if (resetMs <= now || weekpct <= 0 || weekpct >= 100 || now <= windowStartMs) {
        return null;
    }

    const elapsedWeight = weightedHours(windowStartMs, now, shape);
    if (elapsedWeight <= 0) {
        return null;
    }
    const pctPerWeightUnit = weekpct / elapsedWeight; // observed pace, calibrated to actual usage so far

    const remainingPct = 100 - weekpct;
    let acc = 0;
    for (let t = now; t < resetMs; t += STEP_MS) {
        const stepMs = Math.min(STEP_MS, resetMs - t);
        const weight = shape[new Date(t).getDay()] * (stepMs / STEP_MS);
        acc += weight * pctPerWeightUnit;
        if (acc >= remainingPct) {
            return t + stepMs;
        }
    }
    return null; // observed pace wouldn't cross 100% before reset
}

// Pure: epoch ms -> "Thu 3pm" style short weekday + 12-hour time, for the projected-exhaustion line.
export function formatProjectedDate(ms: number): string {
    const d = new Date(ms);
    let h = d.getHours();
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12;
    if (h === 0) {
        h = 12;
    }
    return `${WEEKDAY_SHORT[d.getDay()]} ${h}${ampm}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/weeklyforecast.test.ts`
Expected: PASS (all tests)

---

### Task 7: Frontend — wire the projection into `usagesurface.tsx`

**Files:**
- Modify: `frontend/app/view/agents/usagesurface.tsx`

- [ ] **Step 1: Add the import**

Add alongside the other local imports (near lines 19-23):

```ts
import { formatProjectedDate, projectWeeklyExhaustion } from "./weeklyforecast";
```

- [ ] **Step 2: Extend `MiniDonut` to accept and render a projected-exhaustion line**

Replace the `MiniDonut` function (lines 116-141) with:

```tsx
function MiniDonut({
    title,
    pct,
    reset,
    now,
    projectedExhaustion,
}: {
    title: string;
    pct?: number;
    reset?: number;
    now: number;
    projectedExhaustion?: number | null;
}) {
    const reduce = useReducedMotion();
    const has = pct != null;
    const arc = has ? Math.min(100, pct) : 0;
    const color = has ? RING[usageLevel(pct)] : "var(--color-edge-strong)";
    const ringStyle = {
        background: `conic-gradient(${color} 0 var(--usage-arc), var(--color-edge-strong) 0)`,
        "--usage-arc": `${arc}%`,
        transition: reduce ? undefined : `--usage-arc ${MOTION.durMacro}s ${easeFluidCss}`,
    } as CSSProperties;
    return (
        <div className="flex items-center gap-[7px]">
            <div className="flex h-[40px] w-[40px] flex-none items-center justify-center rounded-full" style={ringStyle}>
                <div className="flex h-[29px] w-[29px] items-center justify-center rounded-full bg-background">
                    <span className="font-mono text-[10px] font-bold text-primary">{has ? Math.round(pct) + "%" : "—"}</span>
                </div>
            </div>
            <div>
                <div className="font-mono text-[10px] font-semibold text-secondary">{title}</div>
                <div className="whitespace-nowrap font-mono text-[9px] text-muted">
                    {reset ? "resets " + formatReset(reset, now) : has ? "live" : "no data"}
                </div>
                {projectedExhaustion != null ? (
                    <div className="whitespace-nowrap font-mono text-[9px] text-warning">
                        ~100% by {formatProjectedDate(projectedExhaustion)}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
```

- [ ] **Step 3: Thread the projection through `LiveLimitCard`**

Replace the `LiveLimitCard` function (lines 143-173) with:

```tsx
function LiveLimitCard({
    d,
    now,
    weeklyProjectionMs,
}: {
    d: ProviderDonuts;
    now: number;
    weeklyProjectionMs?: number | null;
}) {
    const stale = d.stale != null;
    const dot = stale ? "var(--color-warning)" : "var(--color-success)";
    const label = stale ? "as of " + ageStr(now - d.stale!.capturedAt) + " ago" : "Live";
    const border = stale
        ? "color-mix(in srgb, var(--color-warning) 22%, transparent)"
        : "color-mix(in srgb, var(--color-success) 22%, transparent)";
    return (
        <motion.div
            variants={cardVariants}
            initial="initial"
            animate="animate"
            className="flex items-center gap-[11px] rounded-[11px] border bg-surface-raised px-[14px] py-[12px]"
            style={{ borderColor: border }}
        >
            <div className="w-[94px] flex-none">
                <div className="mb-[5px] flex items-center gap-[7px]">
                    <span className="h-[7px] w-[7px] flex-none rounded-full" style={{ background: dot }} />
                    <span className="truncate font-semibold text-[13px] text-primary">{PROVIDER_LABEL[d.provider] ?? d.provider}</span>
                </div>
                <div className="whitespace-nowrap font-mono text-[10px]" style={{ color: dot }}>
                    {label}
                </div>
            </div>
            <div className="flex flex-1 justify-end gap-[10px]">
                <MiniDonut title="5-hour" pct={d.fivehour.pct} reset={d.fivehour.reset} now={now} />
                <MiniDonut
                    title="Weekly"
                    pct={d.week.pct}
                    reset={d.week.reset}
                    now={now}
                    projectedExhaustion={weeklyProjectionMs}
                />
            </div>
        </motion.div>
    );
}
```

- [ ] **Step 4: Compute the projection in `UsageSurface` and pass it down**

Change line 429 from:

```ts
    const donuts = mergeRateLimitWindows(providerPlanUsage([...asking, ...working, ...idle]), saved, now);
```

to:

```ts
    const donuts = mergeRateLimitWindows(providerPlanUsage([...asking, ...working, ...idle]), saved, now);
    const claudeDonut = donuts.find((d) => d.provider === "claude");
    const weeklyProjectionMs =
        claudeDonut?.week.pct != null && claudeDonut.week.reset != null
            ? projectWeeklyExhaustion(
                  stats.daily.map((d) => ({ day: d.day, tokens: d.claudeTokens })),
                  claudeDonut.week.pct,
                  claudeDonut.week.reset,
                  now
              )
            : null;
```

Change the `donuts.map` render (lines 492-496) from:

```tsx
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                {donuts.map((d) => (
                                    <LiveLimitCard key={d.provider} d={d} now={now} />
                                ))}
                            </div>
```

to:

```tsx
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                {donuts.map((d) => (
                                    <LiveLimitCard
                                        key={d.provider}
                                        d={d}
                                        now={now}
                                        weeklyProjectionMs={d.provider === "claude" ? weeklyProjectionMs : null}
                                    />
                                ))}
                            </div>
```

- [ ] **Step 5: Typecheck to verify**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

Optional manual verification (no automated render harness exists for this surface): run `task dev`, focus the Usage tab with a Claude agent that has rate-limit + daily-history data, and use `node scripts/cdp-shot.mjs` to screenshot the Weekly donut.

---

### Task 8: Final verification and batched commit

**Files:** none (verification + git only)

- [ ] **Step 1: Run the full Go suite**

Run: `go test ./pkg/...`
Expected: PASS

- [ ] **Step 2: Run the full frontend suite**

Run: `npx vitest run`
Expected: PASS (no regressions in existing suites)

- [ ] **Step 3: Full typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0

- [ ] **Step 4: Review the full diff**

Run: `git status --short` and `git diff` (or the PowerShell equivalent) to review every changed/new file against this plan. Confirm nothing unrelated snuck in.

- [ ] **Step 5: Present the commit for approval**

Per this project's `CLAUDE.md` git workflow, show the user:
- Every changed/new file with its status (M/A)
- A one-line summary of what changed in each
- The proposed commit message:

```
feat(agents): add cache-expiry countdown and rhythm-aware weekly forecast

- LastCacheWrite (Go) + GetCacheStatusCommand surface per-agent prompt-cache
  TTL countdown in the details rail, reusing the existing transcript parser.
- projectWeeklyExhaustion (pure FE) reuses already-loaded daily token
  history to project weekly-quota exhaustion, weighted by day-of-week shape
  instead of naive linear extrapolation.
```

Then ask: **"Awaiting approval. Proceed? (yes/no)"**

- [ ] **Step 6: Commit (only after explicit approval)**

Stage exactly these files (adjust if `task generate` touched additional generated files — include those too, but nothing unrelated):

```
pkg/usagestats/usagestats.go
pkg/usagestats/usagestats_test.go
pkg/wshrpc/wshrpctypes.go
pkg/wshrpc/wshserver/wshserver.go
pkg/wshrpc/wshclient/wshclient.go
frontend/app/store/wshclientapi.ts
frontend/types/gotypes.d.ts
frontend/app/view/agents/cachestatusstore.ts
frontend/app/view/agents/cachestatusstore.test.ts
frontend/app/view/agents/agentdetailsrail.tsx
frontend/app/view/agents/weeklyforecast.ts
frontend/app/view/agents/weeklyforecast.test.ts
frontend/app/view/agents/usagesurface.tsx
docs/superpowers/specs/2026-07-07-cache-countdown-and-weekly-forecast-design.md
docs/superpowers/plans/2026-07-07-cache-countdown-and-weekly-forecast.md
```

On Windows, write the commit message to a temp file and use `git commit -F <tempfile>` (per this repo's environment notes — no bash heredoc / no PowerShell here-string for commit messages).
