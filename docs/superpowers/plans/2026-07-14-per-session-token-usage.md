# Per-session token-usage breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the focused-agent detail rail a "Token usage" section showing the session's per-class (input / output / cache read / cache write) and per-model token + spend breakdown, replacing the single "Tokens" / "Cost" rows.

**Architecture:** A new backend command returns per-model usage buckets for one transcript (reusing the existing parse/dedup/bucket accounting instead of collapsing to a single int). A pure frontend aggregator folds those buckets into a per-class + per-model shape, pricing via the shared `usagepricing.ts`. A loader store (stale-guarded, like `tokenstore.ts`) feeds a new `TokenUsageSection` component rendered as a `RailSection`.

**Tech Stack:** Go (wshrpc + `pkg/usagestats`), TypeScript/React 19 + jotai + Tailwind v4, vitest, Go testing.

## Global Constraints

- **Git policy (project owner):** NEVER commit without explicit approval. Batch ALL tasks into ONE commit at the end; fold the design spec (`docs/superpowers/specs/2026-07-14-per-session-token-usage-design.md`) into that same commit. Steps below say **"Stage"**, not "commit" — the single commit is the final approved step. Do NOT add a co-author.
- **No hardcoded colors:** use `--color-*` theme tokens only (utility classes or `var(--color-*)`), never raw hex/rgba.
- **Never hand-edit generated files:** `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go` are produced by `task generate`. Edit the Go source, then regenerate.
- **Typecheck command:** `npx tsc` stack-overflows on this repo. Use `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. Baseline is clean (exit 0).
- **Spend is an estimate** — always framed "≈ API-equivalent", never a bill (matches the global Usage surface).
- **Class colors (adapted to our design system, matching `usagesurface.tsx` `CLASS_COLOR`):** input → `--color-success`, output → `--color-accent`, cacheWrite → `--color-warning`, cacheRead → `--color-cacheread`. This deliberately flips the mockup's input/output colors.

---

### Task 1: Backend — per-transcript usage command

**Files:**
- Modify: `pkg/usagestats/usagestats.go` (add `TranscriptUsage`)
- Test: `pkg/usagestats/usagestats_test.go` (add `TestTranscriptUsage`)
- Modify: `pkg/wshrpc/wshrpctypes.go` (interface method + data/rtn types)
- Modify: `pkg/wshrpc/wshserver/wshserver.go` (implement)
- Regenerated (do not hand-edit): `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**Interfaces:**
- Produces (Go): `usagestats.TranscriptUsage(path string) ([]Bucket, error)` — reuses the existing `Bucket` struct.
- Produces (wire): `GetTranscriptUsageCommand(data { path: string }) -> { buckets: UsageBucket[] }`. `UsageBucket` is the existing wire type (fields: `provider, model, day, input, output, cacheread, cachecreate, cachecreate1h, msgs`), already generated into `frontend/types/gotypes.d.ts`.

- [ ] **Step 1: Write the failing Go test**

Add to `pkg/usagestats/usagestats_test.go`:

