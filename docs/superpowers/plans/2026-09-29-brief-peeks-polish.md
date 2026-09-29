# Brief Peeks Polish Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/jarvisdossier/`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brief-peeks-polish brief-peek brief-contextual-map`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/brief-peeks-polish/project/Main.dc.html

> **For agentic workers:** implement your one task in your worktree, TDD where the pure model is involved. Steps use
> checkbox (`- [ ]`) syntax. Do not spawn subagents or forks. Never write a `Co-Authored-By` or any other attribution
> trailer into a commit message.

**Goal:** Put the Brief's record peek and graph peek on the brief type scale per the approved mockup, and fix the
duplicated objective, the graph's full-objective printing and the explainer copy.

**Architecture:** The record peek's title/body split moves into the pure `buildRecordPeek` (`briefpeek.ts`, tested
beside it); the views only restyle and render. The graph peek restyles its header and side panel, and its canvas loses
the redundant `SelectionCard`. One new CDP scenario checks the merged result.

**Tech Stack:** React 19, Tailwind 4, jotai, lucide-react, vitest, raw-CDP scenarios (`scripts/cdp/scenarios.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-29-brief-peeks-polish-design.md`. Read it first. The mockup it points at is
the design: `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/brief-peeks-polish/project/Main.dc.html`
(record peek, `REC_TODAY`/`REC_POLISHED`) and `.../Graph.dc.html` (graph peek, `G_TODAY`/`G_POLISHED`, the markup's
`pol` branches). TODAY transcribes today's classes, so TODAY → POLISHED is the change list.

## Global Constraints

- Nothing below 10.5px of text on either peek (icons are sized separately). `text-ink-faint` → `text-muted`.
- Colours only from the `@theme` tokens in `frontend/tailwindsetup.css`. No new tokens, no raw hex or rgba, no emoji.
- Frontend only: no Go or wire-type change; do not change `nodeLabel`.
- Do not touch `frontend/app/view/jarvis/pet*`, `runsheet.tsx`, `briefrunsheet.tsx` (import `SHEET_BTN` only),
  `briefsheet.tsx`, `effortdetailview.tsx`, `inlinetrackerview.tsx`, `chunksidebar.tsx`, `briefrowviews.tsx`,
  `briefsurface.tsx`, or `.superpowers/design/brief-peeks-polish`.
- Unchanged: both peeks' layouts, widths and motion, `ModalShell`, the status picker's rows and notes, the terminal
  confirm, `fleetForRecord` / `fleetCountsLine` / `runRow`, the canvas drawing, physics, zoom controls and legend,
  search matching and `MAX_MATCHES`, the Open run / Open record actions, keybindings.
- `npx tsc` stack-overflows here: typecheck with the Check command above (≈2 minutes; give it a long timeout).
- No jsdom render tests. Pure logic is tested in `.test.ts`; rendered UI is checked by the CDP scenario at Final.
- One owner per file. Task 1 owns `briefpeek.ts`, `briefpeek.test.ts`, `briefpeekview.tsx`; Task 2 owns
  `graphpeek.tsx`, `jarvisgraph.tsx` and every `scripts/cdp/scenarios.mjs` change.

## Review Focus

1. An objective whose single sentence is longer than 180 characters: the title is cut with "…", so the body must still
   show the whole objective. Pinned by the Task 1 test "shows the whole objective when the headline had to cut it".
2. An objective of exactly 400 characters shows no show-full link; 401 does. Pinned by the Task 1 threshold test.
3. Opening a second record while the first one's objective is expanded: the second opens clamped (the open state
   resets on `recordId`, in the same effect as `pickerOpen`). Not unit-testable (view state); Task 1 Step 6 puts
   the reset in that effect, and the reviewer checks it there.
4. A search match of kind `decision` or `memory`: the kind column is `min-w-10`, not `w-10`, so the wider word does
   not run into the label (spec, Graph peek → Matches).
5. A selected node with no status: the kind line shows the kind alone, with no empty status span.

---

### Task 1: Record peek on the brief scale, title/body split

**Depends on:** none

