# Runs view: finish deferred controls + visual polish

Date: 2026-07-11
Scope: feature batch (front-end only). Finishes three deferred controls and a four-part
visual/interaction pass on the channel Runs view. Spec only — hands off to writing-plans.
Related: `docs/superpowers/specs/2026-07-04-channels-runs-ui-design.md` (original Runs IA;
deferred controls shown disabled), `docs/superpowers/specs/2026-07-05-channels-runs-orchestrator-mode-design.md`
(documents why Pause is impossible with current primitives), `docs/superpowers/specs/2026-07-04-channels-motion-design.md`
(the shared no-cascade entrance guard reused here).

## Problem

The Runs view (`frontend/app/view/agents/runssurface.tsx`) is functionally mature but carries
visible rough edges that the surrounding chat surface does not:

- **Three disabled controls** were deliberately shipped inert (per the original Runs IA: "deferred
  controls are shown disabled, not omitted"). Two of them — **Pause** and **Re-dispatch** — cannot
  be made real with a small change (Pause has no suspend primitive; Re-dispatch needs new backend),
  so they are permanently-looking dead buttons. **Edit plan** is disabled but is in fact reachable
  with existing RPCs.
- **Steer** uses a raw `window.prompt` — the only `window.prompt` on the surface, and jarring
  against the inline composers used everywhere else.
- **The start-run composer is a thin single-line `<input>`** while the chat composer is a rich
  multiline textarea; a code comment even claims the two "feel like one system," which they don't.
- **`+ New run` is redundant.** It sets `activeRunId = undefined`, which only swaps the detail area
  for terse empty-state text, while a start-run composer sits permanently at the bottom regardless
  of selection. Two ways to start a run, one confusing.
- **Empty/loading states** are unstyled one-liners ("No runs yet.").
- **No motion.** The chat view animates message entrance and gate settle; the Runs view pops
  everything in with no entrance or settle, so it reads as less finished than the tab it lives in.

This batch is entirely front-end. It touches no wire protocol and adds no backend command.

## Decisions (locked via brainstorming, 2026-07-11)

- **All work is FE-only.** Steer, Edit plan, and every visual item reuse existing RPCs
  (`steerWorker`/`steerRunLead`, `FileReadCommand`/`FileWriteCommand`, `CreateRunCommand`, gate RPCs).
  No `task generate`, no backend build required.
- **Re-dispatch is retired, not built.** Its backend (re-spawning a phase's exited worker) is out of
  scope; leaving the button disabled next to a retired Pause is inconsistent, so both dead buttons
  are removed. `BlockedCard` keeps its two working actions (Take control, Cancel run). Re-dispatch
  returns when its backend lands.
- **Pause is retired.** `ControllerInputCommand` injects input; it cannot suspend a running turn
  (documented in the orchestrator-mode spec). Steer + Cancel cover the need.
- **`activeRunId === undefined` becomes the explicit "new run" state**, rendering a focused compose
  panel in the body. The always-present bottom composer is removed; a real selected run shows run
  detail + controls only. This makes "start a run" a single affordance.
- **Composer parity via a shared `ComposerShell`**, not a restyle-in-place. One source of truth for
  the composer frame + multiline textarea + Send row. Chat's @mention highlight/dropdown layer on
  top via an overlay slot; Runs uses the shell plain.
- **Motion reuses the existing guard.** `computeEntrances`/`initialEntranceState` (motiontokens.ts)
  and `cardVariants`, keyed to `activeRunId` + a phase/card id signature. No new motion system.

## Non-goals

- Re-dispatch backend / re-spawning an exited phase worker.
- Real Pause / suspend / interrupt of a running turn.
- Repointing `@jarvis <goal>` chat to `CreateRun` (unchanged; still explicit New run only).
- Worktree-isolated separate workers.
- Any change to the run lifecycle, phase model, or gate semantics on the backend.

---

## Item A — Steer inline UI (FE-only)

### Data flow
The steer path is unchanged: submit calls the existing
`steerWorker({ channelId, workerORef: "tab:<id>", agents, text })` (`channelactions.ts`), which
routes to `steerRunLead` (SendInput into the worker's block). Only the input mechanism changes.

### Components
- The run header **Steer** button becomes a toggle (`steering` local state).
- When on, an inline steer composer (the shared `ComposerShell`, used plain) renders below the run
  header. Placeholder `Steer <worker>…`; Enter submits, Escape/blur closes, submit clears + closes.
- The steer target is resolved exactly as today: `phaseWorkers(run.phases[currentPhaseIndex(run)], agents)[0]`.
- Disabled/hidden when `isTerminal(run.status)` or there is no steerable worker (same guard the
  button uses today). Remove the `window.prompt` call entirely.

### Testing
- Unit: a thin pure helper `steerTarget(run, agents)` (returns the worker or undefined) so the view
  stays a shell; test terminal run → none, running phase → its first worker, no worker → none.
- Visual (CDP): toggling Steer reveals the inline composer; submit resumes the worker.

---

## Item B — Edit plan in the review gate (FE-only)

### Data flow
The plan is already loaded in `PlanPreview` via `FileReadCommand`. Editing writes it back with the
existing `FileWriteCommand`; **Approve is unchanged** — it advances the run, and the worker (pipeline
next-phase worker, or the steered orchestrator lead) reads the file from disk, which now holds the
edits. No new RPC, no change to `AdvanceRunCommand`.

### Components
- `PlanPreview` gains an **Edit** control in its "Plan" header (beside the collapse chevron) and an
  `editing` state. Editing swaps the rendered `MarkdownMessage` for a `<textarea>` seeded with the
  loaded text.
- **Save** calls `FileWriteCommand({ info: { path }, data64: stringToBase64(text) })`, updates the
  in-memory `load.text`/`lines`, and returns to the rendered view.
- **Dirty guard:** if the textarea has unsaved changes when the gate's **Approve** is clicked, save
  them first (Approve must never silently discard an edit). Simplest: lift a `dirtyRef`/`getEdited`
  from `PlanPreview` to `ReviewGateCard`, or route Approve through a `saveThenApprove` that flushes
  pending edits before `approveGate`.
- Errors handled at the boundary: a failed read still renders the gate with actions enabled (as
  today); a failed write surfaces a subtle inline message and keeps the edit in the textarea (never
  lost, never silently swallowed).

### Testing
- Unit: a pure `needsFlush(editedText, savedText)` (or equivalent) guard for the Approve-with-dirty
  path — dirty → true, clean → false, empty edit vs saved.
- Visual (CDP): Edit → change text → Save → reopen shows the change; Approve with unsaved edits
  persists them (read the file back).

---

## Item C — Retire dead controls (FE-only)

- Remove the **Pause** button from the run header (`runssurface.tsx`, run header actions).
- Remove the disabled **Re-dispatch** button from `BlockedCard`; keep Take control + Cancel run.
- No tooltip/placeholder left behind. Layout closes up cleanly (the header keeps Steer; BlockedCard
  keeps two actions).

### Testing
- Visual (CDP): run header shows Steer only; a blocked run's card shows Take control + Cancel run.

---

## Item D — New-run as an explicit state (FE-only)

### Data flow / state
`activeRunId` already drives selection; `undefined` already means "no run selected." This item gives
that state a real body and removes the duplicate composer.

- **Body when `run` is undefined:** a centered compose panel — heading "Start a run", subtext
  `Give Jarvis a goal for #<channel>`, the shared `ComposerShell` (multiline), the
  `composerSummary(runMode, planGate)` line (`pipeline · plan gate`), and `Start run ⏎`. This is
  also the empty state when `runs.length === 0` (Item F folds into this).
- **Body when a run is selected:** run detail + controls exactly as today, **and the bottom
  start-run composer is removed** (the panel above is the only place to start a run).
- `startRun()` is unchanged (`createRun` then `setActiveRunId(created.id)`), so starting from the
  new-run panel switches straight into the fresh run.

### Run tabs
- Each run tab gains a compact phase-progress indicator (small dots, one per phase, colored by
  `phaseStateView` tone) and a close **×** that dismisses the tab from the strip. Closing the active
  run falls back to `defaultRunId(remaining)`; closing the last leaves the new-run state.
- Dismiss is view-local (hides the tab from the strip); it does not cancel or delete the run on the
  backend. If that proves confusing in use it can be revisited, but a client-side hide matches the
  "New run" pseudo-tab already being client state. **This is the one place to double-check during
  planning** — confirm there is no expectation that closing a tab also stops the run (there is not:
  Cancel run is the explicit stop).

### Testing
- Unit (`runmodel.test.ts` or new): tab dismissal + active-run fallback (`defaultRunId` after
  removing the active id; removing a non-active id keeps the active one; removing the last → new-run
  state); phase-progress dot derivation if a new pure helper is added.
- Visual (CDP): `+ New run` shows the compose panel; selecting a run hides it and shows detail;
  per-tab dots reflect phase state; × dismisses a tab and reselects sanely.

---

## Item E — Shared `ComposerShell` (FE-only)

### Component
New small component (colocated, e.g. `composer-shell.tsx` under `view/agents/`, or exported from a
shared UI spot if one fits):

- Renders: the rounded bordered frame (`bg-surface-raised` etc., matching today's chat frame), an
  auto-growing multiline `<textarea>` (Enter submits, Shift+Enter newline), and a footer row with a
  **left slot** (`children`/`footerLeft` for summary/hint) and a right **Send** button (label
  configurable: `Send ⏎` / `Start run ⏎`).
- Props: `value`, `onChange`, `onSubmit`, `placeholder`, `disabled`, `sendLabel`, `footerLeft`, and
  an optional `overlay` slot rendered inside the relative wrapper (chat's @mention dropdown).
- Chat's `Composer` (`channelssurface.tsx`) is refactored to build on `ComposerShell`: it keeps its
  highlight backdrop + mention dropdown + `@ mention agent` button, passing the dropdown through the
  `overlay` slot and its command-hint legend / plan chip through `footerLeft`. Behavior unchanged.
- Runs' new-run panel and the inline steer composer use `ComposerShell` plain.

### Constraints
- One source of truth for the frame + textarea + Send affordance (DRY); mention logic stays
  chat-only (no premature abstraction of a single-consumer feature).
- The chat composer's existing behavior (highlighting, caret sync, suggestion accept) must be
  byte-for-byte preserved — this is a mechanical extraction, not a rewrite.

### Testing
- The chat composer has no unit harness today; verify parity by typecheck + the existing chat visual
  checks (mention dropdown still works). Any pure helper already lives in `channelderive.ts` and is
  untouched.

---

## Item F — Empty & loading states (FE-only)

- **Loading** (runs not yet resolved / `channel` mirrored but empty transiently): a light skeleton
  or a single muted line in the surface's type scale — not blank, not the terse current text.
- **No runs yet**: folds into Item D's compose panel (guides straight to the first goal) rather than
  standalone "No runs yet." text.
- All states use the surface's existing muted/centered visual language (same classes as the chat
  empty state) so the two tabs match.

### Testing
- Visual (CDP): empty channel → compose panel; a run present → detail. (Loading is transient; verify
  best-effort or note as such.)

---

## Item G — Motion parity (FE-only)

### Data flow
Reuse the shared no-cascade entrance guard (`computeEntrances`, `initialEntranceState` from
`@/app/element/motiontokens`) and `cardVariants`, exactly as `channelssurface.tsx` does for messages.

- Scope the guard to `activeRunId` + an id signature over the phase rail's rendered items (phase
  index + card kind, e.g. `phase-<i>`, `gate-<i>`, `ask-<i>`, `blocked-<i>`, `ship`). Switching runs
  or first mount is silent (no cascade) — the guard's whole purpose.
- Wrap phase-rail rows and the gate/ask/blocked/ship cards in `motion.div` with `variants={cardVariants}`
  under an `AnimatePresence` and `MotionConfig reducedMotion="user"` (mirrors the chat stream).
- Reuse the existing `useSettle` one-shot (already in `channelssurface.tsx` — extract to a small
  shared hook if used in both, else colocate) for: a phase transitioning to `done`, and a gate
  resolving (approve/send-back). 520ms settle, `motion-reduce:animate-none`, matching chat.

### Testing
- The entrance guard is already unit-tested (`motionhooks.test.ts` / motiontokens). Add a runs-scoped
  case only if a new signature helper is introduced.
- Visual (CDP): a new phase/card animates in; switching runs does not cascade; a completing phase
  settles once.

---

## File touch map (for plan sequencing)

**Front-end only (TS/TSX), all under `frontend/app/view/agents/` unless noted:**
- `runssurface.tsx` — A (inline steer), B (edit-plan wiring in `ReviewGateCard`/`PlanPreview`),
  C (retire Pause + Re-dispatch), D (new-run body + tabs), F (empty/loading), G (motion). **Central
  file for the batch.**
- `composer-shell.tsx` (new) — E (`ComposerShell`).
- `channelssurface.tsx` — E (refactor chat `Composer` onto `ComposerShell`; no behavior change).
- `runmodel.ts` / `runmodel.test.ts` — A (`steerTarget`), D (tab dismiss + active-run fallback,
  phase-progress dot helper), B (dirty-guard helper) — pure helpers so the view stays a shell.
- Possibly a small shared `useSettle` extraction (G) if colocation is cleaner than duplicating.

**Conflict summary:** `runssurface.tsx` is edited by nearly every item — this is a single-file batch,
so tasks are largely sequenced rather than parallel. Item E touches two files (`composer-shell.tsx`
new + `channelssurface.tsx` refactor) and is a prerequisite for A and D (both consume `ComposerShell`),
so **E lands first**, then A/B/C/D/F/G against `runssurface.tsx` in sequence.

## Verification conventions (all items)

- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean,
  exit 0; `npx tsc` stack-overflows here).
- FE unit: `npx vitest run frontend/app/view/agents/runmodel.test.ts` (and any new file).
- Visual (CDP, best-effort): `tail -f /dev/null | task dev` running, capture via
  `node scripts/cdp-shot.mjs`; never `Page.reload`. If the dev app is not running, mark the visual
  step unverified rather than claiming it passed.
- No backend build / no `task generate` (nothing regenerated this batch).
- Do not commit; the user batches commits and approves them.
