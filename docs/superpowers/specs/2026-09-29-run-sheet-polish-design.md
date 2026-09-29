# Run sheet polish

**Status:** Approved, not built.

The run face of the Brief's detail sheet (`frontend/app/view/jarvis/runsheet.tsx`) and what it renders
(`briefrunsheet.tsx`'s `SheetShell`, `briefsheet.tsx`'s run header actions and `ChannelLaunch` label,
`runreportview.tsx`, `frontend/app/view/agents/childaskcard.tsx`, `runcards.tsx`'s `CancelSurvivorsCard`, and the
timeline in the tasks heading) moves onto the Jarvis brief type scale (`frontend/app/view/jarvis/briefstyle.ts`):
nothing under 10.5px, lucide icons in place of text glyphs, the shared task strip under the verb, and a compact form
of the DAG modal's lifecycle rail. Frontend only: no wire type or Go change.

## The design is the mockup

The approved interactive canvas is the spec. It is gitignored, so read it by absolute path:

- `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/run-sheet-polish/project/Main.dc.html` draws the sheet
  at its real 640px width, Today and Polished side by side under the same state. Controls: run state (Planning, Lead
  asks you, Executing, Worker asks you, Landing, Stale read, Done with a report, Done with no report, Cancelled with a
  survivor, Quick run), the timeline open or closed, the Adjust dials open or closed; in Landing, End final stage
  opens the reason form.
- Serve it with `python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design` from the main checkout
  (`C:/Users/kael02/IdeaProjects/waveterm`). If port 8766 already answers, it is being served.

The board's script holds two style tables, `TODAY` and `POLISHED` (search for `const POLISHED`). TODAY transcribes
today's classes, so **the difference between TODAY and POLISHED is the change list**; POLISHED holds the exact
values. The script also holds the timeline rows (`RAIL`, `railVM`) and the bar (`meterVM`). Where this spec names a
value it restates the mockup; it does not override it.

Colours come only from the `@theme` tokens in `frontend/tailwindsetup.css`; the mockup's hex values are those tokens
transcribed (`#9aa3ad` ink-mid, `#7f858b` muted, `#646a72` ink-faint, `#20262e` edge-mid). No new tokens, no raw hex
or rgba, no emoji.

## Decisions

### 1. Headings on the brief scale

`REGION_LABEL` is mono 10.5px bold uppercase, 0.1em tracking. It replaces every 9-9.5px `.13em` eyebrow on the sheet.

- `runsheet.tsx`'s "tasks", "what landed", "sealed evidence", and `runreportview.tsx`'s "run report" and its section
  headings: `SectionLabel` (`frontend/app/view/agents/sectionlabel.tsx`, ink-mid). The local `EYEBROW` and
  `EYEBROW_MID` constants in both files go.
- `SheetShell`'s label ("project"): `REGION_LABEL` in `text-accent-soft`. `ChannelLaunch`'s "run this in …" label
  takes the same `REGION_LABEL` in `text-accent-soft`: it is the same header family.
- "Questions for you" (`childaskcard.tsx`): `REGION_LABEL` in `text-warning`. "Cancelled · N still running"
  (`CancelSurvivorsCard`): `REGION_LABEL` in `text-error`. `BlockedCard` and `TriageChip` in the same file are not
  touched.

### 2. Nothing on the sheet below 10.5px

- `SheetShell`'s run line (`meta`, 10px) → 10.5px.
- Task-row states → mono 10.5px semibold, still coloured by `stateTone`.
- `ROW_BTN` → `inline-flex h-[22px] items-center gap-1`, `border-edge-mid`, `px-[7px]`, mono 10.5px, `text-secondary`.
- The attention row's action chip → 10.5px (`py-px`).
- The report's task tags → 10.5px, `px-1.5`, `leading-[17px]`.
- The questions card's task id and "N waiting" → 10.5px.
- The per-file +/− counts → 10.5px (and see 5).

### 3. Contrast

The tasks-heading meta, the "next:" prefix and "+N more files" move from `text-ink-faint` to `text-muted`.

### 4. Icons (lucide-react)

- `↗` → `ArrowUpRight` (11px, after the text) on: Open in Agent and Open DAG (row buttons; `ROW_ACTION_LABEL` loses
  its arrows), open the full timeline, open the repository diff (report and evidence), Open lead and Open in Agent
  (dock), and Open in Agent in the quick run's empty box.
- The timeline toggle's `▸`/`▾` → `ChevronRight`/`ChevronDown`. The header's `↑`/`↓` run steppers → `ChevronUp`/
  `ChevronDown` (13px); their `aria-label` and `title` stay.
- The effort chunk link's `↳` → `CornerDownRight` (11px, `text-muted`).
- The questions card's "?" → `MessageCircleQuestion` (13px, `text-warning`). The survivors card's "!" →
  `CircleAlert` (13px, `text-error`).

### 5. File counts in the Diff surface's colours

The evidence list drawn when a run has no commits shows `+N` in `text-diff-added` and `−N` in `text-diff-removed`.

### 6. The shared task strip under the verb

