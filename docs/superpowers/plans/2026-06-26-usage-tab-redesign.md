# Usage Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the cockpit Usage tab to the handoff mockup — a live-limits block (donuts that survive idle via localStorage) plus a historical block (token-class split, daily chart, by-model, with a 7-day/All-time window toggle).

**Architecture:** Pure-FE. Extend two pure modules (`usagepricing.ts` per-class spend; `usagestats.ts` split + daily + window-scoped by-model), add one new store (`ratelimitstore.ts`) with a one-line capture hook in `agentstatusstore.ts`, then rewrite `usagesurface.tsx`. No new Go, no new RPC — `GetUsageStatsCommand` already returns per-(provider,model,day) buckets.

**Tech Stack:** React 19 + jotai + Tailwind v4 (`@theme` tokens), vitest. Specs: [usage-historical-redesign](../specs/2026-06-26-usage-historical-redesign-design.md), [ratelimit-donut-persistence](../specs/2026-06-26-ratelimit-donut-persistence-design.md), [data brief](../specs/2026-06-26-usage-redesign-data-brief.md).

**Test commands:**
- Single vitest file: `npx vitest run frontend/app/view/agents/<file>.test.ts`
- Typecheck (bare `tsc` overflows — see CLAUDE.md): `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
- Full suite: `npx vitest run`

**Verification note:** Tasks 1, 3, 4 are pure logic → unit-tested (TDD). Task 6 (the surface) is presentation with no render harness → verified by tsc + full vitest green + a CDP screenshot of the dev app (`node scripts/cdp-shot.mjs`).

---

### Task 1: Per-class spend in `usagepricing.ts`

The split's spend bar needs dollars **per token class**. Add `spendBreakdown`; refactor `spendOf` to sum it (single rate-table use).

**Files:**
- Modify: `frontend/app/view/agents/usagepricing.ts`
- Test: `frontend/app/view/agents/usagepricing.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/usagepricing.test.ts`:

```ts
import { spendBreakdown } from "./usagepricing";

describe("spendBreakdown", () => {
    const rec = (over: Partial<UsageRecord>): UsageRecord => ({
        ts: 0,
        provider: "claude",
        model: "claude-opus-4-8",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        ...over,
    });

    it("prices each class separately (opus rates, per 1M)", () => {
        const b = spendBreakdown(
            rec({ inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheCreateTokens: 1e6 })
        );
        expect(b.input).toBeCloseTo(15, 5);
        expect(b.output).toBeCloseTo(75, 5);
        expect(b.cacheRead).toBeCloseTo(1.5, 5);
        expect(b.cacheWrite).toBeCloseTo(18.75, 5); // all 5m (no 1h portion)
    });

    it("splits cache write into 1h vs 5m tiers", () => {
        const b = spendBreakdown(rec({ cacheCreateTokens: 1e6, cacheCreate1hTokens: 1e6 }));
        expect(b.cacheWrite).toBeCloseTo(30, 5); // opus cacheWrite1h
    });

    it("unknown model -> all zero", () => {
        const b = spendBreakdown(rec({ model: "mystery", inputTokens: 1e6 }));
        expect(b).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    });

    it("spendOf equals the sum of the breakdown", () => {
        const r = rec({ inputTokens: 5e5, outputTokens: 3e5, cacheReadTokens: 9e6, cacheCreateTokens: 2e5 });
        const b = spendBreakdown(r);
        expect(spendOf(r)).toBeCloseTo(b.input + b.output + b.cacheRead + b.cacheWrite, 9);
    });
});
```

(Note: `spendOf` is already imported at the top of the file if present; if not, add it to the existing import from `./usagepricing`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/usagepricing.test.ts`
Expected: FAIL — `spendBreakdown is not exported` / not a function.

- [ ] **Step 3: Implement**

In `frontend/app/view/agents/usagepricing.ts`, replace the `spendOf` function (lines ~43-61) with:

```ts
export interface SpendBreakdown {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number; // 1h + 5m cache-write tiers folded together
}

// Client-side cost estimate, broken out per token class. Cache writes split into 1h (extended) vs
// 5m (default) tiers internally; the 1h portion is a subset of cacheCreateTokens, the remainder 5m.
// Unknown models price at 0 (tokens still counted elsewhere; spend under-reports rather than guesses).
export function spendBreakdown(r: UsageRecord): SpendBreakdown {
    const p = priceFor(r.model);
    if (!p) {
        return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const cache1h = r.cacheCreate1hTokens ?? 0;
    const cache5m = Math.max(0, r.cacheCreateTokens - cache1h);
    return {
        input: (r.inputTokens * p.input) / 1_000_000,
        output: (r.outputTokens * p.output) / 1_000_000,
        cacheRead: (r.cacheReadTokens * p.cacheRead) / 1_000_000,
        cacheWrite: (cache5m * p.cacheWrite5m + cache1h * p.cacheWrite1h) / 1_000_000,
    };
}

// Total client-side cost estimate (sum of the per-class breakdown).
export function spendOf(r: UsageRecord): number {
    const b = spendBreakdown(r);
    return b.input + b.output + b.cacheRead + b.cacheWrite;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/usagepricing.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/usagepricing.ts frontend/app/view/agents/usagepricing.test.ts
git commit -m "feat(usage): per-class spend breakdown in usagepricing"
```

---

### Task 2: Add the cache-read `@theme` token

The mockup's chart colors map to existing tokens (`--color-accent` #7c95ff = claude/output, `--color-success` #54c79a = codex/input, `--color-warning` #e6b450 = cache-write). Only cache-read slate `#5b6675` is new.

**Files:**
- Modify: `frontend/tailwindsetup.css`

- [ ] **Step 1: Add the token**

In `frontend/tailwindsetup.css`, immediately after the `--color-success` line (~line 55, inside the same `@theme` block), add:

```css
    --color-cacheread: #5b6675; /* usage split: cache-read segment (low-value, high-volume) */
```

- [ ] **Step 2: Verify it typechecks / builds the utility**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (baseline has ~3 pre-existing `api.test.ts` errors only).

(The token is consumed via `var(--color-cacheread)` in Task 6 inline styles; Tailwind v4 also generates a `bg-cacheread` utility, but Task 6 uses the `var()` form for the dynamic class→color map.)

- [ ] **Step 3: Commit**

```bash
git add frontend/tailwindsetup.css
git commit -m "feat(usage): add cache-read slate theme token"
```

---

### Task 3: Extend `usagestats.ts` — split + daily + window-scoped by-model

Add the split and daily aggregations; make by-model window-scoped (not rolling-7); keep today/week totals date-filtered. Update `EMPTY` in the store and the existing empty-case test.