**Files:**
- Modify: `frontend/app/view/jarvis/briefpeek.ts`
- Test: `frontend/app/view/jarvis/briefpeek.test.ts`
- Modify: `frontend/app/view/jarvis/briefpeekview.tsx`

**Interfaces:**
- Consumes: `headline(body: string): string` and `kilo(n: number): string` from `./effortfeed` (existing; import, do
  not copy). `REGION_LABEL`, `MONO_META`, `MONO_FAINT`, `SMALL_BTN` from `./briefstyle`.
- Produces: `RecordPeek.body: string | null`, `RecordPeek.bodyMore: string | null`; `absenceChip`, `footer`,
  `PEEK_ABSENCE_CHIP`, `PEEK_FOOTER` removed. DOM hooks Task 2's scenario reads: `data-jarvis-peek-title` (header
  title span), `data-jarvis-peek-body` (body `<p>`), `data-jarvis-peek-body-toggle` (show-full link). The existing
  `data-jarvis-brief-band="peek"` and `data-jarvis-peek-open-graph` stay.

- [ ] **Step 1: Write the failing tests**

In `briefpeek.test.ts`, change the import to drop `PEEK_ABSENCE_CHIP`:

```ts
import { buildRecordPeek, statusPickerRows, type RecordPeekInput } from "./briefpeek";
```

Replace the test `"titles the peek by its objective and falls back to its id"` with:

```ts
    it("titles the peek by its objective's first sentence and falls back to its id", () => {
        expect(buildRecordPeek(input()).title).toBe("Make attention polling reliable");
        expect(buildRecordPeek(input({ detail: detail({ objective: "Ship it. Then tidy up." }) })).title).toBe(
            "Ship it."
        );
        expect(buildRecordPeek(input({ detail: detail({ objective: "  " }) })).title).toBe("task-a");
    });

    // 126 of the user's 163 records are one sentence: printing it as the title and again as the body said it twice
    it("shows no body when the objective is its own headline", () => {
        const peek = buildRecordPeek(input());
        expect(peek.body).toBeNull();
        expect(peek.bodyMore).toBeNull();
    });

    it("shows the whole objective, paragraphs kept, when it says more than its headline", () => {
        const objective = "Ship it.\n\nThen tidy up the rest.";
        const peek = buildRecordPeek(input({ detail: detail({ objective }) }));
        expect(peek.title).toBe("Ship it.");
        expect(peek.body).toBe(objective);
        expect(peek.bodyMore).toBeNull();
    });

    it("shows the whole objective when the headline had to cut it", () => {
        const objective = "word ".repeat(60).trim();
        const peek = buildRecordPeek(input({ detail: detail({ objective }) }));
        expect(peek.title.endsWith("…")).toBe(true);
        expect(peek.body).toBe(objective);
    });

    it("offers the full objective only past 400 characters, counted in kilo", () => {
        const at = (n: number) => "First sentence. " + "y".repeat(n - 16);
        expect(buildRecordPeek(input({ detail: detail({ objective: at(400) }) })).bodyMore).toBeNull();
        expect(buildRecordPeek(input({ detail: detail({ objective: at(401) }) })).bodyMore).toBe(
            "Show the full objective · 401"
        );
        expect(buildRecordPeek(input({ detail: detail({ objective: at(1216) }) })).bodyMore).toBe(
            "Show the full objective · 1.2k"
        );
    });
```

Replace the test `"falls back from a missing objective to the notes, then to a stated absence"` with:

```ts
    it("falls back from a missing objective to the notes, then to a stated absence, never clamped", () => {
        const notes = buildRecordPeek(input({ detail: detail({ objective: "", notes: "scratch" }) }));
        expect(notes.body).toBe("scratch");
        expect(notes.bodyMore).toBeNull();
        expect(buildRecordPeek(input({ detail: detail({ objective: "", notes: "" }) })).body).toBe(
            "This record states no objective yet."
        );
    });
```

