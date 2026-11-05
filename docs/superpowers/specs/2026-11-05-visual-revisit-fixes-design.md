# Visual revisit fixes: Cockpit, Sessions, Agent, Code, Diff

Fixes the 16 findings (F1-F16) of the visual revisit report
(`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\visual-revisit\report.md`, gitignored; its screenshots
sit beside it, named by the shot numbers each finding cites). Every finding is checked at 1000x700 and 1600x950.
Out of scope: the report's "Tooling gaps" section, including the go.mod-opens-as-binary note.

Each cause below was re-read against the code at f15fdc695. Where the code supports a different fix than the
report suggests, the decision says so and why.

## Rules every fix keeps

- Existing `@theme` tokens only (`frontend/tailwindsetup.css`); no new token. A `color-mix()` of two existing
  tokens is allowed where no single token fits, since it still re-skins with the theme.
- Narrow-width behavior uses container queries (`@container` + `@max-[Npx]:`), the pattern the cockpit card
  (`agentrow.tsx:80` `WIDE_ONLY`) and the brainstorm pane already use, not viewport breakpoints: the surfaces'
  columns change width with rails, so the window width says little about a component's room.
- Logic goes in a pure `.ts` with a test beside it (AGENTS.md). Pure class-name changes need no test; their proof
  is a CDP scenario step.
