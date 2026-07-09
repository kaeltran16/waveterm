# Deferred work

Running log of intentionally-deferred features. Each entry records what was deferred, why,
where it would plug in, and how to pick it back up. Append new entries at the top.

## Subagent interior view — v1 exclusions (2026-07-09)

Shipped the focused-view subagent interior (click a tree child → its live-tailing transcript swaps
into the center pane), disk-backed by `<parent>/<sessionId>/subagents/agent-*.jsonl`. Spec:
`docs/superpowers/specs/2026-07-09-subagent-interior-view-design.md` §11. Out of scope for v1:

1. **Cockpit-card fan-out badge** (`⑃ N` + peek on `agentrow.tsx`) — the deferred v1 half; brings
   fan-out to the at-a-glance grid. The focused view got the interior; the card grid did not.
2. **Codex subagents** — Codex has no confirmed per-subagent transcript files, so Codex parents show
   no children (graceful degradation). Revisit if/when Codex grows per-subagent files.
3. **Retire the vestigial hook path** — `agenthook.go` subagent deltas + `agentstatusstore`
   reducer/TTL + `baseds.AgentSubagentDelta` are no longer the tree's source (the tree now reads
   `subagentsByIdAtom`). Left dormant; `getSubagentsAtom` is now a dead export. Remove once the
   disk-source path is proven in the field (separate change, its own blast radius).
4. **Deep nesting (depth > 1)** — a subagent that itself fans out is rendered flat, not as a subtree.
5. **Workflow-orchestrated subagents degrade** (surfaced by the Phase 0 spike): 582/606 (96%) of real
   child files correlate by exact prompt-match. The other 24 are Workflow-tool / orchestration
   subagents whose parent transcript has no `Task` tool_use (16) or a substantively-different prompt
   (7). These still appear in the tree and open their interior, but with a **prompt-derived label**
   and a **perpetual "working" dot** (no parent `tool_result` to resolve ✓/✗). A future pass could
   read a terminal signal from the child file itself; a prefix-match was rejected (rescues only 1/24,
   adds collision risk). See `subagentcorrelate.ts` header.

## Feature-triage residue — prioritization + scoping corrections (2026-07-03)

Reconciled `docs/feature-triage.md` (2026-06-23) against the current tree. Most of that ~13-item
"Add" pile shipped (Channels, Jarvis @agent, Memory + graph, Command Palette, Activity, Sessions &
Resume, Usage, New-Agent launchers, Files accept/reject, **Git Worktrees** inside the New-Agent
launcher). The residual **not-built** items, ranked by leverage:

1. **Multi-answer ask** — **multi-SELECT SHIPPED 2026-07-03; multi-QUESTION SHIPPED 2026-07-09.** Chose the
   live-keystroke-spike path (option (a)). Drove a real CC v2.1.199 multi-select `AskUserQuestion`
   picker under a `node-pty` harness and verified the protocol *by outcome* (CC echoed back exactly the
   toggled labels), including at the real 60ms `KeystrokeDelay`. Protocol (now encoded + commented in
   `encode.go` `encodeMultiSelect`, and TDD'd in `encode_test.go`): unlike single-select (Enter
   confirms immediately), multi-select **Enter toggles** the highlighted checkbox; `ESC[B/[A` navigate;
   after the N options CC appends a "Type something" row (idx N) then a **"Submit"** row (idx N+1);
   Enter on Submit opens a "Ready to submit your answers?" review whose default confirms with **one
   more Enter**. `DeliverAnswer` (panel answers) and the Jarvis actuator are unaffected (the actuator
   only sends single indices). FE was already multi-capable (`toggleSelection`/`buildAskAnswers`/
   `canSubmitAsk`), so single-question multi-select now works end-to-end.
   **Multi-question (2026-07-09):** `EncodeAnswer`'s `len(questions) != 1` guard is gone; the new
   `encodeMultiQuestion` walks the tab bar (`←  ☐ Q1  …  ✔ Submit  →`). Protocol, verified live vs CC
   v2.1.205 with an in-repo PTY harness driving the real `EncodeAnswer` output: each tab starts at
   option 0; a **single-select** confirms *and* auto-advances to the next tab on Enter; a
   **multi-select** toggles on Enter and needs an explicit **Tab** to advance; whichever trailing type
   lands on the Submit tab, it shows a "Ready to submit your answers?" review defaulting to "Submit
   answers", so one final Enter confirms. Both labels echoed back exactly for `[single][multi]` and
   `[multi][single]` batches. FE + `DeliverAnswer` were already multi-question capable.
   **Remaining gap:** free-text ("Type something") answering is still not delivered from the panel.
