# Brief initiatives polish

**Status:** Built (run e696008f, 2026-09-29).

The initiative side of the Brief moves onto the Jarvis brief type scale (`frontend/app/view/jarvis/briefstyle.ts`):
the Brief's row views (`briefrowviews.tsx`), the inline initiative tracker (`inlinetrackerview.tsx` over
`inlinetracker.ts`), the Chunk sidebar (`chunksidebar.tsx`), the initiative activity feed (`effortdetailview.tsx` over
`effortfeed.ts`) and two small bits of `briefsurface.tsx`. Two behaviour changes ride along: the stage rule (a flat plan
draws no stage header; the "unstaged" header loses Delete) and a grouped, one-line-per-entry activity feed. Frontend
only: no wire type or Go change.

## The design is the mockup

The approved interactive canvases are the spec. They are gitignored, so read them by absolute path:

- `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/brief-initiatives-polish/project/Main.dc.html`: the
  Brief at a 1360px window with Initiatives (one plan open), Runs, Behind you and the Chunk sidebar. Controls: Version
  (Today/Polished), Plan (Staged = effort 868d36b8 with stages and a trailing unstaged group; No stages = effort
  c4157d0e, a flat plan), Menu (None, Chunk status, Stage, Unstaged). Chunk rows select into the sidebar; stage carets
  fold; note cards expand. The stage rule is in its script's `trackerVM` and `stageMenu`.
- `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/brief-initiatives-polish/project/Activity.dc.html`: the
  detail sheet's initiative face, Today and Polished side by side, on the real feed of effort c4157d0e. Filter: every
  chunk, or one chunk (as a tag click sets it). The grouped rows are built by its script's `groupedRows`.
- Serve with `python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design` from the main checkout
  (`C:/Users/kael02/IdeaProjects/waveterm`). If port 8766 already answers, it is being served.

Each board's script holds two style tables, `TODAY` and `POLISHED` (search for `const POLISHED`). TODAY transcribes
today's classes, so **the difference between TODAY and POLISHED is the change list**; POLISHED holds the exact values.
Where this spec names a value it restates the mockup; it does not override it.

Colours come only from the `@theme` tokens in `frontend/tailwindsetup.css`; the mockup's hex values are those tokens
transcribed. No new tokens, no raw hex or rgba, no emoji.

## Decisions

### 1. Nothing below 10.5px

Fonts only; icons are sized separately.

- `briefrowviews.tsx`: `RunRowView`'s type badge (10px to 10.5px, leading 17px), `ShippedRowView`'s "new" pill
  (9.5px) and "report" (10px).
- `chunksidebar.tsx`: the status radiogroup labels (9.5px); "j / k" (10px, and ink-mid to muted); Close (10px) moves
  to the sheet's `SHEET_BTN` scale: 11px semibold, text-secondary, px 10.
- `effortdetailview.tsx`: the count and "only" meta, the day column, the facts row, "N more", "show all", "Show N
  older" (all 10px), and the chunk status tag (9px uppercase to 10.5px semibold lowercase, the run sheet's row-state
  treatment).
- `briefsurface.tsx`: the "/" search kbd (10px) and the "refresh failed" line (10px; its ✕ becomes lucide `X`).

### 2. Headings

- `effortdetailview.tsx`'s "Notes" (the local `SECTION_LABEL`, 9.5px .13em feed-label) becomes `SectionLabel`
  (`frontend/app/view/agents/sectionlabel.tsx`); the local constant goes.
- The sidebar's "Chunk" and "Notes" labels move to `REGION_LABEL` in ink-mid.

### 3. Contrast

`text-ink-faint` on these surfaces moves to `text-muted`: the feed's day column, counts, fact keys, "N more". The feed's
chunk status is no longer the old tag's ink-faint for skipped/removed: its heading takes `TONE_FG`, as POLISHED does
(skipped and removed read ink-mid; see Decision 6).

### 4. Icons (lucide-react) in place of unicode glyphs