**Files:**
- Modify: `frontend/app/view/agents/usagestats.ts`
- Modify: `frontend/app/view/agents/usagestore.ts` (the `EMPTY` constant)
- Test: `frontend/app/view/agents/usagestats.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the whole `describe("aggregateBuckets", ...)` body in `frontend/app/view/agents/usagestats.test.ts` with (the `bkt` helper at the top of the file stays):

```ts
describe("aggregateBuckets", () => {
    const now = Date.parse("2026-06-26T12:00:00.000Z");
    const today = "2026-06-26";

    it("splits today vs rolling week (totals stay date-filtered even with older buckets)", () => {
        const stats = aggregateBuckets(
            [
                bkt({ day: today, input: 100 }),
                bkt({ day: "2026-06-22", input: 50 }), // within rolling 7
                bkt({ day: "2026-06-01", input: 999 }), // older — excluded from totals
            ],
            now
        );
        expect(stats.totals.tokensToday).toBe(100);
        expect(stats.totals.tokensWeek).toBe(150);
    });

    it("by-model pct is over the whole loaded window (includes >7d buckets), desc by tokens", () => {
        const stats = aggregateBuckets(
            [
                bkt({ model: "claude-opus-4-8", day: "2026-05-01", input: 75 }), // older than a week
                bkt({ model: "claude-sonnet-4-6", day: today, input: 25 }),
            ],
            now
        );
        const p = stats.providers[0];
        expect(p.tokens).toBe(100);
        expect(p.models[0].model).toBe("claude-opus-4-8");
        expect(p.models[0].pct).toBeCloseTo(75, 5);
        expect(p.models[1].pct).toBeCloseTo(25, 5);
    });

    it("builds an all-provider token-class split in fixed order with priced spend", () => {
        const stats = aggregateBuckets(
            [bkt({ model: "claude-opus-4-8", input: 1e6, output: 1e6, cacheread: 1e6, cachecreate: 1e6 })],
            now
        );
        expect(stats.split.map((s) => s.cls)).toEqual(["cacheRead", "output", "cacheWrite", "input"]);
        const byCls = Object.fromEntries(stats.split.map((s) => [s.cls, s]));
        expect(byCls.cacheRead.tokens).toBe(1e6);
        expect(byCls.output.spendUsd).toBeCloseTo(75, 5);
        expect(byCls.input.spendUsd).toBeCloseTo(15, 5);
    });

    it("daily zero-fills idle days in range and keys claude vs codex", () => {
        const stats = aggregateBuckets(
            [
                bkt({ provider: "claude", day: "2026-06-24", input: 10 }),
                bkt({ provider: "codex", model: "gpt-5.5", day: "2026-06-26", input: 20 }),
            ],
            now
        );
        // range 06-24..06-26 inclusive -> 3 days, the middle one idle
        expect(stats.daily.map((d) => d.day)).toEqual(["2026-06-24", "2026-06-25", "2026-06-26"]);
        expect(stats.daily[0].claudeTokens).toBe(10);
        expect(stats.daily[1].claudeTokens + stats.daily[1].codexTokens).toBe(0); // idle day
        expect(stats.daily[2].codexTokens).toBe(20);
        expect(stats.dailyTruncated).toBe(false);
    });

    it("caps the daily series to the last 30 days and flags truncation", () => {
        const stats = aggregateBuckets(
            [bkt({ day: "2026-04-01", input: 1 }), bkt({ day: today, input: 1 })], // ~86-day span
            now
        );
        expect(stats.daily.length).toBe(30);
        expect(stats.daily[stats.daily.length - 1].day).toBe(today);
        expect(stats.dailyTruncated).toBe(true);
    });

    it("returns empty shapes for no buckets", () => {
        expect(aggregateBuckets([], now)).toEqual({
            totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
            split: [
                { cls: "cacheRead", label: "Cache read", tokens: 0, spendUsd: 0 },
                { cls: "output", label: "Output", tokens: 0, spendUsd: 0 },
                { cls: "cacheWrite", label: "Cache write", tokens: 0, spendUsd: 0 },
                { cls: "input", label: "Input", tokens: 0, spendUsd: 0 },
            ],
            daily: [],
            dailyTruncated: false,
            providers: [],
        });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: FAIL — `stats.split` undefined, `stats.daily` undefined, `p.tokens` undefined, empty shape mismatch.

- [ ] **Step 3: Implement the new shapes + restructured fold**

In `frontend/app/view/agents/usagestats.ts`:

(a) Change the `spendOf` import to also pull `spendBreakdown`:

```ts
import { spendBreakdown, spendOf } from "./usagepricing";
```

(b) Replace the `ModelUsage` / `ProviderUsage` / `UsageStats` interface block (lines ~23-39) with:

```ts
export interface ModelUsage {
    model: string;
    tokens: number;
    pct: number; // share of the provider's window tokens
    spendUsd: number;
}

export interface ProviderUsage {
    provider: string;
    tokens: number; // window tokens (was tokensWeek; now window-scoped)
    models: ModelUsage[]; // desc by tokens
}

export type TokenClass = "input" | "output" | "cacheRead" | "cacheWrite";

export interface ClassUsage {
    cls: TokenClass;
    label: string;
    tokens: number;
    spendUsd: number;
}

export interface DailyUsage {
    day: string; // "YYYY-MM-DD"
    claudeTokens: number;
    codexTokens: number;
    claudeSpendUsd: number;
    codexSpendUsd: number;
}

export interface UsageStats {
    totals: { tokensToday: number; tokensWeek: number; spendTodayUsd: number; spendWeekUsd: number };
    split: ClassUsage[]; // all providers, the window, fixed order [cacheRead, output, cacheWrite, input]
    daily: DailyUsage[]; // ascending; zero-filled idle days; capped to last 30 in range
    dailyTruncated: boolean; // true when the day range exceeded the cap
    providers: ProviderUsage[]; // window-scoped by-model, claude-first
}
```

(c) Add these module constants just below `const DAY_MS = ...`:

```ts
const MAX_DAILY_DAYS = 30;
const CLASS_ORDER: TokenClass[] = ["cacheRead", "output", "cacheWrite", "input"];
const CLASS_LABEL: Record<TokenClass, string> = {
    cacheRead: "Cache read",
    output: "Output",
    cacheWrite: "Cache write",
    input: "Input",
};

// Inclusive list of local day-keys from startKey to endKey ("YYYY-MM-DD" sorts chronologically).
// Iterates via a local Date so month/DST rollovers are handled; bounded so a bad range can't spin.
function enumerateDays(startKey: string, endKey: string): string[] {
    const [y, m, d] = startKey.split("-").map(Number);
    const cur = new Date(y, m - 1, d);
    const days: string[] = [];
    for (let i = 0; i < 3650 && localDayKey(cur.getTime()) <= endKey; i++) {
        days.push(localDayKey(cur.getTime()));
        cur.setDate(cur.getDate() + 1);
    }
    return days;
}
```

(d) Replace the entire `aggregateBuckets` function (lines ~74-119) with:

```ts
// Fold backend buckets into the surface's UsageStats. today/week totals stay date-filtered
// (today = current local day; week = rolling 7); the split, daily series, and per-model breakdown
// fold the WHOLE loaded window (the window is chosen by the loader's windowdays).
export function aggregateBuckets(buckets: UsageBucket[], now: number): UsageStats {
    const today = localDayKey(now);
    const weekStart = localDayKey(now - 6 * DAY_MS);
    let tokensToday = 0;
    let tokensWeek = 0;
    let spendTodayUsd = 0;
    let spendWeekUsd = 0;

    const classTok: Record<TokenClass, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const classSpd: Record<TokenClass, number> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const byDay = new Map<string, { ct: number; xt: number; cs: number; xs: number }>();
    const byProvider = new Map<string, Map<string, { tokens: number; spend: number }>>();
    let minDay: string | null = null;
    let maxDay: string | null = null;

    for (const b of buckets) {
        const tk = bucketTokens(b);
        const sb = spendBreakdown(bucketAsRecord(b));
        const sp = sb.input + sb.output + sb.cacheRead + sb.cacheWrite;

        // token-class split (all providers, window)
        classTok.input += b.input;
        classTok.output += b.output;
        classTok.cacheRead += b.cacheread;
        classTok.cacheWrite += b.cachecreate;
        classSpd.input += sb.input;
        classSpd.output += sb.output;
        classSpd.cacheRead += sb.cacheRead;
        classSpd.cacheWrite += sb.cacheWrite;

        // daily series (window), keyed claude vs codex
        const day = byDay.get(b.day) ?? { ct: 0, xt: 0, cs: 0, xs: 0 };
        if (b.provider === "codex") {
            day.xt += tk;
            day.xs += sp;
        } else if (b.provider === "claude") {
            day.ct += tk;
            day.cs += sp;
        }
        byDay.set(b.day, day);
        if (minDay == null || b.day < minDay) minDay = b.day;
        if (maxDay == null || b.day > maxDay) maxDay = b.day;

        // by-model (window)
        let models = byProvider.get(b.provider);
        if (!models) {
            models = new Map();
            byProvider.set(b.provider, models);
        }
        const cur = models.get(b.model) ?? { tokens: 0, spend: 0 };
        cur.tokens += tk;
        cur.spend += sp;
        models.set(b.model, cur);

        // totals (date-filtered)
        if (b.day >= weekStart) {
            tokensWeek += tk;
            spendWeekUsd += sp;
        }
        if (b.day === today) {
            tokensToday += tk;
            spendTodayUsd += sp;
        }
    }

    const split: ClassUsage[] = CLASS_ORDER.map((cls) => ({
        cls,
        label: CLASS_LABEL[cls],
        tokens: classTok[cls],
        spendUsd: classSpd[cls],
    }));

    let daily: DailyUsage[] = [];
    let dailyTruncated = false;
    if (minDay != null) {
        const endKey = maxDay != null && maxDay > today ? maxDay : today;
        let dayKeys = enumerateDays(minDay, endKey);
        if (dayKeys.length > MAX_DAILY_DAYS) {
            dailyTruncated = true;
            dayKeys = dayKeys.slice(-MAX_DAILY_DAYS);
        }
        daily = dayKeys.map((day) => {
            const e = byDay.get(day) ?? { ct: 0, xt: 0, cs: 0, xs: 0 };
            return { day, claudeTokens: e.ct, codexTokens: e.xt, claudeSpendUsd: e.cs, codexSpendUsd: e.xs };
        });
    }

    const providers: ProviderUsage[] = [...byProvider.entries()]
        .map(([provider, models]) => {
            const tokens = [...models.values()].reduce((s, m) => s + m.tokens, 0);
            const modelUsages: ModelUsage[] = [...models.entries()]
                .map(([model, v]) => ({
                    model,
                    tokens: v.tokens,
                    spendUsd: v.spend,
                    pct: tokens > 0 ? (v.tokens / tokens) * 100 : 0,
                }))
                .sort((a, b) => b.tokens - a.tokens);
            return { provider, tokens, models: modelUsages };
        })
        .sort((a, b) => (PROVIDER_RANK[a.provider] ?? 99) - (PROVIDER_RANK[b.provider] ?? 99));

    return { totals: { tokensToday, tokensWeek, spendTodayUsd, spendWeekUsd }, split, daily, dailyTruncated, providers };
}
```

(e) In `frontend/app/view/agents/usagestore.ts`, update the `EMPTY` constant (lines ~17-20) so its shape matches:

```ts
const EMPTY: UsageStats = {
    totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
    split: [
        { cls: "cacheRead", label: "Cache read", tokens: 0, spendUsd: 0 },
        { cls: "output", label: "Output", tokens: 0, spendUsd: 0 },
        { cls: "cacheWrite", label: "Cache write", tokens: 0, spendUsd: 0 },
        { cls: "input", label: "Input", tokens: 0, spendUsd: 0 },
    ],
    daily: [],
    dailyTruncated: false,
    providers: [],
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors. (`usagesurface.tsx` still consumes the old shape — it gets rewritten in Task 6. If tsc flags `tokensWeek`/`models` usage there now, that is expected and resolved in Task 6; note it and continue. If you prefer a clean tsc here, do Task 6 before this commit — but the recommended order keeps them as separate commits and accepts a transient surface error until Task 6.)

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/agents/usagestats.ts frontend/app/view/agents/usagestats.test.ts frontend/app/view/agents/usagestore.ts
git commit -m "feat(usage): token-class split + daily series + window-scoped by-model aggregation"
```

---

### Task 4: New `ratelimitstore.ts` — persist + merge live limits

Per the [donut-persistence spec](../specs/2026-06-26-ratelimit-donut-persistence-design.md). One new module: a pure merge + a localStorage-backed snapshot store.

**Files:**
- Create: `frontend/app/view/agents/ratelimitstore.ts`
- Test: `frontend/app/view/agents/ratelimitstore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/view/agents/ratelimitstore.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeRateLimitWindows, readSavedRateLimits, recordRateLimit, type SavedSnapshot } from "./ratelimitstore";

function mockLocalStorage(): Record<string, string> {
    const store: Record<string, string> = {};
    (globalThis as any).localStorage = {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
            store[k] = v;
        },
        removeItem: (k: string) => {
            delete store[k];
        },
        clear: () => {
            for (const k of Object.keys(store)) delete store[k];
        },
        key: () => null,
        length: 0,
    };
    return store;
}

describe("mergeRateLimitWindows", () => {
    const now = 1_800_000_000_000; // fixed epoch ms
    const live = (provider: string, usage: AgentUsage) => ({ provider, usage });

    it("prefers live and sets no stale flag", () => {
        const out = mergeRateLimitWindows([live("claude", { fivehourpct: 62, fivehourreset: 100, weekpct: 41 })], {}, now);
        expect(out).toHaveLength(1);
        expect(out[0].fivehour).toEqual({ pct: 62, reset: 100 });
        expect(out[0].week).toEqual({ pct: 41, reset: undefined });
        expect(out[0].stale).toBeUndefined();
    });

    it("falls back to a saved snapshot and marks it stale", () => {
        const saved: Record<string, SavedSnapshot> = {
            claude: { fivehourpct: 50, fivehourreset: now / 1000 + 600, weekpct: 30, capturedAt: now - 5000 },
        };
        const out = mergeRateLimitWindows([], saved, now);
        expect(out[0].fivehour).toEqual({ pct: 50, reset: now / 1000 + 600 });
        expect(out[0].stale).toEqual({ capturedAt: now - 5000 });
    });

    it("rolls a window over to empty once its reset has passed", () => {
        const saved: Record<string, SavedSnapshot> = {
            claude: { fivehourpct: 80, fivehourreset: now / 1000 - 10, weekpct: 30, weekreset: now / 1000 + 600, capturedAt: now - 5000 },
        };
        const out = mergeRateLimitWindows([], saved, now);
        expect(out[0].fivehour).toEqual({ pct: 0, reset: undefined }); // rolled over
        expect(out[0].week).toEqual({ pct: 30, reset: now / 1000 + 600 }); // still valid
    });

    it("unions live + saved providers, claude first", () => {
        const out = mergeRateLimitWindows(
            [live("codex", { fivehourpct: 10 })],
            { claude: { fivehourpct: 5, capturedAt: now } },
            now
        );
        expect(out.map((p) => p.provider)).toEqual(["claude", "codex"]);
    });
});

describe("recordRateLimit + readSavedRateLimits round-trip", () => {
    beforeEach(() => mockLocalStorage());
    afterEach(() => {
        delete (globalThis as any).localStorage;
    });

    it("persists only window fields (+capturedAt), dropping context/cost", () => {
        recordRateLimit("claude", { fivehourpct: 62, fivehourreset: 999, weekpct: 41, contextpct: 70, costusd: 1.2 });
        const saved = readSavedRateLimits();
        expect(saved.claude.fivehourpct).toBe(62);
        expect(saved.claude.weekpct).toBe(41);
        expect(saved.claude.capturedAt).toBeGreaterThan(0);
        expect((saved.claude as any).contextpct).toBeUndefined();
        expect((saved.claude as any).costusd).toBeUndefined();
    });

    it("is a no-op for usage without window fields", () => {
        recordRateLimit("claude", { contextpct: 70, costusd: 1.2 });
        expect(readSavedRateLimits()).toEqual({});
    });

    it("corrupt localStorage reads back as empty", () => {
        (globalThis as any).localStorage.setItem("wave:ratelimits", "{not json");
        expect(readSavedRateLimits()).toEqual({});
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run frontend/app/view/agents/ratelimitstore.test.ts`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Implement**

Create `frontend/app/view/agents/ratelimitstore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Persists the last-known account-level rate-limit windows (5-hour + weekly) per provider so the
// Usage surface donuts survive when no agent is running. Live AgentUsage only exists while a Claude
// agent is active; this saves a snapshot whenever one reports, seeds from localStorage at load, and
// merges live-over-saved (with per-window rollover) for the surface. Pure-FE — no Go, no RPC.
// See docs/superpowers/specs/2026-06-26-ratelimit-donut-persistence-design.md.

import { atom, type PrimitiveAtom } from "jotai";
import { globalStore } from "@/app/store/jotaiStore";

const STORAGE_KEY = "wave:ratelimits";
const PROVIDER_RANK: Record<string, number> = { claude: 0, codex: 1 };

export interface SavedSnapshot {
    fivehourpct?: number;
    fivehourreset?: number; // absolute epoch seconds (matches AgentUsage)
    weekpct?: number;
    weekreset?: number;
    capturedAt: number; // epoch ms at record time
}

export interface DonutWindow {
    pct?: number;
    reset?: number;
}

export interface ProviderDonuts {
    provider: string;
    fivehour: DonutWindow;
    week: DonutWindow;
    stale?: { capturedAt: number }; // present iff sourced from a saved (not-live) snapshot
}

// Best-effort read; any failure (no localStorage, parse error) -> {}.
export function readSavedRateLimits(): Record<string, SavedSnapshot> {
    try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, SavedSnapshot>) : {};
    } catch {
        return {};
    }
}

// Seeded from localStorage at module load so donuts render on a fresh launch with no agent.
export const savedRateLimitsAtom = atom<Record<string, SavedSnapshot>>(
    readSavedRateLimits()
) as PrimitiveAtom<Record<string, SavedSnapshot>>;

// Save a snapshot for `provider` — only when the usage carries a 5h or weekly window field.
// Window fields + capturedAt only; context/cost are per-session and deliberately dropped.
export function recordRateLimit(provider: string, usage: AgentUsage): void {
    if (usage == null || (usage.fivehourpct == null && usage.weekpct == null)) {
        return;
    }
    const snapshot: SavedSnapshot = {
        fivehourpct: usage.fivehourpct,
        fivehourreset: usage.fivehourreset,
        weekpct: usage.weekpct,
        weekreset: usage.weekreset,
        capturedAt: Date.now(),
    };
    const next = { ...globalStore.get(savedRateLimitsAtom), [provider]: snapshot };
    globalStore.set(savedRateLimitsAtom, next);
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        // quota/disabled — the in-memory atom still serves this session
    }
}

function windowFromSaved(pct: number | undefined, reset: number | undefined, now: number): DonutWindow {
    if (reset != null && reset * 1000 <= now) {
        return { pct: 0, reset: undefined }; // rolled over; the new cadence is unknowable
    }
    return { pct, reset };
}

// Live wins (no stale); else build from the saved snapshot with per-window rollover. Union of live
// + saved provider keys, claude-first.
export function mergeRateLimitWindows(
    live: { provider: string; usage: AgentUsage }[],
    saved: Record<string, SavedSnapshot>,
    now: number
): ProviderDonuts[] {
    const liveMap = new Map(live.map((l) => [l.provider, l.usage]));
    const providers = [...new Set([...liveMap.keys(), ...Object.keys(saved)])];
    return providers
        .map((provider) => {
            const u = liveMap.get(provider);
            if (u != null) {
                return {
                    provider,
                    fivehour: { pct: u.fivehourpct, reset: u.fivehourreset },
                    week: { pct: u.weekpct, reset: u.weekreset },
                };
            }
            const s = saved[provider];
            return {
                provider,
                fivehour: windowFromSaved(s.fivehourpct, s.fivehourreset, now),
                week: windowFromSaved(s.weekpct, s.weekreset, now),
                stale: { capturedAt: s.capturedAt },
            };
        })
        .sort((a, b) => (PROVIDER_RANK[a.provider] ?? 99) - (PROVIDER_RANK[b.provider] ?? 99));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run frontend/app/view/agents/ratelimitstore.test.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/ratelimitstore.ts frontend/app/view/agents/ratelimitstore.test.ts
git commit -m "feat(usage): rate-limit snapshot store (persist + live-over-saved merge)"
```

---

### Task 5: Capture wiring in `agentstatusstore.ts`

One call at the existing usage-set point so every live reading is persisted.

**Files:**
- Modify: `frontend/app/view/agents/session-models/agentstatusstore.ts:118-120`

- [ ] **Step 1: Add the import**

At the top of `frontend/app/view/agents/session-models/agentstatusstore.ts`, after the existing `./sessionviewmodel` import (line ~7), add:

```ts
import { recordRateLimit } from "../ratelimitstore";
```

- [ ] **Step 2: Add the capture call**

Replace the usage block (lines ~118-120):

```ts
            if (data.usage != null) {
                globalStore.set(getAgentUsageAtom(data.oref), data.usage);
            }
```

with:

```ts
            if (data.usage != null) {
                globalStore.set(getAgentUsageAtom(data.oref), data.usage);
                // persist account-level windows so the Usage donuts survive idle (no-op if none present)
                const provider = data.agent ?? globalStore.get(getAgentStatusAtom(data.oref))?.agent ?? "claude";
                recordRateLimit(provider, data.usage);
            }
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors from this file.

- [ ] **Step 4: Verify the existing suite still passes**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (no regressions; `recordRateLimit` self-guards on window fields).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/session-models/agentstatusstore.ts
git commit -m "feat(usage): capture live rate-limit windows into the snapshot store"
```

---

### Task 6: Rewrite `usagesurface.tsx` to the new layout

Two trust zones: live-limits donut cards (merged live/stale) then the historical block (totals, token-class split, daily chart, by-model), with a window toggle. No render-test harness → verify via tsc + full vitest + CDP screenshot.

**Files:**
- Modify (full replace): `frontend/app/view/agents/usagesurface.tsx`

- [ ] **Step 1: Replace the whole file**

Replace the entire contents of `frontend/app/view/agents/usagesurface.tsx` with:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface (handoff redesign: Wave-cockpit-live.dc.html isUsage block). Two trust zones:
// LIVE LIMITS — ephemeral 5h/weekly quota donuts, merged live-over-saved (ratelimitstore) so they
// survive idle; and HISTORICAL — durable token-class split, daily series, and per-model breakdown
// folded from the backend usage scan (usagestore/usagestats), scoped by a 7-day / All-time toggle.
// Loads on mount + a 60s refresh for the current window; a 1s tick keeps reset countdowns current.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { formatReset, groupAgents, providerPlanUsage, usageLevel } from "./agentsviewmodel";
import { mergeRateLimitWindows, savedRateLimitsAtom, type ProviderDonuts } from "./ratelimitstore";
import type { ClassUsage, DailyUsage, ProviderUsage, TokenClass, UsageStats } from "./usagestats";
import { loadUsage, usageErrorAtom, usageStatsAtom } from "./usagestore";

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };
const RING: Record<"ok" | "warn" | "hot", string> = {
    ok: "var(--color-success)",
    warn: "var(--color-warning)",
    hot: "var(--color-error)",
};
const CLASS_COLOR: Record<TokenClass, string> = {
    cacheRead: "var(--color-cacheread)",
    output: "var(--color-accent)",
    cacheWrite: "var(--color-warning)",
    input: "var(--color-success)",
};
const MODEL_COLORS = [
    "var(--color-accent)",
    "var(--color-success)",
    "var(--color-warning)",
    "var(--color-accent-300)",
    "var(--color-muted-foreground)",
];
const DAILY_CHART_H = 156;

// Denser than viewmodel.formatTokens (adds B, rounds large M) to match the redesign's compact cards.
function fmt(n: number): string {
    if (n >= 1e9) return +(n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return +(n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(Math.round(n));
}
function usd(n: number): string {
    if (n >= 1000) return "$" + +(n / 1000).toFixed(1) + "K";
    if (n >= 100) return "$" + Math.round(n);
    return "$" + n.toFixed(2);
}
function pctStr(n: number): string {
    if (n >= 10) return Math.round(n) + "%";
    if (n < 0.1) return n <= 0 ? "0%" : "<0.1%";
    return +n.toFixed(1) + "%";
}
function ageStr(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
}

function Segmented<T extends string>({
    value,
    options,
    onChange,
}: {
    value: T;
    options: { key: T; label: string }[];
    onChange: (v: T) => void;
}) {
    return (
        <div className="flex flex-none rounded-[8px] border border-border bg-surface-raised p-[3px]">
            {options.map((o) => (
                <button
                    key={o.key}
                    onClick={() => onChange(o.key)}
                    className={cn(
                        "cursor-pointer rounded-[6px] border-0 px-[12px] py-[5px] font-mono text-[11px] font-semibold",
                        value === o.key ? "bg-accentbg text-primary" : "bg-transparent text-muted"
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="rounded-[12px] border border-border bg-surface-raised px-[17px] py-[15px]">
            <div className="mb-[9px] font-mono text-[11px] font-medium text-muted">{label}</div>
            <div className="mb-[6px] font-mono text-[23px] font-bold text-primary">{value}</div>
            {sub ? <div className="font-mono text-[10px] text-muted">{sub}</div> : null}
        </div>
    );
}

function MiniDonut({ title, pct, reset, now }: { title: string; pct?: number; reset?: number; now: number }) {
    const has = pct != null;
    const ring = has
        ? `conic-gradient(${RING[usageLevel(pct)]} 0 ${Math.min(100, pct)}%, var(--color-edge-strong) 0)`
        : "conic-gradient(var(--color-edge-strong) 0 100%)";
    return (
        <div className="flex items-center gap-[7px]">
            <div className="flex h-[40px] w-[40px] flex-none items-center justify-center rounded-full" style={{ background: ring }}>
                <div className="flex h-[29px] w-[29px] items-center justify-center rounded-full bg-background">
                    <span className="font-mono text-[10px] font-bold text-primary">{has ? Math.round(pct) + "%" : "—"}</span>
                </div>
            </div>
            <div>
                <div className="font-mono text-[10px] font-semibold text-secondary">{title}</div>
                <div className="whitespace-nowrap font-mono text-[9px] text-muted">
                    {reset ? "resets " + formatReset(reset, now) : has ? "live" : "no data"}
                </div>
            </div>
        </div>
    );
}

function LiveLimitCard({ d, now }: { d: ProviderDonuts; now: number }) {
    const stale = d.stale != null;
    const dot = stale ? "var(--color-warning)" : "var(--color-success)";
    const label = stale ? "as of " + ageStr(now - d.stale!.capturedAt) + " ago" : "Live";
    const border = stale
        ? "color-mix(in srgb, var(--color-warning) 22%, transparent)"
        : "color-mix(in srgb, var(--color-success) 22%, transparent)";
    return (
        <div className="flex items-center gap-[11px] rounded-[11px] border bg-surface-raised px-[14px] py-[12px]" style={{ borderColor: border }}>
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
                <MiniDonut title="Weekly" pct={d.week.pct} reset={d.week.reset} now={now} />
            </div>
        </div>
    );
}

function SplitBar({ items, totalOf }: { items: ClassUsage[]; totalOf: (c: ClassUsage) => number }) {
    const total = items.reduce((s, c) => s + totalOf(c), 0) || 1;
    return (
        <div className="mb-[18px] flex h-[30px] overflow-hidden rounded-[7px] bg-background">
            {items.map((c) => (
                <div key={c.cls} style={{ width: `${(totalOf(c) / total) * 100}%`, background: CLASS_COLOR[c.cls] }} />
            ))}
        </div>
    );
}

function SplitCard({ split }: { split: ClassUsage[] }) {
    const tokTotal = split.reduce((s, c) => s + c.tokens, 0);
    const spdTotal = split.reduce((s, c) => s + c.spendUsd, 0);
    const cacheRead = split.find((c) => c.cls === "cacheRead");
    const cachePct = tokTotal > 0 && cacheRead ? (cacheRead.tokens / tokTotal) * 100 : 0;
    return (
        <div className="mb-4 rounded-[14px] border border-border bg-surface-raised px-[22px] py-[20px]">
            <div className="mb-1 flex items-baseline gap-[10px]">
                <h3 className="text-[15px] font-bold tracking-[-0.01em] text-primary">Where it goes</h3>
                <span className="font-mono text-[11px] text-muted">all providers</span>
            </div>
            <p className="mb-5 max-w-[680px] text-[12.5px] leading-[1.5] text-secondary">
                {pctStr(cachePct)} of the token count is cache reads — so a single “tokens” number misleads. Cache reads
                price at a fraction of input, so the two bars tell different stories.
            </p>

            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="font-mono text-[11px] font-semibold text-secondary">Tokens</span>
                <span className="font-mono text-[13px] font-bold text-primary">{fmt(tokTotal)}</span>
            </div>
            <SplitBar items={split} totalOf={(c) => c.tokens} />

            <div className="mb-[7px] flex items-baseline justify-between">
                <span className="font-mono text-[11px] font-semibold text-secondary">
                    Spend <span className="font-medium text-muted">≈ API-equiv</span>
                </span>
                <span className="font-mono text-[13px] font-bold text-primary">{usd(spdTotal)}</span>
            </div>
            <SplitBar items={split} totalOf={(c) => c.spendUsd} />

            <div className="grid grid-cols-2 gap-x-[12px] gap-y-[14px] border-t border-border pt-4 sm:grid-cols-4">
                {split.map((c) => (
                    <div key={c.cls}>
                        <div className="mb-2 flex items-center gap-[7px]">
                            <span className="h-[10px] w-[10px] flex-none rounded-[3px]" style={{ background: CLASS_COLOR[c.cls] }} />
                            <span className="text-[11.5px] font-semibold text-secondary">{c.label}</span>
                        </div>
                        <div className="mb-[3px] flex justify-between font-mono text-[10.5px] text-muted">
                            <span>tokens</span>
                            <span className="text-secondary">
                                {fmt(c.tokens)} · {pctStr(tokTotal > 0 ? (c.tokens / tokTotal) * 100 : 0)}
                            </span>
                        </div>
                        <div className="flex justify-between font-mono text-[10.5px] text-muted">
                            <span>spend</span>
                            <span className="text-secondary">
                                {usd(c.spendUsd)} · {pctStr(spdTotal > 0 ? (c.spendUsd / spdTotal) * 100 : 0)}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function DailyChart({
    daily,
    truncated,
    window,
    metric,
    onMetric,
}: {
    daily: DailyUsage[];
    truncated: boolean;
    window: "7d" | "all";
    metric: "tokens" | "spend";
    onMetric: (m: "tokens" | "spend") => void;
}) {
    const rows = daily.map((d) => {
        const a = metric === "tokens" ? d.claudeTokens : d.claudeSpendUsd;
        const b = metric === "tokens" ? d.codexTokens : d.codexSpendUsd;
        return { day: d.day.slice(5), a, b, total: a + b };
    });
    const dmax = Math.max(1, ...rows.map((r) => r.total));
    const axis = (v: number) => (metric === "tokens" ? fmt(v) : usd(v));
    const label = window === "7d" ? "last 7 days" : truncated ? "last 30 days" : "all time";
    return (
        <div className="mb-4 rounded-[14px] border border-border bg-surface-raised px-[22px] pb-5 pt-[18px]">
            <div className="mb-5 flex flex-wrap items-center gap-3">
                <h3 className="text-[15px] font-bold tracking-[-0.01em] text-primary">Daily</h3>
                <span className="font-mono text-[11px] text-muted">{label}</span>
                <div className="flex-1" />
                <div className="flex items-center gap-[14px]">
                    <span className="flex items-center gap-[5px] font-mono text-[10.5px] text-secondary">
                        <span className="h-[9px] w-[9px] rounded-[2px] bg-accent" />
                        claude
                    </span>
                    <span className="flex items-center gap-[5px] font-mono text-[10.5px] text-secondary">
                        <span className="h-[9px] w-[9px] rounded-[2px] bg-success" />
                        codex
                    </span>
                </div>
                <Segmented
                    value={metric}
                    onChange={onMetric}
                    options={[
                        { key: "tokens", label: "Tokens" },
                        { key: "spend", label: "Spend" },
                    ]}
                />
            </div>
            {rows.length === 0 ? (
                <div className="py-8 text-center font-mono text-[12px] text-muted">No activity in range.</div>
            ) : (
                <div className="flex gap-2">
                    <div className="flex h-[156px] w-[42px] flex-none flex-col items-end justify-between pb-5">
                        <span className="font-mono text-[9.5px] text-muted">{axis(dmax)}</span>
                        <span className="font-mono text-[9.5px] text-muted">{axis(dmax / 2)}</span>
                        <span className="font-mono text-[9.5px] text-muted">0</span>
                    </div>
                    <div className="flex flex-1 items-end gap-[7px] border-b border-l border-border px-1">
                        {rows.map((r) => {
                            const aH = Math.round((r.a / dmax) * DAILY_CHART_H);
                            const bH = Math.round((r.b / dmax) * DAILY_CHART_H);
                            const idle = r.total === 0;
                            const tip = `${r.day} · ${metric === "tokens" ? fmt(r.total) + " tok" : usd(r.total) + " ≈"}`;
                            return (
                                <div key={r.day} title={tip} className="flex flex-1 cursor-default flex-col items-center gap-[7px]">
                                    <div className="flex h-[156px] w-full flex-col items-center justify-end gap-[2px]">
                                        {r.b > 0 ? <div className="w-[64%] max-w-[30px] rounded-t-[3px] bg-success" style={{ height: bH }} /> : null}
                                        <div
                                            className={cn("w-[64%] max-w-[30px] bg-accent", r.b > 0 ? "" : "rounded-t-[3px]")}
                                            style={{ height: aH }}
                                        />
                                        {idle ? <div className="h-[2px] w-[64%] max-w-[30px] rounded-[2px] bg-edge-strong" /> : null}
                                    </div>
                                    <span className="font-mono text-[9.5px] text-muted">{r.day}</span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

function ModelGroup({ p }: { p: ProviderUsage }) {
    return (
        <div className="rounded-[14px] border border-border bg-surface-raised px-[20px] py-[18px]">
            <div className="mb-4 flex items-baseline justify-between">
                <div className="flex items-center gap-[9px]">
                    <h3 className="text-[14px] font-bold tracking-[-0.01em] text-primary">{PROVIDER_LABEL[p.provider] ?? p.provider}</h3>
                    <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted">by model</span>
                </div>
                <span className="font-mono text-[12px] font-bold text-secondary">{fmt(p.tokens)}</span>
            </div>
            {p.models.map((m, i) => (
                <div key={m.model} className="mb-[13px]">
                    <div className="mb-[6px] flex items-baseline justify-between">
                        <span className="font-mono text-[12px] text-secondary">{m.model}</span>
                        <span className="font-mono text-[11px] text-muted">
                            {fmt(m.tokens)} · <span className="font-semibold text-secondary">{pctStr(m.pct)}</span>
                        </span>
                    </div>
                    <div className="h-[7px] overflow-hidden rounded-[4px] bg-edge-strong">
                        <div className="h-full rounded-[4px]" style={{ width: `${m.pct}%`, background: MODEL_COLORS[i % MODEL_COLORS.length] }} />
                    </div>
                </div>
            ))}
        </div>
    );
}

export function UsageSurface({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const stats: UsageStats = useAtomValue(usageStatsAtom);
    const loadError = useAtomValue(usageErrorAtom);
    const saved = useAtomValue(savedRateLimitsAtom);
    const now = useAtomValue(model.nowAtom);
    const [usageWindow, setUsageWindow] = useState<"7d" | "all">("7d");
    const [usageMetric, setUsageMetric] = useState<"tokens" | "spend">("tokens");
    const { asking, working, idle } = groupAgents(agents);

    useEffect(() => {
        const days = usageWindow === "7d" ? 7 : 0;
        void loadUsage(days);
        const refresh = setInterval(() => void loadUsage(days), 60_000);
        return () => clearInterval(refresh);
    }, [usageWindow]);

    useEffect(() => {
        const tick = setInterval(() => globalStore.set(model.nowAtom, Date.now()), 1000);
        return () => clearInterval(tick);
    }, [model]);

    const donuts = mergeRateLimitWindows(providerPlanUsage([...asking, ...working, ...idle]), saved, now);
    const tokTotal = stats.split.reduce((s, c) => s + c.tokens, 0);
    const cacheRead = stats.split.find((c) => c.cls === "cacheRead");
    const cachePctSub =
        tokTotal > 0 && cacheRead ? `${pctStr((cacheRead.tokens / tokTotal) * 100)} are cache reads` : "API-equivalent";
    const claudeToday = stats.daily.length ? stats.daily[stats.daily.length - 1].claudeTokens : 0;
    const codexToday = stats.daily.length ? stats.daily[stats.daily.length - 1].codexTokens : 0;
    const hasHistory = stats.providers.length > 0 || stats.totals.tokensWeek > 0;

    return (
        <div className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto max-w-[1060px] px-[30px] pb-[90px] pt-[28px]">
                <div className="mb-[22px] flex items-end gap-[18px]">
                    <div className="min-w-0 flex-1">
                        <h1 className="mb-[5px] text-[25px] font-bold tracking-[-0.02em] text-primary">Usage</h1>
                        <p className="max-w-[640px] text-[13.5px] leading-[1.5] text-secondary">
                            Durable history from transcripts, plus live quota while agents run. Spend is an{" "}
                            <span className="text-muted-foreground">≈ API-equivalent</span> estimate from a bundled price
                            table — never a bill.
                        </p>
                        {loadError ? (
                            <p className="mt-1 text-[12px] text-warning">Couldn’t refresh — showing the last loaded usage.</p>
                        ) : null}
                    </div>
                    <Segmented
                        value={usageWindow}
                        onChange={setUsageWindow}
                        options={[
                            { key: "7d", label: "7 days" },
                            { key: "all", label: "All time" },
                        ]}
                    />
                </div>

                {/* LIVE LIMITS */}
                <div className="mb-[10px] rounded-[14px] border border-border bg-background px-[18px] py-[15px]">
                    <div className="mb-[14px] flex flex-wrap items-center gap-[11px]">
                        <span className="flex items-center gap-2">
                            <span className="h-[8px] w-[8px] flex-none animate-pulse rounded-full bg-success" />
                            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-secondary">
                                Live limits
                            </span>
                        </span>
                        <span className="font-mono text-[10.5px] text-muted">ephemeral · known only while a Claude agent runs</span>
                        <div className="flex-1" />
                        <div className="flex items-center gap-[13px] font-mono text-[10px] text-secondary">
                            <span className="flex items-center gap-[5px]">
                                <span className="h-[7px] w-[7px] rounded-full bg-success" />
                                live
                            </span>
                            <span className="flex items-center gap-[5px]">
                                <span className="h-[7px] w-[7px] rounded-full bg-warning opacity-[0.65]" />
                                as of …
                            </span>
                        </div>
                    </div>
                    {donuts.length === 0 ? (
                        <div className="py-3 text-center font-mono text-[11px] text-muted">
                            No quota readings yet — start a Claude agent.
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {donuts.map((d) => (
                                <LiveLimitCard key={d.provider} d={d} now={now} />
                            ))}
                        </div>
                    )}
                </div>
                <p className="mb-8 ml-[2px] font-mono text-[10.5px] leading-[1.5] text-muted">
                    Each donut keeps its last snapshot per provider — countdowns stay correct off absolute reset times,
                    rolling to empty once a window passes. Codex quota isn’t wired through the live roster yet.
                </p>

                {/* HISTORICAL */}
                <div className="mb-4 flex items-center gap-[11px]">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">Historical</span>
                    <span className="font-mono text-[10.5px] text-muted">durable · every transcript in window</span>
                    <div className="h-px flex-1 bg-border" />
                </div>

                {!hasHistory ? (
                    <div className="mt-10 text-center text-[13px] text-muted">No usage yet — start an agent.</div>
                ) : (
                    <>
                        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                            <StatCard
                                label="Tokens · today"
                                value={fmt(claudeToday + codexToday)}
                                sub={`claude ${fmt(claudeToday)} · codex ${fmt(codexToday)}`}
                            />
                            <StatCard label="Spend · today" value={`≈ ${usd(stats.totals.spendTodayUsd)}`} sub="API-equivalent" />
                            <StatCard label="Tokens · 7 days" value={fmt(stats.totals.tokensWeek)} sub={cachePctSub} />
                            <StatCard label="Spend · 7 days" value={`≈ ${usd(stats.totals.spendWeekUsd)}`} sub="API-equivalent" />
                        </div>

                        <SplitCard split={stats.split} />

                        <DailyChart
                            daily={stats.daily}
                            truncated={stats.dailyTruncated}
                            window={usageWindow}
                            metric={usageMetric}
                            onMetric={setUsageMetric}
                        />

                        <div className="grid grid-cols-1 gap-[14px] lg:grid-cols-2">
                            {stats.providers.map((p) => (
                                <ModelGroup key={p.provider} p={p} />
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors beyond the ~3 pre-existing `api.test.ts` baseline. (Resolves any transient Task-3 surface errors.)

- [ ] **Step 3: Full unit suite**

Run: `npx vitest run`
Expected: PASS — all suites green (the new pricing/stats/ratelimit tests plus the existing baseline).

- [ ] **Step 4: Visual verification (CDP)**

With the dev app running (`task dev`), capture the Usage tab:

Run: `node scripts/cdp-shot.mjs scratchpad/usage-redesign.png`
Then open the PNG and confirm against the mockup: header + window toggle; LIVE LIMITS block with donut card(s) + legend; Historical header; 4 stat cards; "Where it goes" two split bars + 4-col legend; Daily chart with Tokens/Spend toggle and y-axis; by-model 2-col grid. Toggle 7 days/All time and Tokens/Spend and confirm the historical section + daily bars re-scope.

(If no agent has ever reported, the LIVE LIMITS block shows the empty hint — inject a live agent first per `scripts/inject-live-agents.mjs` if you want to see populated donuts, or rely on a real saved snapshot.)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/agents/usagesurface.tsx
git commit -m "feat(usage): rewrite Usage surface to the redesigned two-zone layout"
```

---

### Task 7: Final verification + spec/plan fold-in

**Files:**
- (docs already on disk; this folds them into the feature history per the git workflow)

- [ ] **Step 1: Confirm the whole suite + typecheck are green**

Run: `npx vitest run && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: vitest all-pass; tsc no new errors.

- [ ] **Step 2: Stage the specs + plan with the final commit**

The spec and plan docs fold into the feature work (no separate docs-only commit, per CLAUDE.md). They were created during planning; stage them now:

```bash
git add docs/superpowers/specs/2026-06-26-usage-historical-redesign-design.md \
        docs/superpowers/specs/2026-06-26-ratelimit-donut-persistence-design.md \
        docs/superpowers/specs/2026-06-26-usage-redesign-data-brief.md \
        docs/superpowers/plans/2026-06-26-usage-tab-redesign.md
git commit -m "docs(usage): Usage tab redesign spec + plan"
```

(If the user prefers a single squashed feature commit, squash Tasks 1–7 at the end instead — confirm before rewriting history.)

---

## Self-Review

**Spec coverage:**
- §3.1 per-class spend → Task 1. ✓
- §3.2 split/daily/window by-model + restructured fold + `EMPTY` → Task 3. ✓
- §2.2 window re-scopes whole historical section (reload 7/0); totals fixed → Task 6 (`useEffect` keyed on `usageWindow`) + Task 3 (totals date-filtered independent of window). ✓
- §2.3 all-provider split, computed cache-read % → Task 3 (`split` all-provider) + Task 6 (`SplitCard` computes `cachePct`). ✓
- §2.5 30-day daily cap + label → Task 3 (`MAX_DAILY_DAYS`, `dailyTruncated`) + Task 6 (label). ✓
- §2.6 / §6 chart `@theme` tokens → Task 2 (cache-read) + Task 6 (others alias accent/success/warning). ✓
- §4 live-limits persistence (ratelimitstore, capture, consume) → Tasks 4, 5, 6. ✓
- §5 surface layout (7 regions) → Task 6. ✓
- §7 error handling (best-effort localStorage, last-good stats) → Task 4 (try/catch) + unchanged store. ✓
- §8 testing → Tasks 1, 3, 4 tests; surface CDP in Task 6. ✓
- §9 non-goals (no Codex fake card) → Task 6 renders only merged providers; no fabricated idle card. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; test bodies are concrete with explicit assertions.

**Type consistency:** `SpendBreakdown`/`spendBreakdown` (Task 1) used in Task 3's fold. `ClassUsage`/`DailyUsage`/`ProviderUsage`/`UsageStats`/`TokenClass` (Task 3) imported and consumed in Task 6. `SavedSnapshot`/`ProviderDonuts`/`DonutWindow`/`mergeRateLimitWindows`/`recordRateLimit`/`readSavedRateLimits`/`savedRateLimitsAtom` (Task 4) consumed in Tasks 5–6. `split` fixed order `[cacheRead, output, cacheWrite, input]` consistent across Task 3 impl, Task 3 empty-test, and `usagestore` `EMPTY`. `ProviderUsage.tokens` (renamed from `tokensWeek`) used in Task 6 `ModelGroup`. ✓

**Deviation from mockup (intentional):** the mockup's fixed "OpenAI · Codex / No active session" idle card is **not** rendered — the surface shows only providers with real live or saved data (per spec §9, avoids a fabricated placeholder). The caption already explains Codex isn't wired.
