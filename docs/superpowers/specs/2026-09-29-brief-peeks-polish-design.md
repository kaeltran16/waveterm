# Brief peeks polish

**Status:** Approved, not built.

The Brief's two peeks move onto the Jarvis brief type scale (`frontend/app/view/jarvis/briefstyle.ts`): the record
peek (`frontend/app/view/jarvis/briefpeekview.tsx` over `briefpeek.ts`) and the graph peek (`graphpeek.tsx` and the
canvas it mounts, `jarvisgraph.tsx`). Nothing under 10.5px, `text-ink-faint` becomes `text-muted`, lucide icons
replace text glyphs, and three content fixes ride along: the record peek stops saying its objective twice, the graph
stops printing a record's whole objective, and the design-explainer copy goes. Frontend only: no wire type or Go
change.

## The design is the mockup

The approved interactive canvases are the spec. They are gitignored, so read them by absolute path:

- `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/brief-peeks-polish/project/Main.dc.html` draws the
  record peek at its real 640px, Today and Polished side by side, on two real vault records: a 7.1k-character
  orchestrator goal and an 85-character one-sentence objective. Controls: which record, status picker open or closed;
  Polished also expands the full objective.
- `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/brief-peeks-polish/project/Graph.dc.html` draws the graph
  peek at 1360px. Controls: Today/Polished, and nothing selected / a record selected / searching "polish". The canvas
  drawing is hand-placed; only the overlays and the side panel are the spec.
- Serve them with `python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design` from the main checkout
  (`C:/Users/kael02/IdeaProjects/waveterm`). If port 8766 already answers, it is being served.

Each board's script holds the style tables: `REC_TODAY`/`REC_POLISHED` (record peek) and `G_TODAY`/`G_POLISHED`
(graph side panel); the markup's `today`/`pol` branches carry the rest (the headers, icons, the find box, the
show-full link). TODAY transcribes today's classes, so **the difference between TODAY and POLISHED is the change
list**. Where this spec names a value it restates the mockup; it does not override it.

Colours come only from the `@theme` tokens in `frontend/tailwindsetup.css`; the mockup's hex values are those tokens
transcribed (`#9aa3ad` ink-mid, `#7f858b` muted, `#646a72` ink-faint, `#1c2128` border, `#161a20` edge-faint,
`#13171d` surface-raised, `#aebfff` accent-soft). No new tokens, no raw hex or rgba, no emoji.

## Record peek

### Title and body (`briefpeek.ts`, pure, tested in `briefpeek.test.ts`)

Today the title and the body are both the objective, so every record says it twice (126 of the user's 163 records are
one sentence). `buildRecordPeek` decides the split; the view only renders it.

- `title` = `headline(objective)`, the existing helper in `effortfeed.ts` (first sentence, cut at 180 on a word).
  Import it; do not copy it. No objective: the record id, as today.
- `body: string | null` = the trimmed objective when it says more than its headline (`headline(objective) !==
  objective`), else `null` and no body renders. The objective keeps its newlines. No objective: today's fallbacks
  (the notes, else "This record states no objective yet."), always shown.
- `bodyMore: string | null` = `Show the full objective · ${kilo(objective.length)}` (`kilo` from `effortfeed.ts`) when
  the body is the objective and the objective is longer than 400 characters (a named constant); else `null`. 20 of
  the user's records cross it.
- `PEEK_ABSENCE_CHIP`, `PEEK_FOOTER` and the `absenceChip` / `footer` fields on `RecordPeek` are deleted, with the
  comments that describe them (the file headers of `briefpeek.ts` and `briefpeekview.tsx` mention the footer).

Tests: a one-sentence objective has a title and no body; a multi-sentence objective's title is its first sentence and
its body is the whole objective with its newlines; a body over 400 characters carries `bodyMore` with the kilo count,
one at or under 400 carries none; no objective keeps the id title and the notes / no-objective fallback. The chip and
footer tests go.

### View (`briefpeekview.tsx`)