- Every fixed visual state gets a step in an existing scenario for its surface, run at the width where it was
  broken (`Emulation.setDeviceMetricsOverride` 1000x700 or 1600x950, cleared in the scenario's teardown), that
  measures the state (rects, scrollWidth vs clientWidth, computed style), not only shoots it.

## Decisions

### F1. Diff editor does not fit its pane or re-lay out on resize

**Trace (static, Monaco 0.55.1).** `diff.layout()` with no argument calls
`_rootSizeObserver.observe()`, which re-measures Monaco's own root (`.monaco-diff-editor`, `height: 100%`) and
therefore our host div. The host (`monaco-react.tsx:279`, `flex flex-col h-full w-full`) sits in the pane's flex
column beside the 48px header (`diffpane.tsx:327-337`). So:

1. `h-full` resolves to 100% of the pane, ignoring the header: the first mount measures the full pane height
   (540 at 1000x700, the report's measurement), and the editor runs 48px past the pane over the footer.
2. As a column flex item the host keeps `min-height: auto`, its content size, which Monaco has pinned in px. The
   host therefore never grows or shrinks with the pane; the ResizeObserver on it sees no change, and a `layout()`
   would re-measure the same stale box anyway. That is why the editor stays 492 after the window grows to 1600.

**Decision.** Fix the host, once, in `MonacoDiffViewer`: an outer box that takes the pane's leftover space in any
parent (`relative min-h-0 min-w-0 flex-1 basis-0` plus `h-full` for a block parent) and the Monaco host inside it
`absolute inset-0`, so its size depends only on the pane and never on Monaco's content. The ResizeObserver hands
the observed size to `diff.layout({ width, height })` (debounced as now). Not `automaticLayout: true`: Monaco's
own observer watches the same `height: 100%` root and inherits the same broken box. The other two callers
(`codediffview.tsx`, `codepeekcard.tsx`) must keep rendering: the Code diff and peek scenarios run in Final as
regressions. `MonacoCodeEditor` has the same host markup but no reported defect and its callers give it a definite
box, so it is left alone.

### F2. Hints footer wraps out of its 28px bar

**Decision.** Chips that do not fit are dropped whole from the end, never wrapped onto a second line or cut
mid-chip. `visibleHints` (`footer-visible.ts`) already orders surface hints before global ones, so the tail is
the lowest priority. CSS does it: the chip row is `h-full min-w-0 flex-1 self-stretch overflow-hidden` with
`flex-wrap content-start` and no row gap, and each chip is `h-full shrink-0 whitespace-nowrap`, so every line is
exactly the bar's content box tall (h-7 minus the 1px top border) and a wrapped chip lands on a second line that
the row's own height clips. The readout gets `shrink-0`. No JS measuring: the clip is exact, and there is no state
to keep in sync. The leader posture's continuation row (`hints-footer.tsx:98`) has the same `flex-wrap` defect, so
both postures render through one shared chip-row element in the same file.

### F3. Agent header loses its title at 1000 with the details rail open

**Decision.** The text column becomes `min-w-0 flex-1 overflow-hidden`; the title gets a floor (`min-w-[96px]`)
and truncates above it. The header is an `@container`; below the width where title floor + runtime pill + state
pill + buttons fit, the model pill and then the context readout hide (`@max-[Npx]:hidden`, N measured at 1000x700
with the rail open). The runtime and state pills stay: they are the agent's identity and status.

### F4. Cockpit Finished strip: age wraps, Open clips

**Decision.** The age span gets `truncate whitespace-nowrap` like the Standing-by branch. On a narrow card (the
existing card `@container`, threshold measured at the 1000x700 two-agent card, about 285px) the "Review changes"
label hides and keeps its `+N −N` counts, and "Open" shows only its arrow icon; both keep the full words as
`title` and `aria-label`.

### F5. App-bar search collapses at 1000

**Decision.** The search takes the leftover space with a floor: its wrapper `min-w-[160px] flex-1`, the button
`w-full max-w-[520px]` instead of `w-[min(520px,42%)]`. The bar is an `@container`; below a measured width the
usage meters hide their bar graphic and keep `5h 41%` (the `Meter` element hides, the text stays, the title keeps
the full detail). **Declined:** centering the search against the whole bar. The sideways shift between surfaces
comes from the switcher's deliberate per-surface label (`surfacecontext.ts`: "Default ·" marks surfaces where the
switcher sets a default rather than filters), and the right cluster (meters, New run, New agent, window controls)
is about twice the left one, so a bar-centered 520px search collides with it at 1600 with meters showing.

### F6. A new file's diff paints full-height gutter bands

**Decision.** As the report says: the `[data-diff-new-file]` rule (`tailwindsetup.css:321`) also sets
`--vscode-diffEditorGutter-insertedLineBackground` and `--vscode-diffEditorGutter-removedLineBackground` to
`transparent`. The cause is confirmed: `DIFF_BANDS` (`monacotheme.ts:40-47`) defines both gutter colors and the
rule clears only the editor ones.

### F7. Diff pane header: a long filename overprints the counts

**Decision.** The filename span becomes `min-w-0 truncate` (it is `flex-none` at `diffpane.tsx:217`) and its
wrapper (`:211`) `overflow-hidden`. The directory keeps truncating first (it is the earlier, rtl-truncated part);
the filename truncates only once the directory is gone. Counts, size and the change counter stay `flex-none`.

### F8. Code view-mode toggle shows no selected segment for a non-markdown file

**Decision.** A pure `shownViewMode(mode, path)` in `codeviewmode.ts` (beside `showsSourceEditor`, which encodes
the same rule) returns `"source"` for `"preview"` on a non-markdown path; the toggle compares against it. Tested in
`codeviewmode.test.ts`.

### F9. White scrollbar corner, horizontal scrollbars, raw thumb colors

**Decisions.**
- Global (`tailwindsetup.css:269-285`): add `::-webkit-scrollbar-corner { background: transparent }`. The thumb
  becomes `var(--color-edge-strong)` (#2a313a, the nearest token to the raw #262c34) and its hover
  `color-mix(in srgb, var(--color-edge-strong) 75%, var(--color-ink-faint))` (no token sits between edge-strong
  and ink-faint). Monaco's slider (`monacotheme.ts` `SCROLL_THUMB*`) reads the same two values from
  `buildThemeVars` like the chrome roles, so the two scrollbars stay one color under every theme.
- Sessions feed (`sessionssurface.tsx:974`): the event text gets `break-words [overflow-wrap:anywhere]`.
- Code markdown preview: the cause is in the shared `Markdown` element (`.content { overflow: scroll }` in
  `markdown.scss:16` with the caller's horizontal padding), which the peek card already works around with
  `!overflow-x-hidden` (`codepeekcard.tsx:178`). Fix it once in the shared element so no caller overflows by its
  padding, then drop the peek card's workaround. If the overflow's source cannot be pinned in the element, the
  fallback is the peek card's precedent on `codeviewer.tsx:313`; the task says which it did.

### F10. Sessions run cards: "9/9 landed" wraps, elapsed is truncated away

**Decision.** The landed spans get `whitespace-nowrap flex-none`. The segment strip becomes `min-w-0` with
segments that shrink (`flex: 0 1 14px`, floor 4px) instead of a fixed 14px each. The trailing text leads with the
elapsed time (`2m ago · waveterm`), so truncation cuts the project, which the card's context already shows, not the
time.

### F11. Sessions detail header becomes a narrow column at 1000

**Decision.** The detail header is an `@container`; below about 600px the actions (Activity/Transcript toggle and
the primary button) wrap to their own row under the title column (`flex-wrap`, the actions `basis-full` or
equivalent), so the title and meta keep the full width. The run-member header (`sessionsdetail.tsx:775`) gets the
same treatment if it shows the same squeeze at 1000.

### F12. Codex logo invisible in the New agent dialog

**Decision.** Recolor `frontend/app/asset/codex.svg` to `fill="#ececec"`, the `rt-codex` identity value (DESIGN.md
identity palette: theme-agnostic by design, "monochrome mark … inverted to near-white"). One asset, every place
the mark shows, no per-caller invert class. `pi.svg` needs nothing: it carries its own dark tile.

### F13. New agent dialog's preselected project row is half clipped

**Decision.** On open (and when the preselection changes), the selected project row scrolls into view with
`scrollIntoView({ block: "nearest" })` inside the list's own scroller.

### F14. Markdown preview renders YAML front matter as body text

**Decision.** A pure `fenceFrontMatter(text)` in `markdown-util.ts`: a document whose first line is exactly `---`
and that has a later line `---` or `...` gets that block rewritten as a fenced `yaml` code block (fence longer
than any backtick run inside it), so it renders as highlighted metadata, not prose and H1s. Anything else is
returned unchanged (a lone opening `---` stays a rule). Applied in `Markdown` before `transformBlocks`, so every
markdown view gets it. No new dependency (not `remark-frontmatter`): the code block already renders and themes.

### F15. Diff has two empty-state styles

**Decision.** The Diff pane's local `EmptyState` (`diffpane.tsx:45`) is replaced by the shared
`SurfaceEmptyState` (`surfacescaffold.tsx`), which the Code surface already uses for its pane-scoped diff states
(`codediffview.tsx`). The `FileText` glyph and the Retry button move into its `glyph` and `action` props. The
`data-diff-empty` and `data-diff-retry` hooks the scenarios use are kept, which needs two optional props on
`SurfaceEmptyState`: `data?: Record<string, string>` spread onto its root and `action.data?: Record<string, string>`
spread onto the action button. DESIGN.md gets one sentence: empty states
use `SurfaceEmptyState` at surface and pane scope alike.

### F16. Cockpit header shows "0 need you" in bold amber

**Decision.** `text-warning font-semibold` only when `counts.needsYou > 0`; otherwise the fact's muted color.

## Verification

Final runs the scenarios each task names (see the plan's Final line) through `final-verify.mjs`'s isolated app;
nothing attaches to the dev app on :9222.
