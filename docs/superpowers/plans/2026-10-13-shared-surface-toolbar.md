# Shared Surface Toolbar Implementation Plan

**Verify:** `node scripts/verify.mjs ./pkg/wconfig`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-headers surface-smoke git-history diff-compare radar-report cockpit-needs-you-cross-channel settings-radar-audit code-search`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\surface-header\project\Main.dc.html

**Goal:** Every cockpit surface except Agent gets one shared toolbar header, as drawn in the prototype canvas: `Main.dc.html` is the spec, and `AppBar`, `NavRail` and `UsageBody` are its parts.

**Architecture:** A single `SurfaceToolbar` component in `frontend/app/view/agents/surfacescaffold.tsx` replaces `SurfaceHeader`. Nine surfaces render it: Cockpit, Code, Sessions, Usage and Settings (today on `SurfaceHeader`), plus Diff, Radar, Setup and the Jarvis Brief (today hand-rolled). A new CDP scenario, `surface-headers`, screenshots each one for the final verifier.

**Tech Stack:** React 19, Tailwind 4 `@theme` tokens, jotai, CDP scenario harness (`scripts/cdp/`).

## Global Constraints

- Toolbar: at least 52px tall (`min-h-[52px]`), horizontal padding 20px (`px-5`), `border-b border-border`, `bg-background`, items centered.
- Title: 15px semibold `text-primary`, rendered as an `<h1>`.
- Facts follow the title in `font-mono text-[11.5px] text-muted`. Then comes a spacer, then the surface's controls and actions on the right.
- The toolbar is a `<header data-surface-toolbar>`. It must not set `overflow-hidden`: Radar's audits popover and Code's project picker open out of it.
- When the controls do not fit on one row, the row wraps (`flex-wrap`, a vertical gap) instead of clipping them. At normal widths it is exactly 52px.
- Only existing `@theme` tokens from `frontend/tailwindsetup.css`; no raw hex/rgba, no new tokens (DESIGN.md).
- Every count, badge and control in today's headers stays visible. Controls keep their current components, styling, behavior and `data-*` attributes; only the chrome around them changes.
- Content below the header is unchanged.
- Agent gets no toolbar.
- Decided, do not reopen:
  - Usage drops its explainer paragraph.
  - The Jarvis waiting chip takes the canvas's look (no border, not uppercase, mono 11px bold), keeping its tones, pulse dot and RollingCount.
  - The Cockpit chip-tab row below the toolbar is content below the header, so it stays as it is today; the canvas's 44px row and 15px numerals are not wanted.
  - Settings drops its subtitle, and its search moves into the toolbar.
  - Jarvis drops its diamond icon but keeps its waiting chip, filter, Gatekeeper picker (`AutonomyLadder`), settings/profile button and New initiative.
- No jsdom render tests (AGENTS.md "Frontend conventions"): rendered results are proven by the `surface-headers` scenario steps, which Final runs.

## Review Focus

Final starts its own dev app on a fresh, empty store, so `surface-headers` arranges every piece of data its steps need and removes it in teardown.

- **A narrow window (1000px) with Diff in compare mode:** the source picker, range strip, ref picker and Fetch must wrap onto a second toolbar line, not clip or push Fetch off the window. Owned by Task 4; checked by the `surface-headers` step "files compare at 1000px", which never skips (the scenario makes its own git repo).
- **Radar's audits popover and Code's project picker opening from inside the toolbar:** they must not be clipped by it. Owned by Tasks 3 and 4; checked by the `surface-headers` steps "radar audits popover not clipped" and "code picker not clipped".
- **The Jarvis Brief's header order:** fleet line → filter → autonomy → profile → New initiative, as the direct `<header>` child of `[data-jarvis-region="brief"]`. Owned by Task 5; checked by the `surface-headers` step "jarvis header order".
- **A long Code project path:** the fact must truncate with an ellipsis rather than push the picker and buttons off the right edge. Owned by Task 3; checked by the `surface-headers` step "code path truncates".
- **Sessions with 0 live agents, or Usage with 0 reporting:** the fact disappears, as the badge does today, with no empty gap. Owned by Task 2.

---

### Task 1: SurfaceToolbar component
**Depends on:** none
**Files:** `frontend/app/view/agents/surfacescaffold.tsx`

Add `SurfaceToolbar` and `ToolbarFact` to `surfacescaffold.tsx`. Keep `SurfaceHeader` for now: Task 7 deletes it once nothing renders it, so the surface tasks can run in parallel without breaking each other's build.

**Interfaces (Tasks 2-6 rely on these exact names):**

```ts
export function SurfaceToolbar(props: {
    title: string;
    children?: ReactNode;  // after the title, before the spacer: facts and inline controls
    actions?: ReactNode;   // after the spacer, right-aligned
    className?: string;    // merged with cn(); for a caller that must add a sticky/z-index class
}): JSX.Element;
// renders: <header data-surface-toolbar className="flex min-h-[52px] flex-none flex-wrap items-center
//   gap-x-3.5 gap-y-2 border-b border-border bg-background px-5 py-[10px]">
//   <h1 className="text-[15px] font-semibold text-primary">{title}</h1> {children}
//   <span className="flex-1" /> {actions in a flex items-center gap-2 group} </header>