- Header: the `record` label is `REGION_LABEL` in `text-accent-soft`; `updatedLabel` is mono 10.5 `text-muted`; the
  status toggle is 10.5 (padding `2px 6px 2px 8px`, `inline-flex items-center gap-1`) and ends in a `text-muted`
  ChevronDown 11, ChevronUp while the picker is open. The toggle gets `aria-expanded`.
- Picker: the current row's `•` becomes Check 12 (stroke 2.4) in the status tone, in a 12px column. Rows, notes and the
  terminal-status confirm are unchanged.
- Body: renders only when `peek.body != null`, `whitespace-pre-line`, clamped with `line-clamp-4` while `bodyMore` is
  set and the objective is not open. Under it, when `bodyMore` is set, a borderless text link: mono 10.5
  `text-accent-soft`, `inline-flex items-center gap-1 self-start`, the LINK_BTN hover and focus ring without its border
  or padding, reading `bodyMore` + ChevronDown 11, or "Show less" + ChevronUp 11 when open, with `aria-expanded`. The
  open state is local, per opening, and reset when `recordId` changes, in the same effect as `pickerOpen`.
- Fleet: the "Fleet · on this record" label is `REGION_LABEL` `text-ink-mid`; its meta is mono 10.5 `text-muted`. The
  run row's shortId, meta and state are mono 10.5 (meta `text-muted`); the headline is 12.5. `runsAbsent` moves to
  `text-muted`.
- The log line is `MONO_META` in its bordered chip (`px-[9px] py-[3px]`). The chip and footer are gone. The map button
  joins the log line's row after a `flex-1` spacer (the mockup's `pol` branch), styled `SMALL_BTN` with
  `inline-flex items-center gap-1.5` and a `text-muted` Waypoints 12 before "Where it sits on the map". Its behaviour
  is unchanged.
- For the scenario: the header title span carries `data-jarvis-peek-title`, the body `<p>` carries
  `data-jarvis-peek-body`, and the show-full link carries `data-jarvis-peek-body-toggle`.

## Graph peek

### Side panel and header (`graphpeek.tsx`)

- Header: `px-4 py-2.5` (its height follows the padding instead of `h-11`), rule `border-edge-faint`. A Waypoints 14
  `text-accent-soft`, then `graph` in `REGION_LABEL` `text-accent-soft` (it replaces "Graph peek"), then `N nodes`
  in mono 10.5 `text-muted`. The ` · kind · label` suffix goes: a task node's label is its record's whole objective
  (`nodeLabel` in `pkg/wshrpc/wshserver/wshserver_jarvis.go`, not changed) and a bloomed run's is the run's whole goal,
  both up to 10k characters. "Close · Esc" becomes `SHEET_BTN` (imported from `briefrunsheet.tsx`, not edited) with
  `inline-flex items-center gap-2`, reading "Close" and a mono 10.5 `font-normal text-muted` "Esc" inside it.
- Find box: a Search 13 `text-muted` inside the input's left edge (absolute, `pointer-events-none`), the input padded
  to clear it.
- Every uppercase panel label (the match count, "Selected node", "Edges", the actions label) is `SubLabel`
  (`frontend/app/view/agents/sectionlabel.tsx`).
- Matches: the kind is mono 10.5 in a column at least 40px wide (`min-w-10`: the mockup draws only `task`, and
  `decision` is about 50px at 10.5px mono, so a fixed 40px would run it into the label); the overflow line is mono 10.5 reading `+N more · narrow the filter`.
  `MAX_MATCHES` and the matching are unchanged.
- Selected node: kind mono 10.5 semibold in its tone, with the status (mono 10.5 `text-muted`) beside it on one line
  (`flex gap-2`), above the label rather than below it. The label is clamped to three lines (`line-clamp-3`,
  `[overflow-wrap:anywhere]`) so Edges and the Open button stay on screen. Edge meta is mono 10.5.
- Copy: the actions label becomes "Open"; the empty hint becomes "Click a node, or find one above."; the closing
  paragraph ("The peek is never a destination…") is deleted.
- For the scenario: the canvas pane (the `relative min-w-0 flex-1` div that mounts `JarvisGraph`) carries
  `data-jarvis-graph-canvas`.

