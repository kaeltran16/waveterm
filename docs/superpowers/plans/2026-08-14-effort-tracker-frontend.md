# Effort Tracker — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The effort tracker UI in the cockpit: the briefing gains the two-column cockpit-grid layout with full-width effort cards that expand in place into an inline chunk tracker, plus a paste-and-tick creation form, an efforts-list Stage subject, effort delta rows, and the `effort-tracking` skill file.

**Architecture:** The backend is **already implemented and committed** (806fba5a..fb31e474: Effort waveobj + migration 000016, `EffortCreateCommand`/`EffortMutateCommand`/`EffortGetCommand`/`EffortListCommand`, WorkState `efforts` leg + delta events, `wsh effort` CLI, `wsh jarvis status` efforts line, run↔chunk link). This plan builds only the frontend on that contract. Pure logic lives in `.ts` files with `.test.ts` beside them; components stay thin. The WorkState leg carries summary-only efforts (no notes), so the expanded inline tracker fetches the full effort on demand via `EffortGetCommand`.

**Tech Stack:** React 19, jotai, Tailwind 4 (`@theme` tokens), vitest, generated TS bindings (`wshclientapi.ts`, `gotypes.d.ts`).

## Global Constraints

- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows; baseline is clean — any error is yours).
- FE tests: `npx vitest run frontend/app/view/jarvis/<file>.test.ts`. Test behavior, not internals.
- **No raw hex in components.** Use `@theme` tokens only: `bg-surface` `bg-surface-raised` `bg-surface-hover`, `border-border` `border-edge-mid` `border-edge-strong`, `text-primary` `text-secondary` `text-muted` `text-ink-faint`, `accent` `accent-soft` `accentbg` (`bg-accent/15 text-accent-soft`), `success` (`bg-success/15 text-success`), `asking` (`bg-asking/15 text-asking`).
- Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`). `task generate` after any Go type change (this plan has one: Task 1, no TS shape change).
- Backend wire contract (already implemented, verified against `pkg/wshrpc/wshrpctypes_effort.go` + `pkg/jarvisstate/`):
  - `WorkState.efforts: EffortSummary[]` — top-level, non-archived only, newest-updated first. Fields: `oref, title, project?, ticket?, status, parentoid?, chunks: EffortChunkSummary[], done, total, activechunk?, updatedts`. `EffortChunkSummary`: `label, status, owner?, workrefs?`. **No notes on the wire.**
  - Delta kinds: `effort-created | chunk-done | chunk-added | chunk-status | effort-status | effort-note`. Effort delta events arrive as `TimelineEvent{Title: <effort title>, Detail: <stamp text>, NavTarget: "effort:<oid>"}` — Task 1 fixes the dropped chunk label.
  - RPCs (generated in `wshclientapi.ts`): `EffortCreateCommand(CommandEffortCreateData{title, project?, ticket?, parentoid?, chunks?: {label, owner?}[]})` → `{effortoid}`; `EffortGetCommand({effortoid})` → full `Effort` (with notes + workrefs); `EffortListCommand({project?})`; `EffortMutateCommand({effortoid, ops: EffortOp[], note?})` → `{effort}` (the updated full effort).
  - `EffortOp` fields: `{op, title?, project?, ticket?, status?, parentoid?, chunk?, label?, at?, owner?, kind?, oref?, note?}`. Op strings (from `pkg/jarvisstate/effortops.go`): `rename, setProject, setTicket, setStatus, link, addChunk, removeChunk, renameChunk, moveChunk, setChunkStatus, setOwner, advance, reopen, appendNote, attachWork, detachWork`.
  - `CommandEffortChunkSeed` has **no status field** — the create form's "ticked lines become done" must be create + one atomic batch-mutate of `setChunkStatus` ops.
  - `EffortEvent` (full effort): `{ts, kind, label?, text?}`; `EffortNote`: `{ts, text}`; `ChunkWorkRef`: `{kind, oref}`.
- Tone language (locked design decision, matches the app's `statusChip` semantics — amber is the attention tone and is never used for in-progress):
  - done → `bg-success/15 text-success` (✓) · active → `bg-accent/15 text-accent-soft` (▶) · blocked → `bg-asking/15 text-asking` (!) · deferred → dashed `border-edge-strong`, `text-muted` (⏸) · skipped → strikethrough `text-ink-faint` (–) · pending → `bg-surface-raised text-muted`.
- Layout: two-column cockpit grid (approved): full-width Efforts section on top, Active work | Since last visit + Shipped below, Ask full width above the composer. Active work keeps its Runs / Blocked records / Direct agents subsections as mono sub-labels. Display caps: 6 effort cards / 12 chips (+ "N more" chip) / 8 active rows / 10 delta rows / 8 shipped rows; overflow is a link, never a longer page.
- Progress math: `done / (total − skipped)`; count line shows `"x of y · n skipped"` only when `n > 0`; edge: all skipped → full bar, "all skipped". Deferred counts as remaining.
- Interaction: card click (or chip click) expands the card in place into the inline tracker; "▾ collapse" restores; one effort expanded at a time; chip click expands and scrolls to that chunk's row; hover shows the full trail; done rows offer reopen on hover.
- Preserve `data-jarvis-briefing-section` / `data-jarvis-briefing-row` / `data-row-kind` attributes (verification hooks).
- Comments explain why, not what. KISS — no speculative abstraction.

---

### Task 1: Effort delta events carry the chunk label

**Files:**
- Modify: `pkg/jarvisstate/jarvisstate.go:166-171` (the efforts loop in `Timeline`)
- Test: `pkg/jarvisstate/jarvisstate_effort_test.go` (new file)

**Interfaces:**
- Consumes: `waveobj.EffortEvent{Ts, Kind, Label, Text}` (the backend stores `Label` for chunk-level events — `pkg/jarvisstate/effortops.go:68-73`)
- Produces: `wshrpc.TimelineEvent{Kind, Title: <effort title>, Detail: "<label> · <stamp text>", NavTarget: "effort:<oid>"}` — the label is folded into `Detail` so the FE delta row can name the chunk.

**Why:** `effortEvent` stamps chunk-level events with `Label` set but the `Timeline` projection at `jarvisstate.go:169` drops it (`Detail: ev.Text` only). A "chunk done" delta row would say "Scenario gate clearance — status: done" with no chunk name. The FE renders `Title` (effort) + `Detail` (what happened, which chunk), so the label must ride in `Detail`.

- [ ] **Step 1: Write the failing test**

`pkg/jarvisstate/jarvisstate_effort_test.go`:

```go
package jarvisstate

