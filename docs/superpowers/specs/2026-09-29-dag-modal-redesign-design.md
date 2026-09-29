# Route DAG modal redesign

The interactive mockup is the design spec. This file points at it, records the decisions that were settled
around it, and says where each piece of its logic lands in the codebase. Where this file and the mockup
disagree, this file wins; where this file is silent, the mockup is the answer.

## The mockup

- `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/dag-visualizer/project/Main.dc.html`: the
  fully interactive modal. Its tabs switch between a sample run and the longest real plan (run 18d08579,
  15 tasks, 123 events). Serve it from the main checkout with
  `python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design`, then open
  `http://127.0.0.1:8766/dag-visualizer/project/Main.dc.html`.
- `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/dag-visualizer/project/NodeStates.dc.html`: a
  node in every task state, and the five edge styles.

Both files are gitignored; read them by absolute path from any worktree. Do not delete the
`dag-visualizer` folder; the user removes it once this ships.

`Main.dc.html`'s `<script type="text/x-dc">` is a working reference implementation. Its logic is ported
into pure `.ts` modules with tests. Its scenario data (`LONGEST_RAW`, `sampleScenario`,
`longestScenario`), its toasts, its fake engine (`mutate`, `act`, `verifyThenMerge`, `requeue`) and its
hex palette (`C`, `WARN_*`, `LIVE_EDGE`) exist only for the mockup and are not ported.

## Scope

Frontend only. The files in scope are `frontend/app/view/orchestrate/{daggraph.tsx, daglayout.ts,
timelinerail.tsx, dagmodal.tsx, dagstore.ts}`, the new pure modules below,
`docs/keyboard-shortcuts.md`, and the CDP checks in `scripts/cdp/`. No wire type changes: `TaskGroup`,
`TaskNode`, `RunEvent` and `DagStatusDigest` already carry everything the design shows.

## Decisions

### D1. Layout goes left to right

`computeLayeredLayout` (top-down, sorted by id) is replaced by the mockup's `computeLayout`:

- Layers are assigned by longest path.
- An edge that skips layers gets a dummy node per skipped layer, so it has its own track.
- 12 alternating barycenter sweeps keep the ordering with the fewest crossings.
- Coordinates come from 8 passes of forward/backward packing.
- Cards are a fixed 196x64 and never overlap.

It returns `{ pos, via, layer, crossings }`: `via` holds each edge's dummy points, which `edgeGeo` draws
through.

A dashed lane band, labelled "lane · one merge", is drawn behind each chain of 2 or more tasks.
`lanesOf` ports `jarvis.Lanes` (`pkg/jarvis/plan.go`) rule for rule, and its tests mirror that
function's cases. The client computes the bands itself rather than reading `digest.lanes`, so they
still draw while the digest is missing or stale.

Why: across the 46 real plans in db_dag, left to right read better in 17, top-down in 4, and 25 were
ties.

### D2. Node card

A card shows a state glyph, the label (up to 2 lines, clamped), and one mono line: `id · state word ·
one fact`. The glyphs and words follow `NodeStates.dc.html` (`kindOf`, `wordOf`, `glyph`). A gated
`done` task reads as attention, with the word "at gate".

The fact comes from real fields:

| state | fact |
|---|---|
| running | elapsed since `firstactivity` (else "starting"), `latesttool`, and "attempt N" when N > 1 |
| verifying | "Verify running" |
| reviewing | "review round N" |
| done | "merged" when `merged`; "merge ready" when in `mergeReadyIds`; else "awaiting merge" |
| failed | "attempt N · retry or skip" |
| stalled | "idle <since lastactivity> · retry or skip" |
| verify-failed | first line of `verifyerror`, else "resolve after your fix" |
| blocked-merge | "conflict · resolve" |
| review-failed | "approve or send back" |
| skipped / cancelled | "skipped by you" / "run cancelled" |
| pending / ready | "asked you" or "asked the lead" when the digest's waitreason is an ask; else "next to start" with no unfinished deps, "waits on t-1, t-3" for up to 4, or "waits on N tasks" |

