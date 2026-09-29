# Run Sheet Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Verify:** `node scripts/verify.mjs ./pkg/util/utilfn/`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs run-sheet-polish surface-smoke`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/run-sheet-polish/project/Main.dc.html

**Goal:** Move the Jarvis run sheet onto the brief type scale: nothing under 10.5px, lucide icons, the shared task strip under the verb, and a compact form of the DAG modal's lifecycle rail in the tasks heading.

**Architecture:** Two independent tasks split by file. Task 1 owns the sheet body (`runsheet.tsx`), its model (`runsheetmodel.ts`, where the meter becomes a strip-or-stale `SheetBar`), the spine icon export in `timelinerail.tsx`, and the CDP scenario. Task 2 owns everything the sheet draws from other files: the header (`briefrunsheet.tsx`, `briefsheet.tsx`), the report (`runreportview.tsx`), the questions card (`childaskcard.tsx`) and the survivors card (`runcards.tsx`). No file is touched by both.

**Tech Stack:** React 19, Tailwind 4 (`@theme` tokens only), jotai, lucide-react, vitest; the CDP scenario harness in `scripts/cdp/`.

**Spec:** `docs/superpowers/specs/2026-09-29-run-sheet-polish-design.md`

## Global Constraints

- The mockup is the design spec. Its script's `POLISHED` table (search `const POLISHED` in the Prototype file) holds the exact values; `TODAY` transcribes today's classes, so their difference is the change list. `RAIL`/`railVM` hold the timeline rows, `meterVM` the bar. Serve it with `python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design` from `C:/Users/kael02/IdeaProjects/waveterm` (if 8766 answers, it is served).
- `REGION_LABEL` (`frontend/app/view/jarvis/briefstyle.ts`) = mono 10.5px bold uppercase, 0.1em tracking. `SectionLabel` (`frontend/app/view/agents/sectionlabel.tsx`) = `REGION_LABEL` in `text-ink-mid`, rendered as an `h3`.
- Nothing on the sheet renders below 10.5px.
- Colours only from the `@theme` tokens in `frontend/tailwindsetup.css`. No new tokens, no raw hex or rgba, no emoji.
- Icons are lucide-react components (already a dependency; see `frontend/app/view/agents/agentrow.tsx` for the import style), `aria-hidden` where a text label sits beside them.
- Frontend only: no wire type, no Go change, no `task generate`.
- Pure logic lives in `.ts` with a `.test.ts` beside it. No jsdom render tests.
- Do not touch `frontend/app/view/jarvis/pet*` (another session's uncommitted work) or `.superpowers/design/run-sheet-polish/`.
- Do not otherwise polish `runbody.tsx`, `runcompletionsurface.tsx`, `runworkercard.tsx`, or `runcards.tsx`'s `BlockedCard`/`TriageChip`.
- Check only the files you touched with `npx prettier --check <paths>` and `npx eslint <paths>`; never `--write` the tree, never prettier `scripts/*.mjs`.

## Review Focus

- A stale read (the digest refresh failed) must still show the dated done/total meter in the dim tone, never the per-task colours: the figures are old. Pinned by Task 1's stale test.
- A run with more than `STRIP_MAX` (24) tasks draws one done/total bar, not 25+ hairline segments. `taskStrip` already returns `{kind:"bar"}` there (tested in `runstrip.test.ts`); Task 1's view must render that branch.
- A quick run, or any run without a `dagoref`: the timeline rows must not be buttons (there is no DAG modal to open), and a run with zero events shows no timeline toggle at all.
- A cancelled or done run with a graph still draws the strip (cancelled tasks as muted segments); a loading or unreadable graph draws no bar. Pinned by Task 1's done/cancelled test and the existing null-meter tests.
- A task that was skipped counts as finished in the strip's label, so "Landing" never sits over "3 of 4 tasks done". Pinned by Task 1's rewritten skipped test.

---

### Task 1: Sheet body — strip, compact timeline, type scale, icons, CDP scenario
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/jarvis/runsheetmodel.ts` (the `SheetTone`/`SheetMeter`/`SheetStatus` types, lines ~36-65; the `meter:` fields in `doneStatus`, `cancelledStatus`, `blockedStatus`, `undaggedStatus`, `daggedStatus`)
- Modify: `frontend/app/view/jarvis/runsheetmodel.test.ts` (the `meter` expectations, lines ~146-335)
- Modify: `frontend/app/view/jarvis/runsheet.tsx`
- Modify: `frontend/app/view/orchestrate/timelinerail.tsx` (`SpineGlyph` ~376, `groupTime` ~405)
- Modify: `scripts/cdp/scenarios.mjs` (append one scenario at the end)

**Interfaces:**
- Produces: `export type SheetBar = { kind: "strip" } | { kind: "stale"; done: number; total: number };` and `SheetStatus.meter: SheetBar | null` in `runsheetmodel.ts`. `export function SpineGlyph({ kind, attention, compact }: { kind: string; attention: boolean; compact?: boolean })` and `export function groupTime(group: EventGroup): string` in `timelinerail.tsx`.
- Consumes: `taskStrip`, `taskStripLabel`, `SEG_FILL` from `frontend/app/view/agents/runstrip.ts`; `groupEvents`, `railRows`, `type EventGroup` from `frontend/app/view/orchestrate/timelinegroups.ts`; `eventTitle`, `tsLabel` from `frontend/app/view/agents/runtimeline.ts`; `SectionLabel` from `frontend/app/view/agents/sectionlabel.tsx`.

- [ ] **Step 1: Rewrite the meter tests to the SheetBar shape (they fail first)**

In `runsheetmodel.test.ts`, add `import { taskStripLabel } from "@/app/view/agents/runstrip";` and change:

```ts
// "reads a healthy run as executing…"
expect(s.meter).toEqual({ kind: "strip" });
// "says Landing when the graph is done…"
expect(s.meter).toEqual({ kind: "strip" });
```

Replace the skipped test's body end:

```ts
    it("counts a skipped task as finished, so Landing never sits over a strip one short", () => {
        const g = group(["done", "skipped", "done", "done"], { status: "done" });
        const s = sheetStatus(
            read({
                dag: {
                    digest: fresh(
                        digest({ next: { kind: "terminal", terminalstatus: "done" } }, { done: 3, running: 0 })
                    ),
                    group: g,
                    groupRead: "ready",
                },
            })
        );
        expect(s.verb).toBe("Landing");
        expect(s.meter).toEqual({ kind: "strip" });
        expect(taskStripLabel(g, undefined)).toBe("4 of 4 tasks done");
    });
```

Stale test:

```ts
        // the digest's own count, not the live group's three, and no per-task colours: the figures are old
        expect(s.meter).toEqual({ kind: "stale", done: 2, total: 4 });
```

Add one test to the `sheetStatus` describe (use the file's existing `run`, `read`, `fresh`, `digest`, `group` helpers):

```ts
    it("draws the strip for a finished or cancelled run with a graph, and no bar without one", () => {
        const dag = { digest: fresh(digest()), group: group(["done", "cancelled"]), groupRead: "ready" as const };
        expect(sheetStatus(read({ run: run({ status: "done" }), dag })).meter).toEqual({ kind: "strip" });
        expect(sheetStatus(read({ run: run({ status: "cancelled" }), dag })).meter).toEqual({ kind: "strip" });
        expect(sheetStatus(read({ run: run({ status: "cancelled" }), dag: null })).meter).toBeNull();
    });
```

The existing `toBeNull()` expectations stay as they are.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run frontend/app/view/jarvis/runsheetmodel.test.ts`
Expected: FAIL on the `{ kind: ... }` expectations (the model still returns `{ done, total, tone }`).

- [ ] **Step 3: Change the model**

In `runsheetmodel.ts`: delete `"dim"` from `SheetTone` (the stale meter was its only producer) and the sentence about it in the comment above; replace `SheetMeter` with

```ts
// The bar under the verb: the shared task strip (runstrip.ts), drawn from the live group. A stale read keeps the
// held digest's dated done/total instead: per-task colours would present old figures as current.
export type SheetBar = { kind: "strip" } | { kind: "stale"; done: number; total: number };

const STRIP: SheetBar = { kind: "strip" };
```

and `meter: SheetBar | null;` in `SheetStatus`. Then `doneStatus` and `cancelledStatus`: `meter: group != null ? STRIP : null`; `daggedStatus`: `const meter = STRIP;` (drop the `SheetMeter` annotation), and the stale branch: `meter: { kind: "stale", done: digest.counts.done, total: digest.counts.total },` (keep its comment). `finishedCount` stays: the subs still use it.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run frontend/app/view/jarvis/runsheetmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Export the spine icon and the time range from timelinerail.tsx**

`SpineGlyph` gains a `compact` prop; the rail's call is unchanged. `groupTime` is exported as is.

```tsx
// the burst's lifecycle icon on the spine; compact is the run sheet's one-line row
export function SpineGlyph({ kind, attention, compact }: { kind: string; attention: boolean; compact?: boolean }) {
    const tone = toneFor(kind);
    let fill = "border-edge-mid bg-surface-raised";
    if (attention) {
        fill = "border-warning/55 bg-warning/10";
    } else if (tone === "text-success") {
        fill = "border-edge-mid bg-success/12";
    }
    const glyph = compact ? 9 : 11;
    return (
        <span className="relative flex w-5 flex-none justify-center">
            <span
                className={cn(
                    "flex items-center justify-center rounded-full border",
                    compact ? "size-4" : "mt-2 size-5",
                    fill,
                    tone
                )}
            >
                <svg
                    width={glyph}
                    height={glyph}
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={compact ? 2.4 : 2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d={GLYPH_PATHS[glyphOf(kind)]} />
                </svg>
            </span>
        </span>
    );
}

export function groupTime(group: EventGroup): string {
```

- [ ] **Step 6: runsheet.tsx — constants, labels, contrast, icons**

Replace `EYEBROW`/`EYEBROW_MID` with `SectionLabel` at "tasks", "what landed", "sealed evidence" (`import { SectionLabel } from "@/app/view/agents/sectionlabel";`). Drop `"dim"` from `TONE_TEXT` and `TONE_BG`. Then:

```tsx
const ROW_BTN =
    "inline-flex h-[22px] flex-none cursor-pointer items-center gap-1 rounded-[5px] border border-edge-mid px-[7px] font-mono text-[10.5px] text-secondary hover:border-edge-strong hover:text-ink-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent";

const ROW_ACTION_LABEL: Record<Exclude<SheetRowAction, null>, string> = {
    "open-agent": "Open in Agent",
    "open-child-run": "View child run",
    "open-dag-task": "Open DAG",
};
```

- Row button: `{ROW_ACTION_LABEL[row.action]}{row.action !== "open-child-run" ? <ArrowUpRight size={11} aria-hidden /> : null}`.
- Row state: `cn("font-mono text-[10.5px] font-semibold", TONE_TEXT[row.stateTone])`.
- Attention chip: `text-[9.5px]` → `text-[10.5px]`, `py-0.5` → `py-px`.
- Tasks-heading meta, the `next: ` prefix, `+N more files`: `text-ink-faint` → `text-muted`.
- Per-file counts: `<span className="font-mono text-[10.5px]"><span className="text-diff-added">+{f.add}</span> <span className="text-diff-removed">−{f.del}</span></span>`.
- Chunk link: `↳ ` → `<CornerDownRight size={11} aria-hidden className="text-muted" />` with the button made `inline-flex items-center gap-1` (keep `truncate` on an inner `<span>` holding the text).
- Every remaining `↗` (open the full timeline, open the repository diff, Open lead, Open in Agent in the dock and in the quick run's empty box): drop the glyph, add `<ArrowUpRight size={11} aria-hidden />` after the text, and give the button `inline-flex items-center gap-1`.

- [ ] **Step 7: runsheet.tsx — the strip under the verb**

Replace the meter block in `Reading` with a `SheetBarView`; `Reading` takes `dag: SheetDagRead | null` (pass it from `RunSheetFrame`).

```tsx
// the shared task strip (the agent tree, the rail and the Cockpit draw the same one); a stale read keeps the
// dated count in the dim tone
function SheetBarView({ bar, dag }: { bar: SheetBar | null; dag: SheetDagRead | null }) {
    if (bar == null) {
        return null;
    }
    if (bar.kind === "stale") {
        if (bar.total === 0) {
            return null;
        }
        return (
            <div
                role="img"
                aria-label={`${bar.done} of ${bar.total} tasks finished`}
                className={cn("flex", bar.total > STRIP_MAX ? "gap-px" : "gap-1")}
            >
                {Array.from({ length: bar.total }, (_, i) => (
                    <span
                        key={i}
                        className={cn("h-1 flex-1 rounded-[2px]", i < bar.done ? "bg-accent-700" : "bg-edge-mid")}
                    />
                ))}
            </div>
        );
    }
    const group = dag?.group ?? undefined;
    const digest = dag?.digest.digest;
    const strip = taskStrip(group, digest);
    if (strip == null) {
        return null;
    }
    return (
        <div role="img" aria-label={taskStripLabel(group, digest)} className="flex h-1 gap-[3px]">
            {strip.kind === "segments" ? (
                strip.states.map((st, i) => (
                    <span key={i} className={cn("h-full min-w-[2px] flex-1 rounded-[2px]", SEG_FILL[st])} />
                ))
            ) : (
                <>
                    <span className="h-full min-w-0 rounded-[2px] bg-success" style={{ flexGrow: strip.done }} />
                    <span
                        className="h-full min-w-0 rounded-[2px] bg-edge-strong"
                        style={{ flexGrow: strip.total - strip.done }}
                    />
                </>
            )}
        </div>
    );
}
```

Imports: `SEG_FILL, STRIP_MAX, taskStrip, taskStripLabel` from `@/app/view/agents/runstrip`; `type SheetBar` from `./runsheetmodel`.

- [ ] **Step 8: runsheet.tsx — the compact timeline**

In `Tasks`: drop `buildRunTimeline`, `eventsCount`, `GroupSection` (and their imports); `const rows = railRows(useMemo(() => groupEvents(events), [events]));`. The toggle renders when `events.length > 0`:

```tsx
<button type="button" aria-expanded={timelineOpen} onClick={() => setTimelineOpen((o) => !o)}
    className={cn(LINK, "inline-flex flex-none items-center gap-1")}>
    {timelineOpen ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
    timeline · {events.length} events
</button>
```

Open, it draws:

```tsx
<div data-run-sheet-timeline className="mb-3 flex flex-col">
    <div className="sc max-h-[230px] overflow-y-auto">
        <div className="relative pb-1.5 pt-0.5">
            <div aria-hidden="true" className="absolute bottom-2 left-[15px] top-2 w-px bg-edge-faint" />
            <div className="relative flex items-center gap-2 py-0.5 pl-[5px] pr-1.5">
                <span className="flex w-5 flex-none justify-center">
                    <span className="size-2 rounded-full bg-accent animate-[pulseDot_1.6s_infinite] motion-reduce:animate-none" />
                </span>
                <span className="font-mono text-[10.5px] text-accent-soft">now · {tsLabel(ctx.now)}</span>
            </div>
            {rows.map((row, i) =>
                row.kind === "gap" ? (
                    <SheetGapRow key={`gap:${i}`} minutes={row.minutes} />
                ) : (
                    <SheetBurstRow key={row.group.id} ctx={ctx} group={row.group} />
                )
            )}
        </div>
    </div>
    {run.dagoref ? (
        <button
            type="button"
            onClick={() => openDagLive(channel.oid, run.id, "dag:" + run.dagoref)}
            className={cn(LINK, "mt-1 inline-flex items-center gap-1 self-start")}
        >
            open the full timeline
            <ArrowUpRight size={11} aria-hidden />
        </button>
    ) : null}
</div>
```

```tsx
function SheetGapRow({ minutes }: { minutes: number }) {
    return (
        <div className="relative flex items-center gap-2 py-0.5 pl-[5px] pr-1.5">
            <span className="flex w-5 flex-none justify-center">
                <span className="size-[5px] rounded-full bg-edge-mid" />
            </span>
            <span className="flex-1 border-t border-dashed border-edge-mid" />
            <span className="font-mono text-[10.5px] text-ink-faint">{minutes} min quiet</span>
            <span className="flex-1 border-t border-dashed border-edge-mid" />
        </div>
    );
}

// one line per burst; the modal keeps the steps, snippet and detail. Without a dag there is no modal to open,
// so the row is plain.
function SheetBurstRow({ ctx, group }: { ctx: SheetCtx; group: EventGroup }) {
    const { channel, run } = ctx;
    const body = (
        <>
            <SpineGlyph kind={group.head.kind} attention={group.attention} compact />
            <span
                className={cn(
                    "min-w-0 truncate text-[12px]",
                    group.attention ? "font-semibold text-warning" : "font-medium text-ink-hi"
                )}
            >
                {eventTitle(group.head)}
            </span>
            {group.taskId ? (
                <span className="flex-none rounded bg-pill px-1.5 font-mono text-[10.5px] leading-4 text-ink-mid">
                    {group.taskId}
                </span>
            ) : null}
            <span className="ml-auto flex-none font-mono text-[10.5px] text-ink-mid">{groupTime(group)}</span>
        </>
    );
    const rowClass = "relative flex w-full items-center gap-2 rounded-[6px] py-[3px] pl-[5px] pr-1.5 text-left";
    if (!run.dagoref) {
        return <div className={rowClass}>{body}</div>;
    }
    const dagOref = "dag:" + run.dagoref;
    return (
        <button
            type="button"
            data-run-sheet-burst={group.taskId || undefined}
            title="Show in the DAG"
            onClick={() =>
                group.taskId
                    ? openDagTask(channel.oid, run.id, dagOref, group.taskId)
                    : openDagLive(channel.oid, run.id, dagOref)
            }
            className={cn(rowClass, "cursor-pointer hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent")}
        >
            {body}
        </button>
    );
}
```

Imports: `groupEvents, railRows, type EventGroup` from `@/app/view/orchestrate/timelinegroups`; `groupTime, SpineGlyph` from `@/app/view/orchestrate/timelinerail`; `eventTitle, tsLabel` from `@/app/view/agents/runtimeline`; `ArrowUpRight, ChevronDown, ChevronRight, CornerDownRight` from `lucide-react`; `useMemo` from react. `runtimelineview.tsx` is not edited.

- [ ] **Step 9: Append the `run-sheet-polish` CDP scenario**

Before `export const SCENARIOS = [`, add a `runSheetPolish` scenario object (`name: "run-sheet-polish"`, `surface: "jarvis"`) and append it as the last entry of `SCENARIOS`. Model it on `cockpit-polish` (the file's last scenario): same arrange/assert/teardown shape, `ctx.arrangeError` captured in arrange and reported as step 0, and `assert` returning `steps` built with its local `rec(step, ok, detail)`.

- Arrange: a temp-dir channel (`createchannel`), an orchestrator run created with `deferstart: true` (`createrun`, as `arrangeFixtureRun` does), then `dagsubmit` with three tasks whose deps chain (`t-1` → `t-2` → `t-3`) so only one worker dispatches — copy the task shape from `dag-lifecycle` (`dagTasks`, near line 3744). Open that run's sheet on the Brief the way existing Jarvis scenarios reach `[data-jarvis-brief-sheet]` (grep `data-jarvis-brief-sheet` in the file), wait up to 15s for `[data-run-sheet] [role="img"]`, then click the timeline toggle (`[data-run-sheet] button[aria-expanded]` whose text starts with "timeline") so the harness's shot shows it open.
- Step 1: the font sweep. Reuse `cockpit-polish`'s sweep verbatim (tree walker over text nodes, range bounding box, visibility/opacity skip, `MIN_FONT_PX`, `{ seen, offenders }`), over two roots: `document.querySelector("[data-run-sheet]")` and `document.querySelector("[data-jarvis-brief-sheet] > header")`. Pass when both roots exist, `seen > 0` and `offenders` is empty; the detail lists the offenders.
- Step 2: the bar. `document.querySelector("[data-run-sheet] [role=img]")?.getAttribute("aria-label")` matches `/^\d+ of \d+ tasks (done|finished)/`.
- Step 3: the timeline opened: `[data-run-sheet-timeline]` exists.
- Teardown: `teardownFixtureRun(h, ctx, "run-sheet-polish")` if you used `arrangeFixtureRun`'s ctx fields (`cwd`, `channelId`, `runId`); otherwise the same best-effort steps: `cancelrun`, `deletechannel`, remove the temp dir.

- [ ] **Step 10: Check**

Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; exit 0 is the baseline)
Run: `npx vitest run frontend/app/view/jarvis/runsheetmodel.test.ts frontend/app/view/agents/runstrip.test.ts frontend/app/view/orchestrate/timelinegroups.test.ts`
Run: `node --check scripts/cdp/scenarios.mjs` (syntax only).
Run: `grep -nE "text-\[([89](\.[0-9])?|10)px\]|↗|↳|▸|▾" frontend/app/view/jarvis/runsheet.tsx` — expected: no output.
Do not start a dev app for the scenario: the Final stage runs `run-sheet-polish` on the merged result, where Task 2's header and cards are in place too (before that merge the font sweep would list them).

- [ ] **Step 11: Commit**

```bash
git add frontend/app/view/jarvis/runsheetmodel.ts frontend/app/view/jarvis/runsheetmodel.test.ts frontend/app/view/jarvis/runsheet.tsx frontend/app/view/orchestrate/timelinerail.tsx scripts/cdp/scenarios.mjs
git commit -m "feat(jarvis): run sheet strip, compact lifecycle timeline, brief type scale" -m "The meter becomes the shared task strip (a stale read keeps its dim dated count), the tasks heading's timeline is the DAG modal's rail drawn one line per burst with the shared spine icon, and nothing on the sheet body is below 10.5px. Adds the run-sheet-polish CDP scenario."
```

### Task 2: Sheet header, report, questions and survivors cards
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/jarvis/briefrunsheet.tsx` (`SheetShell` header, ~lines 75-81)
- Modify: `frontend/app/view/jarvis/briefsheet.tsx` (`ChannelLaunch` label ~171; run steppers ~398-416)
- Modify: `frontend/app/view/jarvis/runreportview.tsx`
- Modify: `frontend/app/view/agents/childaskcard.tsx` (header ~60-68, task id ~77)
- Modify: `frontend/app/view/agents/runcards.tsx` (`CancelSurvivorsCard` header only, ~104-108)

**Interfaces:**
- Consumes: `REGION_LABEL` from `@/app/view/jarvis/briefstyle`; `SectionLabel` from `@/app/view/agents/sectionlabel`; lucide-react icons.
- Produces: nothing other tasks use.

- [ ] **Step 1: The sheet header**

`briefrunsheet.tsx` `SheetShell`:

```tsx
<span className={cn(REGION_LABEL, "text-accent-soft")}>{label}</span>
<span className="min-w-0 truncate text-[13.5px] font-semibold text-ink-hi">{title}</span>
{meta ? <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">{meta}</span> : null}
```

`briefsheet.tsx` `ChannelLaunch`: `<span className={cn(REGION_LABEL, "text-accent-soft")}>run this in {channelProjectLabel(channel, projects)}</span>`. The steppers: `↑` → `<ChevronUp size={13} aria-hidden />`, `↓` → `<ChevronDown size={13} aria-hidden />`; keep `aria-label`, `title`, `STEP_BTN` and the tone logic (make sure `STEP_BTN` centres its content: add `inline-flex items-center justify-center` if it does not already).

- [ ] **Step 2: The report**

`runreportview.tsx`: delete `EYEBROW`; "run report" and each section heading become `<SectionLabel>` (`import { SectionLabel } from "@/app/view/agents/sectionlabel";`). Task tag: `className="flex-none rounded-[5px] border border-edge-mid px-1.5 font-mono text-[10.5px] leading-[17px] text-ink-mid"`. "open the repository diff": drop `↗`, add `<ArrowUpRight size={11} aria-hidden />` after the text, button gets `inline-flex items-center gap-1`. This also reaches `chunksidebar.tsx`'s compact report, which is intended.

- [ ] **Step 3: The questions card**

`childaskcard.tsx` header:

```tsx
<MessageCircleQuestion size={13} aria-hidden className="flex-none text-warning" />
<span className={cn(REGION_LABEL, "text-warning")}>Questions for you</span>
<div className="flex-1" />
<span className="font-mono text-[10.5px] text-muted">{asks.length} waiting</span>
```

Task id line: `font-mono text-[10.5px] text-ink-mid`.

- [ ] **Step 4: The survivors card**

`runcards.tsx` `CancelSurvivorsCard` only:

```tsx
<CircleAlert size={13} aria-hidden className="flex-none text-error" />
<span className={cn(REGION_LABEL, "text-error")}>Cancelled · {n} still running</span>
```

`BlockedCard` and `TriageChip` stay as they are.

- [ ] **Step 5: Check**

Run: `grep -nE "text-\[([89](\.[0-9])?|10)px\]|↗|↑|↓" frontend/app/view/jarvis/briefrunsheet.tsx frontend/app/view/jarvis/briefsheet.tsx frontend/app/view/jarvis/runreportview.tsx frontend/app/view/agents/childaskcard.tsx` — expected: no output. In `runcards.tsx` only `BlockedCard`'s and `TriageChip`'s 9px labels remain.
Run: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (about 2 minutes; exit 0).
Run: `npx vitest run frontend/app/view/jarvis/runreport.test.ts frontend/app/view/agents/childaskmodel.test.ts` (the pure models behind these views; they must stay green).
Run: `npx prettier --check` and `npx eslint` on the five files.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/view/jarvis/briefrunsheet.tsx frontend/app/view/jarvis/briefsheet.tsx frontend/app/view/jarvis/runreportview.tsx frontend/app/view/agents/childaskcard.tsx frontend/app/view/agents/runcards.tsx
git commit -m "feat(jarvis): run sheet header, report, questions and survivors cards on the brief scale" -m "REGION_LABEL and SectionLabel headings, nothing below 10.5px, and lucide icons for the header steppers, the report's diff link, the questions card and the survivors card."
```