import (
    "context"
    "testing"

    "github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestTimelineEffortEventsFoldChunkLabel(t *testing.T) {
    eff := &waveobj.Effort{
        OID:   "eff-1",
        Title: "Scenario gate clearance",
        Events: []waveobj.EffortEvent{
            {Ts: 100, Kind: "chunk-done", Label: "Phase 3", Text: "marked done"},
        },
    }
    evs := Timeline(nil, nil, nil, nil, []*waveobj.Effort{eff}, 0)
    if len(evs) != 1 {
        t.Fatalf("expected 1 event, got %d", len(evs))
    }
    ev := evs[0]
    if ev.Title != "Scenario gate clearance" {
        t.Errorf("title = %q, want effort title", ev.Title)
    }
    if ev.Detail != "Phase 3 · marked done" {
        t.Errorf("detail = %q, want %q", ev.Detail, "Phase 3 · marked done")
    }
    if ev.NavTarget != "effort:eff-1" {
        t.Errorf("navtarget = %q, want effort:eff-1", ev.NavTarget)
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm
$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"; go test ./pkg/jarvisstate/ -run TestTimelineEffortEventsFoldChunkLabel -v
```

Expected: FAIL — `detail = "marked done", want "Phase 3 · marked done"`.

- [ ] **Step 3: Fix the projection**

In `pkg/jarvisstate/jarvisstate.go`, the efforts loop (currently):

```go
for _, e := range efforts {
    if e.Status == "archived" {
        continue
    }
    for _, ev := range e.Events {
        add(wshrpc.TimelineEvent{Ts: ev.Ts, Kind: ev.Kind, Project: e.Project, Title: e.Title, Detail: ev.Text, NavTarget: "effort:" + e.OID})
    }
}
```

Change the `Detail` argument:

```go
        detail := ev.Text
        if ev.Label != "" {
            detail = ev.Label + " · " + detail
        }
        add(wshrpc.TimelineEvent{Ts: ev.Ts, Kind: ev.Kind, Project: e.Project, Title: e.Title, Detail: detail, NavTarget: "effort:" + e.OID})
```

- [ ] **Step 4: Run the test to verify it passes**

Same command as Step 2. Expected: PASS. Then run the package suite: `go test ./pkg/jarvisstate/` — existing effort tests (`efforts_leg_test.go`, `effortlink_test.go`, `effortops_test.go`) must stay green.

- [ ] **Step 5: Commit**

```bash
git add pkg/jarvisstate/jarvisstate.go pkg/jarvisstate/jarvisstate_effort_test.go
git commit -m "fix(effort): fold chunk label into delta event detail"
```

---

### Task 2: Effort card model — pure projection logic

**Files:**
- Create: `frontend/app/view/jarvis/effortmodel.ts`
- Create: `frontend/app/view/jarvis/effortmodel.test.ts`
- Modify: `frontend/app/view/jarvis/briefingfixtures.ts`

**Interfaces:**
- Consumes: `EffortSummary` / `EffortChunkSummary` / `TimelineEvent` from `frontend/types/gotypes.d.ts`
- Produces (consumed by Tasks 3, 4, 5, 7):
  - `type ChunkTone = "done" | "active" | "blocked" | "deferred" | "skipped" | "pending"`
  - `function chunkTone(status: string): ChunkTone` — unknown statuses map to `"pending"` (never throw)
  - `type ChunkChip = { label: string; tone: ChunkTone }`
  - `type EffortCardModel = { oref, title, project?, ticket?, status, parentoid?, done, total, remaining, skipped, progressPct, countLine, activeChunk?, chips: ChunkChip[], chipOverflow: number, blockedChunks: string[] }`
  - `function buildEffortCard(e: EffortSummary): EffortCardModel`
  - `function effortDeltaRow(ev: TimelineEvent): { title: string; meta: string } | null` — null for non-effort kinds
  - `const CHUNK_CHIP_CLASSES: Record<ChunkTone, string>` — the token class strings (single source of truth for chips, detail rows, and marks)

- [ ] **Step 1: Write the failing tests**

`frontend/app/view/jarvis/effortmodel.test.ts` (fixtures inline, typed `as EffortSummary` per repo convention — see `jarviscards.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { buildEffortCard, chunkTone, effortDeltaRow } from "./effortmodel";
import type { EffortSummary, TimelineEvent } from "../../../types/gotypes";

const base = {
    oref: "effort:abc",
    title: "Scenario gate clearance",
    status: "active",
    done: 2,
    total: 8,
    activechunk: "Phase 3",
    updatedts: 1000,
    chunks: [
        { label: "Phase 1", status: "done" },
        { label: "Phase 2", status: "done" },
        { label: "Phase 3", status: "active" },
        { label: "Phase 4", status: "deferred" },
        { label: "Phase 5", status: "blocked" },
        { label: "Phase 6", status: "skipped" },
        { label: "Phase 7", status: "pending" },
        { label: "Phase 8", status: "pending" },
    ],
} as EffortSummary;

describe("buildEffortCard", () => {
    it("projects tones and progress with the skip-shrinking denominator", () => {
        const m = buildEffortCard(base);
        expect(m.done).toBe(2);
        expect(m.remaining).toBe(5); // 8 - 2 done - 1 skipped
        expect(m.progressPct).toBe(29); // round(2/7)
        expect(m.countLine).toBe("2 of 7 · 1 skipped · active: Phase 3");
        expect(m.activeChunk).toBe("Phase 3");
        expect(m.chips.map((c) => c.tone)).toEqual([
            "done", "done", "active", "deferred", "blocked", "skipped", "pending", "pending",
        ]);
        expect(m.blockedChunks).toEqual(["Phase 5"]);
    });

    it("caps chips at 12 with an overflow count", () => {
        const chunks = Array.from({ length: 15 }, (_, i) => ({ label: `c${i}`, status: "pending" }));
        const m = buildEffortCard({ ...base, total: 15, chunks } as EffortSummary);
        expect(m.chips).toHaveLength(12);
        expect(m.chipOverflow).toBe(3);
    });

    it("reads as complete when all non-skipped chunks are done", () => {
        const m = buildEffortCard({
            ...base, done: 7, total: 8, chunks: base.chunks.map((c) =>
                c.status === "skipped" ? c : { ...c, status: "done" }),
        } as EffortSummary);
        expect(m.progressPct).toBe(100);
        expect(m.countLine).toBe("7 of 7 · 1 skipped");
    });

    it("handles all-skipped edge", () => {
        const m = buildEffortCard({
            ...base, done: 0, total: 2, chunks: [
                { label: "a", status: "skipped" }, { label: "b", status: "skipped" },
            ],
        } as EffortSummary);
        expect(m.progressPct).toBe(100);
        expect(m.countLine).toBe("all skipped");
    });

    it("omits the skipped suffix when nothing is skipped", () => {
        const m = buildEffortCard({
            ...base, chunks: base.chunks.filter((c) => c.status !== "skipped"), total: 7,
        } as EffortSummary);
        expect(m.countLine).toBe("2 of 7 · active: Phase 3");
    });
});

describe("chunkTone", () => {
    it("maps all six statuses and degrades unknown to pending", () => {
        expect(chunkTone("done")).toBe("done");
        expect(chunkTone("active")).toBe("active");
        expect(chunkTone("blocked")).toBe("blocked");
        expect(chunkTone("deferred")).toBe("deferred");
        expect(chunkTone("skipped")).toBe("skipped");
        expect(chunkTone("pending")).toBe("pending");
        expect(chunkTone("weird")).toBe("pending");
    });
});

describe("effortDeltaRow", () => {
    it("maps effort events to title + meta and ignores others", () => {
        const ev = { ts: 1, kind: "chunk-done", title: "Scenario gate clearance", detail: "Phase 3 · marked done", navtarget: "effort:abc" } as TimelineEvent;
        expect(effortDeltaRow(ev)).toEqual({ title: "Scenario gate clearance", meta: "Phase 3 · marked done" });
        expect(effortDeltaRow({ ts: 1, kind: "run-done", title: "x", detail: "y" } as TimelineEvent)).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/effortmodel.test.ts
```

Expected: FAIL — `effortmodel.ts` does not exist.

- [ ] **Step 3: Implement `effortmodel.ts`**

```ts
import type { EffortSummary, TimelineEvent } from "../../../types/gotypes";

export type ChunkTone = "done" | "active" | "blocked" | "deferred" | "skipped" | "pending";

// single source of truth for chips, detail-row status pills, and mark squares
export const CHUNK_CHIP_CLASSES: Record<ChunkTone, string> = {
    done: "bg-success/15 text-success",
    active: "bg-accent/15 text-accent-soft",
    blocked: "bg-asking/15 text-asking",
    deferred: "text-muted border border-dashed border-edge-strong",
    skipped: "text-ink-faint line-through",
    pending: "bg-surface-raised text-muted",
};

const TONES: Record<string, ChunkTone> = {
    done: "done", active: "active", blocked: "blocked",
    deferred: "deferred", skipped: "skipped", pending: "pending",
};

export function chunkTone(status: string): ChunkTone {
    return TONES[status] ?? "pending";
}

export const CHIP_CAP = 12;

export type ChunkChip = { label: string; tone: ChunkTone };

export type EffortCardModel = {
    oref: string;
    title: string;
    project?: string;
    ticket?: string;
    status: string;
    parentoid?: string;
    done: number;
    remaining: number;
    skipped: number;
    progressPct: number;
    countLine: string;
    activeChunk?: string;
    chips: ChunkChip[];
    chipOverflow: number;
    blockedChunks: string[];
};

// done/(total-skipped): skips shrink the denominator so a finished-by-skipping effort still reads 100%.
// the count line shows "x of y · n skipped" only when something was skipped; all-skipped is a corner.
export function buildEffortCard(e: EffortSummary): EffortCardModel {
    const skipped = e.chunks.filter((c) => c.status === "skipped").length;
    const denominator = Math.max(1, e.total - skipped);
    let countLine: string;
    if (e.total > 0 && skipped === e.total) {
        countLine = "all skipped";
    } else {
        countLine = `${e.done} of ${e.total - skipped}`;
        if (skipped > 0) countLine += ` · ${skipped} skipped`;
        if (e.activechunk) countLine += ` · active: ${e.activechunk}`;
    }
    const pct = skipped === e.total && e.total > 0 ? 100 : Math.round((e.done / denominator) * 100);
    const chips = e.chunks.slice(0, CHIP_CAP).map((c) => ({ label: c.label, tone: chunkTone(c.status) }));
    return {
        oref: e.oref,
        title: e.title,
        project: e.project,
        ticket: e.ticket,
        status: e.status,
        parentoid: e.parentoid,
        done: e.done,
        remaining: Math.max(0, e.total - e.done - skipped),
        skipped,
        progressPct: Math.min(100, pct),
        countLine,
        activeChunk: e.activechunk,
        chips,
        chipOverflow: Math.max(0, e.chunks.length - CHIP_CAP),
        blockedChunks: e.chunks.filter((c) => c.status === "blocked").map((c) => c.label),
    };
}

const EFFORT_DELTA_KINDS = new Set(["effort-created", "chunk-done", "chunk-added", "chunk-status", "effort-status", "effort-note"]);

// delta rows carry Title = effort title, Detail = "<label> · <stamp>" (Task 1 fold)
export function effortDeltaRow(ev: TimelineEvent): { title: string; meta: string } | null {
    if (!EFFORT_DELTA_KINDS.has(ev.kind)) return null;
    return { title: ev.title, meta: ev.detail ?? "" };
}
```

All nine tasks have concrete, typed code — no stubs remain. Typecheck the model file after writing it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/effortmodel.test.ts
```

Expected: PASS. Also `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — clean.

- [ ] **Step 5: Add briefing fixtures**

In `frontend/app/view/jarvis/briefingfixtures.ts`, add an `EFFORT_FIXTURES` export (typed `EffortSummary[]`) with two efforts: "Scenario gate clearance" (8 chunks: 2 done, 1 active, 1 deferred, 1 blocked, 1 skipped, 2 pending — the SIEM example) and "Reflux state-layer migration" (14 pending-ish chunks to exercise the chip cap). Include `oref: "effort:scenario-gate"` and `effort:reflux` (valid non-UUID oids are fine here — these never flow through `ParseORef` server-side; keep `as EffortSummary` casts).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/effortmodel.ts frontend/app/view/jarvis/effortmodel.test.ts frontend/app/view/jarvis/briefingfixtures.ts
git commit -m "feat(effort): effort card projection model"
```

---

### Task 3: Briefing restructure — two-column cockpit grid

**Files:**
- Modify: `frontend/app/view/jarvis/briefingmodel.ts` (add efforts to the projection + display caps)
- Modify: `frontend/app/view/jarvis/briefingmodel.test.ts`
- Modify: `frontend/app/view/jarvis/briefingview.tsx` (layout restructure)

**Interfaces:**
- Consumes: `buildEffortCard`, `EffortCardModel` (Task 2); `snapshot.state.efforts: EffortSummary[]`
- Produces: `projectBriefing` output gains `efforts: EffortCardModel[]` (top 6 by `updatedts`, non-archived), `effortMore: number`, `activeRows: {…}[]` / `activeMore`, `deltaRows` / `deltaMore`, `shippedRows` / `shippedMore` (capped), `attentionLines` (blocked chunks folded in as `"Chunk blocked · <label>"` lines with the effort title)

**Why the model does the capping:** the view stays dumb; caps are testable pure logic. The mockup caps: 8 active rows, 10 delta rows, 8 shipped rows, 6 effort cards.

- [ ] **Step 1: Extend the failing tests**

In `frontend/app/view/jarvis/briefingmodel.test.ts`, add (using `EFFORT_FIXTURES`):

```ts
it("projects efforts, capped at 6, non-archived only", () => {
    const input = { ...baseInput, efforts: EFFORT_FIXTURES } as WorkState;
    const m = projectBriefing({ state: input, agents: [], actualCursor: now, queryStartedAt: now });
    expect(m.efforts.map((e) => e.title)).toEqual(["Scenario gate clearance", "Reflux state-layer migration"]);
    expect(m.effortMore).toBe(0);
});

it("folds blocked chunks into attention lines", () => {
    const input = { ...baseInput, efforts: EFFORT_FIXTURES } as WorkState;
    const m = projectBriefing({ state: input, agents: [], actualCursor: now, queryStartedAt: now });
    expect(m.attentionLines).toContain("Scenario gate clearance — chunk blocked · Phase 5");
});

it("caps delta rows at 10 and counts the overflow", () => {
    const events = Array.from({ length: 12 }, (_, i) => ({
        ts: 1000 + i, kind: "run-created", title: `r${i}`,
    })) as TimelineEvent[];
    const input = { ...baseInput, projects: [{ project: "waveterm", delta: events }] } as WorkState;
    const m = projectBriefing({ state: input, agents: [], actualCursor: now, queryStartedAt: now });
    expect(m.deltaRows).toHaveLength(10);
    expect(m.deltaMore).toBe(2);
});
```

(`projectBriefing(input: BriefingModelInput)` takes one object — `{ state, agents, actualCursor, queryStartedAt }` per `briefingmodel.ts:127-128`. Build `now` the same way the existing tests in this file do, and spread `baseInput` to match their existing fixture shape.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts
```

Expected: FAIL — new assertions on missing fields.

- [ ] **Step 3: Implement the model changes**

In `frontend/app/view/jarvis/briefingstore.ts`, change the timeout const to `export const stateRpcTimeoutMs = 180_000;` (it already exists from the uncommitted timeout fix in the working tree).
- Add to the `projectBriefing` input the efforts from `state.efforts`.
- `const effortCards = (state.efforts ?? []).filter((e) => e.status !== "archived").map(buildEffortCard).sort((a, b) => b.updatedts - a.updatedts)` — sort on the wire is already newest-first; the defensive sort keeps the projection total. Cap: `efforts: effortCards.slice(0, 6)`, `effortMore: Math.max(0, effortCards.length - 6)`.
- Caps for the existing legs (constants at top: `ACTIVE_CAP = 8`, `DELTA_CAP = 10`, `SHIPPED_CAP = 8`): slice each array and expose `*More` counts. Keep the existing count numbers (`counts.*`) as the **uncapped** totals (the section header pill shows the real count; the rows show the cap).
- `attentionLines: string[]` — map `effortCard.blockedChunks` to `` `${card.title} — chunk blocked · ${label}` `` and append to the existing attention banner content. The view renders these as extra lines inside the banner (see Step 4).
- Sort delta by ts desc (already done by the server; keep existing behavior).

- [ ] **Step 4: Restructure `briefingview.tsx`**

Current structure: one column of `<section>` blocks (attention banner → Active work → Since last visit → Shipped → Ask). New structure, keeping every `data-jarvis-briefing-*` attribute and the `RowShell`/row anatomy:

```tsx
<div className={cn(STAGE_SCROLLER, "min-h-0 flex-1")}>
    <div className={cn(STAGE_GUTTER, "flex flex-col gap-4 py-4")} aria-live="polite">
        {/* attention banner: existing block, plus attentionLines rendered as extra
            <span className="block"> lines inside the banner container */}
        {/* Efforts — full width, first section */}
        <section data-jarvis-briefing-section="efforts" className="flex flex-col gap-2">
            <div className="mb-1 flex items-center gap-2">
                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">Efforts</span>
                <span className="rounded-[9px] bg-surface px-1.5 font-mono text-[9.5px] font-semibold text-muted">{efforts.length + effortMore}</span>
                <button type="button" onClick={openCreateForm}
                    className="ml-auto cursor-pointer rounded-[7px] border border-accent/40 bg-accentbg px-2.5 py-1 text-[11px] font-semibold text-accent-soft hover:border-accent/60">
                    + Effort
                </button>
            </div>
            {efforts.length === 0 ? (
                <div className="rounded-[10px] border border-dashed border-edge-strong px-4 py-4 text-center text-[12px] text-muted">
                    <span className="font-medium text-secondary">No efforts yet.</span> Big tasks — a migration,
                    an enablement, a multi-week refactor — get a tracker here. Paste your phase list once,
                    then tick chunks as work lands.
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {efforts.map((e) => <EffortCard key={e.oref} model={e} />)}
                    {effortMore > 0 && (
                        <button type="button" onClick={openEffortsList}
                            className="w-fit cursor-pointer rounded-[7px] px-2.5 py-1 font-mono text-[10.5px] font-semibold text-accent-soft hover:bg-surface-hover">
                            +{effortMore} more
                        </button>
                    )}
                </div>
            )}
        </section>
        {/* two-column grid */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <section className="flex flex-col gap-1" data-jarvis-briefing-section="active">
                {/* existing Active work content, unchanged: Runs / Blocked records / Direct agents
                    mono sub-labels, RowShell rows, then the "N more" link when activeMore > 0 */}
            </section>
            <section className="flex flex-col gap-1">
                {/* existing Since last visit section (day groups, RowShell rows, "see all" link
                    when deltaMore > 0) then existing Shipped section (cap rows, "N more" link) */}
            </section>
        </div>
        {/* Ask section: unchanged, full width */}
    </div>
</div>
```

`EffortCard` and `openCreateForm`/`openEffortsList` are Tasks 4/5/7/8 — for this task, render a placeholder card from `EffortCardModel` (title, count line, progress bar) so the layout is testable, and stub the two nav callbacks with `() => {}` until those tasks land. Delete the placeholder in Task 4.

- [ ] **Step 5: Run tests**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/briefingmodel.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/briefingmodel.ts frontend/app/view/jarvis/briefingmodel.test.ts frontend/app/view/jarvis/briefingview.tsx
git commit -m "feat(effort): two-column briefing layout with efforts section"
```

---

### Task 4: Effort card (resting) + progress bar primitive

**Files:**
- Create: `frontend/app/view/jarvis/effortcard.tsx`
- Create: `frontend/app/view/jarvis/progressbar.tsx`
- Modify: `frontend/app/view/jarvis/briefingview.tsx` (replace the Task 3 placeholder with the real card)

**Interfaces:**
- Consumes: `EffortCardModel`, `ChunkChip`, `CHUNK_CHIP_CLASSES`, `chunkTone` (Task 2)
- Produces: `EffortCard({ model, expanded, onToggle }: { model: EffortCardModel; expanded: boolean; onToggle: () => void })` — expanded rendering is Task 5; this task renders the resting card and the collapsed/expanded shell (expanded body placeholder).

- [ ] **Step 1: Write `progressbar.tsx`** (new primitive — the app has no progress bar today)

```tsx
export function ProgressBar({ pct, className }: { pct: number; className?: string }) {
    return (
        <div className={cn("h-[5px] overflow-hidden rounded-full bg-border", className)}>
            <div
                className="h-full rounded-full bg-gradient-to-r from-accent-600 to-accent transition-[width] duration-[300ms]"
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
        </div>
    );
}
```

- [ ] **Step 2: Write the resting card**

`frontend/app/view/jarvis/effortcard.tsx` — a `<button>` (whole card clickable, `role="button"`, `text-left`):

```tsx
export function EffortCard({ model, expanded, onToggle }: Props) {
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="cursor-pointer rounded-[10px] border border-border bg-surface px-[13px] py-[11px] text-left transition-colors duration-[140ms] hover:bg-surface-hover"
        >
            <span className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-semibold text-primary">{model.title}</span>
                {model.ticket != null && <Tag>{model.ticket}</Tag>}
                {model.project != null && <Tag>{model.project}</Tag>}
                {model.parentoid != null && <Tag>parent</Tag>}
                <span className="ml-auto flex-none font-mono text-[10px] text-muted">
                    {expanded ? "▾ collapse" : model.countLine}
                </span>
            </span>
            <ProgressBar pct={model.progressPct} className="mt-2" />
            <span className="mt-2 flex flex-wrap gap-1">
                {model.chips.map((c) => (
                    <Chip key={c.label} chip={c} />
                ))}
                {model.chipOverflow > 0 && (
                    <span className="inline-flex items-center rounded-full border border-dotted border-accent/40 px-[7px] py-[1px] font-mono text-[9.5px] text-accent-soft">
                        +{model.chipOverflow}
                    </span>
                )}
            </span>
            {expanded && <span className="mt-2 block">…</span> /* Task 5 replaces this */}
        </button>
    );
}
```

`Tag` = `inline-flex rounded-full bg-surface-raised px-[6px] py-[1px] font-mono text-[9.5px] text-muted`; `Chip` = `inline-flex items-center gap-[3px] rounded-full border border-border px-[7px] py-[1px] font-mono text-[9.5px]` + `cn(CHUNK_CHIP_CLASSES[c.tone])`, with the mark glyph per tone (`✓`/`▶`/`!`/`⏸`/`–`/none) and `line-through` inherited from the tone class for skipped. Copyable handle: the header right side also gets a `wsh effort show <oid>` chip with `onClick={(e) => { e.stopPropagation(); void navigator.clipboard.writeText("wsh effort show " + model.oref); }}` (copy the oid only, strip the `effort:` prefix).

- [ ] **Step 3: Wire into the briefing**

Replace the Task 3 placeholder in `briefingview.tsx` with `<EffortCard model={e} expanded={expandedEffort === e.oref} onToggle={() => toggleEffort(e.oref)} />` — `expandedEffort`/`toggleEffort` come from Task 5's store; for this task, use a local `useState<string | null>` and pass it through.

- [ ] **Step 4: Verify**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/effortmodel.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: PASS, tsc clean. Visual check via `task verify:ui -- briefing` (CDP contact sheet) once the dev build is up.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/effortcard.tsx frontend/app/view/jarvis/progressbar.tsx frontend/app/view/jarvis/briefingview.tsx
git commit -m "feat(effort): resting effort card with progress bar"
```

---

### Task 5: Inline expand/collapse — the inline tracker

**Files:**
- Create: `frontend/app/view/jarvis/effortstore.ts`
- Create: `frontend/app/view/jarvis/effortstore.test.ts`
- Modify: `frontend/app/view/jarvis/effortcard.tsx` (expanded body)

**Interfaces:**
- Consumes: `RpcApi.EffortGetCommand` / `RpcApi.EffortMutateCommand` (generated); `Effort`, `EffortOp` types; `chunkTone`, `CHUNK_CHIP_CLASSES` (Task 2)
- Produces:
  - `expandedEffortOrefAtom: Atom<string | null>` — one expanded at a time
  - `effortDetailAtom: Atom<Map<string, Effort>>` — full-effort cache (fetch on expand, replace on mutate rtn)
  - `toggleEffort(oref: string): Promise<void>` — expand (fetch full effort if not cached) or collapse
  - `advanceChunk(oref): Promise<void>` / `setChunkStatus(oref, chunkRef, status)` / `appendNote(oref, chunkRef | null, text)` / `addChunk(oref, label)` / `reopenChunk(oref, chunkRef)` — each builds `EffortOp[]`, calls `EffortMutateCommand`, replaces the cache entry with `rtn.effort`, and calls `loadBriefingAsync()` to refresh the summary leg
  - `effortChunkRows(effort: Effort): ChunkRowModel[]` — pure: `{ label, status, tone, latestNote?: string, trail: {ts, text}[], owner?, workrefs }` (latest note = last `notes` entry, truncated for display)

**Chunk refs:** the mutate ops take a `chunk` ref — always pass the exact label (never 1-based indices) from the FE.

- [ ] **Step 1: Write the failing store tests**

`frontend/app/view/jarvis/effortstore.test.ts` — test the pure reducer-style helpers, not the RPC client (seam: export `applyEffortRtn(cache, oref, effort)` and `buildEffortOps` helpers; the store functions are thin wrappers):

```ts
import { describe, expect, it } from "vitest";
import { effortChunkRows } from "./effortstore";
import type { Effort } from "../../../types/gotypes";

const effort = {
    oid: "abc", version: 3, title: "Scenario gate clearance",
    chunks: [
        { label: "P1", status: "done", notes: [{ ts: 1, text: "marked done" }] },
        { label: "P3", status: "active", notes: [
            { ts: 3, text: "resolver seeded" }, { ts: 2, text: "dry-run pending" }] },
        { label: "P5", status: "blocked", notes: [{ ts: 1, text: "blocked on substrate" }] },
    ],
} as unknown as Effort;

describe("effortChunkRows", () => {
    it("derives latest note per chunk and full trails", () => {
        const rows = effortChunkRows(effort);
        expect(rows[0].latestNote).toBe("marked done");
        expect(rows[1].latestNote).toBe("resolver seeded");
        expect(rows[1].trail).toHaveLength(2);
        expect(rows[2].tone).toBe("blocked");
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/effortstore.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the store**

`frontend/app/view/jarvis/effortstore.ts`:

```ts
export const expandedEffortOrefAtom = atom<string | null>(null);
export const effortDetailAtom = atom<Map<string, Effort>>(new Map());

export type ChunkRowModel = {
    label: string; status: string; tone: ChunkTone;
    latestNote?: string; trail: EffortNote[]; owner?: string; workrefs: ChunkWorkRef[];
};

// notes are append-only; the latest entry is the newest
export function effortChunkRows(effort: Effort): ChunkRowModel[] {
    return effort.chunks.map((c) => {
        const trail = [...(c.notes ?? [])].sort((a, b) => a.ts - b.ts);
        return {
            label: c.label, status: c.status, tone: chunkTone(c.status),
            latestNote: trail.length > 0 ? trail[trail.length - 1].text : undefined,
            trail, owner: c.owner, workrefs: c.workrefs ?? [],
        };
    });
}

async function mutateEffort(oref: string, ops: EffortOp[]): Promise<void> {
    const oid = oref.replace(/^effort:/, "");
    const rtn = await RpcApi.EffortMutateCommand(TabRpcClient, { effortoid: oid, ops }, { timeout: stateRpcTimeoutMs });
    const cache = new Map(globalStore.get(effortDetailAtom));
    cache.set(oref, rtn.effort);
    globalStore.set(effortDetailAtom, cache);
    void loadBriefingAsync(); // summary leg refresh; failure degrades to the next load
}

export async function toggleEffort(oref: string): Promise<void> {
    const cur = globalStore.get(expandedEffortOrefAtom);
    if (cur === oref) {
        globalStore.set(expandedEffortOrefAtom, null);
        return;
    }
    if (!globalStore.get(effortDetailAtom).has(oref)) {
        const oid = oref.replace(/^effort:/, "");
        const rtn = await RpcApi.EffortGetCommand(TabRpcClient, { effortoid: oid }, { timeout: stateRpcTimeoutMs });
        const cache = new Map(globalStore.get(effortDetailAtom));
        cache.set(oref, rtn.effort);
        globalStore.set(effortDetailAtom, cache);
    }
    globalStore.set(expandedEffortOrefAtom, oref);
}

export async function advanceChunk(oref: string, note?: string): Promise<void> {
    await mutateEffort(oref, note != null ? [{ op: "advance", note }] : [{ op: "advance" }]);
}
export async function setChunkStatus(oref: string, chunk: string, status: string, note?: string): Promise<void> {
    await mutateEffort(oref, [{ op: "setChunkStatus", chunk, status, note }]);
}
export async function reopenChunk(oref: string, chunk: string): Promise<void> {
    await mutateEffort(oref, [{ op: "reopen", chunk }]);
}
export async function addChunkOp(oref: string, label: string): Promise<void> {
    await mutateEffort(oref, [{ op: "addChunk", label }]);
}
export async function appendChunkNote(oref: string, chunk: string | null, text: string): Promise<void> {
    await mutateEffort(oref, [{ op: "appendNote", chunk: chunk ?? undefined, note: text }]);
}
```

(`TabRpcClient`, `globalStore`, and the exported `stateRpcTimeoutMs` all come from `briefingstore.ts` — Task 3 adds the export.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/effortstore.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: PASS, tsc clean.

- [ ] **Step 5: Build the expanded body**

In `effortcard.tsx`, replace the Task 4 placeholder with the expanded chunk list (only when `expanded && effort != null`; `effort` comes from `useAtomValue(effortDetailAtom).get(model.oref)`):

```tsx
<div className="mt-2 flex flex-col">
    {rows.map((r, i) => (
        <div key={r.label} id={`chunk-${model.oref}-${i}`}
            className={cn("group flex items-center gap-2.5 rounded-[7px] px-2 py-[5px]",
                i > 0 && "border-t border-edge-faint", highlighted === r.label && "bg-surface-selected")}>
            <Mark tone={r.tone} />
            <span className="min-w-0 flex-1 truncate text-[12px] text-primary">{r.label}</span>
            {r.latestNote != null && (
                <span className="max-w-[30%] truncate text-right font-mono text-[10px] text-muted">{r.latestNote}</span>
            )}
            <span className={cn("flex-none rounded-[4px] px-[5px] py-[1px] font-mono text-[9px] font-semibold uppercase",
                CHUNK_CHIP_CLASSES[r.tone])}>{r.status}</span>
            {r.status === "done" && (
                <button type="button" onClick={(e) => { e.stopPropagation(); void reopenChunk(model.oref, r.label); }}
                    className="hidden cursor-pointer rounded-[4px] border border-border px-1.5 py-[1px] font-mono text-[9px] text-muted group-hover:block hover:text-primary">
                    reopen
                </button>
            )}
        </div>
    ))}
</div>
<div className="mt-2 flex items-center gap-2">
    <button type="button" disabled={model.activeChunk == null}
        onClick={(e) => { e.stopPropagation(); void advanceChunk(model.oref); }}
        className="cursor-pointer rounded-[7px] bg-accent px-3 py-[5px] text-[11px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:opacity-40">
        Mark active chunk done
    </button>
    <button type="button" onClick={(e) => { e.stopPropagation(); setAddingChunk(true); }}
        className="cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[10px] text-secondary hover:border-accent hover:text-primary">
        + chunk
    </button>
    <button type="button" onClick={(e) => { e.stopPropagation(); setNoting(true); }}
        className="cursor-pointer rounded-[6px] border border-border px-2 py-[3px] text-[10px] text-secondary hover:border-accent hover:text-primary">
        note
    </button>
    <span className="ml-auto font-mono text-[9.5px] text-ink-faint">hover a row for its trail · reopen on done rows</span>
</div>
```

Behavior details (local state in the component):
- `Mark` = 14px rounded-[4px] square; tone styling: done = `bg-success/15 border-success/40 text-success` with ✓, active = `border-accent/60 text-accent-soft` with ▶ + `shadow-[0_0_0_3px_rgba(94,156,255,0.12)]`, blocked = amber equivalent with !, deferred = `border-dashed border-edge-strong` with ⏸, skipped = `text-ink-faint` with –, pending = `border-edge-strong` empty.
- **Chip click → expand + scroll:** `onClick` on the card is `onToggle`; chips inside the card must `e.stopPropagation()` and instead call `onChipClick(label)` — the briefing wires `onChipClick` to `toggleEffort(oref)` then `scrollIntoView` on the row (`document.getElementById("chunk-" + oref + "-" + index)`) plus a transient `highlighted` state (`setTimeout` clear, ~1.2s) using `bg-surface-selected`.
- **Hover trail:** the row's `title` attribute gets the full trail rendered as `"07-10 marked done\n07-10 …"` (native tooltip — minimal v1; a styled popover is follow-up).
- **+ chunk:** inline mini-input row appears (a `border-edge-mid bg-background rounded-[7px] px-2 py-1 text-[12px]` input + confirm button); Enter submits `addChunkOp`.
- **note:** inline input + Enter submits `appendChunkNote(oref, activeChunk ?? null, text)` — chunk omitted = effort-level note.
- When the effort detail is still loading, render a `animate-pulse rounded-[8px] bg-surface` row.
- Errors from `mutateEffort` surface inline: `text-[11px] text-error` line under the actions (never silently swallow).

- [ ] **Step 6: Verify**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: all jarvis tests PASS, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/view/jarvis/effortstore.ts frontend/app/view/jarvis/effortstore.test.ts frontend/app/view/jarvis/effortcard.tsx frontend/app/view/jarvis/briefingview.tsx
git commit -m "feat(effort): inline tracker expand/collapse with chunk ops"
```

---

### Task 6: Effort detail Stage subject

**Files:**
- Create: `frontend/app/view/jarvis/effortdetailview.tsx`
- Modify: `frontend/app/view/jarvis/stage.tsx` (register the `effort` subject kind)
- Modify: `frontend/app/view/jarvis/briefingview.tsx` (expanded card header opens the detail subject)

**Interfaces:**
- Consumes: `effortDetailAtom` / `toggleEffort` / `effortChunkRows` (Task 5); `Effort` full type (notes, workrefs, effort-level `notes`)
- Produces: the Stage subject `kind: "effort"` — the full record (all trails, owners, workrefs, edit ops), opened from the expanded card's header (spec UI §4).

- [ ] **Step 1: Register the subject kind**

In `frontend/app/view/jarvis/stage.tsx` the subject switch checks `subject.kind` at three places (`:181` scroll behavior, `:189` project label, `:205-206` snapshot/refresh wiring). Add `"effort"` alongside `"briefing"` at `:181` (scroll as a briefing-style subject) and `:189` (label = the effort title, read from `effortDetailAtom`), and `:205-206` gets no snapshot/refresh (leave as the existing default).

- [ ] **Step 2: Build the detail view**

`effortdetailview.tsx` — same Stage shell as `briefingview` (`STAGE_SCROLLER`/`STAGE_GUTTER`). Given the `effort:…` subject oref:

- Full effort from `effortDetailAtom` (fetch via `toggleEffort` semantics — the store already fetches on demand; if absent, fetch directly with `EffortGetCommand`).
- Header: title 15px semibold + ticket/project tags + "updated <date>" right-aligned (mono 10px muted), `ProgressBar`, count line (reuse `buildEffortCard` on the wire summary — or compute inline from the full effort: same `done/(total−skipped)` math via `buildEffortCard({…} as EffortSummary)`).
- Chunk rows (same anatomy as the expanded card but full width and no truncation): mark square + label + mono sub-line (owner + workrefs) + full trail (all notes, `ts` formatted `MM-DD`, mono 10.5px muted) + status pill; blocked/skipped/deferred tones per `CHUNK_CHIP_CLASSES`.
- Workref line per chunk: `workrefs` rendered as `"loom working here · 4m"` style — mono 10px `text-accent-soft`, one per ref (`<kind>:<oref>`), under the label; no detach affordance in v1 (CLI-only).
- Edit ops (the same store mutations as Task 5): advance button (app primary, disabled without an active chunk), + chunk / note inline inputs, reopen on done rows (hover). All through `mutateEffort`-equivalent store functions — reuse Task 5's exports (`advanceChunk`, `addChunkOp`, `appendChunkNote`, `reopenChunk`, `setChunkStatus`).
- Loading (`animate-pulse` rows), error (text + retry), and archived-effort states follow `briefingview`'s patterns.

- [ ] **Step 3: Open from the expanded card**

In `effortcard.tsx`, the expanded header's count-line area becomes a "details →" affordance: `onClick` (stopPropagation) navigates to the Stage subject — follow how `briefingview` rows call `openORef(model, oref)` with the effort oref (Task 8 wires `orefNavPlan`/`openORef` for `effort:`; until then, stub it behind a `onOpenDetail` prop).

- [ ] **Step 4: Verify**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: all jarvis tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/view/jarvis/effortdetailview.tsx frontend/app/view/jarvis/stage.tsx frontend/app/view/jarvis/effortcard.tsx
git commit -m "feat(effort): effort detail stage subject"
```

---

### Task 7: Create form — paste-and-tick

**Files:**
- Create: `frontend/app/view/jarvis/effortcreateform.tsx`
- Create: `frontend/app/view/jarvis/effortcreateform.test.ts` (pure parse logic)
- Modify: `frontend/app/view/jarvis/briefingview.tsx` (open the modal from "+ Effort")

**Interfaces:**
- Consumes: `RpcApi.EffortCreateCommand`; `CommandEffortChunkSeed` (label + owner only — **no status**); `setChunkStatus` path via `EffortMutateCommand` for ticked lines
- Produces: `parseChunkLines(text: string): { label: string; checked: boolean }[]` (exported, pure), `EffortCreateForm({ onClose }: { onClose: () => void })`

**The ticked-lines gap:** `CommandEffortChunkSeed` has no `status`, so "ticked lines become done at save" = create with all labels, then one atomic `EffortMutateCommand` with `setChunkStatus` ops for the ticked lines (in the same handler, sequentially — two RPCs, failure of the mutate rolls nothing back but the effort exists with all-pending chunks, which is the documented safe fallback).

- [ ] **Step 1: Write the failing parse tests**

`frontend/app/view/jarvis/effortcreateform.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseChunkLines } from "./effortcreateform";

describe("parseChunkLines", () => {
    it("splits lines and defaults unchecked", () => {
        expect(parseChunkLines("Phase 1\nPhase 2 — N1 WAF\n")).toEqual([
            { label: "Phase 1", checked: false },
            { label: "Phase 2 — N1 WAF", checked: false },
        ]);
    });
    it("drops blank lines and trims", () => {
        expect(parseChunkLines("  \nP1  \n\n  P2")).toEqual([
            { label: "P1", checked: false },
            { label: "P2", checked: false },
        ]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/effortcreateform.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the form**

`effortcreateform.tsx` — a modal following `newagentmodal.tsx`'s shell (fixed backdrop, `bg-modalbg` panel, `rounded-[10px] border border-edge-mid`), fields:

- Title (required; inline error `text-error` if empty on submit), Project, Ticket, Parent effort (free-text input, oid or `effort:` oref; passed through as `parentoid` after stripping the prefix).
- Chunks: a `textarea` (mono, `min-h-[130px]`, `border-edge-mid bg-background rounded-[7px] font-mono text-[11px] leading-[1.7]`) bound to text state; below it, the parsed lines render as checkbox rows (`accent-success` checkboxes, `font-mono text-[11.5px]`), live as you type. Parse hint line: `` `${lines.length} chunks · ${lines.filter((l) => l.checked).length} already done` `` (only when `lines.length > 0`).
- Ticked lines stay ticked as done at save: `chunks: lines.map((l) => ({ label: l.label }))`, then `EffortMutateCommand` with `lines.filter((l) => l.checked).map((l) => ({ op: "setChunkStatus", chunk: l.label, status: "done" }))` when non-empty.
- Buttons: primary "Create effort" (`bg-accent text-background rounded-[7px] px-3.5 py-1.5 text-[11.5px] font-semibold`), ghost "Cancel". On success: `onClose()` + `void loadBriefingAsync()`.
- Duplicate labels: disable submit and show `text-error` "duplicate chunk labels" (server would reject with `EC-DUPLICATE-LABEL`; catch it client-side first).
- Error handling: RPC errors render in the modal footer (`text-[11px] text-error`), modal stays open.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/effortcreateform.test.ts
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: PASS, tsc clean.

- [ ] **Step 5: Wire "+ Effort"**

In `briefingview.tsx`, `openCreateForm` (Task 3 stub) sets a `showCreateForm` local state; render `{showCreateForm && <EffortCreateForm onClose={() => setShowCreateForm(false)} />}`.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/effortcreateform.tsx frontend/app/view/jarvis/effortcreateform.test.ts frontend/app/view/jarvis/briefingview.tsx
git commit -m "feat(effort): paste-and-tick effort creation form"
```

---

### Task 8: Navigation — effort subjects, efforts list, delta rows

**Files:**
- Modify: `frontend/app/view/jarvis/openref.ts` (orefNavPlan gains `effort` kind)
- Modify: `frontend/app/view/jarvis/subjects.ts` + `frontend/app/view/jarvis/subjectscolumn.tsx` (Efforts group)
- Create: `frontend/app/view/jarvis/effortslistview.tsx` (Stage subject)
- Modify: `frontend/app/view/jarvis/briefingview.tsx` (effort delta rows clickable; "+N more" → efforts list)

**Interfaces:**
- Consumes: `RpcApi.EffortListCommand`; `effortDeltaRow` (Task 2); `toggleEffort` (Task 5)
- Produces: `effortslistview` Stage subject (`kind: "effort-list"`), the `Efforts` group in the subjects column, effort delta rows with `navtarget "effort:<oid>"` navigating to the briefing with that effort expanded.

- [ ] **Step 1: Extend `orefNavPlan`**

In `frontend/app/view/jarvis/openref.ts`, add an `"effort"` kind to `OrefNav` and its classifier: `oref.startsWith("effort:")` → `{ kind: "effort", oref }`. Extend `openORef` (see `openref.ts:44-80` for the existing dispatch): for `kind === "effort"`, navigate to the Work briefing subject and call `toggleEffort(oref)` (expand; if already expanded this is a no-op) — reusing the Stage subject switch the briefing rows use.

- [ ] **Step 2: Efforts group in the subjects column**

Follow `buildSubjectGroups`/`filterSubjectGroups` in `subjects.ts` (`subjectscolumn.tsx:68-74`): add an `Efforts` group listing `state.efforts` (from `briefingStateAtom`) — each item `{ label: e.title, oref: e.oref }`, navigable via the same `openORef`. Only render the group when `efforts.length > 0`. `subjectscolumn.tsx` renders groups generically from `visibleSubjectGroups` — verify the item shape matches `col-item` rows and add the group key to any group-allowlist/collapse state.

- [ ] **Step 3: Efforts list Stage subject**

`effortslistview.tsx`: a Stage subject (same shell as `briefingview` — `STAGE_SCROLLER`/`STAGE_GUTTER`) that loads `EffortListCommand({})` on mount and renders one row per effort (RowShell anatomy: title 12.5px medium, mono meta = count line from `buildEffortCard`, right-side status chip). Click → `openORef(oref)` (which expands it in the briefing). Loading/error/empty states follow `briefingview`'s patterns (`animate-pulse` rows; error text + retry). Register the subject in `stage.tsx` beside the Task 6 `"effort"` kind (a sibling `"effort-list"` kind with the same `:181`/`:189` treatment).

- [ ] **Step 4: Delta rows + "N more" links**

In `briefingview.tsx`'s Since last visit section, map rows through `effortDeltaRow` for kind-based meta formatting (non-effort rows keep the existing `d.wording` path); rows with `navtarget "effort:…"` already navigate via `openORef` once Step 1 lands — verify `orefNavPlan(d.oref).kind !== "unsupported"` still guards correctly. The efforts section's "+N more" button (Task 3) now opens the efforts-list Stage subject instead of being a stub.

- [ ] **Step 5: Verify**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit
```

Expected: all jarvis tests PASS, tsc clean. Existing `openref.test.ts` / `subjects.test.ts` suites must be extended with the new kind/group and stay green.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/openref.ts frontend/app/view/jarvis/subjects.ts frontend/app/view/jarvis/subjectscolumn.tsx frontend/app/view/jarvis/effortslistview.tsx frontend/app/view/jarvis/briefingview.tsx
git commit -m "feat(effort): effort navigation, subjects group, efforts list"
```

---

### Task 9: Skill file + sync step

**Files:**
- Create: `pi/skills/effort-tracking/SKILL.md`
- Modify: `Taskfile.yml` (`sync:piartifacts` — add a skills copy step)

**Interfaces:**
- Consumes: the `wsh effort` CLI (committed)
- Produces: the agent-facing skill (description + full command reference), installed to `~/.claude/skills/effort-tracking/SKILL.md`

- [ ] **Step 1: Write the skill**

`pi/skills/effort-tracking/SKILL.md` — frontmatter per the existing `pi/skills/arc-dev/SKILL.md` conventions:

```markdown
---
name: effort-tracking
description: Use when a task is too big for one run, when tracking multi-part work, or when brainstorming a large effort — creates and updates Wave effort trackers via `wsh effort`.
---
```

Body: create-at-design-approval step, the full `wsh effort` command reference (from `cmd/wsh/cmd/wshcmd-effort.go` — the committed CLI: create/list/show/rename/project/ticket/status/link/unlink/delete, chunk add/rename/move/remove/status/note/owner, advance, reopen, chunk attach/detach, `--json` shapes), and ticking conventions: agents claim a chunk with `wsh effort chunk attach --agent <tabid>`, tick `setChunkStatus done` only when the work is actually complete, annotate with `--note`, advance moves the marker, reopen undoes.

- [ ] **Step 2: Extend `sync:piartifacts`**

In `Taskfile.yml` (after the extension copies, around line 189), add:

```yaml
            - cmd: cp pi/skills/effort-tracking/SKILL.md "$HOME/.claude/skills/effort-tracking/SKILL.md"
```

(`$HOME` expansion works in the existing `cp` invocations; mkdir the target first if the dir does not exist.)

- [ ] **Step 3: Verify**

```bash
cd C:/Users/kael02/IdeaProjects/waveterm && task sync:piartifacts && ls ~/.claude/skills/effort-tracking/
```

Expected: the skill file is installed. Sanity-check the command list against `wsh effort --help` output (build via `task build:backend`, run `dist/bin/wsh effort --help`).

- [ ] **Step 4: Commit**

```bash
git add pi/skills/effort-tracking/SKILL.md Taskfile.yml
git commit -m "feat(effort): effort-tracking skill + sync step"
```

---

## Cross-cutting verification (run before declaring done)

```bash
cd C:/Users/kael02/IdeaProjects/waveterm
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit          # clean
npx vitest run frontend/app/view/jarvis/                                     # all jarvis tests pass
$env:CGO_CFLAGS="-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"; go test ./pkg/jarvisstate/   # Task 1 + existing
task verify:ui -- briefing                                                       # visual: cards, expand, form
```

## Out of scope (tracked in the spec's Deferred section)

- Launch-modal / composer effort pickers (second UI slice; agents claim chunks via CLI attach meanwhile).
- Bounding the runs + dossiers WorkState legs (pre-existing, adjacent optimization).
- Workrefs on the agent card ("on: <chunk> · <effort>") and the run completion "Mark chunk done" offer — these belong to the deferred picker slice.
- Styled trail popover (v1 uses the native title tooltip).
