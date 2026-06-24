# Agents Tab — UX Fixes (Design)

- **Date:** 2026-06-19
- **Status:** Approved (design); pending implementation plan
- **Scope:** 10 UX/correctness items on the Agents view + its sidebar entry, grouped into 4 independently-shippable phases.

## Context

The Agents view (`frontend/app/view/agents/`) renders a live roster of agent sessions: those *asking* a question (the focused `AskCard` + a queue) and those *working* (a 2-column grid of `WorkingPanel`s streaming live transcript narration). It is a **pure projection** of two upstream sources:

1. `sessionSidebarViewModelAtom` — one row per running session (the sidebar's single source of truth).
2. Per-block `agent:status` and `agent:ask` WPS events — status/model and pending questions.

`liveAgentBaseAtom` (`liveagents.ts:32`) rebuilds the whole roster on any change; pure mapping lives in `agentsviewmodel.ts` and `transcriptprojection.ts` (no React/runtime imports, covered by `*.test.ts`).

Round one of usage produced ten items of feedback. This design addresses all ten while preserving the projection architecture (presentation changes stay in the view/pure layers; only one item opens a new *write* path back to the agent).

## Locked decisions

| Decision | Choice |
|---|---|
| Working-panel drag/resize model | Self-contained resizable grid (not Wave-native tiles) |
| Idle-agent presentation | Collapsed, expandable section at the bottom |
| Input placement | Per-panel footer composer (separate input + state per panel) |
| Panel sizing persistence | Live in-memory for the session (resets on full reload) — YAGNI |
| User-message rendering | Inline, Claude-Code-style (`>`/"you" marker, muted) — no chat bubbles |

## Architecture notes referenced below

**Roster mapping.** `agentVMFromInput` (`agentsviewmodel.ts:111`) maps a live row → `AgentVM` (`status: "waiting"` → `state: "asking"`). `groupAgents` (`:76`) splits into `asking`/`working`/`idle`, each sorted. `AgentVM` currently carries `id` = **tabId** only — not the agent's terminal blockId.

**Ask lifecycle.** A pending ask appears via a PreToolUse hook → `wsh ask` → `AskCommand` (`wshserver.go:1609`) → publishes `agent:ask`. It disappears **only** via a PostToolUse hook → `wsh ask --clear` → `AgentAskClearCommand` (`:1659`) → publishes `cleared=true`. `AnswerAgentCommand` (`:1632`) injects keystrokes but does **not** clear. The FE stores asks in `agentAskAtoms` keyed by block oref (`agentaskstore.ts`); `withAsk` (`agentsviewmodel.ts:159`) overlays the ask onto the VM. There is no client-side fallback if the clear hook fails to fire.

---

## Phase 1 — Presentation + correctness

Low risk. Where logic is non-trivial it goes into the pure modules and is unit-tested.

### #7 — Agents tab: no "· ungrouped", no pin icon

**Problem.** The sidebar shows the Agents tab as "Agents · ungrouped" with a pin thumbtack.

**Root cause.** `openAgentsTab` (`sessionsidebarmodel.ts:270`) creates the tab with `session:pinned: true` and no `cmd:cwd`. Pinned rows render with `includeService=true`, so `rowLabel` (`sessionviewmodel.ts:97`) appends `· {serviceLabel}`, and a no-cwd tab's serviceLabel resolves to `NO_CWD_LABEL = "ungrouped"` (`:151`). `SessionRow` always renders the thumbtack (`sessionrow.tsx:206`).

**Approach.** Mark the Agents tab distinctly and special-case it:
- Detect it in the sidebar model by the presence of a block with `meta.view === "agents"` (the Agents tab has no `view === "term"` block, so the existing term-block loop already skips it). This is robust to renaming, unlike matching `tab.name`. Carry an `isAgentsTab` flag on `SessionInput`/`SessionRowVM`.
- When `isAgentsTab`: `rowLabel` omits the service suffix even though it's pinned; `SessionRow` hides the pin toggle (it is structurally pinned, the toggle is meaningless).

**Files.** `sessionviewmodel.ts` (flag + `rowLabel`/`toRow`), `sessionsidebarmodel.ts` (set the flag), `sessionrow.tsx` (hide pin when `isAgentsTab`).

**Tests.** `sessionviewmodel.test.ts`: a pinned Agents-tab input yields label `"Agents"` (no suffix) and `isAgentsTab: true`.

### #10 — "N asking" badge padding

**Problem.** The sidebar "1 asking" pill is vertically cramped (text touches the pill edges).

**Root cause.** `sessionsidebar.tsx:177` — `…px-2 text-[10px] font-bold…` has horizontal but no vertical padding.

**Approach.** Add `py-0.5 leading-none` (and keep `px-2`). CSS-only.

**Files.** `sessionsidebar.tsx`.

### #5 — Stop layout shift from timestamps

**Problem.** The working-panel header reflows once per second.

**Root cause.** The right-side meta (`outputpanel.tsx:83`) renders `formatAge` + `⟳ {since}` + `quiet`, recomputed every 1s via the `now` tick. The strings are variable-width and sit in an `ml-auto` flex span, so each tick changes their width and re-truncates the task label.

**Approach.** Make the meta width stable: apply `tabular-nums` and reserve width for the age/since segments (fixed min-width or right-aligned fixed-width spans) so digit/label changes don't move neighbors. No behavior change.

**Files.** `outputpanel.tsx` (and `agents.tsx` header `RollingCount` already uses `tabular-nums`; verify the asking/working counts don't shift).

### #4 — Markdown rendering of agent messages

**Problem.** Agent narration renders as raw text; markdown is shown literally.

**Root cause.** `NarrationTimeline` renders `{e.text}` in a `div` (`narrationtimeline.tsx:45`).

**Approach.** Render `kind: "message"` entries as markdown. **Refinement (planning):** the full `element/markdown.tsx` component is heavyweight (wraps each render in OverlayScrollbars, builds a TOC, enables `rehypeRaw`) — wrong for many small inline narration lines. Instead use `react-markdown` + `remarkGfm` directly (both already dependencies) with no `rehypeRaw`, so raw HTML in transcript text is not executed. Action/tool strips (`kind: "action"`) stay as the monospace verb/target line. Keep the `accentLatest` left-border treatment around the markdown block.

**Files.** `narrationtimeline.tsx`.

**Tests.** Rendering is visual; no new pure-logic tests. The projection that feeds it is already tested.

### #3 — Idle agents visible (collapsed section)

**Problem.** Idle agents are computed but never rendered.

**Root cause.** `AgentsView` destructures only `{ asking, working }` (`agents.tsx:62`); the `idle` group from `groupAgents` is dropped.

**Approach.** Render `idle` as a collapsed, expandable section below the working grid:
- Header row: chevron + "Idle" + count; click toggles expand. Default collapsed.
- Collapsed: nothing but the header. Expanded: compact rows (status dot · name · last-activity · idle-for), and an expanded idle agent reveals its narration timeline + per-panel input (Phase 3). Expand state is local component state.

**Files.** `agents.tsx` (render idle section), small presentational component for idle rows (new file `idlesection.tsx` to keep `agents.tsx` thin).

**Tests.** `groupAgents` idle bucket already tested; new component is presentational.

### #8 — Show your own turns inline

**Problem.** Panels show only agent (assistant) text; the user's messages/answers are invisible.

**Root cause.** `projectTranscript` (`transcriptprojection.ts:54`) emits `message` entries only from `assistant` records; `user` records are used solely to attach `tool_result` outcomes (`:86`) — user text blocks are discarded.

**Approach.**
- Extend the `AgentEntry` union with `{ kind: "user"; text: string }` (`agentsviewmodel.ts`).
- In `projectTranscript`, for `user` records emit a `user` entry for each text block (string content or `type: "text"` blocks), while still consuming `tool_result` blocks for outcomes. Skip `tool_result`-only user records (they produce no user message).
- In `NarrationTimeline`, render `kind: "user"` inline, left-aligned, with a `>` marker and muted color (Claude-Code prompt-echo style) — distinct from assistant markdown.

**Files.** `agentsviewmodel.ts` (type), `transcriptprojection.ts` (projection), `narrationtimeline.tsx` (render).

**Tests.** `transcriptprojection` test: a transcript with a user text turn yields a `user` entry in order; a user record containing only `tool_result` yields no `user` entry but still applies outcomes.

### #9 — Self-healing ask-clear

**Problem.** A question answered in the agent's own terminal tab stays visible in the Agents tab.

**Root cause.** Clearing depends entirely on the PostToolUse `wsh ask --clear` hook publishing `cleared=true`. If that hook does not fire (or fails — the dual-answer hooks are staged but the binary may not be rebuilt in the live env), the ask atom is never nulled and the `AskCard` persists. `AnswerAgentCommand` does not clear either, so the panel-answer path has the same dependency.

**Approach (in-repo safety net).** Treat a pending ask as stale when the agent demonstrably moved past it: when a *newer* `agent:status` arrives for the block (`status.ts > ask.ts`) with state `working` or `idle`, ignore the ask. This is safe because a blocked agent emits no new working/idle status until it resumes — i.e., until the question was resolved by some path.
- Add a pure helper `isAskStale(askTs, statusTs, statusState)` to `agentsviewmodel.ts`, used in `liveAgentBaseAtom` (`liveagents.ts:56`) to pass `null` to `withAsk` when stale.
- The PostToolUse hook stays the fast primary clear; this is the fallback that makes the panel self-heal.

**Files.** `agentsviewmodel.ts` (helper), `liveagents.ts` (apply).

**Tests.** `agentsviewmodel.test.ts`: stale when `statusTs > askTs` and state ∈ {working, idle}; not stale when state is waiting or when `statusTs ≤ askTs` / unknown.

**Caveat (partly external).** The primary clear path (`wsh ask --clear` PostToolUse hook + rebuilt `wsh` binary) lives in `~/.claude` settings and the built binary, outside this repo. The safety net makes the panel correct regardless; a separate optional task can verify/repair the hook wiring.

---

## Phase 2 — Live status dots (#1, both sizes)

Begins with **diagnosis**, not a blind fix.

**In-view dots (big).** Currently the asking dot is a static amber (`askcard.tsx:120`) and the working dot is green/hollow (`outputpanel.tsx:70`). They are section-static, so they don't track a live transition within a panel.
- **Approach.** Unify to a small shared dot component driven by the agent's live state using the same `STATUS_COLOR` map as the sidebar (`sessionrow.tsx:10`): working = green, asking = amber, idle = grey, plus the quiet = hollow nuance for working. This makes the in-view dot reflect live state consistently.

**Sidebar dot (small).** `sessionrow.tsx:117` already binds `backgroundColor` to `STATUS_COLOR[status]` reactively.
- **Approach.** Reproduce first (systematic-debugging). Hypotheses to rule out: (a) the `motion.span` `animate` prop interfering with the inline `style.backgroundColor` update; (b) the upstream `agent:status` events not arriving / the external reporter not emitting transitions. Fix follows the confirmed cause. If (b), the fix may be partly external (reporter) — flag rather than guess.

**Files.** `askcard.tsx`, `outputpanel.tsx`, a shared `statusdot.tsx` (new); `sessionrow.tsx` only if the confirmed cause is in-repo.

---

## Phase 3 — Per-agent input (#6)

**Problem.** No way to message a working/just-finished agent from the Agents tab; you must open its terminal.

**Approach.**
- Thread the agent's terminal blockId down into `AgentVM`. `liveAgentBaseAtom` already has `row.termBlockOref` (`liveagents.ts`); add `blockOref`/`blockId` to `AgentVM` and `LiveAgentInput`, populated in `agentVMFromInput`.
- Add a footer composer to each `WorkingPanel`, the expanded idle agent, and the `AskCard` (beside Submit). Enter (or Send) writes the text via `ControllerInputCommand` (`wshserver.go:322`, `CommandBlockInputData`) to that block, appending a newline to submit. Separate input value + state per panel.
- The transport is proven (used by the dual-answer flow). No backend changes.

**Files.** `agentsviewmodel.ts` (`AgentVM`/`LiveAgentInput` + `agentVMFromInput`), `liveagents.ts` (populate blockId), `outputpanel.tsx` / `askcard.tsx` / idle row (composer), a small `agentcomposer.tsx` (new) shared by all three.

**Tests.** `agentsviewmodel.test.ts`: `agentVMFromInput` carries blockId.

---

## Phase 4 — Resizable / reorderable grid (#2)

**Problem.** Working panels are a fixed 2-column grid with locked 260px rows (`agents.tsx:192`).

**Approach.** Replace with a self-contained resizable grid — no new dependency (KISS):
- Container: `flex flex-wrap` of panels; each panel is `resize: both; overflow: hidden` with a sensible min-size, so the user drags the corner to set width + height.
- Reorder: HTML5 drag-and-drop on the panel header, mirroring the sidebar's existing `onDragStart/onDragOver/onDrop` pattern (`sessionrow.tsx`).
- Sizing/order held **in-memory** keyed by agent id (a per-view atom/map on a small model or local state); resets on full reload. No persistence plumbing.

**Files.** `agents.tsx` (container + DnD), `outputpanel.tsx` (resize affordance + drag handle), in-memory size/order state (local to the view).

**Tests.** Reorder logic (if extracted to a pure helper) gets a unit test; resize is visual.

---

## Cross-cutting

- **Pure-first.** New logic (`#8` projection, `#9` staleness, `#3`/`#2` ordering helpers) lands in `agentsviewmodel.ts` / `transcriptprojection.ts` with unit tests; components stay thin.
- **No backend changes** beyond reusing `ControllerInputCommand`. No new RPCs, no `task generate`.
- **Shared working tree.** Re-check git branch/status before any commit; nothing is committed without explicit approval.
- **New files** kept small and single-purpose: `statusdot.tsx`, `agentcomposer.tsx`, `idlesection.tsx`.

## Caveats / partly-external

- **#9** primary clear path and **#1** sidebar-dot cause (if upstream) involve the external status/ask hook system (`~/.claude` settings + rebuilt `wsh`/reporter), outside this repo. The in-repo work makes the UI correct regardless; external verification is a separate optional task.

## Out of scope

- Persisting panel sizes across reloads (deferred per YAGNI; in-memory only).
- Wave-native tiling for agents (rejected: too large a rebuild).
- Reworking the dual-answer hook system itself.

## Testing strategy

- Unit tests for all new pure logic (projection user-turns, ask staleness, sidebar Agents-tab labeling, blockId threading).
- Existing `agentsviewmodel.test.ts` / `sessionviewmodel.test.ts` / transcript projection tests extended, not replaced.
- Visual items (markdown, dots, resize, idle, composer, badge padding) verified by running the dev app.