Delete the two tests `"states that a record cannot be messaged"` and `"states the read/write split in its footer"`
(and the comment above the first).

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run frontend/app/view/jarvis/briefpeek.test.ts`
Expected: FAIL: the new title/body tests (`title` is the whole objective, `body` is never null, `bodyMore` is
undefined).

- [ ] **Step 3: Implement the split in `briefpeek.ts`**

Add the import beside the others:

```ts
import { headline, kilo } from "./effortfeed";
```

Delete `PEEK_ABSENCE_CHIP` and `PEEK_FOOTER` with their comment, and add in their place:

```ts
// past this many characters the body is clamped behind a link to the rest; 20 of the user's records cross it
const BODY_CLAMP_CHARS = 400;
```

In `RecordPeek`, replace `body: string;` with the two fields below, and delete `absenceChip` and `footer`:

```ts
    // null when the objective is one sentence: the title already says all of it
    body: string | null;
    // the link that opens a clamped body, or null when the body is short enough to show whole
    bodyMore: string | null;
```

Replace `peekBody` with:

```ts
function peekBody(detail: DossierDetail): { body: string | null; bodyMore: string | null } {
    const objective = detail.objective?.trim() ?? "";
    if (objective === "") {
        const notes = detail.notes?.trim() ?? "";
        return { body: notes !== "" ? notes : "This record states no objective yet.", bodyMore: null };
    }
    if (headline(objective) === objective) {
        return { body: null, bodyMore: null };
    }
    const bodyMore =
        objective.length > BODY_CLAMP_CHARS ? `Show the full objective · ${kilo(objective.length)}` : null;
    return { body: objective, bodyMore };
}
```

In `buildRecordPeek`: set `title: objective !== "" ? headline(objective) : detail.id,`, replace
`body: peekBody(detail),` with `...peekBody(detail),`, and delete the `absenceChip` and `footer` lines. Update the file
header comment: it says the module derives "plus the sentences that state the split"; drop that clause.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run frontend/app/view/jarvis/briefpeek.test.ts`
Expected: PASS.

- [ ] **Step 5: Restyle `briefpeekview.tsx`**

Imports: add `import { Check, ChevronDown, ChevronUp, Waypoints } from "lucide-react";` and
`import { MONO_FAINT, MONO_META, REGION_LABEL, SMALL_BTN } from "./briefstyle";`. Delete `MONO_LABEL`. Add:

```tsx
// LINK_BTN's type and hover without its border: a link inside the body, not a control beside it
const BODY_LINK =
    "inline-flex cursor-pointer items-center gap-1 self-start font-mono text-[10.5px] text-accent-soft hover:text-ink-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
```

`StatusRow`'s mark span becomes:

```tsx
            <span className={cn("inline-flex w-3 flex-none", fg)}>
                {row.current ? <Check size={12} strokeWidth={2.4} className="translate-y-px" /> : null}
            </span>
```

Header, replacing the `record` label through the status toggle:

```tsx
                        <span className={cn(REGION_LABEL, "text-accent-soft")}>record</span>
                        <span
                            data-jarvis-peek-title
                            className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-hi"
                        >
                            {peek != null ? peek.title : <SkeletonLine className="h-[12px] w-[180px]" />}
                        </span>
                        {peek != null ? (
                            <>
                                <span className={cn("flex-none", MONO_FAINT)}>{peek.updatedLabel}</span>
                                <button
                                    type="button"
                                    data-jarvis-peek-status-toggle
                                    aria-label="Change what this record does"
                                    aria-expanded={pickerOpen}
                                    onClick={() => setPickerOpen((v) => !v)}
                                    className={cn(
                                        "inline-flex flex-none cursor-pointer items-center gap-1 rounded-[6px] border border-border bg-surface-raised py-0.5 pl-2 pr-1.5 font-mono text-[10.5px] font-semibold hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                                        STATUS_FG[peek.statusLabel] ?? "text-muted"
                                    )}
                                >
                                    {peek.statusLabel}
                                    <span className="inline-flex text-muted">
                                        {pickerOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                    </span>
                                </button>
                            </>
                        ) : null}
```

- [ ] **Step 6: The body, its clamp, and the open state**

Add state beside `pickerOpen`: `const [objectiveOpen, setObjectiveOpen] = useState(false);` and reset it in the
existing `recordId` effect (the one that resets `pickerOpen`), updating that effect's comment to cover both:

