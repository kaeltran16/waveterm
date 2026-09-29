# Narration timeline polish

The narration feed (`frontend/app/view/agents/narrationtimeline.tsx`) renders in the run lead card and
worker cards (`runworkercard.tsx`), Sessions detail (`sessionsdetail.tsx`), subagent views, ended
transcripts (`endedtranscript.tsx`) and, through `ToolDetailBody`, the tool detail modal. Its text runs as
small as 9px, tool lines sit behind 0.68–0.72 opacity, and its states are drawn with text glyphs. This
brings it onto the Jarvis brief type scale (`frontend/app/view/jarvis/briefstyle.ts`) with readable contrast
and lucide icons.

## The design is the mockup

The user approved an interactive mockup. It is the spec for every value below:

- `C:/Users/kael02/IdeaProjects/waveterm/.superpowers/design/narration-timeline/project/Main.dc.html`: the
  feed in an agent card, with toggles for Today and Polished, live and ended, and wide and narrow widths.
- `ToolRows.dc.html` (same folder): each tool-line, edit-burst, folded-run and inline-detail state.
- `Markers.dc.html` (same folder): messages, the You bubble, command and skill chips, compaction,
  interrupted and background-task rows.

The folder is gitignored, so read it by absolute path. To view it, serve it with
`python -m http.server 8766 --bind 127.0.0.1 --directory .superpowers/design` from the main checkout and
open `http://127.0.0.1:8766/narration-timeline/project/Main.dc.html`. The exact Polished values are in the
`const POLISHED` table in each board's script. `TODAY` transcribes the current classes, so the difference
between the two tables is the change list. When this spec and a POLISHED value disagree, POLISHED wins.
Do not delete the folder; the user removes it after this ships.

## Decisions

1. **Type scale.** No text in the feed is below 10.5px.
   - Labels are 10.5px mono, semibold or bold, uppercase, tracking 0.06–0.1em. That covers tool verbs,
     "You", "Compacted", "Interrupted", "Task", status chips, exit chips and the edit-file A/M badges.
   - Tool targets are 11.5px mono in `ink-mid`.
   - Summaries, durations and +N/−N counts are 10.5px mono.
   - Detail panel text (grep, read, bash, skill and edit lines) is 11.5px mono.
   - The You bubble text is 13px.
   - `text-xxxs`, `text-[9px]`, `text-[9.5px]` and `text-[10px]` leave `narrationtimeline.tsx`. The
     `--text-xxxs` token itself stays, because other files use it.
2. **Contrast.**
   - Remove `opacity-[0.72]` and `opacity-[0.68]` from tool lines and edit-burst rows.
   - Text in `text-feed-time` or `text-edge-strong` becomes `text-muted`. That covers durations, the grep
     "more" line and the expand affordances.
   - `text-feed-label` labels become `text-muted` (tool verbs) or `text-ink-mid` (the Task label and the
     interrupted pill).
   - The `feed-*` tokens stay defined in `tailwindsetup.css`; the feed just stops using the ones that fail
     contrast.
3. **Glyphs become `lucide-react` icons.**
   - ✓ becomes `Check` and ✗ becomes `X`.
   - ▶ and ▼ become `ChevronRight` and `ChevronDown`; the compaction ▲/▼ become `ChevronUp`/`ChevronDown`;
     the folded run's ▸ becomes its `Layers` square (decision 7).
   - ↗ becomes `ArrowUpRight`, ⊘ becomes `Ban`, and the Insight ★ becomes `Lightbulb`.
   - ✦ on the skill chip and ⑃ on the task glyph stay as they are.
4. **Tool line** (`ToolLine`, `EditBurstRow`).
   - One column, in order: a 16px rounded status square, the verb (min-width 50px), the target, the summary
     or diff counts, a spacer, the duration and the affordance. The gap is 8px.
   - The open inline detail panel is indented 30px so it sits under the target. It has an `edge-mid`
     border and an 8px radius.
5. **Inline detail panels.**
   - Long lines wrap instead of scrolling sideways: `whitespace-pre-wrap` plus `overflow-wrap:anywhere`
     for bash output, read lines and edit lines.
   - Edit lines keep the +/− sign column, so a wrapped line hangs under its text.
   - Grep matches stay one line each and truncate.
   - Only `ToolDetailBody`'s `inline` variant wraps. The `modal` variant, used by the tool detail modal,
     keeps its unwrapped, scrolling lines. The type scale and colours (decisions 1–3) apply to both
     variants, because they share the class strings.
