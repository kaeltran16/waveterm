# Usage Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the cockpit's Usage NavRail surface — real account/provider usage for the external Claude Code agents (rate-limit windows + token/spend/per-model breakdown).

**Architecture:** Pure frontend, zero new Go. Two data paths composed in one surface: (1) **live** rate-limit windows from the existing `AgentUsage` atoms via `providerPlanUsage`; (2) **historical** tokens/spend by reusing the Activity surface's transcript discovery (`discoverSessions`) + read (`GetAgentTranscriptCommand`), parsed and aggregated in new pure TS. Reuses existing usage helpers so it stays consistent with the side-panel summary.

**Tech Stack:** React 19 + jotai + Tailwind 4 (`@theme` tokens), vitest. Spec: `docs/superpowers/specs/2026-06-26-usage-surface-design.md`.

> **Git workflow (overrides the skill's per-task commit default, per the user's CLAUDE.md):** Do NOT commit per task. Implement all tasks, then make ONE approval-gated commit at the end (Task 10). The spec + this plan fold into that feature commit.

---

## File Structure

**New (frontend, all under `frontend/app/view/agents/`)**
- `usagestats.ts` — pure: types, pricing/spend (`spendOf`, `tokensOf`), `extractUsage`, `aggregateUsage`.
- `usagestats.test.ts` — unit tests for the pure module.
- `usagestore.ts` — impure loader `loadUsage()` + `usageStatsAtom` (mirrors `activitystore.ts`).
- `usagesurface.tsx` — the surface component.

**Modified**
- `cockpitshell.tsx` — add the `surface === "usage"` render branch.
- `placeholdersurface.tsx` — drop `usage` from `TITLES`.
- `docs/deferred.md` — record deferred items.

---

### Task 1: Pure usage types + pricing/spend

**Files:**
- Create: `frontend/app/view/agents/usagestats.ts`
- Test: `frontend/app/view/agents/usagestats.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/view/agents/usagestats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { spendOf, tokensOf, type UsageRecord } from "./usagestats";

function rec(over: Partial<UsageRecord>): UsageRecord {
    return {
        ts: 0,
        provider: "claude",
        model: "claude-opus-4-20250514",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        ...over,
    };
}

describe("tokensOf", () => {
    it("sums all four token classes", () => {
        expect(
            tokensOf(rec({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreateTokens: 200 }))
        ).toBe(1350);
    });
});

describe("spendOf", () => {
    it("prices opus tokens by class", () => {
        const s = spendOf(rec({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreateTokens: 200 }));
        // 100*15 + 50*75 + 1000*1.5 + 200*18.75 = 10500 (per 1e6) = 0.0105
        expect(s).toBeCloseTo(0.0105, 6);
    });
    it("returns 0 for unknown models (tokens still counted elsewhere)", () => {
        expect(spendOf(rec({ model: "gpt-5", inputTokens: 1000 }))).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: FAIL — `Failed to resolve import "./usagestats"` / `spendOf is not defined`.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/app/view/agents/usagestats.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure usage aggregation for the Usage surface. Parses per-message token usage out of agent
// transcript JSONL (extractUsage) and folds it into today/week + per-provider per-model totals
// (aggregateUsage). Spend is a client-side estimate from a static pricing table. No React, no
// Wave runtime imports — unit-tested in isolation.

export const USAGE_WINDOW_DAYS = 7;

export interface UsageRecord {
    ts: number; // epoch ms
    provider: string; // "claude" | "codex"
    model: string; // raw model id
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
}

export interface ModelUsage {
    model: string;
    tokens: number;
    pct: number; // share of the provider's week tokens
    spendUsd: number;
}

export interface ProviderUsage {
    provider: string;
    tokensWeek: number;
    models: ModelUsage[]; // desc by tokens
}

export interface UsageStats {
    totals: { tokensToday: number; tokensWeek: number; spendTodayUsd: number; spendWeekUsd: number };
    providers: ProviderUsage[]; // claude-first
}

// $ per million tokens. Client-side ESTIMATE (like Claude Code's own cost figure); refresh as plans
// change. Unknown models price at 0 (tokens still counted; spend under-reports rather than guesses).
interface ModelPrice {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}
const PRICING: Record<string, ModelPrice> = {
    opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1.0 },
};

function priceFor(model: string): ModelPrice | undefined {
    const m = model.toLowerCase();
    if (m.includes("opus")) return PRICING.opus;
    if (m.includes("sonnet")) return PRICING.sonnet;
    if (m.includes("haiku")) return PRICING.haiku;
    return undefined;
}

export function tokensOf(r: UsageRecord): number {
    return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreateTokens;
}

export function spendOf(r: UsageRecord): number {
    const p = priceFor(r.model);
    if (!p) {
        return 0;
    }
    return (
        (r.inputTokens * p.input +
            r.outputTokens * p.output +
            r.cacheReadTokens * p.cacheRead +
            r.cacheCreateTokens * p.cacheWrite) /
        1_000_000
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: PASS (3 tests).

---

### Task 2: `extractUsage` — parse transcript lines

**Files:**
- Modify: `frontend/app/view/agents/usagestats.ts`
- Test: `frontend/app/view/agents/usagestats.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/usagestats.test.ts`:

```ts
import { extractUsage } from "./usagestats";