```tsx
    useEffect(() => {
        setPickerOpen(false);
        setPendingStatus(null);
        setObjectiveOpen(false);
    }, [recordId]);
```

Replace `<p className="text-[13px] leading-[1.6] text-ink-mid">{peek.body}</p>` with:

```tsx
                            {peek.body != null ? (
                                <div className="flex flex-col gap-1.5">
                                    <p
                                        data-jarvis-peek-body
                                        className={cn(
                                            "whitespace-pre-line text-[13px] leading-[1.6] text-ink-mid",
                                            peek.bodyMore != null && !objectiveOpen && "line-clamp-4"
                                        )}
                                    >
                                        {peek.body}
                                    </p>
                                    {peek.bodyMore != null ? (
                                        <button
                                            type="button"
                                            data-jarvis-peek-body-toggle
                                            aria-expanded={objectiveOpen}
                                            onClick={() => setObjectiveOpen((v) => !v)}
                                            className={BODY_LINK}
                                        >
                                            {objectiveOpen ? "Show less" : peek.bodyMore}
                                            {objectiveOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                        </button>
                                    ) : null}
                                </div>
                            ) : null}
```

- [ ] **Step 7: Fleet, run rows, log line and the map button**

- Fleet label: `<span className={cn(REGION_LABEL, "text-ink-mid")}>Fleet · on this record</span>`; its meta:
  `<span className={cn("flex-none", MONO_FAINT)}>{peek.fleetMeta}</span>`.
- `RunRowView`: shortId `text-[10px]` → `text-[10.5px]`; headline `text-[12px]` → `text-[12.5px]`; meta
  `font-mono text-[9.5px] text-ink-faint` → `font-mono text-[10.5px] text-muted`; state `text-[9.5px]` →
  `text-[10.5px]`.
- `runsAbsent` div: `text-ink-faint` → `text-muted`.
- Replace everything from the log-line row through the footer span with one row (the absence chip, the map button's
  separate row and the footer go):

```tsx
                            <div className="flex flex-wrap items-center gap-2">
                                {/* a label, not a button: the peek reports the count and the Brief owns the log,
                                    so this states it and stops there. */}
                                <span className={cn("rounded-[6px] border border-edge-faint px-[9px] py-[3px]", MONO_META)}>
                                    {peek.logLine}
                                </span>
                                <span className="flex-1" />
                                {/* The peek's one exit. It closes the peek first: the graph peek is an overlay on the
                                    surface, and leaving the record modal up over it would stack two modals, both
                                    claiming Escape. */}
                                <button
                                    type="button"
                                    data-jarvis-peek-open-graph
                                    onClick={() => {
                                        if (recordId == null) return;
                                        globalStore.set(briefGraphRecordAtom, recordId);
                                        setRecordId(null);
                                        globalStore.set(graphPeekOpenAtom, true);
                                    }}
                                    className={cn(SMALL_BTN, "inline-flex items-center gap-1.5")}
                                >
                                    <Waypoints size={12} className="text-muted" />
                                    Where it sits on the map
                                </button>
                            </div>
```

- Update the file header comment: drop "and the footer says so rather than leaving the reader to wonder what is
  missing"; the sentence before it stands.
- Grep the file for `ink-faint`, `text-[9`, `text-[10px]`, `absenceChip`, `footer`, `MONO_LABEL`: none may remain.

Do not edit `scripts/cdp/scenarios.mjs`: Task 2 owns it, including the `brief-peek` scenario's update for the removed
chip and footer.

- [ ] **Step 8: Typecheck, test, commit**

Run the Check command (`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`, ≈2 min): exit 0.
Run `npx vitest run frontend/app/view/jarvis/briefpeek.test.ts`: PASS.
Run `npx prettier --check frontend/app/view/jarvis/briefpeek.ts frontend/app/view/jarvis/briefpeek.test.ts frontend/app/view/jarvis/briefpeekview.tsx`
and fix only what it flags in these files.

