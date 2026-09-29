# Brief Initiatives Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/util/utilfn/`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brief-initiatives-polish surface-smoke`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/brief-initiatives-polish/project/Main.dc.html

**Goal:** Move the Brief's initiative side (row views, inline tracker, Chunk sidebar, activity feed) onto the brief type scale with lucide icons, draw flat plans without a stage header, and turn the activity feed into day- and chunk-grouped one-line entries.

**Architecture:** Task 1 lays the two shared pieces every surface draws on: a `ToneIcon` component exported from `inlinetrackerview.tsx` in place of the `GLYPH` map, and the flat-plan rule (`isFlatPlan`, `trackerRows`) in `inlinetracker.ts`. Then two tasks run side by side on disjoint files: Task 2 polishes the tracker, the row views, `briefsurface.tsx` and the Chunk sidebar; Task 3 replaces the feed's row model with `feedGroups`, rewrites the activity view over it, and adds the CDP scenario.

**Tech Stack:** React 19, Tailwind 4 (`@theme` tokens only), jotai, lucide-react 0.542, vitest; the CDP scenario harness in `scripts/cdp/`.

**Spec:** `docs/superpowers/specs/2026-09-29-brief-initiatives-polish-design.md`

## Global Constraints

- The mockups are the design spec. Each board's script holds `TODAY` and `POLISHED` style tables (search `const POLISHED`); TODAY transcribes today's classes, so **POLISHED minus TODAY is the change list**, and POLISHED holds the exact sizes, weights, colours and icon sizes. Main board: `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/brief-initiatives-polish/project/Main.dc.html` (tracker, row views, sidebar; stage rule in `trackerVM`/`stageMenu`). Activity board: `.../brief-initiatives-polish/project/Activity.dc.html` (feed; `groupedRows`). Serve with `python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design` from `C:/Users/kael02/IdeaProjects/waveterm` (if 8766 answers, it is served). The mockup's hex values are theme tokens transcribed (`#9aa3ad` ink-mid, `#7f858b` muted, `#646a72` ink-faint).
- Colours only from the `@theme` tokens in `frontend/tailwindsetup.css`. No new tokens, no raw hex or rgba, no emoji.
- No font below 10.5px on these surfaces (icons are sized separately).
- Frontend only: no wire type or Go change.
- Pure logic in `.ts` with a `.test.ts` beside it. No jsdom render tests.
- tsconfig `lib` is es6: no `Array.prototype.findLastIndex` / `.at`.
- Do NOT edit: `runsheet.tsx`, `runsheetmodel.ts`, `briefrunsheet.tsx`, `briefsheet.tsx`, `runreportview.tsx`, `childaskcard.tsx`, `runcards.tsx`, `timelinerail.tsx`, `briefpeekview.tsx`, `graphpeek.tsx`, `jarvisgraph.tsx`, `frontend/app/view/jarvis/pet*`, the `run-sheet-polish` scenario. Importing an export from them is fine.
- Check only the files you touched with `npx prettier --check <paths>` and `npx eslint <paths>`; never `--write` the tree.
- Comments explain why, lower case, only where needed; match the surrounding files.

## Review Focus

- A flat plan whose chunks are all done: it must still show every chunk (the old `stageStartsOpen` would have folded it). Pinned in Task 1.
- A stale stage override on a flat plan (`stepTo`/`revealChunk` still write one): ignored, chunks shown. Pinned in Task 1.
- A flat plan's "+ Add chunk": with no header to own the run it must still appear after the last chunk and add to stage "". Task 1 Step 5, checked in the scenario (Task 3).
- A chunk with entries on two days: it gets a heading in each day, not one heading that drags an older entry up. Pinned in Task 3.
- A `chunk-status` event carrying note text must stay an expandable note (with its "marked X · " prefix), not collapse into a bookkeeping line. Pinned in Task 3.

---

### Task 1: Tone icons and the flat-plan rule

**Depends on:** none