export function ToolbarFact(props: { children: ReactNode; className?: string }): JSX.Element;
// a <span> with "flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-[11.5px] text-muted";
// className lets a caller recolor a fact (Usage's reporting fact is text-accent-soft in the canvas)
// or add `truncate` (Code's path)
```

The 14px gap (`gap-x-3.5`) matches the canvas's `gap: 14px`. The vertical padding is sized so a single row of 28-30px controls lands at exactly 52px.

Update the file's header comment so it names `SurfaceToolbar` as the single source of truth for surface headers.

**Acceptance:**
- `SurfaceToolbar` and `ToolbarFact` are exported with the signatures above.
- `SurfaceHeader` still compiles for its current callers.
- The Check line passes.

### Task 2: Cockpit, Sessions and Usage on the toolbar
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/cockpitsurface.tsx`, `frontend/app/view/agents/sessionssurface.tsx`, `frontend/app/view/agents/usagesurface.tsx`

**Cockpit** (`cockpitsurface.tsx`, around line 486):
- Today `SurfaceHeader` sits inside the sticky band with negative margins. Render `SurfaceToolbar title="Cockpit"` as its own row, the first child of the column, and drop the `-mx/-mt` wrapper.
- The chip-tab row ("need you / working / ready for review / live") stays below it, keeps its sticky band, and looks as it does today. The toolbar row should stay pinned too (sticky with the band, or both in one sticky wrapper) so scrolling the roster does not lose it.
- Facts: `{counted.length} agents · {projectCount} projects · <span className="font-semibold text-warning"><RollingCount value={needsYou}/> need you</span>` in one `ToolbarFact`. The `N need you` span text must stay findable by scenario `cockpit-needs-you-cross-channel`, which matches a span whose text is `/^\s*\d+\s*need you\s*$/`.
- Actions: `UsageMeters`, `ProjectSwitcher variant="header"`, the Live only button, unchanged.

**Sessions** (`sessionssurface.tsx`, around line 267):
- `SurfaceToolbar title="Sessions"`.
- The `{liveCount} agent(s) live` badge becomes a `ToolbarFact` with the same `pulse-dot bg-working` dot before the text, and no pill background. It is rendered only when `liveCount > 0`.
- Actions: the Status filter group, unchanged, including its `needsCount` badge.

**Usage** (`usagesurface.tsx`, around line 1077):
- `SurfaceToolbar title="Usage"`.
- Delete the explainer subtitle paragraph.
- The `{reporting} reporting` badge becomes a `ToolbarFact className="text-accent-soft"` with the `bg-accent` dot and no bordered pill. It is rendered only when `reporting > 0`.
- Actions: the `Segmented` 7 days / All time control, unchanged.

**Acceptance:**
- Each of the three surfaces renders exactly one `[data-surface-toolbar]` with its title.
- No surface in this task imports `SurfaceHeader` any more.
- Scenario `surface-headers` steps "cockpit", "sessions" and "usage" (Task 6) pass and their screenshots match the canvas strips.
- `surface-smoke` and `cockpit-needs-you-cross-channel` still pass.

### Task 3: Code and Settings on the toolbar
**Depends on:** Task 1
**Files:** `frontend/app/view/code/codesurface.tsx`, `frontend/app/view/code/codepathbar.tsx`, `frontend/app/view/agents/settingssurface.tsx`