```go
func TestTranscriptUsage(t *testing.T) {
	dir := t.TempDir()

	// Claude file: two models (opus + haiku), opus streamed twice on one id → dedupe keeps output:50.
	claude := filepath.Join(dir, "claude.jsonl")
	lines := "" +
		`{"type":"assistant","timestamp":"2026-06-26T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-06-26T10:00:01.000Z","requestId":"r1","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}` + "\n" +
		`{"type":"assistant","timestamp":"2026-06-26T10:01:00.000Z","requestId":"r2","message":{"id":"m2","model":"claude-haiku-4-5","usage":{"input_tokens":12,"output_tokens":2}}}` + "\n"
	if err := os.WriteFile(claude, []byte(lines), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := TranscriptUsage(claude)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 buckets (opus, haiku), got %d: %+v", len(got), got)
	}
	byModel := map[string]Bucket{}
	for _, b := range got {
		byModel[b.Model] = b
	}
	opus := byModel["claude-opus-4-8"]
	if opus.Input != 100 || opus.Output != 50 || opus.CacheRead != 1000 || opus.CacheCreate != 200 || opus.Msgs != 1 {
		t.Errorf("opus bucket = %+v", opus)
	}
	if h := byModel["claude-haiku-4-5"]; h.Input != 12 || h.Output != 2 {
		t.Errorf("haiku bucket = %+v", h)
	}

	// Codex rollout: one cumulative record, no cache-write class.
	codex := filepath.Join(dir, "rollout-x.jsonl")
	codexLines := "" +
		`{"timestamp":"2026-06-26T03:07:50.000Z","type":"turn_context","payload":{"model":"gpt-5.5"}}` + "\n" +
		`{"timestamp":"2026-06-26T03:08:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9458,"cached_input_tokens":7040,"output_tokens":89,"total_tokens":9547}}}}` + "\n"
	if err := os.WriteFile(codex, []byte(codexLines), 0o644); err != nil {
		t.Fatal(err)
	}
	cg, err := TranscriptUsage(codex)
	if err != nil || len(cg) != 1 {
		t.Fatalf("codex buckets = %+v, err = %v; want 1", cg, err)
	}
	if cg[0].Provider != "codex" || cg[0].Input != 2418 || cg[0].CacheRead != 7040 || cg[0].Output != 89 || cg[0].CacheCreate != 0 {
		t.Errorf("codex bucket = %+v", cg[0])
	}

	// Missing/empty → nil, no error.
	if mg, err := TranscriptUsage(filepath.Join(dir, "nope.jsonl")); err != nil || mg != nil {
		t.Fatalf("missing = %+v, err = %v; want nil/nil", mg, err)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/usagestats/ -run TestTranscriptUsage -v`
Expected: FAIL — `undefined: TranscriptUsage`.

- [ ] **Step 3: Implement `TranscriptUsage`**

Add to `pkg/usagestats/usagestats.go` (after `SumTranscript`):

```go
// TranscriptUsage parses one transcript file into per-(provider, model, day) buckets, reusing the
// same dedup + bucket accounting as the Usage surface — the per-session analogue of ScanUsage.
// Claude parser first, Codex fallback (mirrors SumTranscript). Empty/unreadable/unknown-shape
// files return nil, no error.
func TranscriptUsage(path string) ([]Bucket, error) {
	lines := readLines(path)
	if len(lines) == 0 {
		return nil, nil
	}
	recs := extractClaude(lines)
	if len(recs) == 0 {
		recs = extractCodex(lines)
	}
	return bucket(dedupe(recs)), nil
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test ./pkg/usagestats/ -run TestTranscriptUsage -v`
Expected: PASS.

- [ ] **Step 5: Add the wire types + interface method**

In `pkg/wshrpc/wshrpctypes.go`, add the interface method next to `GetTranscriptTokensCommand` (~line 97):

```go
	GetTranscriptUsageCommand(ctx context.Context, data CommandGetTranscriptUsageData) (*CommandGetTranscriptUsageRtnData, error)
```

And add the data/rtn types next to `CommandGetTranscriptTokensData` (~line 901):

```go
type CommandGetTranscriptUsageData struct {
	Path string `json:"path"`
}

type CommandGetTranscriptUsageRtnData struct {
	Buckets []UsageBucket `json:"buckets"`
}
```

- [ ] **Step 6: Implement the command handler**

In `pkg/wshrpc/wshserver/wshserver.go`, add after `GetTranscriptTokensCommand` (~line 1416):

```go
func (ws *WshServer) GetTranscriptUsageCommand(ctx context.Context, data wshrpc.CommandGetTranscriptUsageData) (*wshrpc.CommandGetTranscriptUsageRtnData, error) {
	buckets, err := usagestats.TranscriptUsage(data.Path)
	if err != nil {
		return nil, fmt.Errorf("scanning transcript usage: %w", err)
	}
	out := make([]wshrpc.UsageBucket, len(buckets))
	for i, b := range buckets {
		out[i] = wshrpc.UsageBucket{
			Provider: b.Provider, Model: b.Model, Day: b.Day,
			Input: b.Input, Output: b.Output, CacheRead: b.CacheRead,
			CacheCreate: b.CacheCreate, CacheCreate1h: b.CacheCreate1h, Msgs: b.Msgs,
		}
	}
	return &wshrpc.CommandGetTranscriptUsageRtnData{Buckets: out}, nil
}
```

- [ ] **Step 7: Regenerate bindings and verify the build**

Run: `task generate`
Then: `go build ./...`
Expected: both succeed; `git status` shows regenerated `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts` now containing `GetTranscriptUsageCommand` / `CommandGetTranscriptUsageRtnData`.

Verify the FE binding exists:
Run: `grep -c GetTranscriptUsageCommand frontend/app/store/wshclientapi.ts`
Expected: `1` (or more).

- [ ] **Step 8: Stage**

```bash
git add pkg/usagestats/usagestats.go pkg/usagestats/usagestats_test.go pkg/wshrpc/wshrpctypes.go pkg/wshrpc/wshserver/wshserver.go pkg/wshrpc/wshclient/wshclient.go frontend/app/store/wshclientapi.ts frontend/types/gotypes.d.ts
```

---

### Task 2: Frontend — pure session-usage aggregator

**Files:**
- Modify: `frontend/app/view/agents/usagestats.ts` (export `CLASS_ORDER`, `CLASS_LABEL`)
- Create: `frontend/app/view/agents/sessionusage.ts`
- Test: `frontend/app/view/agents/sessionusage.test.ts`

**Interfaces:**
- Consumes: `UsageBucket` (global generated type); `spendBreakdown` from `./usagepricing`; `ClassUsage`, `TokenClass`, and the newly-exported `CLASS_ORDER` / `CLASS_LABEL` from `./usagestats`.
- Produces:
  - `SessionModelUsage { model: string; tokens: number; spendUsd: number; classes: Record<TokenClass, number> }`
  - `SessionInsight { readTokPct: number; readCostPct: number; topCostClass: TokenClass }`
  - `SessionUsage { totalTokens: number; totalSpendUsd: number; classes: ClassUsage[]; models: SessionModelUsage[]; insight: SessionInsight | null }`
  - `aggregateSessionUsage(buckets: UsageBucket[]): SessionUsage`

- [ ] **Step 1: Export the shared class order/labels**

In `frontend/app/view/agents/usagestats.ts`, add `export` to the two existing consts (~lines 68-74):

```ts
export const CLASS_ORDER: TokenClass[] = ["cacheRead", "output", "cacheWrite", "input"];
export const CLASS_LABEL: Record<TokenClass, string> = {
    cacheRead: "Cache read",
    output: "Output",
    cacheWrite: "Cache write",
    input: "Input",
};
```

- [ ] **Step 2: Write the failing test**

Create `frontend/app/view/agents/sessionusage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { aggregateSessionUsage } from "./sessionusage";

function bkt(over: Partial<UsageBucket>): UsageBucket {
    return {
        provider: "claude",
        model: "claude-opus-4-8",
        day: "2026-07-14",
        input: 0,
        output: 0,
        cacheread: 0,
        cachecreate: 0,
        cachecreate1h: 0,
        msgs: 1,
        ...over,
    };
}

describe("aggregateSessionUsage", () => {
    it("returns a zeroed shape with null insight for no buckets", () => {
        const s = aggregateSessionUsage([]);
        expect(s.totalTokens).toBe(0);
        expect(s.totalSpendUsd).toBe(0);
        expect(s.models).toEqual([]);
        expect(s.insight).toBeNull();
        expect(s.classes.map((c) => c.cls)).toEqual(["cacheRead", "output", "cacheWrite", "input"]);
    });

    it("folds one model: per-class tokens + opus-priced spend + derived insight", () => {
        // opus prices ($/MTok): input 5, output 25, cacheRead 0.5, cacheWrite5m 6.25
        const s = aggregateSessionUsage([
            bkt({ input: 1_000_000, output: 1_000_000, cacheread: 1_000_000, cachecreate: 1_000_000 }),
        ]);
        expect(s.totalTokens).toBe(4_000_000);
        const output = s.classes.find((c) => c.cls === "output")!;
        expect(output.tokens).toBe(1_000_000);
        expect(output.spendUsd).toBeCloseTo(25, 5);
        expect(s.totalSpendUsd).toBeCloseTo(5 + 25 + 0.5 + 6.25, 5);
        expect(s.models).toHaveLength(1);
        expect(s.models[0].model).toBe("claude-opus-4-8");
        expect(s.insight).not.toBeNull();
        expect(s.insight!.topCostClass).toBe("output"); // largest spend share
        expect(s.insight!.readTokPct).toBeCloseTo(25, 5); // 1M / 4M
    });

    it("sorts models by tokens desc and keeps per-model class splits", () => {
        const s = aggregateSessionUsage([
            bkt({ model: "claude-haiku-4-5", input: 1_000_000 }),
            bkt({ model: "claude-opus-4-8", input: 2_000_000, output: 2_000_000 }),
        ]);
        expect(s.models.map((m) => m.model)).toEqual(["claude-opus-4-8", "claude-haiku-4-5"]);
        expect(s.models[0].classes.output).toBe(2_000_000);
        expect(s.models[1].classes.input).toBe(1_000_000);
    });

    it("handles a codex session with no cache-write class", () => {
        const s = aggregateSessionUsage([
            bkt({ provider: "codex", model: "gpt-5-codex", input: 1_000_000, output: 100_000, cacheread: 500_000 }),
        ]);
        const write = s.classes.find((c) => c.cls === "cacheWrite")!;
        expect(write.tokens).toBe(0);
        expect(write.spendUsd).toBe(0);
        expect(s.totalTokens).toBe(1_600_000);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run frontend/app/view/agents/sessionusage.test.ts`
Expected: FAIL — cannot resolve `./sessionusage`.

- [ ] **Step 4: Implement the aggregator**

Create `frontend/app/view/agents/sessionusage.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure per-session usage aggregation. Folds one transcript's backend buckets
// (GetTranscriptUsageCommand) into a per-class split + per-model breakdown + a derived insight.
// Spend is priced via usagepricing (single source of truth). No React/runtime imports; unit-tested.

import { spendBreakdown } from "./usagepricing";
import { CLASS_LABEL, CLASS_ORDER, type ClassUsage, type TokenClass } from "./usagestats";

export interface SessionModelUsage {
    model: string; // raw id; labelled via prettyModel at render
    tokens: number;
    spendUsd: number;
    classes: Record<TokenClass, number>; // per-class tokens (for the mini stacked bar)
}

export interface SessionInsight {
    readTokPct: number; // cache-read share of tokens
    readCostPct: number; // cache-read share of spend
    topCostClass: TokenClass; // class with the largest spend share
}

export interface SessionUsage {
    totalTokens: number;
    totalSpendUsd: number;
    classes: ClassUsage[]; // fixed CLASS_ORDER
    models: SessionModelUsage[]; // desc by tokens
    insight: SessionInsight | null; // null when the session has no tokens
}

function zeroClasses(): Record<TokenClass, number> {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function aggregateSessionUsage(buckets: UsageBucket[]): SessionUsage {
    const tok = zeroClasses();
    const spd = zeroClasses();
    const byModel = new Map<string, { tokens: number; spend: number; classes: Record<TokenClass, number> }>();

    for (const b of buckets) {
        const sb = spendBreakdown({
            ts: 0,
            provider: b.provider,
            model: b.model,
            inputTokens: b.input,
            outputTokens: b.output,
            cacheReadTokens: b.cacheread,
            cacheCreateTokens: b.cachecreate,
            cacheCreate1hTokens: b.cachecreate1h,
        });
        tok.input += b.input;
        tok.output += b.output;
        tok.cacheRead += b.cacheread;
        tok.cacheWrite += b.cachecreate;
        spd.input += sb.input;
        spd.output += sb.output;
        spd.cacheRead += sb.cacheRead;
        spd.cacheWrite += sb.cacheWrite;

        const m = byModel.get(b.model) ?? { tokens: 0, spend: 0, classes: zeroClasses() };
        m.tokens += b.input + b.output + b.cacheread + b.cachecreate;
        m.spend += sb.input + sb.output + sb.cacheRead + sb.cacheWrite;
        m.classes.input += b.input;
        m.classes.output += b.output;
        m.classes.cacheRead += b.cacheread;
        m.classes.cacheWrite += b.cachecreate;
        byModel.set(b.model, m);
    }

    const totalTokens = tok.input + tok.output + tok.cacheRead + tok.cacheWrite;
    const totalSpendUsd = spd.input + spd.output + spd.cacheRead + spd.cacheWrite;

    const classes: ClassUsage[] = CLASS_ORDER.map((cls) => ({
        cls,
        label: CLASS_LABEL[cls],
        tokens: tok[cls],
        spendUsd: spd[cls],
    }));

    const models: SessionModelUsage[] = [...byModel.entries()]
        .map(([model, v]) => ({ model, tokens: v.tokens, spendUsd: v.spend, classes: v.classes }))
        .sort((a, b) => b.tokens - a.tokens);

    let insight: SessionInsight | null = null;
    if (totalTokens > 0) {
        const topCostClass = CLASS_ORDER.reduce((top, c) => (spd[c] > spd[top] ? c : top), CLASS_ORDER[0]);
        insight = {
            readTokPct: (tok.cacheRead / totalTokens) * 100,
            readCostPct: totalSpendUsd > 0 ? (spd.cacheRead / totalSpendUsd) * 100 : 0,
            topCostClass,
        };
    }

    return { totalTokens, totalSpendUsd, classes, models, insight };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run frontend/app/view/agents/sessionusage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Stage**

```bash
git add frontend/app/view/agents/usagestats.ts frontend/app/view/agents/sessionusage.ts frontend/app/view/agents/sessionusage.test.ts
```

---

### Task 3: Frontend — loader store, section component, rail wiring

No unit test: there is no render harness for the cockpit (per CLAUDE.md), so this task verifies via typecheck + a live CDP screenshot.

**Files:**
- Create: `frontend/app/view/agents/transcriptusagestore.ts`
- Create: `frontend/app/view/agents/tokenusagesection.tsx`
- Modify: `frontend/app/view/agents/railicons.tsx` (add a `usage` glyph)
- Modify: `frontend/app/view/agents/agentdetailsrail.tsx` (add section, remove Tokens/Cost rows, swap loader)
- Delete: `frontend/app/view/agents/tokenstore.ts` (superseded; only the rail consumed it)

**Interfaces:**
- Consumes: `aggregateSessionUsage`, `SessionUsage`, `SessionModelUsage`, `SessionInsight` from `./sessionusage`; `RpcApi.GetTranscriptUsageCommand`; `prettyModel` from `./modellabel`; `TokenClass`/`ClassUsage` from `./usagestats`; `SkeletonLine` from `@/app/element/skeleton`; `RAIL_ICON` from `./railicons`.
- Produces: `sessionUsageAtom` (`PrimitiveAtom<SessionUsage | null>`), `loadSessionUsage(id, transcriptPath, opts?)`, `<TokenUsageSection/>`.

- [ ] **Step 1: Create the loader store**

Create `frontend/app/view/agents/transcriptusagestore.ts`:

```ts
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Focused-agent per-session usage: buckets for the agent's own transcript (GetTranscriptUsageCommand)
// folded via aggregateSessionUsage. Mirrors tokenstore.ts's stale-load guard so a slow load for a
// previous focus can't overwrite a newer one. A silent reload (the rail's refresh tick) keeps the
// last-good value instead of blanking to the skeleton.

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { aggregateSessionUsage, type SessionUsage } from "./sessionusage";

export const sessionUsageAtom = atom<SessionUsage | null>(null) as PrimitiveAtom<SessionUsage | null>;

const current = { id: "" };

export async function loadSessionUsage(
    id: string,
    transcriptPath: string | undefined,
    opts?: { silent?: boolean }
): Promise<void> {
    current.id = id;
    if (!opts?.silent) {
        globalStore.set(sessionUsageAtom, null);
    }
    if (!transcriptPath) {
        return;
    }
    try {
        const rtn = await RpcApi.GetTranscriptUsageCommand(TabRpcClient, { path: transcriptPath });
        if (current.id === id) {
            globalStore.set(sessionUsageAtom, aggregateSessionUsage(rtn.buckets ?? []));
        }
    } catch {
        if (current.id === id && !opts?.silent) {
            globalStore.set(sessionUsageAtom, null);
        }
    }
}
```

- [ ] **Step 2: Add the rail icon**

In `frontend/app/view/agents/railicons.tsx`, add `Coins` to the lucide import and a `usage` entry:

```tsx
import { BarChart3, Bell, Coins, Diamond, FileText, Folder, GitBranch, Info, Settings, Users, Wrench } from "lucide-react";
```

Add inside `RAIL_ICON` (after `files`):

```tsx
    usage: <Coins {...iconProps} />,
```

- [ ] **Step 3: Create the section component**

Create `frontend/app/view/agents/tokenusagesection.tsx`:

```tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// "Token usage" rail section for the focused agent: per-class split (tokens + ≈ spend) and a
// per-model breakdown, from the session's own transcript (transcriptusagestore/sessionusage).
// Class colors mirror usagesurface.tsx's CLASS_COLOR (theme tokens only). Spend is an estimate.

import { SkeletonLine } from "@/app/element/skeleton";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { prettyModel } from "./modellabel";
import { sessionUsageAtom, type SessionUsage } from "./transcriptusagestore";
import type { ClassUsage, TokenClass } from "./usagestats";

const CLASS_COLOR: Record<TokenClass, string> = {
    cacheRead: "var(--color-cacheread)",
    output: "var(--color-accent)",
    cacheWrite: "var(--color-warning)",
    input: "var(--color-success)",
};

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
    if (n <= 0) return "0%";
    if (n < 0.1) return "<0.1%";
    return +n.toFixed(1) + "%";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[.1em] text-ink-mid">{children}</h3>;
}

function StackedBar({ segs, total }: { segs: { cls: TokenClass; value: number }[]; total: number }) {
    const denom = total || 1;
    return (
        <div className="flex h-[11px] overflow-hidden rounded-[5px] bg-surface-hover">
            {segs.map((s) =>
                s.value > 0 ? (
                    <span key={s.cls} style={{ width: `${(s.value / denom) * 100}%`, background: CLASS_COLOR[s.cls] }} />
                ) : null
            )}
        </div>
    );
}

export function TokenUsageSection() {
    const usage = useAtomValue(sessionUsageAtom);

    if (usage == null) {
        return (
            <div>
                <SectionLabel>Token usage</SectionLabel>
                <SkeletonLine className="mt-[12px] h-[24px] w-[120px]" />
                <SkeletonLine className="mt-[12px] h-[11px] w-full rounded-[5px]" />
                <SkeletonLine className="mt-[10px] h-[11px] w-full rounded-[5px]" />
            </div>
        );
    }
    if (usage.totalTokens === 0) {
        return (
            <div>
                <SectionLabel>Token usage</SectionLabel>
                <div className="mt-[10px] text-[11.5px] text-muted">No token usage recorded yet.</div>
            </div>
        );
    }

    const { classes, models, insight, totalTokens, totalSpendUsd } = usage;
    const single = models.length === 1;
    const topLabel = insight ? classes.find((c) => c.cls === insight.topCostClass)?.label ?? "" : "";

    return (
        <div>
            <div className="flex items-baseline justify-between">
                <SectionLabel>Token usage</SectionLabel>
                <span className="font-mono text-[11px] font-semibold text-accent">{fmt(totalTokens)}</span>
            </div>

            {/* headline pair */}
            <div className="mt-[13px] mb-[15px] flex items-end justify-between">
                <div>
                    <div className="font-mono text-[22px] font-bold leading-none text-primary">{fmt(totalTokens)}</div>
                    <div className="mt-[4px] font-mono text-[10px] text-muted">total tokens</div>
                </div>
                <div className="text-right">
                    <div className="font-mono text-[22px] font-bold leading-none text-success">≈ {usd(totalSpendUsd)}</div>
                    <div className="mt-[4px] font-mono text-[10px] text-muted">API-equivalent</div>
                </div>
            </div>

            {/* tokens bar */}
            <div className="mb-[6px] flex items-baseline justify-between">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">Tokens</span>
                <span className="font-mono text-[11px] text-secondary">{fmt(totalTokens)}</span>
            </div>
            <StackedBar segs={classes.map((c) => ({ cls: c.cls, value: c.tokens }))} total={totalTokens} />

            {/* spend bar */}
            <div className="mb-[6px] mt-[13px] flex items-baseline justify-between">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">≈ Spend</span>
                <span className="font-mono text-[11px] text-secondary">{usd(totalSpendUsd)}</span>
            </div>
            <StackedBar segs={classes.map((c) => ({ cls: c.cls, value: c.spendUsd }))} total={totalSpendUsd} />

            {/* insight */}
            {insight ? (
                <div className="mt-[13px] flex gap-[8px] rounded-[9px] border border-border bg-surface-raised px-[11px] py-[9px]">
                    <span className="flex-none text-[12px] leading-[1.4] text-warning">◆</span>
                    <p className="text-[11.5px] leading-[1.5] text-secondary">
                        Cache reads are {pctStr(insight.readTokPct)} of tokens but {pctStr(insight.readCostPct)} of spend;{" "}
                        {topLabel.toLowerCase()} drives the cost.
                    </p>
                </div>
            ) : null}

            {/* per-class table */}
            <div className="mt-[14px] flex flex-col">
                {classes.map((c) => (
                    <div
                        key={c.cls}
                        className="flex items-center gap-[9px] border-b border-edge-faint py-[7px] last:border-b-0"
                    >
                        <span className="h-[9px] w-[9px] flex-none rounded-[3px]" style={{ background: CLASS_COLOR[c.cls] }} />
                        <span className="min-w-0 flex-1 text-[12px] text-secondary">{c.label}</span>
                        <span className="w-[52px] text-right font-mono text-[11.5px] text-secondary">{fmt(c.tokens)}</span>
                        <span className="w-[34px] text-right font-mono text-[9.5px] text-muted">
                            {pctStr(totalTokens > 0 ? (c.tokens / totalTokens) * 100 : 0)}
                        </span>
                        <span className="w-[48px] text-right font-mono text-[11.5px] text-muted">{usd(c.spendUsd)}</span>
                    </div>
                ))}
            </div>

            {/* by model */}
            <div className="mb-[11px] mt-[16px] flex items-center gap-[8px]">
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.09em] text-muted">By model</span>
                <div className="h-px flex-1 bg-edge-faint" />
                <span className="font-mono text-[10px] text-muted">{single ? "1 model" : `${models.length} models`}</span>
            </div>
            <div className="flex flex-col gap-[11px]">
                {models.map((m) => (
                    <div key={m.model}>
                        <div className="mb-[6px] flex items-center gap-[8px]">
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold text-secondary" title={m.model}>
                                {prettyModel(m.model)}
                            </span>
                            <span className="font-mono text-[11px] text-muted">{fmt(m.tokens)}</span>
                            <span className="w-[48px] text-right font-mono text-[11px] text-muted">{usd(m.spendUsd)}</span>
                        </div>
                        {single ? null : (
                            <StackedBar
                                segs={(Object.keys(m.classes) as TokenClass[]).map((cls) => ({ cls, value: m.classes[cls] }))}
                                total={m.tokens}
                            />
                        )}
                    </div>
                ))}
            </div>

            <p className="mt-[13px] font-mono text-[10px] leading-[1.5] text-muted">
                Priced per class from a bundled table. Subagents run in separate transcripts — see Subagents.
            </p>
        </div>
    );
}
```

Note: `SessionUsage` is re-exported through `transcriptusagestore.ts`? No — import the type from `./sessionusage` where needed. In this component only the atom is imported; the `type SessionUsage` import line above is unused, so **remove it** if tsc flags it. (Keep only `sessionUsageAtom`.)

- [ ] **Step 4: Wire the section into the rail and remove the old rows**

In `frontend/app/view/agents/agentdetailsrail.tsx`:

(a) Replace the token-store import (line ~31)
```ts
import { agentTokensAtom, loadTokensForAgent } from "./tokenstore";
```
with
```ts
import { loadSessionUsage } from "./transcriptusagestore";
import { TokenUsageSection } from "./tokenusagesection";
```

(b) In the imports from `./agentsviewmodel` (lines ~13-21), remove `formatTokens` (it becomes unused). Keep `formatAge, projectOf, recentActions, summarizeActions, usageLevel, type AgentVM`.

(c) Remove the `tokensTotal` atom read (line ~64):
```ts
    const tokensTotal = useAtomValue(agentTokensAtom);
```

(d) Replace the load effect (lines ~68-72) so it loads session usage and refreshes every 15s while mounted:
```ts
    useEffect(() => {
        fireAndForget(() => loadRailForAgent(agent.id, agent.transcriptPath, agent.blockId));
        fireAndForget(() => loadSessionUsage(agent.id, agent.transcriptPath));
        fireAndForget(() => loadCacheStatusForAgent(agent.id, agent.transcriptPath));
        const refresh = setInterval(
            () => fireAndForget(() => loadSessionUsage(agent.id, agent.transcriptPath, { silent: true })),
            15_000
        );
        return () => clearInterval(refresh);
    }, [agent.id, agent.transcriptPath, agent.blockId]);
```

(e) Remove the now-dead `tokens` and `cost` locals (lines ~98, ~101):
```ts
    const tokens = tokensTotal != null ? formatTokens(tokensTotal) : "—";
```
```ts
    const cost = usage?.costusd ? `$${usage.costusd.toFixed(2)}` : "—";
```

(f) In the `details` section content, remove the two rows:
```tsx
                        <DetailRow label="Tokens" value={tokens} />
```
```tsx
                        <DetailRow label="Cost" value={cost} />
```

(g) Insert the new section into the `sections` array immediately AFTER the `context` section block (after the `...(ctxPct != null ? [ ... ] : [])` entry, before the `subagents` block):
```tsx
        {
            id: "usage",
            label: "Token usage",
            icon: RAIL_ICON.usage,
            content: <TokenUsageSection />,
        },
```

- [ ] **Step 5: Delete the superseded store**

```bash
git rm frontend/app/view/agents/tokenstore.ts
```

- [ ] **Step 6: Typecheck**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
Expected: exit 0. If it flags the unused `type SessionUsage` import in `tokenusagesection.tsx` or a leftover `usage`/`agentTokensAtom`/`formatTokens` reference, remove it and re-run until clean.

- [ ] **Step 7: Run the full frontend test suite (guard against regressions)**

Run: `npx vitest run frontend/app/view/agents/`
Expected: PASS (includes the new `sessionusage.test.ts`; nothing else broken by the `usagestats.ts` export change).

- [ ] **Step 8: Visual verification (live dev app over CDP)**

Prereq: `task dev` running (WebView2 remote-debugging is on in dev per `src-tauri/src/main.rs`).
If no live agent is focused, inject one: `node scripts/inject-live-agents.mjs <scenario>` (see the script header for scenarios), then focus an agent so the detail rail is open.

Run: `node scripts/cdp-shot.mjs C:/Users/kael02/AppData/Local/Temp/claude/token-usage-rail.png`
Confirm in the screenshot: the "Token usage" section renders between "Context window" and "Subagents"; headline token + ≈ spend pair; the two stacked bars; the four-row class table; the by-model block (single model → no per-model bar); colors match the app (input green, output blue). Iterate on the component until it reads correctly at 296px.

- [ ] **Step 9: Stage**

```bash
git add frontend/app/view/agents/transcriptusagestore.ts frontend/app/view/agents/tokenusagesection.tsx frontend/app/view/agents/railicons.tsx frontend/app/view/agents/agentdetailsrail.tsx
git add -u frontend/app/view/agents/tokenstore.ts
```

---

### Task 4: Commit (single, approved)

- [ ] **Step 1: Self-review the staged diff**

Run: `git diff --cached --stat` and `git diff --cached`
Confirm: no debug/commented-out code; generated files only changed by `task generate`; no raw hex colors in `tokenusagesection.tsx`; spec doc included.

- [ ] **Step 2: Stage the spec + this plan (fold-in per git policy)**

```bash
git add docs/superpowers/specs/2026-07-14-per-session-token-usage-design.md docs/superpowers/plans/2026-07-14-per-session-token-usage.md
```

- [ ] **Step 3: Commit — ONLY after explicit approval**

```bash
git commit -m "feat(agents): per-session token-usage breakdown in the detail rail" -m "Per-class (input/output/cache read/write) + per-model tokens and estimated spend for the focused agent, from a new GetTranscriptUsageCommand. Replaces the single Tokens/Cost rows; supersedes tokenstore."
```

---

## Self-Review

**Spec coverage:**
- Backend per-file command → Task 1. ✓
- Pure aggregator (per-class + per-model + spend via usagepricing) → Task 2. ✓
- Loader store with stale-guard → Task 3 Step 1. ✓
- Section component (headline, tokens bar, spend bar, insight, class table, by-model, single-model collapse, footnote, loading/empty states) → Task 3 Step 3. ✓
- Theme-token colors (input green / output blue) → Global Constraints + `CLASS_COLOR`. ✓
- ~15s refresh → Task 3 Step 4(d). ✓
- Remove duplicate Details rows; keep Runtime/Project/Branch/Model/Running/Cache-expires → Task 3 Step 4(e,f). ✓
- Out-of-scope (Context-window redesign, Details "Turns") → not present. ✓
- Tests: Go `TranscriptUsage` + TS `aggregateSessionUsage` → Tasks 1-2; UI has no harness → CDP verify (Task 3 Step 8), consistent with CLAUDE.md. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output.

**Type consistency:** `TranscriptUsage`/`Bucket` (Go) ↔ `UsageBucket` wire ↔ `aggregateSessionUsage`/`SessionUsage`/`SessionModelUsage`/`SessionInsight`/`sessionUsageAtom`/`loadSessionUsage` used consistently across Tasks 1-3. `CLASS_ORDER`/`CLASS_LABEL` exported in Task 2 Step 1 before use. `RAIL_ICON.usage` added in Task 3 Step 2 before use in Step 4(g).