6. **Panel footer** (`ToolLine`'s inline detail).
   - The lone ↗ button with `title="Expand"` becomes a text button reading "Open full view", with the
     `ArrowUpRight` icon, in 10.5px mono `ink-mid`.
   - It has no native `title` tooltip; it uses `aria-label`.
   - For bash details, the exit chip moves out of the scrolling body into this footer, on the left, so it
     never scrolls away or sits against the output. In the modal variant the exit chip stays where it is.
7. **Folded run** (the collapsed group button).
   - It loses the `border-l-2` left ribbon and the accent wash.
   - It becomes a row with a 1px `edge-mid` border and a 6px radius, on the same column as the tool lines.
   - The row holds, in order: a 16px accent-tinted square with the `Layers` icon; "N tools" at 11.5px
     semibold; the per-verb counts ("4 read · 3 ran") at 10.5px `ink-mid`, truncating; a spacer; the
     outcome; and `ChevronRight`.
   - The outcome reads "all ok" with `Check` in `muted`, or "N failed" with `X` in `error`. Colour is never
     the only signal.
   - This needs a fail count, so `summarizeActions` in `agentsviewmodel.ts` gains `failed: number`, tested
     in `agentsviewmodel.test.ts`. `outcome` stays; the rail's tool chips (`agentdetailsrail.tsx`) read only
     `byVerb`.
8. **Compaction and interrupted dividers.**
   - The gradient hairlines become plain 1px `edge-mid` lines.
   - Pill text is 10.5px, as in decision 1.
   - The compaction summary panel's eyebrow is 10.5px `muted`.
9. **Insight callout** (`InsightCallout` in `markdownmessage.tsx`).
   - It loses its `border-l-2` ribbon and gets a full 1px `accent/25` border with an 8px radius, on the same
     `accent/5` fill.
   - The eyebrow is 10.5px mono, bold, uppercase, tracking 0.1em, in `accent-soft`, with the `Lightbulb`
     icon and the word "Insight".
   - The change also reaches answerbar, planpreview and runbody, which use the same component. The user
     approved that.
10. **Ended transcripts.** Remove `opacity-80` from the feed container in `endedtranscript.tsx`. It dimmed
    the whole ended feed on top of the tool-line opacity.
11. **Unchanged:**
    - Messages: the avatar, 13px text, and `accentLatest` in `primary`.
    - The command and skill chips.
    - The notification row's layout; only its sizes change.
    - Grouping and routing: `groupTimeline`, `burstRenderMode` and `detailExceedsInline`.
    - Motion and the 200-item render cap (`TIMELINE_RENDER_CAP`).
    - The tool detail modal's own header (`tooldetailmodal.tsx`).

## Verification

- **Unit:** `summarizeActions` returns `failed` (0 when nothing failed, the count otherwise), in
  `agentsviewmodel.test.ts`. There are no jsdom render tests.
- **Rendered feed (CDP).** No existing scenario renders the feed, and every surface that mounts it needs a
  live session or run. So a feed gets onto the screen through a dev-only seam, following
  `window.__waveDagModalFixture` (`frontend/app/view/orchestrate/dagmodalstate.ts`):
  - A small `NarrationFeedFixtureModal` renders `NarrationTimeline` over a fixture entry list at a given
    width (inside `ModalShell`, marked `data-narration-fixture`).
  - It is registered in `modalsrenderer.tsx` only when `import.meta.env.DEV` is set.
  - `window.__narrationFeedFixture.show(entries, width)` pushes it.
  - The fixture entries live in the scenario, not the frontend.
- **Scenario `narration-feed`.** It lives in its own module, `scripts/cdp/narrationfeed.mjs`, because run
  ba79c116 is editing `scenarios.mjs`; `scenarios.mjs` only imports it and lists it. It renders one feed
  with every entry kind at a wide width (640px) and a narrow width (360px). It screenshots both and
  asserts from computed styles and the DOM:
  - No text node in the feed computes below 10.5px.
  - No tool row has opacity below 1.
  - None of the replaced glyphs (✓ ✗ ▶ ▼ ▲ ▸ ↗ ⊘ ★) appears in the feed's text.
  - The folded run has a 1px border on all four sides, no 2px left border, and reads "N tools" and
    "all ok" or "N failed".
  - An opened bash line's panel has a footer with the exit chip and an "Open full view" button carrying
    `aria-label` and no `title`. Its output computes `white-space: pre-wrap`, and at 360px the panel does
    not scroll horizontally.
  - The insight callout has a 1px border on all four sides.
  - "Open full view" opens the tool detail modal, whose bash output still computes `white-space: pre`.
- **Final:** `node scripts/cdp/final-verify.mjs narration-feed surface-smoke`.

## Constraints

- Colours come only from the `@theme` tokens in `frontend/tailwindsetup.css`. No new tokens, no raw hex or
  rgba, no emoji.
- Frontend only: no wire-type or Go change.
- Stay out of run ba79c116's files (`frontend/app/view/orchestrate`, `timelinerail.tsx`, the
  `dag-lifecycle` scenario) and run 02d0840e's (`pkg/orchestrate`, `pkg/wshrpc/wshserver`,
  `scripts/verify.mjs`).