**Files:**
- Modify: `frontend/app/view/jarvis/inlinetracker.ts`
- Test: `frontend/app/view/jarvis/inlinetracker.test.ts`
- Modify: `frontend/app/view/jarvis/inlinetrackerview.tsx` (`GLYPH` to `ToneIcon`, its two uses in this file; flat-plan "+ Add chunk")
- Modify: `frontend/app/view/jarvis/chunksidebar.tsx` (only the radiogroup's `GLYPH` use, lines ~210-220, so the tree compiles)

**Interfaces:**
- Produces: `export function isFlatPlan(chunks: { stage: string }[]): boolean` in `inlinetracker.ts`.
- Produces: `export function ToneIcon({ tone, size, className }: { tone: ChunkTone; size?: number; className?: string })` in `inlinetrackerview.tsx`, drawing the lucide icon for the tone in its `TONE_FG` colour. `GLYPH` is deleted. `TONE_FG` stays exported.

- [ ] **Step 1: Write the failing tests** (append to `inlinetracker.test.ts`; add `isFlatPlan` to its import list)

```ts
const FLAT: ChunkRowModel[] = [
    chunk("F1 schema", "done", ""),
    chunk("F2 writer", "done", ""),
    chunk("F3 reader", "done", ""),
];

describe("isFlatPlan", () => {
    it("is flat when no chunk has a stage", () => {
        expect(isFlatPlan(FLAT)).toBe(true);
    });
    it("is staged as soon as one chunk has a stage", () => {
        expect(isFlatPlan([...FLAT, chunk("S1", "pending", "Ticket #1")])).toBe(false);
    });
});

describe("trackerRows on a flat plan", () => {
    it("draws no stage header and shows every chunk, even when all are done", () => {
        const rows = trackerRows({ ...base, chunks: FLAT });
        expect(rows.some((r) => r.kind === "stage")).toBe(false);
        expect(rows.filter((r) => r.kind === "chunk").map((r) => r.id)).toEqual(
            FLAT.map((c) => chunkRowId("initiatives:" + OREF, c.label))
        );
    });

    it("ignores a stage override that says folded", () => {
        const folded = { [stageRowId("initiatives:" + OREF, "", 0)]: false };
        const rows = trackerRows({ ...base, chunks: FLAT, stageOverrides: folded });
        expect(rows.filter((r) => r.kind === "chunk")).toHaveLength(3);
    });

    it("keeps the unstaged run's header once any chunk is staged", () => {
        const mixed = [chunk("S1", "active", "Ticket #1"), chunk("U1", "pending", "")];
        const rows = trackerRows({ ...base, chunks: mixed });
        expect(rows.filter((r) => r.kind === "stage").map((r) => (r.kind === "stage" ? r.stage : ""))).toEqual([
            "Ticket #1",
            "",
        ]);
    });

    it("still walks the flat plan's chunks with the one cursor", () => {
        const nav = trackerNavIds(trackerRows({ ...base, chunks: FLAT }));
        expect(nav).toEqual(["initiatives:" + OREF, ...FLAT.map((c) => chunkRowId("initiatives:" + OREF, c.label))]);
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/inlinetracker.test.ts`
Expected: FAIL (`isFlatPlan` is not exported; the flat plan draws a stage row).

- [ ] **Step 3: Implement the rule in `inlinetracker.ts`**

Add beside `stageStartsOpen`:

```ts
/**
 * A plan with no staged chunk is flat. It draws no stage header: one header over the whole plan would
 * only repeat the initiative row's own fraction, and its folding would hide the plan the row just opened.
 */
export function isFlatPlan(chunks: { stage: string }[]): boolean {
    return chunks.every((c) => c.stage === "");
}
```

In `trackerRows`, after `const next = nextChunk(chunks);`, lift the chunk push into a local and branch on the rule:

```ts
        const pushChunk = (row: ChunkRowModel) =>
            out.push({
                kind: "chunk",
                id: chunkRowId(line.id, row.label),
                oref,
                row,
                notes: noteCounts.get(row.label) ?? 0,
                next: next != null && row.label === next.label,
            });
        if (isFlatPlan(chunks)) {
            chunks.forEach(pushChunk);
            continue;
        }
        groupChunksByStage(chunks).forEach((group, at) => {
            // ...the stage row push, unchanged...
            if (!open) {
                return;
            }
            group.rows.forEach(pushChunk);
        });
```

Update the file's header comment to say stage headers are drawn only for a staged plan.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/inlinetracker.test.ts`
Expected: PASS, including every existing test.

- [ ] **Step 5: Flat-plan "+ Add chunk" in `InitiativeDetail` (`inlinetrackerview.tsx`)**

The `addAfter` map is filled by open stage headers, so a flat plan (no stage row) would lose "+ Add chunk". Widen the map's value to what `AddChunkRow` needs and give a flat plan its one run:

```tsx
    const addAfter = new Map<number, { stage: string; at: number }>();
    // ...the existing loop over stage rows, unchanged...
    // a flat plan has no header to own its run, so its one run ends at its last chunk
    if (!rows.some((r) => r.kind === "stage")) {
        const last = rows.map((r) => r.kind).lastIndexOf("chunk");
        if (last >= 0) {
            addAfter.set(last, { stage: "", at: 0 });
        }
    }
```

`edits.onAddChunk(label, tail.stage, tail.at)` then works unchanged (run 0 of a flat plan is the whole plan).

- [ ] **Step 6: `ToneIcon` in place of `GLYPH`**

In `inlinetrackerview.tsx`, delete `GLYPH` and its comment and add:

```tsx
import { Check, Circle, CircleAlert, Minus, Pause, Play, type LucideIcon } from "lucide-react";

const TONE_ICON: Record<ChunkTone, LucideIcon> = {
    done: Check,
    active: Play,
    blocked: CircleAlert,
    deferred: Pause,
    skipped: Minus,
    // pending reads as an empty circle
    pending: Circle,
};

export function ToneIcon({ tone, size = 12, className }: { tone: ChunkTone; size?: number; className?: string }) {
    const Icon = TONE_ICON[tone];
    return <Icon size={size} strokeWidth={2.25} aria-hidden className={cn("flex-none", TONE_FG[tone], className)} />;
}
```

Replace the three uses (take the icon size for each from POLISHED's `tone(t, size)`; default 12):
- the chunk row's `<span className={cn("w-3 ...", TONE_FG[row.row.tone])}>{GLYPH[row.row.tone]}</span>` becomes `<ToneIcon tone={row.row.tone} />` (keep the 12px-wide slot so rows stay aligned);
- the status menu's `glyph={<span className={TONE_FG[chunkTone(s)]}>{GLYPH[chunkTone(s)]}</span>}` becomes `glyph={<ToneIcon tone={chunkTone(s)} />}`;
- `chunksidebar.tsx`'s radiogroup `<span className={cn("text-[11px] leading-none", on ? TONE_FG[tone] : "text-ink-mid")}>{GLYPH[tone]}</span>` becomes `<ToneIcon tone={tone} className={on ? undefined : "text-ink-mid"} />` (the class passed last wins through `cn`'s tailwind-merge), and its import drops `GLYPH` for `ToneIcon`.

- [ ] **Step 7: Check and commit**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (takes ~2 minutes; give it a 5-minute timeout). Expected: exit 0.
Run: `npx vitest run frontend/app/view/jarvis/inlinetracker.test.ts`. Expected: PASS.

```bash
git add frontend/app/view/jarvis/inlinetracker.ts frontend/app/view/jarvis/inlinetracker.test.ts frontend/app/view/jarvis/inlinetrackerview.tsx frontend/app/view/jarvis/chunksidebar.tsx
git commit -m "feat(jarvis): flat initiatives draw no stage header; chunk tones as lucide icons"
```

### Task 2: Tracker, row views, Brief bits and Chunk sidebar on the brief scale

**Depends on:** Task 1

**Files:**
- Modify: `frontend/app/view/jarvis/inlinetrackerview.tsx`
- Modify: `frontend/app/view/jarvis/briefrowviews.tsx`
- Modify: `frontend/app/view/jarvis/briefsurface.tsx` (the "/" kbd ~L1287, the "refresh failed" line ~L1321, the `<ChunkSidebar` call ~L1799)
- Modify: `frontend/app/view/jarvis/chunksidebar.tsx`
- Modify: `frontend/app/view/jarvis/sidebarnotes.ts` (the note cards' `chev` string)
- Test: `frontend/app/view/jarvis/sidebarnotes.test.ts`

**Interfaces:**
- Consumes: `isFlatPlan` (`inlinetracker.ts`), `ToneIcon`, `TONE_FG` (`inlinetrackerview.tsx`), `SHEET_BTN` (`briefrunsheet.tsx`, import only), `REGION_LABEL` (`briefstyle.ts`).
- Produces: `ChunkSidebar` takes a new required prop `flat: boolean`.

Every value below is POLISHED in Main.dc.html; read it there before each edit.

- [ ] **Step 1: The tracker (`inlinetrackerview.tsx`)**
  - The stage toggle's ▸/▾ and the new-stage placeholder's ▾ become `ChevronRight`/`ChevronDown` (size per POLISHED `stageCaret`), ink-mid.
  - The stage ⋯ button becomes `<Ellipsis size={…} />` (keep the button box).
  - The chunk status button's `<span className="text-[8px] text-muted">▾</span>` becomes `<ChevronDown size={11} className="text-muted" />`.
  - The status menu's `glyph="↑"`, `"↓"`, `"→"` become `<ArrowUp …/>`, `<ArrowDown …/>`, `<ArrowRight …/>` (check `MenuItem`'s `glyph` prop type accepts a node; the tone rows already pass one).
  - "+" on `AddChunkRow` and `NewStageRow` becomes `<Plus …/>` before the text.
  - The unstaged header's menu: when `row.stage === ""`, the ⋯ menu holds only `<MenuItem onClick={() => startEdit(row.id, row.stage)}>Name this stage</MenuItem>`. Real stages keep "Rename stage" and "Delete stage" as today. (A flat plan has no stage row after Task 1, so this `""` header only exists inside a staged plan.)
  - Any remaining font under 10.5px in this file moves to POLISHED's value.

- [ ] **Step 2: The row views (`briefrowviews.tsx`)**
  - `InitiativeRow`'s ▸/▾ become `ChevronRight`/`ChevronDown` (POLISHED `caret`).
  - `RunRowView`'s type badge: `text-[10px]` to `text-[10.5px]`, leading 17px. Its ↳ chunk link becomes `<CornerDownRight size={11} />` before the chunk text (as `runsheet.tsx`'s chunk link does; read it, don't edit it).
  - `ShippedRowView`'s "new" pill (9.5px) and "report" (10px) to POLISHED's 10.5px values.
  - `text-ink-faint` here moves to `text-muted`.

- [ ] **Step 3: The Brief bits (`briefsurface.tsx`)**
  - The "/" search `<kbd>`: `text-[10px]` to `text-[10.5px]`.
  - The "refresh failed" line: `text-[10px]` to `text-[10.5px]`; its ✕ becomes `<X size={12} aria-hidden />` (from lucide-react).
  - The `<ChunkSidebar …>` call gains `flat={isFlatPlan(planChunks)}` (import `isFlatPlan` from `./inlinetracker`; `planChunks` is the open plan's chunk list already in scope; confirm it is the list the sidebar's chunk belongs to).

- [ ] **Step 4: The Chunk sidebar (`chunksidebar.tsx`)**
  - Add `flat: boolean` to the props. The crumb: `{flat ? null : <><span className="text-feed-glyph">/</span><span>{stage || "unstaged"}</span></>}` (the "/" goes with the stage, so a flat plan's crumb is the initiative alone; a staged plan's unstaged chunk keeps "/ unstaged").
  - The ↑/↓ steppers become `ChevronUp`/`ChevronDown` 13px (as `briefrunsheet.tsx`'s header steppers).
  - "j / k": `text-[10px] text-ink-mid` to `text-[10.5px] text-muted`.
  - Close: its class becomes `SHEET_BTN` (11px semibold, text-secondary, px 10), imported from `./briefrunsheet`.
  - The status radiogroup labels: `text-[9.5px]` to `text-[10.5px]`.
  - The "Chunk" and "Notes" labels: `cn(REGION_LABEL, "text-ink-mid")`.
  - The handle's ⧉ becomes `<Copy size={…} />`; "activity ↗" and "open agent session ↗"/"open run ↗" become the text followed by `<ArrowUpRight size={11} />`.
  - Note cards' "more ▾"/"less ▴": the strings come from the pure model. In `sidebarnotes.ts` change
    `chev: newestShort ? "" : open ? "less ▴" : "more ▾"` to `chev: newestShort ? "" : open ? "less" : "more"`, and
    update the three assertions in `sidebarnotes.test.ts` (`"more ▾"` twice to `"more"`, `"less ▴"` to `"less"`); run
    `npx vitest run frontend/app/view/jarvis/sidebarnotes.test.ts` and expect it to FAIL before the model change and
    PASS after. Then in `chunksidebar.tsx` (~L269, `<span className="ml-auto text-muted">{c.chev}</span>`) draw the
    text followed by `{c.open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}` inside that span, only when
    `c.chev !== ""`. Leave `sidebarnotes.ts`'s `stamp` import alone.
  - Any remaining font under 10.5px in this file moves to POLISHED's value; `text-ink-faint` to `text-muted`.

- [ ] **Step 5: Check, look, commit**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (5-minute timeout). Expected: exit 0.
Run: `npx vitest run frontend/app/view/jarvis/inlinetracker.test.ts frontend/app/view/jarvis/sidebarnotes.test.ts`. Expected: PASS.
Run: `grep -nE "text-\[(8|9|9\.5|10)px\]|[▸▾▴⋯↳↗⧉✕]" frontend/app/view/jarvis/{inlinetrackerview,briefrowviews,chunksidebar}.tsx frontend/app/view/jarvis/sidebarnotes.ts`. Expected: no output.
If a dev app is available, screenshot the open initiative and the sidebar (`node scripts/cdp-shot.mjs`) and compare them with Main.dc.html's Polished board.

```bash
git add frontend/app/view/jarvis/inlinetrackerview.tsx frontend/app/view/jarvis/briefrowviews.tsx frontend/app/view/jarvis/briefsurface.tsx frontend/app/view/jarvis/chunksidebar.tsx frontend/app/view/jarvis/sidebarnotes.ts frontend/app/view/jarvis/sidebarnotes.test.ts
git commit -m "feat(jarvis): tracker, row views and chunk sidebar on the brief scale"
```

### Task 3: A grouped activity feed, and the CDP scenario

**Depends on:** Task 1

**Files:**
- Modify: `frontend/app/view/jarvis/effortfeed.ts` (add `feedGroups`, `dayLabel`, `clock`; delete `feedRows`, `FeedRow`; keep `stamp`, which `sidebarnotes.ts` uses)
- Test: `frontend/app/view/jarvis/effortfeed.test.ts` (replace the `feedRows` tests; keep the `stamp` test)
- Do not touch `sidebarnotes.ts` (Task 2 owns it).
- Modify: `frontend/app/view/jarvis/effortdetailview.tsx`
- Modify: `scripts/cdp/scenarios.mjs` (append one scenario)

**Interfaces:**
- Consumes: `ToneIcon`, `TONE_FG` (`inlinetrackerview.tsx`), `chunkTone` (`effortmodel.ts`), `SectionLabel` (`frontend/app/view/agents/sectionlabel.tsx`), `REGION_LABEL` (`briefstyle.ts`).
- Produces:

```ts
export type FeedGroupRow =
    | { kind: "day"; key: string; label: string }
    | { kind: "head"; key: string; chunk: string; status: string }
    | { kind: "note"; key: string; entry: FeedEntry; time: string; marked: string; head: string; body: string; size: string }
    | { kind: "event"; key: string; entry: FeedEntry; time: string; text: string };
export function feedGroups(feed: FeedEntry[], opts: { only: string | null; limit: number; now: number }): { rows: FeedGroupRow[]; left: number };
export function dayLabel(ts: number, now: number): string;
export function clock(ts: number): string;
```

- [ ] **Step 1: Write the failing tests** (in `effortfeed.test.ts`: delete the `describe("feedRows", …)` block, keeping the `stamp` test; swap `feedRows` in the import for `clock`, `dayLabel`, `feedGroups` and `type FeedGroupRow`; keep the `entry`/`added` helpers and `T`, which is Tue 15 Sep 2026 09:05)

```ts
const shape = (rows: FeedGroupRow[]) =>
    rows.map((r) =>
        r.kind === "day" ? `day ${r.label}` : r.kind === "head" ? `head ${r.chunk}` : `${r.kind} ${r.entry.seq}`
    );

describe("dayLabel and clock", () => {
    it("names today, yesterday with its date, and older days by date", () => {
        expect(dayLabel(T, T)).toBe("Today");
        expect(dayLabel(new Date(2026, 8, 14, 23, 0).getTime(), T)).toBe("Yesterday · Mon 14 Sep");
        expect(dayLabel(new Date(2026, 8, 13, 8, 0).getTime(), T)).toBe("Sun 13 Sep");
    });
    it("reads the time of day as HH:MM, whatever the day", () => {
        expect(clock(new Date(2026, 8, 13, 8, 7).getTime())).toBe("08:07");
    });
});

describe("feedGroups", () => {
    it("divides by day, groups by chunk ordered by newest entry, entries newest first", () => {
        const feed = [
            entry(4, T + 4 * MIN, "A"),
            entry(3, T + 3 * MIN, "B"),
            entry(2, T + 2 * MIN, "A"),
            entry(1, new Date(2026, 8, 14, 12, 0).getTime(), "B"),
        ];
        const { rows } = feedGroups(feed, { only: null, limit: 25, now: T });
        expect(shape(rows)).toEqual([
            "day Today",
            "head A",
            "note 4",
            "note 2",
            "head B",
            "note 3",
            "day Yesterday · Mon 14 Sep",
            "head B",
            "note 1",
        ]);
    });

    it("under one chunk draws no headings but keeps the day dividers, and pages the rest", () => {
        const feed = Array.from({ length: 12 }, (_, i) => entry(11 - i, T - i * 60 * MIN, i % 2 === 0 ? "A" : "B"));
        const { rows, left } = feedGroups(feed, { only: "A", limit: 4, now: T });
        expect(rows.some((r) => r.kind === "head")).toBe(false);
        expect(rows.filter((r) => r.kind === "note")).toHaveLength(4);
        expect(rows[0]).toMatchObject({ kind: "day", label: "Today" });
        expect(left).toBe(2);
    });

    it("sets a chunk added and a bare status change as quiet lines, and keeps a status change with a note readable", () => {
        const feed = [
            entry(3, T + 3 * MIN, "A", { kind: "chunk-done", marked: "marked done", text: "Landed. Details follow." }),
            entry(2, T + 2 * MIN, "A", { kind: "chunk-status", marked: "marked active", text: "" }),
            added(1, T + MIN, "A"),
        ];
        const { rows } = feedGroups(feed, { only: null, limit: 25, now: T });
        expect(shape(rows)).toEqual(["day Today", "head A", "note 3", "event 2", "event 1"]);
        expect(rows[3]).toMatchObject({ text: "marked active", time: "09:07" });
        expect(rows[4]).toMatchObject({ text: "chunk added" });
        expect(rows[2]).toMatchObject({ marked: "marked done", head: "Landed.", size: "23" });
    });

    it("heads each note with its first sentence and sizes the whole body", () => {
        const body = "First. " + "x".repeat(1200);
        const { rows } = feedGroups([entry(0, T, "A", { text: body })], { only: null, limit: 25, now: T });
        expect(rows[2]).toMatchObject({ kind: "note", head: "First.", size: "1.2k", body });
    });

    it("carries the chunk's status on its heading", () => {
        const { rows } = feedGroups([entry(0, T, "A", { status: "removed" })], { only: null, limit: 25, now: T });
        expect(rows[1]).toMatchObject({ kind: "head", chunk: "A", status: "removed" });
    });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run frontend/app/view/jarvis/effortfeed.test.ts`
Expected: FAIL (`feedGroups` is not exported).

- [ ] **Step 3: Implement in `effortfeed.ts`**

Delete `FeedRow` and `feedRows` (keep `stamp`: `sidebarnotes.ts` imports it). Add:

```ts
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function clock(ts: number): string {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// the divider above a day's entries; the time column then needs only the time of day
export function dayLabel(ts: number, now: number): string {
    const d = new Date(ts);
    const date = `${WEEKDAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}`;
    if (localDay(ts) === localDay(now)) {
        return "Today";
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return localDay(ts) === localDay(yesterday.getTime()) ? "Yesterday · " + date : date;
}

// a chunk added, or a status change with nothing written: the event itself is all there is to read
const isBookkeeping = (e: FeedEntry) => e.kind === "chunk-added" || (e.kind !== "effort-note" && e.text === "");

export type FeedGroupRow =
    | { kind: "day"; key: string; label: string }
    | { kind: "head"; key: string; chunk: string; status: string }
    | { kind: "note"; key: string; entry: FeedEntry; time: string; marked: string; head: string; body: string; size: string }
    | { kind: "event"; key: string; entry: FeedEntry; time: string; text: string };

/**
 * The feed as a reader scans it: a divider per local day, and inside a day one group per chunk, the groups
 * ordered by their newest entry. The stream interleaves chunks, so grouping is what stops every line from
 * needing its own chunk tag. Under "only" the chunk is already named, so no headings.
 */
export function feedGroups(
    feed: FeedEntry[],
    opts: { only: string | null; limit: number; now: number }
): { rows: FeedGroupRow[]; left: number } {
    const entries = opts.only == null ? feed : feed.filter((e) => e.chunk === opts.only);
    const page = entries.slice(0, opts.limit);
    const rows: FeedGroupRow[] = [];
    const days = [...new Set(page.map((e) => localDay(e.ts)))];
    for (const day of days) {
        const inDay = page.filter((e) => localDay(e.ts) === day);
        rows.push({ kind: "day", key: "day:" + day, label: dayLabel(inDay[0].ts, opts.now) });
        for (const chunk of [...new Set(inDay.map((e) => e.chunk))]) {
            const items = inDay.filter((e) => e.chunk === chunk);
            if (opts.only == null) {
                rows.push({ kind: "head", key: `head:${day}:${chunk}`, chunk, status: items[0].status });
            }
            for (const e of items) {
                const key = String(e.seq);
                if (isBookkeeping(e)) {
                    rows.push({ kind: "event", key, entry: e, time: clock(e.ts), text: e.marked });
                    continue;
                }
                const body = noteBody(e);
                rows.push({
                    kind: "note",
                    key,
                    entry: e,
                    time: clock(e.ts),
                    marked: e.marked,
                    head: headline(body),
                    body,
                    size: kilo(body.length),
                });
            }
        }
    }
    return { rows, left: Math.max(0, entries.length - opts.limit) };
}
```

(`kilo` is declared below `feedRows` today; a `function` declaration hoists, so order does not matter.) Update the file's header comment where it describes the feed's rows.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run frontend/app/view/jarvis/effortfeed.test.ts`
Expected: PASS, including the remaining `effortFeed`, note text, `kilo`, `feedNoteCounts` and `noteAt` tests.

- [ ] **Step 5: The view (`effortdetailview.tsx`) over `feedGroups`**

Replace `FeedLine` and `NotesFeed`'s row loop; values from Activity.dc.html's POLISHED:
- Drop the local `SECTION_LABEL`; "Notes" is `<SectionLabel>Notes</SectionLabel>`. The count beside it, the "only" meta and "show all": 10.5px, `text-muted` (show all keeps its accent colour).
- `day` row: `REGION_LABEL` in `text-ink-mid` with a hairline after it (`flex-1 border-t border-edge-faint`).
- `head` row: a button that calls `setOnly(row.chunk)` (and resets `opened`), holding `<ToneIcon tone={row.status === "removed" ? "skipped" : chunkTone(row.status)} />`, the label (`min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-hi`) and the status (`flex-none text-[10.5px] font-semibold`, lowercase, no `uppercase`) in the tone's `TONE_FG` colour, as POLISHED's `groupedRows` does: skipped and removed (drawn with the skipped tone) read `text-ink-mid`, not the old tag's ink-faint or muted. The local `STATUS_FG`/`statusFg` go if nothing else uses them.
- `note` row, indented under the heading: one button line (`aria-expanded`, `data-jarvis-effort-note={row.key}`) holding the time (`w-[38px] flex-none font-mono text-[10.5px] text-muted`), the marked prefix when `row.marked !== ""` (`font-mono text-[10.5px] text-muted`, `{row.marked} · `), the headline (`min-w-0 flex-1 truncate`, POLISHED's size/colour), the size (`font-mono text-[10.5px] text-muted`) and `ChevronRight`/`ChevronDown` muted. Clicking toggles `opened[row.key]`; when open, the existing `NoteParagraphs` renders `row.body` below the line. Nothing starts open: `newestKey` is gone.
- `event` row: the time column, then `row.text` as `font-mono text-[10.5px] text-muted`; not a button.
- "Show N older · M left" keeps its behaviour; font `text-[10.5px]`, and its left inset follows the new time column.
- The facts row (`text-[10px]`) to 10.5px; fact keys `text-ink-faint` to `text-muted`. Any other `text-ink-faint` or font under 10.5px in the file follows POLISHED.

- [ ] **Step 6: The CDP scenario (`scripts/cdp/scenarios.mjs`)**

Append `briefInitiativesPolish` after `runSheetPolish` in the scenario list, independent of it. Read `briefDesignParity` (fixture reload and wait-for-row pattern, ~L4743) and `briefInlineTracker` (~L4533) first and reuse their helpers.

- `name: "brief-initiatives-polish"`, `surface: "jarvis"`.
- `arrange(h)`: create two efforts with `h.rpc("effortcreate", { title, chunks: [{ label }, …] })` (returns `{ effortoid }`), then shape them with `h.rpc("effortmutate", { effortoid, ops, author: "you" })`:
  - staged, e.g. title "verify initiatives polish · staged": chunks S1, S2, U1; ops `setChunkStage` S1 and S2 to "Stage one" (`{ op: "setChunkStage", chunk, stage }`), U1 left unstaged;
  - flat, e.g. "verify initiatives polish · flat": chunks F1, F2, F3; ops `setChunkStatus` F1 done with a `note` of a few sentences, `setChunkStatus` F2 active with no note (a bookkeeping line), `appendNote` on F2 with a long note.
  - Return `{ staged, flat }` oids. The first `effortcreate` sits inside a try whose catch still returns ctx, so teardown removes what was made.
- `assert(h, ctx)`: go to jarvis (reload first if a briefing fixture is on, as `briefDesignParity` does); wait for both rows by title; then:
  1. click the staged row: `[data-jarvis-initiative-detail] [data-jarvis-tracker-stage]` count is at least 1; sweep the detail.
  2. click the flat row: the detail has no `[data-jarvis-tracker-stage]`, holds 3 `[data-jarvis-tracker-chunk]` and a "+ Add chunk" control; sweep the detail.
  3. click a flat chunk row: `[data-jarvis-chunk-sidebar]` appears and its crumb has no "unstaged"; sweep the sidebar.
  4. click the sidebar's "activity" link: `[data-jarvis-brief-sheet="effort"]` appears; sweep it; check it holds day-divider text "Today" and at least one `[data-jarvis-effort-note]`.
  - The sweep, scoped to one container: every element with a non-whitespace own text node (skip `svg` and its children) whose `parseFloat(getComputedStyle(el).fontSize) < 10.5`; the step fails and lists up to 5 offenders (tag, class, text) in `detail`.
  - `h.shot` after steps 1, 2, 3 and 4 into `cdp-shots/brief-initiatives-polish-*.png`.
- `teardown(h, ctx)`: close the sheet and sidebar, then `h.rpc("effortdelete", { effortoid })` for each oid made (best-effort, per the file's convention).

- [ ] **Step 7: Check and commit**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (5-minute timeout). Expected: exit 0.
Run: `npx vitest run frontend/app/view/jarvis/effortfeed.test.ts`. Expected: PASS.
Run: `node --check scripts/cdp/scenarios.mjs`. Expected: no output.
Run: `grep -nE "text-\[(8|9|9\.5|10)px\]|ink-faint|[▸▾]" frontend/app/view/jarvis/effortdetailview.tsx`. Expected: no output.
If a dev app is running (`CDP_PORT` answers), run `task verify:ui -- brief-initiatives-polish`. Steps 1 and 2 need Task 2's tracker to pass fully; the Final re-runs it on the merged result.

```bash
git add frontend/app/view/jarvis/effortfeed.ts frontend/app/view/jarvis/effortfeed.test.ts frontend/app/view/jarvis/effortdetailview.tsx scripts/cdp/scenarios.mjs
git commit -m "feat(jarvis): initiative activity grouped by day and chunk, one line per entry"
```