```bash
git add frontend/app/view/jarvis/briefpeek.ts frontend/app/view/jarvis/briefpeek.test.ts frontend/app/view/jarvis/briefpeekview.tsx
git commit -m "feat(jarvis): record peek on the brief scale, titled by its first sentence"
```

### Task 2: Graph peek on the brief scale, no selection card, and the peeks scenario

**Depends on:** none

**Files:**
- Modify: `frontend/app/view/jarvis/graphpeek.tsx`
- Modify: `frontend/app/view/jarvis/jarvisgraph.tsx` (delete `SelectionCard`, lines ~546-548 and ~553-604)
- Modify: `scripts/cdp/scenarios.mjs` (sole owner: `brief-peek` steps 2 and 2b around lines 700-740;
  `brief-contextual-map` step 1 around line 4170; a new scenario after `briefInitiativesPolish` and an entry at the
  end of `SCENARIOS`)

**Interfaces:**
- Consumes: `SubLabel` from `@/app/view/agents/sectionlabel`; `SHEET_BTN` from `./briefrunsheet` (import only);
  `REGION_LABEL` from `./briefstyle`. The scenario reads Task 1's DOM hooks `data-jarvis-peek-title`,
  `data-jarvis-peek-body`, `data-jarvis-peek-body-toggle` (they land when Task 1 merges; the scenario runs at Final on
  the merged result), plus the existing `data-jarvis-brief-band="peek"`, `data-jarvis-peek-open-graph`,
  `data-jarvis-graph-peek`, and `window.__openAddress` (dev hook, `linkingdevhooks.ts`).
- Produces: `data-jarvis-graph-canvas` on the canvas pane; the `brief-peeks-polish` scenario.

- [ ] **Step 1: Confirm `JarvisGraph` has one mount**

Run: `git grep -n "JarvisGraph" -- frontend`
Expected: only `jarvisgraph.tsx` itself and `graphpeek.tsx` (import + `<JarvisGraph />`). If anything else mounts
it, stop and report instead of deleting the card.

- [ ] **Step 2: Delete `SelectionCard` from `jarvisgraph.tsx`**

Delete the `{selectedId ? (<SelectionCard … />) : null}` block and the whole `SelectionCard` function with its comment.
Then, for each identifier the card used (`GLink`, `idOf`, `useThemeColors`, `colors`, `selectedId` and any other),
grep the file: remove an import or local only if nothing else in the file uses it. Also drop any mention of the
selection card or read-out in the file's comments. The canvas drawing, physics, zoom controls and legend are unchanged.

- [ ] **Step 3: Header**

In `graphpeek.tsx` add imports:

```tsx
import { SubLabel } from "@/app/view/agents/sectionlabel";
import { Search, Waypoints } from "lucide-react";
import { SHEET_BTN } from "./briefrunsheet";
import { REGION_LABEL } from "./briefstyle";
```

Replace the header div (the `h-11` one) with:

```tsx
            <div className="flex flex-none items-center gap-2.5 border-b border-edge-faint bg-surface px-4 py-2.5">
                <Waypoints size={14} className="flex-none text-accent-soft" />
                <span className={cn(REGION_LABEL, "text-accent-soft")}>graph</span>
                {/* the count only: a task node's label is its record's whole objective, up to 10k characters */}
                <span className="font-mono text-[10.5px] text-muted">{merged.nodes.length} nodes</span>
                <div className="flex-1" />
                {/* no legend here: the canvas draws one in its bottom-left, sitting with the nodes it
                    labels. Two legends disagreed on case and order for the same four kinds. */}
                <button type="button" onClick={onClose} className={cn(SHEET_BTN, "inline-flex items-center gap-2")}>
                    Close
                    <span className="font-mono text-[10.5px] font-normal text-muted">Esc</span>
                </button>
            </div>
```

Add `data-jarvis-graph-canvas` to the canvas pane: `<div data-jarvis-graph-canvas className="relative min-w-0 flex-1">`.

- [ ] **Step 4: Find box and matches**

Replace the `<input … />` with:

```tsx
                    <div className="relative flex-none">
                        <Search
                            size={13}
                            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
                        />
                        <input
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Find a node…"
                            aria-label="Find a node"
                            className="w-full rounded-[7px] border border-edge-mid bg-background py-1.5 pl-[30px] pr-2.5 text-[12px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                        />
                    </div>
```