The done/total meter becomes the task strip the agent tree, the rail and the Cockpit draw: `taskStrip` /
`taskStripLabel` / `SEG_FILL` (`frontend/app/view/agents/runstrip.ts`), one segment per task, one done/total bar past
`STRIP_MAX`. The element keeps `role="img"`, with `taskStripLabel(group, digest)` as its `aria-label`. Segments are
4px high, 3px apart, `min-w-[2px]`, 2px radius (the mockup's `meterVM`); the bar form is `bg-success` over
`bg-edge-strong`, as `LeadBar` draws it.

A stale read is the exception: its figures are the held digest's, so per-task colours would present old data as
current. It keeps today's dated done/total meter in the dim tone (`bg-accent-700` over `bg-edge-mid`, "N of M tasks
finished").

The model says which bar to draw. `SheetMeter` has no use left but the stale case, so it is reduced to it:
`SheetStatus.meter` becomes `SheetBar = { kind: "strip" } | { kind: "stale"; done: number; total: number } | null`
(the tone field goes; stale is always dim). Every branch that today returns a non-null meter from the live group
returns `{ kind: "strip" }`; the stale branch returns `{ kind: "stale", ...digest.counts }`; the rest stay `null`.
The view draws the strip from `dag.group` and `dag.digest.digest`, and draws nothing when `taskStrip` returns
undefined. `runsheetmodel.test.ts` asserts the kind per state.

### 7. The timeline in the tasks heading is the rail, compactly

- Rows come from `groupEvents` and `railRows` (`frontend/app/view/orchestrate/timelinegroups.ts`) over the events
  the sheet already reads (`useRunEvents`): bursts per task and phase, newest first, "N min quiet" gap rows, and a
  "now · HH:MM" line at the top (`tsLabel` of the sheet's clock, accent pulsing dot, as `NowMarker`).
- One line per burst, about 22px: the spine icon in a 16px circle on a 1px `bg-edge-faint` guide line, the burst
  title (`eventTitle` of its head; `text-warning` and semibold when the burst needs attention, else `text-ink-hi`
  medium, 12px), the task-id pill (`bg-pill`, mono 10.5px, `text-ink-mid`) and the time range (mono 10.5px,
  `text-ink-mid`, `ml-auto`). The gap row is the rail's: a 5px `bg-edge-mid` dot, dashed `border-edge-mid` rules, mono
  10.5px "N min quiet".
- No step pills, snippets, detail box, activity strip or All/Task/Attention filter: those stay in the modal.
- Clicking a row opens the DAG modal at its task (`openDagTask`), or the live modal (`openDagLive`) for a row with no
  task. Both need the run's dag, so on a run with no `dagoref` the rows are plain (not buttons).
- The list is capped at `max-h-[230px]` before it scrolls. It stays collapsed by default behind
  "timeline · N events", N = `events.length`, shown when there is at least one event. "open the full timeline"
  stays, for a run with a `dagoref`.
- The spine icon is shared, not copied: `timelinerail.tsx` exports `SpineGlyph` with a `compact` prop (16px circle
  and a 9px glyph, no top margin; the rail keeps its 20px circle and 11px glyph), and exports `groupTime` for the
  time range. The sheet no longer imports `GroupSection`, `eventsCount` or `buildRunTimeline`;
  `runtimelineview.tsx` keeps them for `RunBody`'s legacy path.

### 8. Unchanged

The layout and the three regions (reading, body, dock); the verb/sub/meta derivations in `runsheetmodel.ts` (only
the meter changes); the goal heading; `AskCard`, `AttentionBanner`, `AnswerBar` (polished by run a02cd7f7); the
empty boxes (apart from 4's icon); Evidence's structure; the dials; `EndFinalForm`; the composer; motion.

## Shared components

`ChildAskCard` and `CancelSurvivorsCard` are also drawn by `RunBody` (`runbody.tsx`), the legacy path for runs
stored before slice 5c, and `RunReportView` by `chunksidebar.tsx` (compact); the changes reach them too. Nothing else
in `RunBody`, `runcompletionsurface.tsx` or `runworkercard.tsx` is polished.

## Verification

- Pure logic stays in `.ts` with a `.test.ts` beside it: the `SheetBar` decision in `runsheetmodel.test.ts`. The
  compact timeline adds no model of its own: `groupEvents` and `railRows` are already tested. No jsdom render tests.
- A CDP scenario, `run-sheet-polish`, appended at the end of `scripts/cdp/scenarios.mjs`: a deferred orchestrator run
  given a DAG with `dagsubmit` (as `dag-lifecycle` arranges it), its sheet opened on the Brief; it asserts that no
  element inside `[data-run-sheet]` renders a computed font size below 10.5px (the sweep is scoped to the sheet), and
  that the bar under the verb has `role="img"` with `taskStripLabel`'s "N of M tasks done" aria-label. `SheetShell`'s
  header sits outside `[data-run-sheet]`, so the scenario also sweeps `[data-jarvis-brief-sheet] > header`. Teardown
  cancels the run and deletes the channel.
- `task check:ts` clean; `npx vitest run` on the touched models.