2. **Sub-agent tree in the cockpit** (M→H) — the one residual item that advances the orchestration
   thesis and undoes a regression (old session sidebar had `SubagentStart`/`SubagentStop` lifecycle;
   the cockpit has zero subagent code). Best "real feature" investment.
3. **Cheap-polish bundle** — smaller and less "cheap" than the triage implied under Tauri:
   - **Open in External Editor:** the `launch-editor` npm dep is a **dead end in Tauri** (Node /
     main-process module; the cockpit is a WebView with no Node). Must ride the existing
     `open_external` Tauri command (`getApi().openExternal` — opens a path in the OS *default*
     handler, i.e. a folder opens in the file explorer, not an editor) or spawn `code`/`$EDITOR` via
     a terminal/`wsh` command. Needs an open-semantics decision before it's buildable.
   - **Jump-to-bottom pill:** the Agent *focus* surface center pane is a **live Claude Code TUI
     terminal** (`CockpitFocusPane`), not a narrated transcript, so the pill target is either xterm
     scrollback (shared `view/term`) or the cockpit **narration card** (`agentrow.tsx`, which already
     has a scroll container + `scrollToBottom`). The narration-card pill is the most self-contained,
     TDD-able piece of the whole residue.
   - Remaining T-items (send-file, terminal path-insert, hover preview) are a later second pass.

**Deferred / skip now:** Light/System theme + editor (cosmetic M, off-thesis — Settings surface
shipped with no theme control), project-wide ripgrep search (generic IDE M), Menu-bar tray (needs a
Tauri-native rewrite).

## Backlog re-verification against the tree (2026-07-02)

A sweep of tracked-but-unverified items (memory notes + `docs/superpowers` plans) against git log
and the current tree. Several items believed "unbuilt/uncommitted" had in fact shipped; the list
below is what remains **genuinely unbuilt** after verification. The working tree was clean at the
time of the sweep, so nothing material is sitting uncommitted.

**Still unbuilt:**

- **Jarvis Gatekeeper v1.1 — make-a-rule + auto-answer countdown.** The Gatekeeper tier ships
  (`6c05ac3f`), but the v1.1 "remember this decision as a rule" persistence and the pre-answer
  countdown were never built — no `makeRule`/`countdown` symbols exist in `pkg/jarvis`. Plan:
  `docs/superpowers/plans/2026-07-01-jarvis-gatekeeper.md`.
- ~~**Agents tab auto-fit engine (fit-one-screen).**~~ **OBSOLETE 2026-07-02 — spec superseded by
  the shipped layout.** The demotion/backgrounding half + asks-spotlight shipped
  (`partitionBackgrounded`, `backgroundedsection.tsx`, the `b` key). The remaining density engine
  (`expandedWorkingIds`/`MaxPanels`, the `MaxPanelsControl` control, the asks↔working region divider,
  the flex-share expanded-set) is **un-executable as written**: the 2026-06-23 spec assumes a
  single-column *asks-region → divider → working-region* layout, but the tab (`cockpitsurface.tsx`)
  is now a **2-column card grid** with per-card wide/height prefs and asks interleaved in-place. The
  region divider (§4) is meaningless in a unified grid; the per-row narration budget (§3) conflicts
  with the shipped per-card sizing; §9's "remove the per-row resize grip" never happened (cards still
  resize). The card grid already adapts to count (2-col) and supports demotion; a fresh density
  design against the current grid would be new work, not a re-base. Spec/plan:
  `docs/superpowers/{specs,plans}/2026-06-23-agents-tab-fit-one-screen*.md` (kept for history).
- ~~**Usage daily-series view.**~~ **RESOLVED 2026-07-02 (stale entry — already shipped).** A
  per-provider (claude/codex) daily bar chart with a tokens/spend toggle already renders in
  `usagesurface.tsx` (`DailyChart`, off `stats.daily` / `DailyUsage[]`), shipped in `fdaada6e`
  (2026-06-29) — *before* this sweep. The only per-day data still unsurfaced is a per-**model**
  daily breakdown (the payload folds per-model only into window totals, not per-day); the "daily
  sparkline/bar" this entry called for exists.