- The match-count `<span className="font-mono text-[9.5px] …">` becomes `<SubLabel>` with the same children.
- The match kind span: `"flex-none font-mono text-[9.5px]"` → `"min-w-10 flex-none font-mono text-[10.5px]"`
  (`min-w`, not `w`: `decision` is wider than 40px).
- The overflow line: `font-mono text-[10px]` → `font-mono text-[10.5px]`, text
  `+{matches.length - MAX_MATCHES} more · narrow the filter`.
- The empty hint text becomes `Click a node, or find one above.`

- [ ] **Step 5: Selected node, edges, actions; drop the closing paragraph**

Replace the selected-node block's first `div` with:

```tsx
                            <div className="flex flex-col gap-1.5">
                                <SubLabel>Selected node</SubLabel>
                                <span className="flex gap-2">
                                    <span
                                        className={cn(
                                            "font-mono text-[10.5px] font-semibold",
                                            KIND_TONE[node.kind] ?? "text-muted"
                                        )}
                                    >
                                        {node.kind}
                                    </span>
                                    {node.status ? (
                                        <span className="font-mono text-[10.5px] text-muted">{node.status}</span>
                                    ) : null}
                                </span>
                                {/* clamped: a task's label is its record's whole objective, which pushed Edges and
                                    the Open button off the panel */}
                                <span className="line-clamp-3 text-[13.5px] font-semibold leading-[1.35] text-primary [overflow-wrap:anywhere]">
                                    {node.label}
                                </span>
                            </div>
```