- Carets: `InitiativeRow`'s ▸/▾, the tracker's stage toggle (and the new-stage placeholder's ▾), the feed's day
  toggle become `ChevronRight`/`ChevronDown`. The chunk status button's 8px ▾ becomes `ChevronDown` 11px muted. Note
  cards' "more ▾"/"less ▴" become "more"/"less" plus `ChevronDown`/`ChevronUp`: the pure model `sidebarnotes.ts`
  carries `chev` as "more"/"less" ("" when the card has none), and `chunksidebar.tsx` draws the chevron after it.
- Chunk tones: `GLYPH` in `inlinetrackerview.tsx` (✓ ▶ ! ❙❙ – ·) becomes `Check`, `Play`, `CircleAlert`, `Pause`,
  `Minus`, `Circle` (pending reads as an empty circle), in the same `TONE_FG` colours. It is shared by the tracker rows,
  the status menu and the sidebar's radiogroup, so it is replaced once: `inlinetrackerview.tsx` exports a `ToneIcon`
  component (`{ tone, size?, className? }`) in place of `GLYPH`, and every consumer draws through it.
- The stage ⋯ button becomes `Ellipsis`; the status menu's ↑ ↓ → become `ArrowUp`, `ArrowDown`, `ArrowRight`; the "+"
  on Add chunk and New stage becomes `Plus`.
- The sidebar's ↑/↓ steppers become `ChevronUp`/`ChevronDown` (13px, as the run sheet's header steppers); the handle's
  ⧉ becomes `Copy`; "activity ↗" and "open agent session ↗"/"open run ↗" become the text followed by `ArrowUpRight`
  11px.
- `RunRowView`'s ↳ chunk link becomes `CornerDownRight` 11px (as the run sheet's chunk link).

### 5. The stage rule

Initiatives are either staged (chunks grouped into stages) or flat (no chunk has a stage). Both are normal; the form
follows the data, with no setting.

- **A flat plan draws no stage header.** Flat means every chunk's stage is "" (`groupChunksByStage` yields one group
  with stage ""). `inlinetracker.ts` exports `isFlatPlan(chunks)`; `trackerRows` emits no `stage` row for a flat plan
  and always emits its chunk rows: stage overrides and `stageStartsOpen` do not apply, so an all-done flat plan does
  not fold. The chunk rows sit directly under the initiative row, followed by "+ Add chunk" and "+ New stage".
  - "+ Add chunk" is placed today by the open stage header that owns a run (`addAfter` in `InitiativeDetail`). With no
    header, the view appends it after a flat plan's last chunk row, adding to stage "" at run 0, the same call the
    unstaged header made.
  - `trackerNavIds` already walks only `line` and `chunk` rows, so the cursor holds. `briefsurface.tsx`'s
    `stepTo` and `revealChunk` still write a stage override on a flat plan; `trackerRows` ignores it, so they need no
    change.
- **A staged plan keeps a header per stage**, as today.
- **An unstaged run inside a staged plan keeps its "unstaged" header, but its ⋯ menu offers only "Name this stage"**:
  the existing rename path (`startEdit`, then `onRenameStage`, i.e. `setChunkStage` on the run). No "Delete stage"
  there: today it deletes every chunk of the run (`onDeleteStage` via `stageRunLabels`). Real stages keep Rename stage
  and Delete stage.
- **The Chunk sidebar's crumb drops "/ unstaged" for a chunk of a flat plan**; a staged plan's unstaged chunk keeps it.
  `ChunkSidebar` takes a `flat` prop, which `briefsurface.tsx` sets with `isFlatPlan` over the open plan's chunks.
- **"+ New stage" stays on flat plans**: it is how a flat initiative becomes staged, and the plan switches to the
  staged form once that stage's first chunk lands. The status menu's "Move to stage" section is unchanged (already
  absent on a flat plan).

### 6. The activity feed becomes scannable

Measured on c4157d0e: a long, interleaved stream whose entries average hundreds of characters, whose 180-character
headlines wrap to 2-3 lines, and where nearly every row carries a chunk tag because the stream alternates chunks.

- **A pure row model**, `feedGroups` in `effortfeed.ts` beside `effortFeed`, with tests in `effortfeed.test.ts`. It
  supersedes `feedRows` (and `FeedRow`), whose only consumer is `effortdetailview.tsx`; those tests are replaced by
  `feedGroups` tests. `stamp` stays: the sidebar's note cards (`sidebarnotes.ts`) use it. Same inputs as `feedRows` (`only`, `limit`,
  `now`), returns `{ rows, left }`. `groupedRows` in Activity.dc.html is the reference.