The action buttons, the route line and the `wave/<runid>` line leave the card and move to the detail rail
(D5). The card still carries `data-dag-node-route`, which the e2e scripts use to count tasks.

### D3. Edges: five styles

The style is decided by a pure `edgeStyle(source, target, focus)`, in this order of precedence:

1. On the selected or hovered task's path: accent-soft, 2px. With a selection, off-path edges fade.
2. Into a task that needs you: amber, dashed.
3. Waiting (the source is not done): dashed, faint.
4. Feeding live work (the source is done and the target is live): accent.
5. Satisfied: faint.

Edges are a custom ReactFlow edge type that draws `edgeGeo`'s path (through `via`) and its own
arrowhead. Colours come from `var(--color-*)` tokens.

### D4. Interactions

- Hover: after `PEEK_OPEN_DELAY_MS` (400ms) the peek opens. The hovered node's path is highlighted, and
  its timeline rows and strip ticks light up.
- Click selects a node: the detail rail opens and unrelated nodes (not ancestors or descendants, per
  `relatives`) dim to about 38%. Clicking the pane clears the selection.
- Double-click, or Enter on a focused node, opens the worker through the existing `openTaskFromGraph`.
- Nodes can be dragged and their edges follow. Dragging empty canvas pans. A "Reset layout" button
  appears once any node is off its computed position.
- Keys, in a pure `graphKey(key, ctx)`:
  - `j` / `k` step through tasks in plan order.
  - Left / right go to the nearest dependency / dependent by y.
  - Up / down move within the column.
  - `f` fits the view; `+` / `=` zoom in and `-` zooms out.
  - With no selection, a movement key selects the first task.
  - Keys are ignored with a modifier held or in an editable target.
  - ReactFlow's own arrow-key node moving is disabled (`disableKeyboardA11y`).
- Esc clears the selection first; a second Esc closes the modal. The modal's Escape handler checks
  `selectedTaskIdAtom` before closing.
- Summary chips in the graph header (need you / working / done / waiting / skipped, each shown only when
  its count is non-zero) cycle the selection through their group, as `pickNext` does.
- Zoom floor (D9) and persisted drag positions (D10) apply.

### D5. Detail rail

The rail sits under the graph when a task is selected. It holds:

- The id, label, state, the route line (`routeSourceLabel`, runtime / model, resolved model) and
  `wave/<runid>`.
- The actions, from the existing `ACTION_BY_STATE` / `buildViewData`, `dagActionRoute`, and the escalate
  `RoutePicker` flow, unchanged in behaviour.