**Code** (`codesurface.tsx`, around line 169):
- `SurfaceToolbar title="Code"`.
- The subtitle `project.name · project.path` (or "No project selected") becomes a `ToolbarFact className="truncate"`. It truncates with an ellipsis and never pushes the actions off the right edge, so give it `min-w-0` and let it shrink.
- Actions are unchanged: the project picker (`data-code-project-picker` and its PopoverReveal), `SaveControls`, and the HeaderButtons (new file, new folder, refresh, back, forward).
- In `codepathbar.tsx`, change the comment "Save status stays in SurfaceHeader" to name the toolbar.

**Settings** (`settingssurface.tsx`):
- Today the header lives inside the 340px `SectionIndex` column. Restructure the surface root into a column: `SurfaceToolbar title="Settings"` spans the full width, and the existing two-column row (index | detail) sits below it, unchanged.
- Remove the subtitle.
- The search input moves into the toolbar's `actions` as a 240px-wide field: the same `Search` icon, placeholder "Search settings" and `query`/`onQuery` wiring, with the canvas's look (`rounded border border-border bg-surface-raised px-2.5 py-1.5`). This is the same recipe the search box uses today.
- `SectionIndex` drops its header block and the `query`/`onQuery` props it no longer uses. The group list keeps its scroll area.