- ~~**Codex card task chip.**~~ **RESOLVED 2026-07-02.** Added `extractCodexTasks` to
  `codextranscriptprojection.ts` (latest `update_plan` → `CardTask[]`, `completed` → done) and
  registered it on the `codex` projector in `transcriptregistry.ts`. The card consumer
  (`livetranscript.ts`) already called `projector.extractTasks?.()` generically, so no consumer
  change was needed. Covered by 4 new unit tests in `codextranscriptprojection.test.ts`.
- **Multi-answer ask — server gate.** ~~single single-select only~~ **PARTIALLY RESOLVED 2026-07-03:**
  `encode.go` now supports single-question **multi-select** (verified live vs CC v2.1.199 — see the
  2026-07-03 entry at the top). The `q.MultiSelect` and `len(sel) != 1` guards are gone; the
  `len(questions) != 1` guard (multi-question batches) remains, pending a tab-navigation spike.

**Shipped since the memory notes were written (corrections, not open work):** Jarvis Delegator
fan-out (`f43768d9`), the memory force-graph (`bb4da8a1`), the Agents cursor-row composer
(`agentrow.tsx` — in place, tree clean), rate-limit donut persistence (`ratelimitstore.ts`), and the
Usage token-type (cache-read) split (`usagesurface.tsx`).

**Obsolete (not deferred — un-executable as written):** the Agents-tab motion Phase 2 plan
(`docs/plans/2026-06-19-agents-tab-motion.md`) targets `askcard.tsx`/`outputpanel.tsx`/
`sessionsidebar.tsx`/`sessionrow.tsx`/`frontend/app/tab/vtab.tsx`, all removed in the cockpit rebuild
+ Phase-5b teardown. The `motion` dep and animations landed via later work (`agentrow.tsx` uses
Reorder/AnimatePresence/layout springs); this specific plan cannot be applied.

## Agent rail "Tokens" — context occupancy, not cumulative (2026-06-26) — RESOLVED 2026-07-01

> **Resolved 2026-07-01 (deferred-token-truth-usage-polish):** the rail's "Tokens" row now shows a
> real whole-file cumulative total for the focused agent, not context occupancy. A thin
> `GetTranscriptTokensCommand` (wshserver) calls `usagestats.SumTranscript`, which reuses the Usage
> surface's Claude/Codex parser + dedupe so the accounting matches. The value loads via
> `tokenstore.ts` (`agentTokensAtom` + `loadTokensForAgent`, with a stale-load guard) from the rail
> effect in `agentdetailsrail.tsx`; a missing/unresolved transcript renders "—". The
> `contextpct × contextmax` occupancy calc and its `DefaultContextMax` fallback are deleted.

Original entry: the Agent details rail's "Tokens" row showed live *context-window occupancy*
(`round(contextpct% × contextmax)`), not cumulative tokens spent, because `AgentUsage` (the
statusLine reporter) carries no token-total field.

## New Agent → Agent tab: dev-mock handoff (2026-06-26)

When a cockpit fixture is loaded (`frontend/tauri/public/cockpit-fixtures/active.json`, dev only),
`agentsAtom`'s base is the static mock, so a launched agent's real roster row never appears there and
the pending "booting" overlay never supersedes to the live transcript. Without a fixture, dev falls
through to the live roster (`devRosterAtom` -> `liveAgentsAtom`) and the handoff works end-to-end.
Verify the launch → terminal → transcript handoff in dev with **no fixture active**, or in a packaged
build / via `scripts/inject-live-agents.mjs`.

Live-CDP finding (2026-06-26): even with no fixture, the boot→transcript auto-swap did not surface in
the dev app. The launch, new-tab roster citizenship, focused booting row, in-layout terminal, and a real
`claude` turn (with token usage) were all confirmed live — but the agent never registered as a roster
row, so the pending overlay never superseded. Cause: the external status reporter resolves `wsh` via
`shutil.which("wsh")` (`agent-status-spike/agent_status_reporter.py`), which is the **packaged Wave's**
`wsh` on PATH; its `wsh agentstatus` call lands in the packaged wavesrv, not the isolated `waveterm-dev`
instance the dev app reads. The supersede + prune logic itself is unit-tested (`agentsviewmodel.test.ts`,
`mergePendingLaunches`). To see the handoff live, run a packaged build (where dev/prod wavesrv coincide),
or point the dev terminal's `wsh` at the dev wavesrv.