- **A divider per local day**: "Today", "Yesterday · Mon 28 Sep", older days "Sun 27 Sep". `REGION_LABEL` ink-mid with
  a hairline. The time column shows HH:MM only.
- **Inside a day, one group per chunk**, groups ordered by their newest entry, entries newest first. The heading: the
  chunk's `ToneIcon`, its label (12.5px semibold ink-hi, truncated) and its status (10.5px semibold, lowercase, in the tone's
  `TONE_FG` colour; a removed chunk takes the skipped tone, ink-mid). Clicking the heading sets the existing "only" filter (the tag's job today).
  With "only" set there are no chunk headings; day dividers stay.
- **One line per entry**, indented under the heading: time (mono 10.5 muted, 38px), the marked prefix if any (mono 10.5
  muted, "marked done · "), the headline (the existing `headline()`, one line with an ellipsis), the note's size
  (`kilo` of the body length, mono 10.5 muted) and a chevron. Clicking the line expands the full note below it (the
  existing `paragraphs()` rendering). Nothing is open by default: the newest-open rule (`newestKey`) goes.
- **Bookkeeping entries render as one quiet mono 10.5 muted line under the time, with no expand.** Classified by what
  the Go side writes into the events the feed reads (`pkg/jarvis/effortops.go`): a `chunk-added` event and a
  `chunk-status`/`chunk-done` event with no note text. The line is the entry's `marked` ("chunk added", "marked
  done"); the chunk's heading above it already names the chunk.
  - **Where this departs from the mockup:** the Go side writes "renamed from X" and "moved to position N" (and "stage
    set to", "activated") only onto the chunk's own note trail with `chunkNote`, never as events, and the feed reads
    only events. Checked on the live store: effort c4157d0e has 199 events, none carrying those strings, while its
    chunk trails hold 40 of them. So they cannot reach the feed, and the mockup's quiet "renamed from …" line cannot
    occur. No text classifier is added for them: one would misfire on real notes, such as c4157d0e's agent-written
    "renamed from 'A6 card surface…' - rev 8 made A6 a dedicated page…".
- **Paging is unchanged**: `FEED_PAGE`, "Show N older · M left".

### 7. Unchanged

Layouts and spacing, the stage progress bars and the initiative row's `ProgressBar` (single-colour done/total), the
tracker's menus apart from the icons and the unstaged menu, the footer and delete confirm, note editing, the sidebar
composer, the facts derivation (`effortFacts`), region heads (already 10.5px), motion. `briefrows.ts`'s run-row chunk
label ("title · unstaged") is not the sidebar crumb and stays.

## Out of scope

- Run 2c52729f's files (landed on main): `runsheet.tsx`, `runsheetmodel.ts`, `briefrunsheet.tsx`, `briefsheet.tsx`,
  `runreportview.tsx`, `childaskcard.tsx`, `runcards.tsx`, `timelinerail.tsx`, and the `run-sheet-polish` CDP scenario.
- The record peek (`briefpeekview.tsx`), graph peek (`graphpeek.tsx`) and `jarvisgraph.tsx`: a later pass.
- `frontend/app/view/jarvis/pet*` (another session's uncommitted work).

## Verification

- Pure logic in `.ts` with a `.test.ts` beside it: `isFlatPlan` and `trackerRows`' flat rule in
  `inlinetracker.test.ts` (no stage row; chunks shown even when all done and when an override says folded; a plan with
  one staged chunk keeps its headers, including the unstaged run's); `feedGroups` in `effortfeed.test.ts` (day
  dividers and their labels, group order by newest entry, entries newest first, no headings under "only", bookkeeping
  classification, paging `left`). No jsdom render tests.
- One CDP scenario, `brief-initiatives-polish`, appended after `run-sheet-polish` in `scripts/cdp/scenarios.mjs`
  (independent of it). It opens an initiative with stages and one without, opens a chunk in the sidebar and opens the
  initiative's activity, and asserts: nothing inside `[data-jarvis-initiative-detail]`, `[data-jarvis-chunk-sidebar]`
  and the activity sheet renders below 10.5px (each font-size sweep scoped to those containers); the flat
  initiative's detail has no `[data-jarvis-tracker-stage]`; the staged one has at least one.
