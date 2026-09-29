# Cockpit Surface Polish Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/util/utilfn/`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs cockpit-polish surface-smoke`
**Prototype:** C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/cockpit-polish/project/Main.dc.html

> **For agentic workers:** Implement your one task in your worktree, TDD where a pure model is involved.
> Steps use checkbox (`- [ ]`) syntax. Do not spawn subagents or forks.

**Goal:** Bring the Cockpit surface to the approved cockpit-polish mockups: the 10.5px type floor, lucide icons,
chips that say what they count, and the tree's Workflow mark and task strip on the lead card.

**Architecture:** Restyle the existing Cockpit components in place under `frontend/app/view/agents/`. The two
bits of real logic (the lead mark's state, the chip labels) are pure functions in the existing `*model.ts` files
with tests beside them. The lead card's progress bar switches to the shared `runstrip.ts`. Frontend only.

**Tech Stack:** React 19, Tailwind 4, jotai, lucide-react, vitest, Node ESM CDP scripts (`scripts/cdp`).

**Spec:** `C:/Users/kael02/IdeaProjects/waveterm/docs/superpowers/specs/2026-09-29-cockpit-polish-design.md`.
Read it first. Its decisions are numbered; each task names the ones it owns.

## Global Constraints

- The mockups are the spec. Open `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/cockpit-polish/project/Main.dc.html`
  and `Cards.dc.html` (serve with `python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design`
  from the main checkout at `C:/Users/kael02/IdeaProjects/waveterm`; if 8766 answers they are served). In each
  board's script, `const TODAY` transcribes today's classes and `const POLISHED` holds the target values: **the
  difference between the two is your change list.** Take exact sizes, paddings and colours from POLISHED.
- Nothing on the Cockpit renders below 10.5px. `REGION_LABEL` (`frontend/app/view/jarvis/briefstyle.ts`) is the
  eyebrow; use `SectionLabel` / `SubLabel` (`frontend/app/view/agents/sectionlabel.tsx`) where they fit. Tailwind's
  `text-xxs` (10px) and `text-xxxs` (8.5px) are below the floor too.
- Colours only from the `@theme` tokens in `frontend/tailwindsetup.css`. No new tokens, no raw hex or rgba, no emoji.
- Icons from `lucide-react` (already a dependency; see `agenttree.tsx` for usage). Decorative icons get `aria-hidden`.
- Do not change handlers, keybindings, layout, grid, tabs, motion, the narration feed, the open composer, the
  Adjust/Cancel panels, or the Tell input.
- No jsdom render tests. Pure logic in `.ts` with a `.test.ts` beside it.
- Do not touch `frontend/app/view/jarvis/pet*` (another session's files) or `.superpowers/design/cockpit-polish/`.
- Check formatting only on the files you touched (`npx prettier --check <files>`); never `--write` the tree.
- Commit messages carry no `Co-Authored-By` or other attribution trailer.

## Review Focus

- A run with no plan yet (dag undefined): the lead card must render no bar, not an empty `role="img"`. Task 1's "lead card bar" test pins `vm.bar` undefined.
- A run past 24 tasks: one done/total bar, still `role="img"` with the "N of M tasks done" label. Task 1's "lead card bar" test pins the `bar` kind and label.
- One subagent: the chip reads "1 subagent", not "1 subagents". Task 2's `subagentsLabel` test pins it.
- A worker that asked the lead with no deadline: the row shows the ArrowRight + "lead" with no trailing " · ". Task 1's model test pins `tag` undefined with `toLead: true`.
- A cancelled or "lead wrapping up" run: the lead mark must not turn green. Task 1's `leadMark` tests pin both.

---

### Task 1: Lead card, its model, and StatusLine
**Depends on:** none

Owns spec decisions 1 (lead card items, card name, project chip), 3 (lead card icons, the `→ lead` tag, the lead
card's banner dot), 4, 5, 6, 7.

**Files:**
- Modify: `frontend/app/view/agents/leadcardmodel.ts`, `frontend/app/view/agents/leadcardmodel.test.ts`
- Modify: `frontend/app/view/agents/leadcard.tsx`
- Modify: `frontend/app/view/agents/statusline.tsx`

**Interfaces:**
- Produces: `StatusLine` gains `mark?: ReactNode` (replaces its `QuietDot` when given). `leadcardmodel.ts` exports
  `leadMark(run: RunInfo, lead: AgentVM | undefined): { tone: "success" | "accent" | "warning" | "muted"; pulse: boolean }`.
  `TaskRowVM` gains `toLead?: boolean`. `LeadCardVM` loses `segs` and gains `complete: boolean` and
  `bar?: { strip: TaskStrip; label: string }` (`TaskStrip` from `runstrip.ts`; undefined when there is no plan).

- [ ] **Step 1: Write the failing model tests** in `leadcardmodel.test.ts`, reusing its `task()` / `runInfo()` helpers:

```ts
describe("leadMark", () => {
    const leadOf = (over: Partial<AgentVM> = {}) => ({ id: "l", name: "lead", state: "working", ...over }) as AgentVM;
    // runmodel.test.ts builds runComplete's cases the same way: run status + land + dag status
    const ended = (status: string, dagStatus: string, land?: RunLand): RunInfo => {
        const r = runInfo([task("t-1", "done")]);
        return { ...r, status, land, dag: { ...r.dag!, status: dagStatus } };
    };
    const MUTED = { tone: "muted", pulse: false };
    it("is green and still only when the run is complete", () => {
        expect(leadMark(ended("done", "done", { state: "landed" } as RunLand), leadOf({ state: "idle" }))).toEqual({
            tone: "success",
            pulse: false,
        });
        expect(leadMark(ended("done", "done"), leadOf({ state: "working" }))).toEqual({ tone: "success", pulse: false });
    });
    it("is not green for a cancelled run, a lead wrapping up, or a held land", () => {
        expect(leadMark(ended("cancelled", "cancelled"), leadOf({ state: "idle" }))).toEqual(MUTED);
        expect(leadMark(ended("finalizing", "done"), leadOf({ state: "working" }))).toEqual({ tone: "accent", pulse: true });
        expect(leadMark(ended("done", "done", { state: "held" } as RunLand), leadOf({ state: "idle" }))).toEqual(MUTED);
    });
    it("is muted with no lead", () => {
        expect(leadMark(runInfo([task("t-1", "running")]), undefined)).toEqual(MUTED);
    });
    it("is muted while the lead stands by", () => {
        expect(leadMark(runInfo([task("t-1", "running")]), leadOf({ atPrompt: true }))).toEqual(MUTED);
    });
    it("pulses accent while working and warning while asking", () => {
        const run = runInfo([task("t-1", "running")]);
        expect(leadMark(run, leadOf({ state: "working" }))).toEqual({ tone: "accent", pulse: true });
        expect(leadMark(run, leadOf({ state: "asking" }))).toEqual({ tone: "warning", pulse: true });
        expect(leadMark(run, leadOf({ state: "idle" }))).toEqual(MUTED);
    });
});

describe("lead card bar", () => {
    it("draws nothing before a plan exists", () => {
        expect(buildLeadCard(input({ ...runInfo([]), dag: undefined })).bar).toBeUndefined();
    });
    it("draws one segment per task, labelled with the done count", () => {
        const vm = buildLeadCard(input(runInfo([task("t1", "done"), task("t2", "running"), task("t3", "pending")])));
        expect(vm.bar).toEqual({
            strip: { kind: "segments", states: ["done", "working", "pending"] },
            label: "1 of 3 tasks done",
        });
    });
    it("becomes one done/total bar past STRIP_MAX tasks", () => {
        const tasks = Array.from({ length: 30 }, (_, i) => task(`t${i}`, i < 12 ? "done" : "pending"));
        const vm = buildLeadCard(input(runInfo(tasks)));
        expect(vm.bar).toEqual({ strip: { kind: "bar", done: 12, total: 30 }, label: "12 of 30 tasks done" });
    });
});
```

`RunLand` is an ambient global from `frontend/types/gotypes.d.ts`: no import is needed. Check the segment states
against `runSegments` (`runrail.ts`) and `runstrip.test.ts` before fixing the expected arrays; the expectations
must match what `taskStrip` returns, not a guess. Change the existing test at the `→ lead · 4m left` expectation to
`{ needsYou: false, toLead: true, tag: "4m left", actions: ["takeover"] }`, and add a case with no deadline
expecting `toLead: true` and `tag` undefined. Assert `vm.complete` for a landed run and that `vm` has no `segs`.

- [ ] **Step 2: Run them and see them fail:** `npx vitest run frontend/app/view/agents/leadcardmodel.test.ts`

- [ ] **Step 3: Implement the model.** In `leadcardmodel.ts`:

```ts
// the lead's Workflow mark, coloured as the agent tree colours it (agenttree.tsx MARK_COLOR): green only when the run is complete
export function leadMark(run: RunInfo, lead: AgentVM | undefined): { tone: LeadMarkTone; pulse: boolean } {
    if (runComplete(run)) return { tone: "success", pulse: false };
    if (lead == null || leadStandingBy(lead, run)) return { tone: "muted", pulse: false };
    if (lead.state === "working") return { tone: "accent", pulse: true };
    if (lead.state === "asking") return { tone: "warning", pulse: true };
    return { tone: "muted", pulse: false };
}
```

(`export type LeadMarkTone = "success" | "accent" | "warning" | "muted"`; import `runComplete` from `./runmodel`.)
The asked-the-lead row becomes `{ ...base, toLead: true, sub: join(task.id, "asked the lead"), tag: left || undefined, actions: ["takeover"] }`.
In `buildLeadCard` drop `segs`, add `complete: runComplete(run)` and
`bar: strip ? { strip, label: taskStripLabel(dag, run.digest) } : undefined` with `strip = taskStrip(dag, run.digest)`
(import both from `./runstrip`). Run the tests; they pass.

- [ ] **Step 4: StatusLine.** Add `mark?: ReactNode`; render `mark ?? <QuietDot …/>`. Name: `font-mono` → `font-sans`
(13.5px semibold `text-primary` stays). Project chip and the runtime mark: `text-[10px]` → `text-[10.5px]`.

- [ ] **Step 5: Lead card header.** Delete the `◆` span. Pass `mark={<Workflow size={13} aria-hidden className={cn(MARK_TONE[m.tone], m.pulse && PULSE)} />}`
to `StatusLine`, with `m = leadMark(run, lead)` and `MARK_TONE: Record<LeadMarkTone, string>` mapping to `text-success`
/ `text-accent` / `text-warning` / `text-muted` (`PULSE` as in `agenttree.tsx`). The no-lead branch shows the same
icon before the run title; its title goes sans (as StatusLine) and the "no lead" tag to 10.5px. The "N asking you"
badge: `bg-askingbg`, 10.5px. Diff chip per POLISHED `chip` (20px high, mono 10.5px semibold). `>_` →
`<SquareTerminal size={13} aria-hidden />` (drop the mono 9px classes). The banner: `glyph="dot" pulse`.

- [ ] **Step 6: The bar and activity line.** Delete `TONE_SEG`. When `vm.bar` is defined render
`<div role="img" aria-label={vm.bar.label} …>` from `vm.bar.strip`: for `segments`, one span per state with `SEG_FILL[st]` (gap 3px, as
POLISHED `segGap`); for `bar`, a done span (`bg-success`, `flex: done`) and a rest span (`bg-edge-strong`,
`flex: total - done`) in an overflow-hidden rounded track, as the mockup's `barVM`. When `vm.complete`, the activity
text is `text-success` and led by `<Check size={12} aria-hidden />`; otherwise `text-accent-soft` as today.

- [ ] **Step 7: The rest of the card.** Replace `SECTION_LABEL` with `SubLabel` / `REGION_LABEL text-muted` (Waiting,
Done fold, Lead pane label, Decisions in the spec review). Folds `▾`/`▸` → `ChevronDown`/`ChevronRight`; `DAG ↗` and
`Open in Code ↗` → `ArrowUpRight`. The inline block at the `border-l-2` site becomes
`mb-2 ml-[30px] mr-2.5 flex flex-col gap-2 rounded-[8px] border border-edge-mid bg-surface-raised px-[11px] py-[9px]`.
Round label, review number keys, row inline kbd, lead pane age: 10.5px. A `toLead` row's tag renders
`<ArrowRight size={11} aria-hidden />lead` then ` · {tag}` when there is a tag. Take anything else from the
POLISHED/TODAY diff (`Cards.dc.html` run states).

- [ ] **Step 8: Verify and commit.** `npx vitest run frontend/app/view/agents/leadcardmodel.test.ts`, the Check
command, `npx prettier --check` on the four files. `grep -n "TONE_SEG\|segs" frontend/app/view/agents/leadcard*.ts*`
returns nothing. Commit: `feat(cockpit): lead card Workflow mark, shared task strip, brief type scale`.

### Task 2: Agent row, attention banner, answer bar
**Depends on:** none

Owns spec decisions 1 (agent card items, banner, finished strip, answer bar), 2, 3 (agent card icons, the banner dot).

**Files:**
- Modify: `frontend/app/view/agents/agentrowmodel.ts`, `frontend/app/view/agents/agentrowmodel.test.ts`
- Modify: `frontend/app/view/agents/agentrow.tsx`
- Modify: `frontend/app/view/agents/attentioncard.tsx`, `frontend/app/view/agents/answerbar.tsx`

**Interfaces:**
- Produces: `agentrowmodel.ts` exports `subagentsLabel(n: number): string` and `tasksLabel(done: number, total: number): string`.

- [ ] **Step 1: Write the failing tests** in `agentrowmodel.test.ts`:

```ts
describe("chip labels", () => {
    it("names what it counts", () => {
        expect(subagentsLabel(3)).toBe("3 subagents");
        expect(subagentsLabel(1)).toBe("1 subagent");
        expect(tasksLabel(3, 5)).toBe("3/5 tasks");
    });
});
```

- [ ] **Step 2: Run and see it fail:** `npx vitest run frontend/app/view/agents/agentrowmodel.test.ts`

- [ ] **Step 3: Implement** in `agentrowmodel.ts`:

```ts
// a chip says what it counts
export function subagentsLabel(n: number): string {
    return `${n} subagent${n === 1 ? "" : "s"}`;
}

export function tasksLabel(done: number, total: number): string {
    return `${done}/${total} tasks`;
}
```

Run the test; it passes.

- [ ] **Step 4: Agent row chips.** `FanoutBadge` drops the `⑃` span and shows `subagentsLabel(subs.length)`;
`TaskChip` shows `tasksLabel(done, total)`; the attention banner's `BannerChip` shows `tasksLabel(...)`. Both
chips and the diff chip use POLISHED `chip`: `h-5 rounded-[5px] border border-edge-mid px-[7px] font-mono text-[10.5px] font-semibold text-ink-mid`
(keep each one's hover). The peek's state goes to mono 10.5px semibold coloured by state (`SUB_COLOR`), its dot to 7px,
and "failure" reads "failed".

- [ ] **Step 5: Agent row icons and type.** `>_` → `SquareTerminal`; the popover's and finished strip's `✓` → `Check`;
the popover's `✕` → `X`; `Open ↗` → `ArrowUpRight`; the composer `+` box → a bare `<Plus size={13} aria-hidden className="text-muted" />`
(POLISHED `plus`). Task popover eyebrow → `SubLabel`, its count 10.5px. The finished strip: label `REGION_LABEL text-accent-soft`,
age and diff mono 10.5px (age not semibold). Key hint kbd 10.5px. The banner passes `glyph="dot" pulse` instead of `glyph="diamond"`.
No `text-xxxs`, `text-xxs`, `text-[9…]` or `text-[10px]` left in `agentrow.tsx`.

- [ ] **Step 6: AttentionBanner / BannerChip.** Label → `REGION_LABEL` + `text-on-warning`; meta → 10.5px; `BannerChip`
→ 10.5px, `py-px` (POLISHED `bannerChip`). Keep the `diamond` glyph option: `runcards.tsx` still uses it.

- [ ] **Step 7: AnswerBar.** Number boxes and the "recommended" pill to 10.5px; the pill drops `uppercase` and its
tracking (POLISHED `recPill`, `ansNum`). Its `✓`/`✕` glyphs → `Check`/`X`.

- [ ] **Step 8: Verify and commit.** `npx vitest run frontend/app/view/agents/agentrowmodel.test.ts frontend/app/view/agents/answerbarpreview.test.ts`,
the Check command, `npx prettier --check` on the five files. Commit: `feat(cockpit): agent card chips and icons, banner and answer bar on the brief scale`.

### Task 3: Events rail, sections, header, meters, and the CDP scenario
**Depends on:** none

Owns spec decisions 1 (Events rail, idle/backgrounded rows, usage meters, project switcher), 3 (Events icons), 8,
and the Testing section's CDP scenario.

**Files:**
- Modify: `frontend/app/view/agents/cockpiteventsrail.tsx`
- Modify: `frontend/app/view/agents/sectionheader.tsx`, `idlesection.tsx`, `backgroundedsection.tsx`, `backgroundagentsstrip.tsx`
- Modify: `frontend/app/view/agents/usagemeters.tsx`, `frontend/app/view/agents/projectswitcher.tsx`
- Modify: `frontend/app/view/agents/cockpitsurface.tsx` (one attribute)
- Modify: `scripts/cdp/scenarios.mjs`

**Interfaces:**
- Produces: `SectionHeader`'s `caret?: string` becomes `open?: boolean` (undefined = no caret). The Cockpit root
  element carries `data-cockpit-surface`.
- Consumes (at Final, from Task 1): the lead card's header svg mark.

- [ ] **Step 1: Events rail.** Replace `KIND.glyph` strings with lucide components: asked `MessageCircleQuestion`,
answered `CornerDownRight`, finished `Check`, quiet `CircleDashed`, failed `X`, told `MessageSquare`, landed
`GitMerge`, 13px, `aria-hidden`, in the existing tone class (as the mockup's `EV_KIND` / `eventsVM`). A grouped row
(`e.group != null`) renders `<Workflow size={11} aria-hidden className="shrink-0 text-muted" />` before the name, not
`"◆ "`. Title → `SectionLabel` (ink-mid); the section headings → `REGION_LABEL` in their current colour; tags 10.5px
with no uppercase or tracking; ages 10.5px. The `›` collapse → `ChevronRight`.

- [ ] **Step 2: SectionHeader.** `caret?: string` → `open?: boolean`; when defined render
`<ChevronDown/ChevronRight size={12} aria-hidden className="w-3 text-muted" />`. Update `idlesection.tsx` and
`backgroundagentsstrip.tsx` to pass `open`. Idle row ages → mono 10.5px.

- [ ] **Step 3: BackgroundedSection.** Its header becomes `SectionHeader` with `open`, `label="Backgrounded"`,
`dotClassName="bg-accent/50"`, the "still running" note (sans 12px muted, as the mockup's `headerSH` note — pass it
through the `right` slot or add a `note?: string` prop placed after the label; pick one and use it only here),
`count`, and the same `countPillClassName` / `dividerClassName` Idle passes. Row ages → mono 10.5px.

- [ ] **Step 4: Meters and switcher.** `usagemeters.tsx` short labels → 10.5px. `projectswitcher.tsx`: `▾` →
`ChevronDown` (12px), its 9-10px labels → 10.5px (the eyebrow → `REGION_LABEL`), the `+` → `Plus`.

- [ ] **Step 5: Mark the Cockpit root.** Add `data-cockpit-surface` to `CockpitSurface`'s outermost element.

- [ ] **Step 6: The `cockpit-polish` scenario**, appended to `scripts/cdp/scenarios.mjs` and listed in `SCENARIOS`.
Reuse `agent-tree-rail`'s setup (read `arrangeTreeRail`, `treeRailRoster`, its teardown): `createrun` (orchestrator,
`deferstart: true`) and a fixture roster whose lead agent carries the run id. **Do not call `dagsubmit`**: a submit
dispatches real workers before it returns (see the "No dagsubmit" comment above `TREE_RAIL_FIXTURE`). The run has no
plan, so its card shows the planning note and no bar; the bar is proven by Task 1's model test. Reload,
`h.goto("cockpit")` (the surface key in `SURFACE_ORDER`, `agents.tsx`), wait for `[data-cockpit-surface]` and the
lead card. Assert, scoped to `[data-cockpit-surface]`:
1. every element with a direct text node has `parseFloat(getComputedStyle(el).fontSize) >= 10.5` (report the offenders' text and size);
2. the lead card (`[data-agent-id="<lead id>"]`) header's leading mark is an `svg` (the Workflow icon).
Teardown removes the fixture, run and channel as `agent-tree-rail` does, and restores any localStorage it changed.
Assertion 2 needs Task 1; the Final stage runs this scenario on the merged result. Here, run
`node --check scripts/cdp/scenarios.mjs`.

- [ ] **Step 7: Verify and commit.** The Check command; `npx prettier --check` on the touched `.tsx` files (not on
`scripts/*.mjs`). Commit: `feat(cockpit): Events rail icons, shared section headers, cockpit-polish CDP scenario`.