## Cockpit card — fabricated data (2026-06-26) — RESOLVED 2026-07-01

> **Resolved 2026-07-01 (cockpit-card-real-data):** both card affordances now render real
> data; the `placeholderDiffStats` / `placeholderTasks` fabricators are deleted.
> - **Card diff stats** are loaded per card by `cardgitstore.ts` (`GitChangesCommand` +
>   `diffStatsFromChanges`), driven off the same rendered set as the transcript stream in
>   `cockpitsurface.tsx`: refreshed on enter, debounced 4s on transcript activity, dropped on
>   leave. A clean/non-repo/unresolvable-cwd worktree drops the id (button hides).
> - **Card task list** is the agent's latest TodoWrite, projected by
>   `transcriptprojection.extractTasks` and streamed into `livetranscript.tasksByIdAtom` from the
>   already-open transcript stream (no new RPC). Claude-only in v1.
> - **Follow-on (Codex tasks):** Codex has no TodoWrite; its `update_plan` tool could feed the same
>   chip via a `codextranscriptprojection` `extractTasks`. Not built — Codex cards stay task-less.

Original entry: the card rendered two affordances (diff stats button, `done/total` task chip +
popover) from deterministic placeholder data seeded off the agent id, because the live `AgentVM`
carried no source for them. See `docs/superpowers/specs/2026-07-01-cockpit-card-real-data-design.md`.

## Usage surface — deferred (2026-06-26)

**Permanent limitations (no honest source — not open TODOs):**
- **Rate-limit window token cap** (handoff "1.34M / 2.2M tok"): there is no faithful *limit* — the
  5h/weekly `%` is Anthropic's opaque server-side number, unrelated to any transcript token sum. The
  cockpit now shows a real *used*-token count with **no denominator** (see the resolved usage-bar
  entry); a "used / limit" ratio would require a cap Anthropic does not publish.
- **Plan-tier badge** (handoff "Max 20×" / "Tier 4"): not carried by the statusLine; the provider
  label is shown without a tier badge. No source to derive it from.

**Resolved 2026-07-01 (deferred-token-truth-usage-polish):**
- **Model-id prettifying** — DONE. `prettyModel` (`modellabel.ts`) turns raw ids into friendly labels
  (e.g. "claude-opus-4-8" → "Opus 4.8"); used in the Usage per-model bar and the rail Model row, with
  the raw id kept as a `title` tooltip. Unknown ids fall through unchanged.
- **Pricing table** — REFRESHED to current-generation rates (`usagepricing.ts`): Fable $10/$50, Opus
  $5/$25, Sonnet $3/$15, Haiku $1/$5, plus the new `fable` family. Caveat: family-substring matching
  loses the version, so a historical Opus-4.0 transcript (billed $15/$75) is priced at the current
  Opus tier — acceptable for an estimate; documented in the code.
- **Scan bound** — OBSOLETE. The `SESSION_READ_CAP`/`USAGE_READ_MAXLINES` text described the old
  frontend scan; the usage scan now runs in the Go backend (`GetUsageStatsCommand` → `usagestats`)
  which walks the transcript roots with no file/line cap.

**Still open:**
- **Codex/OpenAI token breakdown**: the parser handles Codex rollout token totals, but OpenAI has no
  5h/weekly window, so the window bars stay Claude-only and a Codex provider row appears only when
  real data exists for it.

## Files surface — deferred (v1)

- ~~**Codex cwd via tail read:**~~ **RESOLVED 2026-07-02.** `GetAgentTranscriptCommand` gained a
  `fromstart` flag (`readTranscriptHead` in `transcript.go`); `resolveCwd` (`agentcwdresolve.ts`)
  now falls back to a head read when the tail yields no cwd. Agent-agnostic — the head read only
  fires on a tail miss, so Claude keeps its `cd`-drift-correct tail resolution and long Codex
  sessions resolve their first-line `session_meta` cwd. Go test `TestReadTranscriptHead`.
- **Remote worktrees:** git runs on the wavesrv (local) host. SSH/WSL agent worktrees need the
  `GitChanges`/`GitDiff` commands routed to `wsh` on that host (same impl can live on `wsh`).