**Acceptance:**
- Code and Settings each render one `[data-surface-toolbar]` with their title.
- Scenario `surface-headers` steps pass: "code", "settings", "settings search filters" (typing in the toolbar's search narrows the section index), "code picker not clipped" and "code path truncates".
- `settings-radar-audit` and `code-search`, both in Final, still pass.

### Task 4: Diff and Radar on the toolbar
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/filessurface.tsx`, `frontend/app/view/agents/radarsurface.tsx`

**Diff** (`filessurface.tsx`, around line 404):
- The hand-rolled subject bar (`h1` 16px bold and the wrapping flex row) becomes `SurfaceToolbar title="Diff"`.
- `children`, in today's order: the 210px `SourcePicker` box, then `RangeStrip` when there is a scope, then `RefPicker` and the Fetch group (Fetch button and "fetched … ago") when compare is on.
- `actions`: the range summary, kept as `data-files-range-summary` and rendered as a `ToolbarFact` with `truncate`.
- Keep the existing comment about why the row wraps, rewritten to say the toolbar wraps. The toolbar's `flex-wrap` replaces the old row's.

**Radar** (`radarsurface.tsx`, around line 255):
- The subject bar becomes `SurfaceToolbar title="Radar"`.
- `children`: `ScopeSelector`, then `MetaLine` when `isReport && report`. `MetaLine` is already mono 11.5px muted, so it becomes Radar's fact: drop its `pb-[11px]` and keep it `relative` so its audits popover still anchors under it.
- `actions`: the Re-scan button (`data-radar-rescan`), unchanged.
- The `SurfaceError` load-error banner moves from above the subject bar to directly below the toolbar.
- The placeholder `<div className="pb-2" />` goes.

**Acceptance:**
- Both surfaces render one `[data-surface-toolbar]` with their title.
- At a 1000px-wide viewport with Diff in compare mode, every control is visible: the toolbar wraps to a second line and nothing overflows the window.
- Scenario `surface-headers` steps pass: "files" (Diff), "files compare at 1000px", "radar" and "radar audits popover not clipped".
- These scenarios in Final still pass:
  - `git-history` reads `[data-files-range-summary]` across ranges;
  - `diff-compare` drives RangeStrip, RefPicker and Fetch at 1000x700;
  - `radar-report` reads `[data-radar-rescan]` and opens the audits popover from a seeded report.

### Task 5: Setup and the Jarvis Brief on the toolbar
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/setupsurface.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`

**Setup** (`setupsurface.tsx`, `SetupSurface` around line 759):
- The hand-rolled 52px row becomes `SurfaceToolbar title="Setup"`.
- `children`: `<Tabs />`, unchanged, keeping its tablist and arrow-key behavior.
- `actions`: `HeaderStatus` on the Instructions tab, or `SkillsHeader` on the Skills tab.

**Jarvis Brief** (`briefsurface.tsx`, around line 1231):
- The `<header className="flex h-[54px] … bg-surface px-[22px]">` becomes `SurfaceToolbar title="Jarvis"`.
- The toolbar must still be the direct `<header>` child of `[data-jarvis-region="brief"]`. The `surface-headers` step "jarvis header order" and scenario `brief-design-parity` both query `[data-jarvis-region="brief"] > header`.
- Delete the `◈` diamond span and both vertical divider spans (`h-[18px] w-px bg-border`).
- `children`, in order:
  - the `all work · N projects` fact, as a `ToolbarFact`;
  - the waiting / all-clear chip (`data-jarvis-brief-band="waiting"`), restyled to the canvas: no border, not uppercase, `font-mono text-[11px] font-bold`, `rounded-[6px] px-2 py-[3px]`. It keeps its current tone tokens (`bg-asking/15 text-asking`, or `bg-success/15 text-success` for all clear), its pulse dot and `RollingCount`;
  - the fleet line (`data-jarvis-brief-band="fleet"`), as a `ToolbarFact`.
- `actions`, in order: the filter label/input (`data-jarvis-brief-filter`), `AutonomyLadder`, the profile button (`data-jarvis-brief-profile`), then `NewInitiativeControl`.
- The filter keeps its current width; the canvas draws it at 200px, so 220px → 200px is fine if it helps it fit.

**Acceptance:**
- Setup and the Brief each render one `[data-surface-toolbar]` with their title.
- The Brief header has no `◈`.
- The waiting chip has no border and is not uppercase.
- Scenario `surface-headers` steps "setup", "jarvis" and "jarvis header order" pass.

### Task 6: surface-headers CDP scenario
**Depends on:** Task 1
**Files:** `scripts/cdp/scenarios.mjs`

Add a `surfaceHeaders` scenario named `surface-headers` and register it in the exported scenario list, as `surfaceSmoke` is. Do not run prettier on this file (AGENTS.md: `scripts/*.mjs` is hand-formatted).

Final runs on a fresh, empty dev store (`final-verify.mjs` gives it its own `ARC_DEV_DATA_DIR`). So the scenario arranges every piece of data its steps read, and no step may skip for lack of data. Reuse the existing helpers instead of writing new ones.

**arrange** (return ctx even when a step throws, so teardown can undo what was made, as `radar-report` does):
1. **A git repo at a long path.** Make it with `mkdtempSync(join(tmpdir(), "verify-surface-headers-"))` plus nested directory segments, so the full path is well over 120 characters. Seed it like `diff-compare`'s arrange: a `main` commit, then a `feature` branch with one more commit. Then call `h.rpc("createproject", { name: "verify-surface-headers", path })`. This one project serves Diff (source and compare), Code (the long-path fact) and Radar.
2. **A fixture roster.** Write `TREE_RAIL_FIXTURE` (`public/cockpit-fixtures/active.json`) with one working and one asking agent in that project, shaped like `cockpit-needs-you-cross-channel`'s. Set `ctx.wroteFixture` so teardown removes only what it wrote. This populates Cockpit's facts and the Jarvis waiting chip.
3. **A radar report.** Seed one for the project path with `seedRadarReport` and `radarFixtureReport`, as `radar-report` does. Save and later restore the `RADAR_SCOPE_KEY` localStorage value, so Radar shows the report's MetaLine, its audits toggle and Re-scan.
4. **The Sessions and Usage facts.** The canvas draws "1 agent live" and "1 reporting". Trace their sources: `liveCount` in `sessionssurface.tsx`, and `countReporting` in `usagerail.ts` (the "reporting" rail group). Seed each through whatever fixture route already feeds it (the roster fixture, an RPC, or the store as `seedRadarReport` does).
   - If a source has no injectable route, the "sessions" / "usage" step still asserts the toolbar itself, and records the fact sub-check as a separate `skipStep`, with a reason naming the source that could not be seeded.
5. Reload the page and wait for the nav, as `diff-compare` does, so the new project and fixture load.

**Steps** (each a named step in the scenario's result):
- **Per-surface toolbar steps, at 1440x900** (the canvas's main board size, pinned with `Emulation.setDeviceMetricsOverride`). One step per surface, in nav order: "cockpit", "jarvis", "code", "files", "sessions", "radar", "usage", "settings", "setup".
  - Each does `h.goto(surface)` and waits for `[data-surface-toolbar]`. On Code and Diff it first selects the arranged project, using the `[data-code-project-picker]` / `[data-files-source-picker]` options.
  - Each asserts:
    - exactly one visible `[data-surface-toolbar]` in the content area;
    - a height of 52;
    - its `h1` text equals `SURFACE_LABEL[surface]` (`files` → "Diff");
    - a computed `padding-left` of 20px.
  - Then it takes `h.shot("cdp-shots/surface-headers-<surface>.png")`, a full window whose top 210px is the strip the canvas draws.
  - For jarvis, make sure the Brief region (`[data-jarvis-region="brief"]`) is showing first.
- **"agent":** `h.goto("agent")`; assert there is no `[data-surface-toolbar]` in the content area.
- **"jarvis header order":** read `[data-jarvis-region="brief"] > header` and assert the document order of `[data-jarvis-brief-band="fleet"]`, `[data-jarvis-brief-filter]`, `[data-jarvis-autonomy="chip"]`, `[data-jarvis-brief-profile]` and `[data-jarvis-new-initiative]` is strictly increasing. Copy the order check `brief-design-parity` uses around line 7482. Also assert the header text has no `◈`, and that the waiting chip's computed `text-transform` is `none` and its `border-top-width` is `0px`.
- **"settings search filters":**
  - Count the visible `[data-section]` buttons.
  - Set the toolbar input `input[placeholder="Search settings"]` to a term that matches some sections but not all. Pick one from the section names in `settingssurface.tsx`. Set it through the native value setter plus an `input` event, so React sees it.
  - Assert the count drops and stays above 0.
  - Clear the input.
- **"code picker not clipped":**
  - Click `[data-code-project-picker]` and wait for its popover.
  - Take the popover's bounding rect and call `document.elementFromPoint` at its center and at a point 8px above its bottom edge. Assert both hit elements are inside the popover.
  - Close the popover.
- **"code path truncates":** the Code toolbar's path `ToolbarFact` has its right edge ≤ the picker button's left edge, and `scrollWidth > clientWidth`, which means the ellipsis is active for the long path.
- **"radar audits popover not clipped":**
  - On Radar with the seeded report, click `[data-radar-audits-toggle]` and wait for `[data-radar-audits-popover]`.
  - Use the same `elementFromPoint` check, at its center and 8px above its bottom.
  - Close it.
- **"files compare at 1000px":**
  - Set the viewport to 1000x700.
  - On Diff with the arranged project as the source, switch the range to compare, the way `diff-compare` does.
  - Assert every toolbar descendant control's right edge is ≤ 1000, and that the Fetch button is visible.
  - Shot `cdp-shots/surface-headers-files-compare-narrow.png`.
  - This step never skips.

**teardown:**
- `Emulation.clearDeviceMetricsOverride`;
- delete the seeded radar report (the `DELETE FROM db_radarreport` pattern `dropPeekItemsRadar` uses) and restore `RADAR_SCOPE_KEY`;
- remove the fixture roster if `ctx.wroteFixture`;
- `h.rpc("deleteproject", { name })`;
- `rmSync` the temp repo;
- `h.goto("cockpit")`.

Also scan `scenarios.mjs` yourself for queries of the old header markup: the `text-[25px]` title, the Settings search located inside the index column, the Brief header's `◈` or a `bg-surface` header, and a Radar/Diff `h1` at 16px. Update each to the toolbar (`[data-surface-toolbar] h1`, or the search input by its placeholder). The scan done while planning found none beyond what Tasks 2-5 preserve; if yours finds none either, say so in the completion note.

**Acceptance:**
- `node --check scripts/cdp/scenarios.mjs` passes.
- `node scripts/cdp/verify.mjs surface-headers` runs and prints one row per step listed above.
- Before Tasks 2-5 land, the toolbar assertions for surfaces still on the old header fail. That is the intended red state; Final runs after all tasks.
- Teardown leaves no project, fixture or radar report behind: a second run of the scenario starts from the same state.

### Task 7: Retire SurfaceHeader
**Depends on:** Task 2, Task 3, Task 4, Task 5
**Files:** `frontend/app/view/agents/surfacescaffold.tsx`, `frontend/app/view/jarvis/petstore.ts`

- Grep `frontend/` for `SurfaceHeader`, including type-only imports and re-exports. Once only the definition remains, delete it.
- Rewrite the comment in `petstore.ts` that cites "SurfaceHeader is justify-between" to describe the toolbar. The measurement it records is historical, so say the band was measured under the old header.
- Leave older specs under `docs/superpowers/specs/` alone: they are historical records.

**Acceptance:**
- `grep -rn "SurfaceHeader" frontend` returns nothing.
- The Check line passes.
- `surface-smoke` still passes.
