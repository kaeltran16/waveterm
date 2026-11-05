# Visual revisit fixes Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-05-visual-revisit-fixes-design.md` (each finding's traced cause and the decision taken; read your finding's section before starting)
**Verify:** `node scripts/verify.mjs ./pkg/util/keyedmutex`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs diff-states diff-compare code-diff-states code-peek resmon-footer usage-charts agent-header cockpit-card-layout cockpit-roster-counts sessions-list-states sessions-detail-states code-markdown code-toolbar cockpit-launch-stays`

**Goal:** Fix findings F1-F16 of the visual revisit report (`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\visual-revisit\report.md`, gitignored; screenshots beside it named by shot number) at 1000x700 and 1600x950.

**Architecture:** Seven independent tasks, one per surface or shared component, each owning its source files and the scenario file that proves it. The frontend is React 19 + Tailwind 4; narrow-width behavior uses container queries (`@container` / `@max-[Npx]:`), as `agentrow.tsx:80` does.

## Global Constraints

- Existing `@theme` tokens only (`frontend/tailwindsetup.css`); no new token. A `color-mix()` of two existing tokens is allowed where no single token fits.
- Logic goes in a pure `.ts` with its test beside it; class-name-only changes are proven by a scenario step.
- Every fixed visual state gets a step in the named existing scenario, run at the width where it was broken via `Emulation.setDeviceMetricsOverride` (`{width: 1000, height: 700, deviceScaleFactor: 1, mobile: false}` or 1600x950), cleared in that scenario's teardown or `finally`. A step measures the state (element rects, `scrollWidth` vs `clientWidth`, computed style) and records pass/fail; a shot alone is not a step.
- Never select an element by window position near the title bar (the app bar's Close button sits top-right). Scope queries to a `data-*` container (docs/reference/cdp-verification.md).
- Never attach to or kill the dev app on :9222; live checks run only through Final (`final-verify.mjs`'s isolated app).
- Out of scope: the report's "Tooling gaps" section.

## Review Focus

1. A Code diff (`codediffview.tsx`) or Code peek diff (`codepeekcard.tsx`) after Task 1's `MonacoDiffViewer` host change: both must still fill their box. Final runs `code-diff-states` and `code-peek` for this.
2. A markdown file whose first line is `---` used as a horizontal rule with no closing `---`: it must render unchanged (Task 6 test).
3. Front matter containing a ``` fence: the yaml block must not end early (Task 6 test).
4. A wide GFM table or a long code line in the markdown preview after Task 6's overflow fix: it must still be readable (scroll inside its own block or the content), never clipped with no way to see it.
5. A hints footer on a surface with few chips at 1600: all chips still show (Task 2's clip must only drop chips that do not fit).

---

### Task 1: Diff pane: editor fit (F1), new-file gutter (F6), header overlap (F7), empty state (F15), scrollbar tokens (F9 global)
**Depends on:** none
**Files:** `frontend/app/monaco/monaco-react.tsx`, `frontend/app/view/agents/diffpane.tsx`, `frontend/app/view/agents/surfacescaffold.tsx`, `frontend/tailwindsetup.css`, `frontend/app/monaco/monacotheme.ts`, `frontend/app/monaco/monacotheme.test.ts`, `DESIGN.md`, `scripts/cdp/scenarios-files-states.mjs`, `scripts/cdp/scenarios-files.mjs`

Decisions are in the spec's F1, F6, F7, F9 (global bullet) and F15 sections.

- [ ] **F1:** In `MonacoDiffViewer` (`monaco-react.tsx`), render an outer box `relative min-h-0 min-w-0 flex-1 basis-0 h-full` holding the Monaco host `absolute inset-0` (the `divRef`). The ResizeObserver passes the entry's size: `diff.layout({ width, height })`, debounced as now. Leave `MonacoCodeEditor` alone.
- [ ] **F6:** Add `--vscode-diffEditorGutter-insertedLineBackground: transparent;` and `--vscode-diffEditorGutter-removedLineBackground: transparent;` to the `[data-diff-new-file]` rule in `tailwindsetup.css`.
- [ ] **F7:** In the pane header, the filename span gets `min-w-0 truncate` (drop `flex-none`), its wrapper (`diffpane.tsx:211`) gets `overflow-hidden`; the directory still truncates first.
- [ ] **F15:** Replace `diffpane.tsx`'s local `EmptyState` with `SurfaceEmptyState`: `glyph` = the current `FileText` tile, `action` = Retry for `kind === "failed"`. Add two optional props to `SurfaceEmptyState` (`surfacescaffold.tsx:64`): `data?: Record<string, string>`, spread onto its root `motion.div`, and `action.data?: Record<string, string>`, spread onto the action button; existing callers are unchanged. Pass `data={{ "data-diff-empty": kind }}` and, for Retry, `action.data={{ "data-diff-retry": "" }}`, so the hooks the scenarios use stay. Add one sentence to DESIGN.md: empty states use `SurfaceEmptyState` at surface and pane scope alike.
- [ ] **F9 global:** In `tailwindsetup.css`, add `::-webkit-scrollbar-corner { background: transparent; }`; thumb background `var(--color-edge-strong)`, hover `color-mix(in srgb, var(--color-edge-strong) 75%, var(--color-ink-faint))`. In `monacotheme.ts`, delete `SCROLL_THUMB`/`SCROLL_THUMB_HOVER`; add `scrollThumb: string | null` and `scrollThumbHover: string | null` to `MonacoChrome`, filled in `readChromeRoles` and `useSyncMonacoTheme` from `--color-edge-strong` and the same 75/25 mix with `--color-ink-faint` (colord `mix` plugin); `monacoThemeFromTokens` sets the three `scrollbarSlider.*` colors from them only when non-null.
- [ ] **Test:** update `monacotheme.test.ts`: with `scrollThumb: "#2a313a"` and `scrollThumbHover` given, `scrollbarSlider.background` is `#2a313a` and hover/active equal the given hover; with both null, no `scrollbarSlider.*` key is set. Run `npx vitest run frontend/app/monaco/monacotheme.test.ts`: PASS.
- [ ] **Scenario steps in `diff-states` (`scenarios-files-states.mjs`):** add to its fixture repo an untracked new file whose name is long enough to overrun the header at 1000 (e.g. `docs/2026-11-05-a-very-long-review-plus-fixes-design.md`) and a modified text file of 60+ lines. Steps, each recorded:
  - at 1000x700, open the modified file: the `.monaco-diff-editor` rect's bottom is within the `[data-diff-pane]` rect and above `[data-hints-footer]`'s top, and its top is at or below the header's bottom;
  - resize to 1600x950 and wait for the debounce (≥ 300ms): the editor's height equals the pane body's height (pane height minus header) within 2px;
  - at 1000x700, open the long-named new file: the header's filename, `+N`, `−N` and change-counter rects do not intersect, and the filename's `scrollWidth > clientWidth` (it truncates);
  - on the new file, `getComputedStyle` of `[data-diff-pane] .monaco-editor` reads `transparent` (or `rgba(0, 0, 0, 0)`) for both `--vscode-diffEditorGutter-*LineBackground` vars;
  - an existing empty kind (e.g. `binary`) renders through `SurfaceEmptyState` (its root carries `data-diff-empty`, its title is the shared component's title style);
  - the app stylesheet's `::-webkit-scrollbar-thumb` rule (read from `document.styleSheets`) uses `var(--color-edge-strong)` and a `::-webkit-scrollbar-corner` rule exists.
- [ ] **Scenario step in `diff-compare` (`scenarios-files.mjs`):** at 1000x700, the "Nothing to compare" state renders through `SurfaceEmptyState` with the same title font size as the surface-level "Pick something to review".
- [ ] Run `task check:ts`: clean.

### Task 2: Shell chrome: hints footer (F2), app-bar search (F5)
**Depends on:** none
**Files:** `frontend/app/cockpit/hints-footer.tsx`, `frontend/app/cockpit/app-bar.tsx`, `frontend/app/view/agents/usagemeters.tsx`, `scripts/cdp/scenarios-agent.mjs`, `scripts/cdp/scenarios-usage.mjs`

Decisions are in the spec's F2 and F5 sections.

- [ ] **F2:** In `hints-footer.tsx`, extract one chip-row element used by both postures (rest/in-terminal at `:120` and the leader continuation row at `:98`, which has the same defect). The row: `h-full min-w-0 flex-1 self-stretch overflow-hidden flex flex-wrap content-start items-center gap-x-4` (no row gap), keeping `data-footer-chips` and the rest posture's `opacity-60` when editable. Each `Chip` gets `h-full shrink-0 whitespace-nowrap`, so every wrapped line is exactly the bar's content box tall (27px: `h-7` minus the 1px top border) and a chip that does not fit lands on a second line the row's own height clips. The readout wrapper gets `shrink-0`.
- [ ] **F5:** In `app-bar.tsx`, the search wrapper becomes `flex min-w-[160px] flex-1 justify-center` and the button `w-full max-w-[520px]` (replacing `w-[min(520px,42%)]`). Make the bar an `@container`; in `usagemeters.tsx` the `Meter` bars hide below a container width you measure (`@max-[Npx]:hidden`) so that at 1000x700 with meters showing the search button is at least 200px wide; the `5h 41%` text stays. Do not center the search against the whole bar (declined in the spec).
- [ ] **Scenario steps in `resmon-footer` (`scenarios-agent.mjs`):** at 1000x700 on the Diff surface: every visible chip's rect lies inside `[data-hints-footer]`'s rect (no chip above its top border or below the window), the readout's `scrollWidth <= clientWidth` and its text ends with its unit (e.g. `GB`), and at least one `[data-footer-chips]` child lies wholly outside the row's rect (proving chips were dropped rather than wrapped into view); at 1600x950 on the Agent surface every `[data-footer-chips]` child's rect lies wholly inside `[data-hints-footer]`'s rect (no chip dropped when all fit).
- [ ] **Scenario steps in `usage-charts` (`scenarios-usage.mjs`, beside step 3b which arranges the meters):** at 1000x700 with meters showing, the app-bar search button is ≥ 200px wide and its placeholder span shows text (`clientWidth > 0`); at 1600x950 the meters still render their bars.
- [ ] Run `task check:ts`: clean.

### Task 3: Agent header title at 1000 with the rail open (F3)
**Depends on:** none
**Files:** `frontend/app/view/agents/agentheader.tsx`, `scripts/cdp/scenarios-agent-header.mjs`

Decision is in the spec's F3 section.

- [ ] In `agentheader.tsx`, the text column (`:245`) becomes `min-w-0 flex-1 overflow-hidden`; the title span gets `min-w-[96px]` and keeps `truncate`. Make the header an `@container`; below a width you measure (1000x700, details rail open), the model pill hides first, then the context readout (`@max-[Npx]:hidden`, two thresholds). Runtime and state pills stay.
- [ ] **Scenario steps in `agent-header`:** at 1000x700 with the details rail open: the title's rect width ≥ 96px, and no pill's rect intersects the header's right-hand buttons; at 1600x950 with the rail open the model pill is visible.
- [ ] Run `task check:ts`: clean.

### Task 4: Cockpit: Finished strip (F4), "need you" fact (F16)
**Depends on:** none
**Files:** `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/cockpitsurface.tsx`, `scripts/cdp/scenarios-cockpit-card.mjs`, `scripts/cdp/scenarios-cockpit-roster.mjs`

Decisions are in the spec's F4 and F16 sections.

- [ ] **F4:** In `agentrow.tsx`, the FinishedAge span (`:584`) gets `truncate whitespace-nowrap`. Using the card's existing `@container`, below a width you measure (the two-agent card at 1000x700 is about 285px) the "Review changes" label hides (counts stay) and "Open" shows only its icon; both buttons carry `title` and `aria-label` with the full words.
- [ ] **F16:** In `cockpitsurface.tsx:493`, `font-semibold text-warning` only when `counts.needsYou > 0`.
- [ ] **Scenario steps in `cockpit-card-layout`:** at 1000x700 with a finished agent that has a diff: the strip is one line (its height ≤ 34px), the age span's height is one line, and the Open button's `scrollWidth <= clientWidth`; at 1600x950 the "Review changes" label is visible.
- [ ] **Scenario steps in `cockpit-roster-counts`:** with nothing asking, the "need you" span's computed color is not the `--color-warning` color and its weight is below 600; with an asking agent in the fixture, it is the warning color.
- [ ] Run `task check:ts`: clean.

### Task 5: Sessions: feed overflow (F9 feed), run cards (F10), detail header (F11)
**Depends on:** none
**Files:** `frontend/app/view/agents/sessionssurface.tsx`, `frontend/app/view/agents/sessionsdetail.tsx`, `scripts/cdp/scenarios-sessions-list-states.mjs`, `scripts/cdp/scenarios-sessions-detail-states.mjs`

Decisions are in the spec's F9 (Sessions bullet), F10 and F11 sections.

- [ ] **F9:** The feed event text (`sessionssurface.tsx:974`) gets `break-words [overflow-wrap:anywhere]`.
- [ ] **F10:** The landed spans get `whitespace-nowrap flex-none`; the segment strip `min-w-0` with segments `flex: 0 1 14px` and a 4px floor; the trailing text reads elapsed first (`[ranLabel(elapsed), view.project]`).
- [ ] **F11:** The `SoloDetail` header (`sessionsdetail.tsx:588`) becomes an `@container` with `flex-wrap`; below about 600px the ViewToggle and primary button wrap to their own row under the title column. Apply the same to the run-member header (`:775`) if it squeezes the same way at 1000x700.
- [ ] **Scenario steps in `sessions-list-states`:** add a feed event whose text holds an unbroken Windows path of 150+ characters and a run with 9 tasks, all landed. At 1000x700: the feed scroller's `scrollWidth <= clientWidth`; the run card's "9/9 landed" span is one line; its trailing text starts with the elapsed label. Repeat the run-card check at 1600x950.
- [ ] **Scenario steps in `sessions-detail-states`:** at 1000x700 on a solo session: the title's rect width ≥ 300px and the meta block is at most two lines tall; at 1600x950 the actions sit on the title's row.
- [ ] Run `task check:ts`: clean.

### Task 6: Code: view-mode toggle (F8), preview overflow (F9 preview), front matter (F14)
**Depends on:** none
**Files:** `frontend/app/view/code/codeviewmode.ts`, `frontend/app/view/code/codeviewmode.test.ts`, `frontend/app/view/code/codepathbar.tsx`, `frontend/app/element/markdown-util.ts`, `frontend/app/element/markdown-util.test.ts`, `frontend/app/element/markdown.tsx`, `frontend/app/element/markdown.scss`, `frontend/app/view/code/codeviewer.tsx`, `frontend/app/view/code/codepeekcard.tsx`, `scripts/cdp/scenarios-code.mjs`, `scripts/cdp/scenarios-code-toolbar.mjs`

Decisions are in the spec's F8, F9 (Code bullet) and F14 sections.

- [ ] **F8 test first** in `codeviewmode.test.ts`: `shownViewMode("preview", "a.js") === "source"`, `shownViewMode("preview", "README.md") === "preview"`, `shownViewMode("diff", "a.js") === "diff"`, `shownViewMode("source", "README.md") === "source"`. Run it: FAIL.
- [ ] **F8:** add `export function shownViewMode(mode: "preview" | "source" | "diff", path: string): "preview" | "source" | "diff"` to `codeviewmode.ts`; `ViewModeToggle` (`codepathbar.tsx:120`) compares segments against it (it needs the open file's path; pass it in or read it where `markdown` is computed). Run the test: PASS.
- [ ] **F14 tests first** in `markdown-util.test.ts` for `export function fenceFrontMatter(text: string): string`:
  - `"---\ntitle: x\n# comment\n---\n# Body"` → a ```` ```yaml ```` fenced block holding `title: x\n# comment`, followed by `# Body`;
  - closing line `...` is accepted like `---`;
  - `"---\nno close\n"` and `"text\n---\na: b\n---"` are returned unchanged;
  - front matter containing a ```` ``` ```` line is fenced with a longer backtick fence so the block does not end early;
  - CRLF line endings are handled the same as LF.
  Run: FAIL.
- [ ] **F14:** implement `fenceFrontMatter` in `markdown-util.ts`; call it in `Markdown` (`markdown.tsx:371`) on the text before `transformBlocks`. Run the tests: PASS.
- [ ] **F9:** find why the preview's `.content` overflows by its horizontal padding (`sw` 644 vs `cw` 624 at 1000) and fix it once in the shared `Markdown` element / `markdown.scss` so no caller overflows; then drop `!overflow-x-hidden` from `codepeekcard.tsx:178`. Wide tables and code blocks must still scroll inside their own block. If the source cannot be pinned in the element, use the peek card's `!overflow-x-hidden` on `codeviewer.tsx:313` instead, keep the peek card as is, and say so in your completion note.
- [ ] **Scenario steps in `code-markdown` (`scenarios-code.mjs`):** open a markdown fixture that starts with YAML front matter containing a `# comment` line: at 1000x700 the preview has no `h1` whose text is the comment, and a `pre` holds the front matter; the preview's scroll element has `scrollWidth <= clientWidth`. Repeat the overflow check at 1600x950.
- [ ] **Scenario step in `code-toolbar` (`scenarios-code-toolbar.mjs`):** at 1600x950 with a `.js` file open in Source view, exactly one `[data-code-view-mode]` button has the selected classes and it is `source`; repeat at 1000x700.
- [ ] Run `task check:ts`: clean.

### Task 7: New agent dialog: Codex mark (F12), preselected project scroll (F13)
**Depends on:** none
**Files:** `frontend/app/asset/codex.svg`, `frontend/app/view/agents/newagentmodal.tsx`, `scripts/cdp/scenarios-cockpit-launch.mjs`

Decisions are in the spec's F12 and F13 sections.

- [ ] **F12:** set `fill="#ececec"` on the root `<svg>` of `codex.svg`.
- [ ] **F13:** in `newagentmodal.tsx`, keep a ref to the selected project row and, when the dialog opens or `selectedProject` changes, call `scrollIntoView({ block: "nearest" })` on it.
- [ ] **Scenario steps in `cockpit-launch-stays`:** arrange enough projects that the list (`max-h-[236px]`) scrolls and the preselected one sorts past the fold (register them in the isolated store; remove them in teardown). At 1600x950 and at 1000x700: the selected project row's rect lies fully inside the list scroller's rect; the Codex runtime row's `img` loads (`naturalWidth > 0`) and its `src` fetched as text contains `#ececec`.
- [ ] Run `task check:ts`: clean.