- ~~**Project picker:**~~ **RESOLVED 2026-07-02.** The Files header picker (`SourcePicker` in
  `filessurface.tsx`) now lists registered projects (from `projectsAtom`) alongside agents; picking a
  project scopes the surface to its registry `path` directly via `loadFilesForProject`
  (`filesstore.ts`) — no agent/transcript needed. The git-load core was extracted to
  `loadChangesForCwd` with a generalized `agent:`/`project:` guard token so switching source cancels
  the in-flight load. Agent picks still write the shared `focusIdAtom` (Agent-tab sync preserved); a
  project pick sets a local override. The empty state now yields only when there are no agents *and*
  no projects.
- **Agent-rail placeholders:** Branch + Files-touched in the Agent details rail (Phase 1b) can now
  be fed by `GitChangesCommand` + `gitstatus.ts`; wiring is a follow-on, not done here.
- **Live visual verification (CDP) deferred:** Task 9 of the plan (CDP screenshot vs the handoff)
  was deferred because a dev app was already bound to `:9222` and shares the `waveterm-dev` data
  home; do the visual pass when that port is free, focusing a real agent (mock roster resolves to
  "Not a git repository").

## Usage-bar token counts (fabricated) — RESOLVED 2026-07-01

> **Resolved 2026-07-01 (deferred-token-truth-usage-polish):** `FAKE_TOKEN_LIMIT` is deleted. The
> 5-hour / Weekly bars now show a **real Claude-only window-used token count** (no denominator — no
> honest ceiling exists) via `GetWindowTokensCommand` + `usagestats.WindowTokens`, summed over the
> Claude transcript root. Each window is anchored to its rate-limit reset: the frontend
> (`windowtokenstore.ts`) computes `windowStart = reset - duration` and falls back to `now - duration`
> when a reset is absent (API-key auth, or not yet reported). Codex bars carry no `used` line (rate
> limits are Claude.ai-specific). The `%` still comes from Anthropic's opaque server number.

Original entry: the usage bars rendered a `used / limit tok` line where `used = pct% × FAKE_TOKEN_LIMIT`
and the ceilings (2.2M / 44M) were hardcoded handoff values, not telemetry — `AgentUsage` carries no
token totals, only `fivehourpct`/`fivehourreset`/`weekpct`/`weekreset`.

## Agent (Focus) surface placeholders (Phase 1b)

> **Resolved 2026-06-26 (agent-rail-toggle):** git Branch + Files-touched (with per-file
> M/+/− status) are now real, sourced from `GitChangesCommand` via `railstore.ts`. cwd resolves
> from the agent's terminal-block `cmd:cwd` meta first (set by `buildLaunchMeta`, so a
> Wave-launched agent resolves its repo *before* its transcript or reporter enrichment exist),
> falling back to the transcript tail — see `agentcwdresolve.ts`; the same shared resolver fixes
> the Files surface for launched agents too. Stop/Resume are now real (ESC interrupt /
> `"continue\r"` nudge via `ControllerInputCommand`), disabled only when the agent has no live
> terminal block. The disabled **Pause** button and the placeholder **suggestion chips** were
> removed. The details rail is now toggleable (default off, `d` key / header button, persisted
> via `atomWithStorage("agent.rail.visible")`).
>
> Still data-gated: **Model** and **Cost** read the reporter-supplied `AgentVM.model` / `AgentUsage`.
> A freshly-launched agent has no `transcriptPath` and no reporter enrichment yet, so those rows show
> "—" until the external status reporter registers it (the dev wsh-routing gap — see the New-Agent
> dev-mock-handoff entry). cwd was recoverable from Wave-owned block meta; model/cost are not.
> **Tokens (total)** is now real regardless of the reporter — a whole-file transcript scan; see the
> resolved "Agent rail Tokens" entry above.