const ASSISTANT_LINE = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-26T10:00:00.000Z",
    message: {
        model: "claude-opus-4-20250514",
        usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 200,
        },
    },
});

describe("extractUsage", () => {
    it("parses an assistant line into a record", () => {
        const [r] = extractUsage([ASSISTANT_LINE], "claude");
        expect(r).toMatchObject({
            provider: "claude",
            model: "claude-opus-4-20250514",
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 1000,
            cacheCreateTokens: 200,
        });
        expect(r.ts).toBe(Date.parse("2026-06-26T10:00:00.000Z"));
    });
    it("skips non-assistant lines", () => {
        expect(extractUsage([JSON.stringify({ type: "user", message: {} })], "claude")).toEqual([]);
    });
    it("skips malformed JSON", () => {
        expect(extractUsage(["{not json"], "claude")).toEqual([]);
    });
    it("skips assistant lines missing usage/model/timestamp", () => {
        expect(
            extractUsage([JSON.stringify({ type: "assistant", message: { model: "claude-opus-4" } })], "claude")
        ).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: FAIL — `extractUsage is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/app/view/agents/usagestats.ts`:

```ts
// Parse per-message token usage from raw transcript JSONL lines. Claude Code writes one assistant
// entry per turn with message.model + message.usage. Codex uses a different shape (no type:"assistant"
// with usage), so codex lines yield nothing here — deferred (see docs/deferred.md). Tolerant of
// malformed lines and missing fields, like the Activity event projector.
export function extractUsage(lines: string[], provider: string): UsageRecord[] {
    const out: UsageRecord[] = [];
    for (const line of lines) {
        let rec: any;
        try {
            rec = JSON.parse(line);
        } catch {
            continue;
        }
        if (rec?.type !== "assistant") {
            continue;
        }
        const msg = rec.message;
        const usage = msg?.usage;
        const model = msg?.model;
        const ts = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : NaN;
        if (!usage || typeof model !== "string" || Number.isNaN(ts)) {
            continue;
        }
        out.push({
            ts,
            provider,
            model,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreateTokens: usage.cache_creation_input_tokens ?? 0,
        });
    }
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: PASS (7 tests total).

---

### Task 3: `aggregateUsage` — fold records into UsageStats

**Files:**
- Modify: `frontend/app/view/agents/usagestats.ts`
- Test: `frontend/app/view/agents/usagestats.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontend/app/view/agents/usagestats.test.ts`:

```ts
import { aggregateUsage } from "./usagestats";

const DAY = 24 * 60 * 60 * 1000;
function arec(ts: number, model: string, input: number): UsageRecord {
    return { ts, provider: "claude", model, inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
}

describe("aggregateUsage", () => {
    const now = Date.parse("2026-06-26T12:00:00.000Z");

    it("buckets today vs week and excludes older-than-week", () => {
        const stats = aggregateUsage(
            [
                arec(now, "claude-opus-4", 100), // today + week
                arec(now - 2 * DAY, "claude-opus-4", 50), // week only
                arec(now - 8 * DAY, "claude-opus-4", 999), // excluded
            ],
            now
        );
        expect(stats.totals.tokensToday).toBe(100);
        expect(stats.totals.tokensWeek).toBe(150);
    });

    it("computes per-model pct within a provider, desc by tokens", () => {
        const stats = aggregateUsage([arec(now, "claude-opus-4", 75), arec(now, "claude-sonnet-4", 25)], now);
        const p = stats.providers[0];
        expect(p.provider).toBe("claude");
        expect(p.models[0].model).toBe("claude-opus-4");
        expect(p.models[0].pct).toBeCloseTo(75, 5);
        expect(p.models[1].pct).toBeCloseTo(25, 5);
    });

    it("returns zeros for no records", () => {
        expect(aggregateUsage([], now)).toEqual({
            totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
            providers: [],
        });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: FAIL — `aggregateUsage is not exported`.

- [ ] **Step 3: Write minimal implementation**

Append to `frontend/app/view/agents/usagestats.ts`:

```ts
// Mirrors agentsviewmodel's module-local PROVIDER_RANK (claude-first). Kept local to keep this a
// self-contained pure module rather than coupling it to the large view-model file.
const PROVIDER_RANK: Record<string, number> = { claude: 0, codex: 1 };

function startOfLocalDay(now: number): number {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

// Fold records into today/week totals + per-provider per-model breakdown. The 7-day window is
// enforced here on the parsed message ts (not on file modtime, which is unit-agnostic).
export function aggregateUsage(records: UsageRecord[], now: number): UsageStats {
    const dayStart = startOfLocalDay(now);
    const weekStart = now - USAGE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    let tokensToday = 0;
    let tokensWeek = 0;
    let spendTodayUsd = 0;
    let spendWeekUsd = 0;
    const byProvider = new Map<string, Map<string, { tokens: number; spend: number }>>();
    for (const r of records) {
        if (r.ts < weekStart) {
            continue;
        }
        const tk = tokensOf(r);
        const sp = spendOf(r);
        tokensWeek += tk;
        spendWeekUsd += sp;
        if (r.ts >= dayStart) {
            tokensToday += tk;
            spendTodayUsd += sp;
        }
        let models = byProvider.get(r.provider);
        if (!models) {
            models = new Map();
            byProvider.set(r.provider, models);
        }
        const cur = models.get(r.model) ?? { tokens: 0, spend: 0 };
        cur.tokens += tk;
        cur.spend += sp;
        models.set(r.model, cur);
    }
    const providers: ProviderUsage[] = [...byProvider.entries()]
        .map(([provider, models]) => {
            const tokensWeekP = [...models.values()].reduce((s, m) => s + m.tokens, 0);
            const modelUsages: ModelUsage[] = [...models.entries()]
                .map(([model, v]) => ({
                    model,
                    tokens: v.tokens,
                    spendUsd: v.spend,
                    pct: tokensWeekP > 0 ? (v.tokens / tokensWeekP) * 100 : 0,
                }))
                .sort((a, b) => b.tokens - a.tokens);
            return { provider, tokensWeek: tokensWeekP, models: modelUsages };
        })
        .sort((a, b) => (PROVIDER_RANK[a.provider] ?? 99) - (PROVIDER_RANK[b.provider] ?? 99));
    return { totals: { tokensToday, tokensWeek, spendTodayUsd, spendWeekUsd }, providers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/usagestats.test.ts`
Expected: PASS (10 tests total).

---

### Task 4: Usage store — loader + atom

**Files:**
- Create: `frontend/app/view/agents/usagestore.ts`

No unit test (impure IO; mirrors `activitystore.ts`'s untested `loadActivity` — verified via the dev/visual check in Task 9).

- [ ] **Step 1: Write the store**

Create `frontend/app/view/agents/usagestore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface store: the aggregated UsageStats atom + the impure loader. Mirrors activitystore —
// discover sessions (newest-first), read each transcript, parse usage, aggregate. Reads newest-first
// up to a file cap; SessionDescriptor.modtime is unit-agnostic, so the 7-day cutoff is enforced on
// parsed message ts inside aggregateUsage, not on modtime.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { discoverSessions } from "./activitydiscovery";
import { aggregateUsage, extractUsage, type UsageRecord, type UsageStats } from "./usagestats";

const SESSION_READ_CAP = 150; // newest-first files to scan (bounds work without trusting modtime units)
const USAGE_READ_MAXLINES = 20000; // ~whole file; the backend reads the full file then tails to this

const EMPTY: UsageStats = {
    totals: { tokensToday: 0, tokensWeek: 0, spendTodayUsd: 0, spendWeekUsd: 0 },
    providers: [],
};

export const usageStatsAtom = atom<UsageStats>(EMPTY) as PrimitiveAtom<UsageStats>;

let loading = false;

export async function loadUsage(): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const sessions = (await discoverSessions()).slice(0, SESSION_READ_CAP);
        const records: UsageRecord[] = [];
        for (const s of sessions) {
            let lines: string[];
            try {
                const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {
                    path: s.path,
                    maxlines: USAGE_READ_MAXLINES,
                });
                lines = rtn.lines ?? [];
            } catch {
                continue;
            }
            records.push(...extractUsage(lines, s.agent));
        }
        globalStore.set(usageStatsAtom, aggregateUsage(records, Date.now()));
    } finally {
        loading = false;
    }
}
```

- [ ] **Step 2: Typecheck the new module**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors referencing `usagestore.ts` (baseline has ~3 pre-existing errors in `frontend/tauri/api.test.ts` — those are expected; see CLAUDE.md tsc gotcha).

---

### Task 5: Usage surface component

**Files:**
- Create: `frontend/app/view/agents/usagesurface.tsx`

- [ ] **Step 1: Write the component**

Create `frontend/app/view/agents/usagesurface.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Usage surface (handoff parity: Wave-cockpit-live.dc.html:809-850). Account/provider-level usage for
// external agents: rate-limit windows (live, from AgentUsage via providerPlanUsage) + token/spend/
// per-model breakdown (historical, from the transcript scan in usagestore). Loads on mount, refreshes
// on a 60s interval; a 1s tick keeps the reset countdowns current.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import {
    formatReset,
    formatTokens,
    groupAgents,
    projectsFromAgents,
    providerPlanUsage,
    usageLevel,
} from "./agentsviewmodel";
import type { ModelUsage } from "./usagestats";
import { loadUsage, usageStatsAtom } from "./usagestore";

const PROVIDER_RANK: Record<string, number> = { claude: 0, codex: 1 };
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };
const RING: Record<"ok" | "warn" | "hot", string> = {
    ok: "var(--color-accent)",
    warn: "var(--color-warning)",
    hot: "var(--color-error)",
};

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
    return (
        <div className="rounded-[12px] border border-border bg-surface-raised px-[17px] py-[16px]">
            <div className="mb-2 font-mono text-[11px] font-medium text-muted">{label}</div>
            <div className={cn("font-mono text-[24px] font-bold", accent ? "text-success" : "text-primary")}>
                {value}
            </div>
        </div>
    );
}

// One rate-limit window as a conic-gradient donut (handoff L828-835). pct null (API-key auth, or a
// window not reported) renders nothing. Token cap denominator is intentionally dropped (no source).
function Donut({ label, pct, reset, now }: { label: string; pct?: number; reset?: number; now: number }) {
    if (pct == null) {
        return null;
    }
    const ring = RING[usageLevel(pct)];
    return (
        <div className="flex items-center gap-[22px] rounded-[14px] border border-border bg-surface-raised px-[22px] py-[20px]">
            <div
                className="relative flex h-[104px] w-[104px] flex-none items-center justify-center rounded-full"
                style={{ background: `conic-gradient(${ring} 0 ${Math.min(100, pct)}%, var(--color-edge-strong) 0)` }}
            >
                <div className="flex h-[78px] w-[78px] flex-col items-center justify-center rounded-full bg-background">
                    <span className="font-mono text-[22px] font-bold text-primary">{Math.round(pct)}%</span>
                    <span className="font-mono text-[9px] text-muted">used</span>
                </div>
            </div>
            <div>
                <div className="mb-[7px] font-mono text-[13.5px] font-semibold text-secondary">{label}</div>
                {reset ? <div className="font-mono text-[12px] text-muted">resets {formatReset(reset, now)}</div> : null}
            </div>
        </div>
    );
}

function ModelBar({ m }: { m: ModelUsage }) {
    return (
        <div className="mb-[12px] flex items-center gap-[14px]">
            <span className="w-[120px] flex-none truncate font-mono text-[12.5px] text-secondary">{m.model}</span>
            <div className="h-[8px] flex-1 overflow-hidden rounded-[5px] bg-surface-raised">
                <div className="h-full rounded-[5px] bg-accent" style={{ width: `${m.pct}%` }} />
            </div>
            <span className="w-[42px] flex-none text-right font-mono text-[12px] text-muted">{Math.round(m.pct)}%</span>
        </div>
    );
}

export function UsageSurface({ model }: { model: AgentsViewModel }) {
    const agents = useAtomValue(model.agentsAtom);
    const stats = useAtomValue(usageStatsAtom);
    const now = useAtomValue(model.nowAtom);
    const { asking, working, idle } = groupAgents(agents);

    useEffect(() => {
        void loadUsage();
        const refresh = setInterval(() => void loadUsage(), 60_000);
        const tick = setInterval(() => globalStore.set(model.nowAtom, Date.now()), 1000);
        return () => {
            clearInterval(refresh);
            clearInterval(tick);
        };
    }, [model]);

    const planByProvider = providerPlanUsage([...asking, ...working, ...idle]);
    const planMap = new Map(planByProvider.map((p) => [p.provider, p.usage]));
    const tokenMap = new Map(stats.providers.map((p) => [p.provider, p]));
    const providerKeys = [...new Set([...planMap.keys(), ...tokenMap.keys()])].sort(
        (a, b) => (PROVIDER_RANK[a] ?? 99) - (PROVIDER_RANK[b] ?? 99)
    );
    const hasAny = providerKeys.length > 0 || stats.totals.tokensWeek > 0;

    return (
        <div className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto max-w-[920px] px-[30px] pb-[70px] pt-[30px]">
                <div className="mb-6">
                    <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Usage</h1>
                    <p className="text-[13.5px] text-secondary">
                        Live quota across providers. Rolling 5-hour window and weekly caps.
                    </p>
                </div>

                <div className="mb-[34px] grid grid-cols-4 gap-3">
                    <StatCard label="Active agents" value={String(working.length)} accent />
                    <StatCard label="Projects" value={String(projectsFromAgents(agents).length)} />
                    <StatCard label="Tokens today" value={formatTokens(stats.totals.tokensToday)} />
                    <StatCard label="Spend today" value={`$${stats.totals.spendTodayUsd.toFixed(2)}`} />
                </div>

                {!hasAny ? (
                    <div className="mt-10 text-center text-[13px] text-muted">No usage yet — start an agent.</div>
                ) : (
                    providerKeys.map((key) => {
                        const usage = planMap.get(key);
                        const tokens = tokenMap.get(key);
                        return (
                            <div key={key} className="mb-[34px]">
                                <div className="mb-[15px] flex items-center gap-[11px]">
                                    <h2 className="text-[16px] font-bold tracking-[-0.01em] text-primary">
                                        {PROVIDER_LABEL[key] ?? key}
                                    </h2>
                                    <div className="h-px flex-1 bg-border" />
                                </div>
                                {usage ? (
                                    <div className="mb-[14px] grid grid-cols-2 gap-[14px]">
                                        <Donut label="5-hour window" pct={usage.fivehourpct} reset={usage.fivehourreset} now={now} />
                                        <Donut label="Weekly" pct={usage.weekpct} reset={usage.weekreset} now={now} />
                                    </div>
                                ) : null}
                                {tokens && tokens.models.length > 0 ? (
                                    <div className="rounded-[14px] border border-border bg-surface-raised px-[22px] py-[18px]">
                                        <div className="mb-[14px] font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
                                            By model · this week
                                        </div>
                                        {tokens.models.map((m) => (
                                            <ModelBar key={m.model} m={m} />
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors (baseline ~3 in `frontend/tauri/api.test.ts` only). If `model.agentsAtom` / `model.nowAtom` are flagged, confirm they exist on `AgentsViewModel` in `agents.tsx` (they are used identically in `cockpitsurface.tsx`).

---

### Task 6: Wire the surface into the shell

**Files:**
- Modify: `frontend/app/view/agents/cockpitshell.tsx`
- Modify: `frontend/app/view/agents/placeholdersurface.tsx`

- [ ] **Step 1: Add the import and render branch in `cockpitshell.tsx`**

Add the import alongside the other surface imports (after the `PlaceholderSurface` import):

```tsx
import { UsageSurface } from "./usagesurface";
```

Replace the `files` branch's trailing `) : (` with a new `usage` branch:

```tsx
                ) : surface === "files" ? (
                    <FilesSurface model={model} />
                ) : surface === "usage" ? (
                    <UsageSurface model={model} />
                ) : (
                    <PlaceholderSurface surface={surface} />
                )}
```

- [ ] **Step 2: Drop `usage` from the placeholder titles**

In `frontend/app/view/agents/placeholdersurface.tsx`, remove the `usage` entry from `TITLES`:

```tsx
const TITLES: Record<string, string> = {
    channels: "Channels",
    sessions: "Sessions",
    files: "Files",
    memory: "Memory",
};
```

- [ ] **Step 3: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: no NEW errors.

---

### Task 7: Record deferred items

**Files:**
- Modify: `docs/deferred.md` (create if absent)

- [ ] **Step 1: Append the Usage section**

Append to `docs/deferred.md` (create the file with a `# Deferred` heading if it does not exist):

```markdown
## Usage surface (2026-06-26)

- **Rate-limit window token cap** (handoff "1.34M / 2.2M tok"): no faithful source — the 5h/weekly %
  is Anthropic's opaque server-side number; transcript token sums are a different accounting. The
  donut shows % + reset only. Revisit if a real cap / used-token source appears.
- **Plan-tier badge** (handoff "Max 20×" / "Tier 4"): not carried by the statusLine; provider label
  is shown without a tier badge.
- **Codex/OpenAI token breakdown**: `extractUsage` only parses Claude `type:"assistant"` lines, and
  OpenAI has no 5h/weekly window. A Codex provider row appears only when real data exists for it.
- **Model-id prettifying**: the per-model bar shows the raw model id (e.g. "claude-opus-4-20250514")
  rather than a friendly label.
- **Pricing table** (`usagestats.ts` PRICING) is a hardcoded estimate; refresh as plans change.
- **Scan bound**: `usagestore.ts` reads the newest `SESSION_READ_CAP` (150) sessions, up to
  `USAGE_READ_MAXLINES` (20000) lines each. Pathologically large fleets/sessions could under-count.
```

---

### Task 8: Static verification (typecheck + full test suite)

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend test suite**

Run: `npx vitest run`
Expected: PASS. The 10 new tests in `usagestats.test.ts` are green and the previously-passing suite count is unchanged otherwise.

- [ ] **Step 2: Typecheck the whole frontend**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: only the ~3 pre-existing `frontend/tauri/api.test.ts` errors (baseline). No errors in any `usage*.ts(x)`, `cockpitshell.tsx`, or `placeholdersurface.tsx`.

---

### Task 9: Visual verification (dev app, CDP)

**Files:** none (verification only). Requires `task dev` running.

- [ ] **Step 1: Ensure the dev app is running with usage data**

If not already running: `task dev`. If the roster is empty, inject fake agents: `node scripts/inject-live-agents.mjs <scenario>` (see that script's header for scenarios). Note: rate-limit window gauges only appear for subscriber sessions that have reported via the statusLine; the token/per-model section populates from on-disk transcripts regardless.

- [ ] **Step 2: Navigate to the Usage surface and screenshot**

In the dev app, click **Usage** in the left NavRail (or set the surface atom over CDP). Then capture:

Run: `node scripts/cdp-shot.mjs usage.png`
Expected: a PNG showing the Usage header, the 4 stat cards, and (when data exists) per-provider donuts + the "By model · this week" bars. Verify against the handoff (`Wave-cockpit-live.dc.html:809-850`): no console errors, layout matches, the empty state ("No usage yet — start an agent.") shows only when there is genuinely no data.

---

### Task 10: Commit (approval-gated, single commit)

**Files:** all of the above.

- [ ] **Step 1: Show the change summary and request approval**

Per the user's CLAUDE.md git rules, present:
- Files with status:
  - A `frontend/app/view/agents/usagestats.ts`
  - A `frontend/app/view/agents/usagestats.test.ts`
  - A `frontend/app/view/agents/usagestore.ts`
  - A `frontend/app/view/agents/usagesurface.tsx`
  - M `frontend/app/view/agents/cockpitshell.tsx`
  - M `frontend/app/view/agents/placeholdersurface.tsx`
  - A/M `docs/deferred.md`
  - A `docs/superpowers/specs/2026-06-26-usage-surface-design.md`
  - A `docs/superpowers/plans/2026-06-26-usage-surface.md`
- Proposed message:
  `feat(cockpit): Usage surface — external-agent rate-limit windows + token/spend/per-model breakdown`
- Then ask: "Awaiting approval. Proceed? (yes/no)"

- [ ] **Step 2: On approval, commit**

```bash
git add frontend/app/view/agents/usagestats.ts frontend/app/view/agents/usagestats.test.ts \
        frontend/app/view/agents/usagestore.ts frontend/app/view/agents/usagesurface.tsx \
        frontend/app/view/agents/cockpitshell.tsx frontend/app/view/agents/placeholdersurface.tsx \
        docs/deferred.md docs/superpowers/specs/2026-06-26-usage-surface-design.md \
        docs/superpowers/plans/2026-06-26-usage-surface.md
git commit -m "feat(cockpit): Usage surface — external-agent rate-limit windows + token/spend/per-model breakdown"
```

(Confirm the working tree first — the repo is edited from parallel sessions; only stage the files above. Do not push unless asked.)

---

## Notes for the implementer

- **Run tests from the repo root** (`C:\Users\kael02\IdeaProjects\waveterm`). `npx vitest run <file>` runs a single file; `-t "<name>"` filters by test name.
- **Never run bare `npx tsc`** — it stack-overflows on this repo. Always use the `node --stack-size=4000 …` form.
- **No new SCSS, no raw hex/rgba** in className/style — use the `@theme` tokens (the component above already does: `accent`, `warning`, `error`, `surface-raised`, `background`, `edge-strong`, `border`, `primary`, `secondary`, `muted`, `success`). The donut conic-gradient uses CSS vars (`var(--color-*)`), matching how `activitysurface.tsx` colors its dots.
- **Don't hand-edit generated files** — this feature touches none.
```