- The "Edges" label becomes `<SubLabel>Edges</SubLabel>`; the edge meta `font-mono text-[10px]` → `text-[10.5px]`.
- The actions label becomes `<SubLabel>Open</SubLabel>`.
- Delete the closing `<p className="mt-auto …">The peek is never a destination…</p>`.
- Grep the file for `text-[9`, `text-[10px]`, `ink-faint`, `◇`, `Graph peek`, `never a destination`: none may remain
  (the file header comment's "never a destination" prose may stay).

- [ ] **Step 6a: Update `brief-peek` steps 2 and 2b**

Task 1 deletes the record peek's absence chip ("Record · you cannot message one.") and footer. In
`scripts/cdp/scenarios.mjs`, `brief-peek`'s `peek` probe (around lines 702-716):

- Replace `fleet: text.includes("Fleet"),` with `fleet: /fleet/i.test(text),` (innerText applies the label's
  uppercase, so the old probe never matched; 2b passed only through the absence chip).
- Delete the `absence:` and `footer:` keys and the comment above them.

Step 2 (around line 718): delete `peek.absence === true &&` and `peek.footer === true &&` from `ok`, and rename the
step to `"2. a record row in the palette opens the peek, with its updated stamp and status toggle"`.

Step 2b (around line 734) becomes:

```js
        steps.push({
            step: "2b. the peek names the record's fleet or says it has none",
            ok: peek != null && peek.fleet === true,
            detail: JSON.stringify({ fleet: peek?.fleet ?? null }),
        });
```

and the comment above it keeps its point but drops any reliance on the absence chip: the fleet band always renders
(its rows, or `runsAbsent`), so its label is what the step reads.

- [ ] **Step 6b: Update `brief-contextual-map` step 1**

In `scripts/cdp/scenarios.mjs`, step 1 of `brief-contextual-map` (around line 4170): `REGION_LABEL` is uppercase, so
innerText reads `GRAPH`. Replace the condition `peek != null && peek.text.includes("Graph peek")` with:

```js
            peek != null && /\bgraph\b/i.test(peek.text) && /\d+ nodes/.test(peek.text),
```

- [ ] **Step 7: Append the `brief-peeks-polish` scenario**

Insert right after the `briefInitiativesPolish` object (before the exported scenario list), reusing its helpers
(`polishNap`, `polishWaitFor`, `polishSweep`, `sweptOk`) and `teardownFixtureRun`:

```js
// --- brief-peeks-polish: the record peek and the graph peek on the brief scale ----------------------
// docs/superpowers/specs/2026-09-29-brief-peeks-polish-design.md. A record whose objective is over 400 characters:
// its peek titles by the first sentence and clamps the rest; the graph peek focused on it prints the objective
// neither in its header nor on the canvas, and keeps Open record on screen. A profile with no such record gets one
// from a deferred run (run creation captures a dossier from the goal); the dossier stays in the vault afterwards,
// as run-sheet-polish's does, since no RPC deletes one.
const PEEKS_LONG = 400;
const PEEKS_GOAL =
    "verify brief-peeks-polish: do nothing, make no file changes, stop immediately. " +
    "This goal is long on purpose, so the record it captures has an objective the peek must clamp. ".repeat(6);
const PEEKS_ESC = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`;
const PEEKS_RECORD = `document.querySelector('[data-jarvis-brief-band="peek"]')`;
const PEEKS_GRAPH = `document.querySelector('[data-jarvis-graph-peek]')`;
const PEEKS_OPEN = `[...(${PEEKS_GRAPH}?.querySelectorAll('button') ?? [])].find((b) => /^open record$/i.test((b.innerText || '').trim()))`;

const briefPeeksPolish = {
    name: "brief-peeks-polish",
    surface: "jarvis",
    async arrange(h) {
        const ctx = {};
        const long = (d) => (d.objective ?? "").trim().length > PEEKS_LONG;
        // a throw past this point still returns ctx, so teardown removes whatever was already made
        try {
            let found = ((await h.rpc("listtaskdossiers", null))?.dossiers ?? []).find(long);
            if (found == null) {
                ctx.cwd = mkdtempSync(join(tmpdir(), "verify-brief-peeks-polish-"));
                const wslist = await h.rpc("workspacelist", null);
                const ch = await h.rpc("createchannel", { name: "verify-brief-peeks-polish", projectpath: ctx.cwd });
                ctx.channelId = ch.oid;
                const created = await h.rpc("createrun", {
                    channelid: ctx.channelId,
                    workspaceid: wslist[0].workspacedata.oid,
                    goal: PEEKS_GOAL,
                    runtime: "claude",
                    mode: "orchestrator",
                    deferstart: true,
                });
                ctx.runId = created.run.id;
                found = ((await h.rpc("listtaskdossiers", null))?.dossiers ?? []).find(
                    (d) => (d.objective ?? "").trim() === PEEKS_GOAL.trim()
                );
            }
            if (found == null) throw new Error("no record has an objective over 400 characters, and seeding made none");
            ctx.recordId = found.id;
            ctx.objective = found.objective.trim();
        } catch (e) {
            ctx.arrangeError = String(e?.message ?? e);
        }
        return ctx;
    },
    async assert(h, ctx) {
        const steps = [];
        const rec = (step, ok, detail) => steps.push({ step, ok, detail });
        if (ctx.arrangeError != null) {
            rec("0. a record with an objective over 400 characters", false, ctx.arrangeError);
            return steps;
        }
        // narrow columns defeat by-name clicks, and verify.mjs clears any earlier override
        await h.cdp("Emulation.setDeviceMetricsOverride", { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
        await h.goto("jarvis");
        await h.ev(PEEKS_ESC);
        await polishNap(400);

        const opened = await h.ev(`(async () => {
            for (let i = 0; i < 20 && typeof window.__openAddress !== "function"; i++) {
                await new Promise((r) => setTimeout(r, 250));
            }
            if (typeof window.__openAddress !== "function") return "no __openAddress hook";
            await window.__openAddress(${JSON.stringify(`task:${ctx.recordId}`)});
            return "ok";
        })()`);
        const shown = await polishWaitFor(h, `!!${PEEKS_RECORD}?.querySelector('[data-jarvis-peek-body]')`, 6000);
        rec("1. the record peek opens on the long record, with a body", opened === "ok" && shown, `opened=${opened} record=${ctx.recordId}`);
        if (!shown) return steps;
        await h.shot("cdp-shots/brief-peeks-polish-1-record.png");

        const text = (sel) => `(${PEEKS_RECORD}?.querySelector('${sel}')?.innerText ?? '').replace(/\\s+/g, ' ').trim()`;
        const split = await h.ev(`({ title: ${text("[data-jarvis-peek-title]")}, body: ${text("[data-jarvis-peek-body]")} })`);
        rec(
            "2. the peek's title is not its body",
            split.title !== "" && split.title !== split.body,
            JSON.stringify({ title: split.title.slice(0, 80), body: split.body.slice(0, 80) })
        );
        const clamped = await h.ev(polishSweep(PEEKS_RECORD));
        rec("3. nothing in the record peek is under 10.5px", sweptOk(clamped), JSON.stringify(clamped));

        const toggled = await h.ev(`(() => {
            const b = ${PEEKS_RECORD}?.querySelector('[data-jarvis-peek-body-toggle]');
            if (!b) return false;
            b.click();
            return true;
        })()`);
        await polishNap(300);
        const expanded = await h.ev(polishSweep(PEEKS_RECORD));
        rec(
            "4. the long objective has a show-full link, and nothing is under 10.5px with it open",
            toggled === true && sweptOk(expanded),
            JSON.stringify({ toggled, expanded })
        );

        await h.ev(`${PEEKS_RECORD}?.querySelector('[data-jarvis-peek-open-graph]')?.click()`);
        const focused = await polishWaitFor(h, `!!${PEEKS_OPEN}`, 8000);
        rec("5. the map button opens the graph peek with the record selected", focused, "");
        if (!focused) return steps;
        await polishNap(800);
        await h.shot("cdp-shots/brief-peeks-polish-2-graph.png");

        // the canvas element holds no text node, so the sweep passes over it
        const graphSweep = await h.ev(polishSweep(PEEKS_GRAPH));
        rec("6. nothing in the graph peek is under 10.5px", sweptOk(graphSweep), JSON.stringify(graphSweep));

        const probe = JSON.stringify(ctx.objective.replace(/\s+/g, " ").slice(0, 40));
        const graph = await h.ev(`(() => {
            const root = ${PEEKS_GRAPH};
            const flat = (el) => (el?.innerText ?? '').replace(/\\s+/g, ' ');
            const pane = root.querySelector('[data-jarvis-graph-canvas]');
            const r = ${PEEKS_OPEN}.getBoundingClientRect();
            return {
                header: flat(root.firstElementChild).includes(${probe}),
                pane: pane != null,
                card: flat(pane).includes(${probe}),
                openInView: r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight,
            };
        })()`);
        rec("7. the graph header prints no objective", graph.header === false, JSON.stringify(graph));
        rec("8. the side panel's Open record button is inside the viewport", graph.openInView === true, JSON.stringify(graph));
        rec("9. the canvas draws no selection card", graph.pane === true && graph.card === false, JSON.stringify(graph));
        return steps;
    },
    async teardown(h, ctx) {
        await h.ev(PEEKS_ESC).catch(() => {});
        await polishNap(300);
        await h.ev(PEEKS_ESC).catch(() => {});
        if (ctx.runId != null) await teardownFixtureRun(h, ctx, "brief-peeks-polish");
    },
};
```

Then add `briefPeeksPolish,` after `briefInitiativesPolish,` at the end of the exported scenario list.

Run `node --check scripts/cdp/scenarios.mjs` (expect no output). The record-peek steps (1-4) depend on Task 1's DOM
hooks, so they fail on this branch alone; the engine runs the scenario at Final on the merged result. Do not start the
dev app to run it here.

- [ ] **Step 8: Typecheck and commit**

Run the Check command (`node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`, ≈2 min): exit 0.
Run `npx prettier --check frontend/app/view/jarvis/graphpeek.tsx frontend/app/view/jarvis/jarvisgraph.tsx` and fix
only what it flags in these files.

```bash
git add frontend/app/view/jarvis/graphpeek.tsx frontend/app/view/jarvis/jarvisgraph.tsx scripts/cdp/scenarios.mjs
git commit -m "feat(jarvis): graph peek on the brief scale; drop the canvas selection card"
```