- **What:** the Agent 3-pane focus surface (`frontend/app/view/agents/agentsurface.tsx` +
  `agenttree.tsx` / `agenttranscript.tsx` / `agentdetailsrail.tsx`) renders to full handoff
  parity, but several fields/actions have no backing data and ship as marked placeholders /
  disabled affordances:
  - **git Branch** — left-tree parent subtitle + Details "Branch" row (static `main`).
  - **Files touched + per-file git status (M / + / −)** — static placeholder list in the rail.
  - **Tokens (total)** — RESOLVED 2026-07-01: the Details "Tokens" row now shows a real whole-file
    cumulative total (`GetTranscriptTokensCommand` / `tokenstore.ts`); see the resolved rail-Tokens
    entry above. (Was: derived input tokens from `contextpct × contextmax`.)
  - **Pause / Resume / Stop** — rendered disabled ("coming soon"); `Open terminal` is the only
    live lifecycle action.
  - **Suggestion chips** — footer chips above the composer are static/disabled (no generator).
- **Why deferred:** Phase 1 is "≈ no new backend" (meta-spec §8) — 1b is a pure
  view-composition pass. Git branch/status and an agent-lifecycle control RPC are backend work;
  a suggestion generator is its own feature. The user chose render-everything (placeholders +
  disabled) over omission, for handoff visual parity.
- **Where it plugs in:** git Branch + Files-touched arrive with the **P2 Files** surface (it
  needs git anyway); Pause/Resume/Stop need a lifecycle control RPC (P2/P3); Tokens-total needs
  a usage extension; suggestion chips need a generator. Each placeholder carries a
  `PLACEHOLDER`/`DISABLED` code comment pointing at spec §8.
- **To resume:** when building P2 Files, add a git-worktree info source (branch + per-file
  status) and feed the tree subtitle + Details "Branch" + the Files-touched list; for lifecycle,
  add a control RPC and enable the disabled buttons; replace the static suggestions with a
  real generator. Full detail:
  `docs/superpowers/specs/2026-06-25-cockpit-phase1b-agent-surface-design.md` §8.
- **Deferred:** 2026-06-25, during the cockpit Phase 1b Agent-surface build.

## Command palette (⌘K) — RESOLVED 2026-07-01

> **Resolved 2026-07-01 (command-palette):** shipped as a working `Ctrl+P` overlay
> (`frontend/app/cockpit/command-palette.tsx` + pure matcher `palette-match.ts`). Fuzzy-searches
> live agents (focus), resumable sessions (resume), and commands (surface nav + New agent/project);
> grouped results, arrow/Enter/Esc nav; opened by the app-bar box or global `Ctrl+P` (replaces the
> terminal's readline Ctrl+P, per user). **v1 exclusions:** read-only sessions (no `resumecommand`)
> are hidden so every row is actionable; results are grouped-by-kind, not one global score-sorted
> list. Both are reversible v2 tweaks. Original entry below.

- **What:** the centered search box in the cockpit top app bar — `Search agents, sessions,
  commands…` with a `⌘K` hint badge. Shipped as a **render-only stub**: the box is drawn to
  match the handoff, but clicking it / pressing `Ctrl+K` does nothing.
- **Why deferred:** no palette component exists anywhere in the codebase (grepped — it only
  appears in the handoff mockup). A real searchable command overlay (fuzzy match over
  agents/sessions/commands, keyboard nav, action dispatch) is its own feature, separate from
  the handoff-parity visual pass.
- **Where it plugs in:** the app-bar stub button in `frontend/app/cockpit/` (see the
  cockpit handoff-parity spec). The no-op `onClick` and a global `Ctrl+K` chord would open the
  overlay.
- **To resume:** build a palette overlay (cmdk-style), wire the stub button's `onClick` plus a
  `Ctrl+K` keybinding to open it, and feed it the roster (`model.agentsAtom`), sessions, and a
  command registry.
- **Deferred:** 2026-06-25, during the cockpit handoff-parity pass.

## Cockpit light mode (Paper theme) — 2026-07-03

The theming engine (`themes.ts`) is light-capable and the `paper` palette exists in `THEMES`, but it is
omitted from the v1 picker (`PICKER_THEMES` = dark only). A faithful light mode needs a cockpit-wide
audit of dark-assumed hardcoded colors: inline `rgba(255,255,255,α)` overlays (hover states, `.agent-md`
dividers/code fills in `tailwindsetup.css`), the hardcoded scrollbar hexes (`tailwindsetup.css`
`::-webkit-scrollbar-thumb`), `cockpit.scss` fallbacks, and the greys left fixed by `buildThemeVars`
(`muted-foreground`, `ink-mid`, `lane`, `lane-asking`, `cacheread`, `feed-*`). Convert those to themed
tokens, then set `paper.dark = true`-equivalent exposure in the picker.