- The action error line and the worker line (`SelectedTaskWorker`, unchanged).
- A Description toggle. It opens the task's full description rendered with the existing `Markdown`
  component (`frontend/app/element/markdown.tsx`). The graph pane shrinks to make room, and the selected
  node is panned back into view if the shrink hid it (`nodeInView`, the mockup's `panInto` test).

### D6. Hover peek

The peek keeps today's `Tooltip` host and `taskPeek` rows and Verify section, with one change: the raw
`description` is replaced by a lead line. That line is the markdown source that `descriptionLead(desc)`
returns, rendered through the existing `InlineMarkdown` (`frontend/app/view/agents/inlinemarkdown.tsx`,
with `plainLinks`) and clamped to 4 lines. `descriptionLead` returns:

- The first prose paragraph that is not a bare `**Label:**` line.
- For a description that opens on `**Files:**` before any prose: "Touches `a`, `b`, `c`, `d` +N more",
  built from the top-level list items that follow. That is 53 of the 100 real task descriptions.

The mockup's `mdInline` and `mdView` are not ported, because `InlineMarkdown` and `Markdown` already
render. Only the block scan needed to pick the lead (from `mdBlocks` / `mdLead`) is ported.

The peek's footer hint: "click to select and read the full description · double-click opens its worker"
when the description has more than one block, else "click to select · double-click to open its worker".

### D7. Native tooltip bug

`title={view.label}` on the card label (`DagTaskCard`) is removed. Nothing inside a `.react-flow__node`
carries a `title` attribute, so the peek is the only thing that appears on hover. The CDP scenario
asserts this (D12). `title` stays on controls outside the nodes (zoom buttons, chips).

### D8. Lifecycle timeline rail (`timelinerail.tsx`)

- The `border-l-2` left ribbon is removed. A row in the selected task shows its task chip in accent
  instead.
- A spine runs down the rows with a glyph per event kind (`glyphOf`: play, eye, merge, shield, check,
  message, bell, alert, skip), newest first, under a "now" marker.
- An activity strip under the header places every event on the run's time axis (first event to now),
  with taller ticks for events in `ATTENTION_KINDS`. It shows the start and now clock labels and the span.
  While a task is selected or hovered, its ticks stay bright and the rest fade.
- Rows are bursts from `groupEvents`: one phase (`phaseOf`: work / review / land) of one task within
  3 minutes (`BURST_MS`). Each row has:
  - its head event (`priority`) as the title;
  - step chips for the steps that `SUPERSEDED` has not made redundant, when there are 2 or more;
  - a one-line `snippetOf`;
  - the time or time range.
- A gap of 5 minutes or more between rows (`QUIET_MS`) gets a "N min quiet" separator.
- Clicking a row expands its per-event detail, newest first: a `task-verify-failed` shows its output as a
  pre block, a review shows its note and downstream, and anything else its snippet. The click still routes
  through `eventClickTarget` / `applyTarget`, applied to the row's head event. Relaunch lead keeps working
  from an expanded row that holds a `lead-exited` event.
- Each filter carries a count: All (rows), Task (rows for the selected task), and Attention (rows with an
  attention event; amber when non-zero).
- Hovering a row highlights its task's node.
- Sources of truth:
  - `timelinefilter.ts` stays the source for attention (`ATTENTION_KINDS`) and click routing
    (`eventClickTarget`). The mockup's own `ATTN` set, which adds `task-retried`, is not used.
  - Tone stays `runtimeline.ts` `KIND_TONE` through `toneFor`, unchanged, so `task-spawned` stays green
    in both timelines. A row's glyph fill and border derive from that tone class.
  - Titles stay `eventTitle` / `eventKindTitle`. Step labels come from a `STEP` table in the new module,
    falling back to the kind title.
- `data-timeline-rail` stays. Rows gain `data-timeline-row` and `data-timeline-task="<id>"` so the e2e
  scripts stop depending on DOM shape (D12).

### D9. Zoom floor

A pure `openView` decides how the modal opens. It fits everything, but when fitting everything would
drop below `ZOOM_FLOOR` (0.85), it fits the focus set at `minZoom: ZOOM_FLOOR` instead. The focus set is
the tasks that need attention, else the live ones, else the ready ones. If there are none (every task is
settled), it centres the whole graph at `ZOOM_FLOOR`. `f` still fits everything at any scale, and zoom
is clamped to 0.3 to 1.6.

### D10. Dragged positions persist per run

Only dragged nodes are stored, as offsets over their computed position, in one
`atomWithStorage("dag.layout.offsets")` map keyed by the dag's oid. Each entry holds `{ at, offsets }`.
Writing an entry prunes the map to the 20 most recently written dags (`LAYOUT_RUNS_KEPT`). An offset for
a task that no longer exists is ignored, and a task added later gets its computed position. "Reset
layout" deletes the dag's entry.

### D11. Text scale

The text follows the Jarvis surface scale (`frontend/app/view/jarvis/briefstyle.ts`):

- Titles are 13px in `text-ink-hi`.
- Secondary text is 11.5 to 12.5px.
- Mono meta is 10.5px in `text-ink-mid` (`MONO_META`).

No text in the modal is below 10.5px. `text-xxxs` (8.5px) and `text-xxs` (10px) leave these files,
including `dagmodal.tsx`'s subtitle (`ModalSubtitle`).

### D12. Verification

- Pure logic goes in `foo.ts` with a `foo.test.ts` beside it; there are no jsdom render tests.
- The `dag-lifecycle` CDP scenario (`scripts/cdp/scenarios.mjs`) keeps its `.react-flow__node` count
  and adds these checks:
  - No element inside a `.react-flow__node` has a `title` attribute.
  - Hovering a node for more than 400ms shows `[data-dag-peek]`.
  - Nodes lay out left to right: a dependent's x is greater than its dependency's.
  - Esc with a selection clears it, and the modal stays open.
- `orchestrator-observability-e2e.mjs` reads rows through `[data-timeline-row]` and
  `[data-timeline-task]` instead of span counts.
- `orchestrator-e2e.mjs`'s `[data-dag-node-route]` counting still works: the card keeps that attribute.
  Its step "14-run-body" closes the modal with one Escape after step 13 clicked a node; under D4 that
  Escape only clears the selection, so the step sends Escape twice.
- `docs/keyboard-shortcuts.md`'s Route DAG table gains Left/right, Up/down, `f`, `+`/`-` and the new
  Esc behaviour, and its peek paragraph describes the lead line and lane bands.

### D13. Graph library

ReactFlow (`@xyflow/react`, already installed) stays, because it covers what the design needs:
- node dragging;
- pane pan and zoom;
- `fitView({ nodes, minZoom })` for the zoom floor;
- custom node types, with lane bands as a non-interactive node type at a lower z-index;
- custom edge types for `edgeGeo`.

If any of these cannot reach the mockup's behaviour, the implementer stops and reports the gap rather
than hand-rolling around it; the user is open to changing libraries.

## Colour

Colours come only from the `@theme` tokens in `frontend/tailwindsetup.css`: Tailwind classes in
components, and `var(--color-*)` in SVG strokes and fills. Translucent fills use the existing
`/NN` opacity modifiers or `color-mix` over a token, as `daggraph.tsx` already does. Add no new
tokens, no raw hex or rgba, and no emoji.

## Modules

| module | holds | ported from |
|---|---|---|
| `daglayout.ts` | `computeLayout`, `lanesOf`, `edgeGeo`, `CARD_W`/`CARD_H`/`GAP_X` | same names |
| `daglayoutstore.ts` | the offsets atom, `applyOffsets`, `withOffsets` (prune to 20) | new |
| `dagcanvas.ts` | `kindOf`, `wordOf`, `factOf`, `glyphKind`, `edgeStyle`, `relatives`, `graphKey`, `chipGroups`, `pickNext`, `fitScale`, `openView`, `nodeInView` | `kindOf`, `wordOf`, `factOf`, `glyph`, edge loop, `relatives`, `keyDown`, `CHIP_GROUPS`, `pickNext`, `fitView`, `panInto` |
| `dagdescription.ts` | `descriptionBlocks`, `descriptionLead` | `mdBlocks`, `mdLead` |
| `timelinegroups.ts` | `groupEvents`, `filterGroups`, `phaseOf`, `priority`, `SUPERSEDED`, `stepLabel`, `snippetOf`, `groupSnippet`, `eventDetail`, `railRows`, `stripTicks`, `glyphOf`, `GLYPH_PATHS`, `BURST_MS`, `QUIET_MS` | `groupEvents`, `phaseOf`, `priority`, `SUPERSEDED`, `STEP`, `snippetOf`, `detailOf`, the quiet-gap loop, the strip ticks, `glyphOf`, `G`, `BURST_MIN`, `QUIET_MIN` |
| `dagstore.ts` | adds `hoveredTaskAtom: { id; from: "graph" \| "timeline" } \| null` | mockup `hover` / `railHover` |

`groupEvents` reads real `RunEvent`s: `ts` in ms, and the task id from `detailOf(event).taskid`. A
node hover (`from: "graph"`) drives the path highlight and lights up the timeline; a row hover (`from:
"timeline"`) only highlights the node, as the mockup's `railHover` does.