### Canvas (`jarvisgraph.tsx`)

`SelectionCard` (the bottom-right card) and its mount are deleted: the side panel already shows the kind, status,
label and every edge with its state and bucket, and the card printed the full objective. `JarvisGraph` is mounted only
by `graphpeek.tsx` (checked). Imports and helpers that only the card used go with it; the drawing, physics, zoom
controls and legend are unchanged.

## Unchanged

Both peeks' layouts, widths and motion, `ModalShell`, the status picker's rows and notes, the terminal-status confirm,
the fleet derivation (`fleetForRecord`, `fleetCountsLine`, `runRow`), the canvas's drawing, physics, zoom controls and
legend, search matching and `MAX_MATCHES`, the Open run / Open record actions, keybindings. `briefsurface.tsx` mounts
the peeks and needs no change.

## Verification

- Unit: `npx vitest run frontend/app/view/jarvis/briefpeek.test.ts`.
- Existing CDP scenarios that assert removed copy are updated: `brief-peek` step 2 stops requiring the absence chip
  and the footer, and step 2b, which passed only through the absence chip (its `fleet` probe,
  `text.includes("Fleet")`, never matched the uppercase label), reads the fleet band as `/fleet/i` and passes on that
  alone; `brief-contextual-map` step 1 reads the header as `/\bgraph\b/i` plus `N nodes` instead of the text
  "Graph peek" (innerText returns `REGION_LABEL`'s uppercase).
- New scenario `brief-peeks-polish`, appended after `brief-initiatives-polish` at the end of `scripts/cdp/scenarios.mjs`:
  - arrange: pick a record whose objective is over 400 characters from `listtaskdossiers`. If the profile has none,
    seed one: a throwaway channel and a `createrun` with `deferstart: true` and a multi-sentence goal over 400
    characters (run creation captures a dossier from the goal, `jarviscapture.CaptureRunDispatch`); teardown removes
    it with `teardownFixtureRun`, as `run-sheet-polish` does.
  - assert, at a pinned 1600x950 viewport: open the record through `window.__openAddress("task:<id>")`; nothing inside
    `[data-jarvis-brief-band="peek"]` renders below `MIN_FONT_PX` (reuse `polishSweep`), both clamped and after
    clicking the show-full link; `[data-jarvis-peek-title]`'s text does not equal `[data-jarvis-peek-body]`'s. Then
    click `[data-jarvis-peek-open-graph]`: nothing inside `[data-jarvis-graph-peek]` renders below `MIN_FONT_PX`,
    excluding the `<canvas>`; the header's text does not contain the objective's headline; the side panel's
    "Open record" button lies inside the viewport; `[data-jarvis-graph-canvas]`'s DOM text does not contain the
    headline (no selection card).
  - teardown: Escape both peeks; remove the seeded run if one was made.
- The engine's Final stage runs `brief-peeks-polish`, `brief-peek` and `brief-contextual-map` on the merged result.

## Work split

Two tasks at the same time, split by file, one owner per file: the record peek (`briefpeek.ts`,
`briefpeek.test.ts`, `briefpeekview.tsx`) and the graph peek (`graphpeek.tsx`, `jarvisgraph.tsx`, and every
`scripts/cdp/scenarios.mjs` change: the `brief-peek` and `brief-contextual-map` edits and the new scenario, which
relies on the record peek's three data attributes named above). The scenarios go in the graph task rather than a third
serial task, to save a worker cycle; their record-peek steps pass only once both tasks have merged, which is when
Final runs them.

## Out of scope

`frontend/app/view/jarvis/pet*` (another session's uncommitted files); `runsheet.tsx`, `briefrunsheet.tsx` (imported,
not edited), `briefsheet.tsx`, `effortdetailview.tsx`, `inlinetrackerview.tsx`, `chunksidebar.tsx`,
`briefrowviews.tsx`, `briefsurface.tsx`; any Go or wire type, including `nodeLabel`;
`.superpowers/design/brief-peeks-polish` (the user removes it once this ships).
