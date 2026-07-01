# Agent Tab Fixes — Design

Date: 2026-07-01
Status: Approved (pending spec review)

Eight fixes to the cockpit Agent tab: three bugs (status, TUI mangle, usage) and
five UX/keyboard additions (right-click toolbar, tool-group shortcuts, Ctrl+C close,
surface jump, agent cycling). All changes are frontend-only unless noted.

## 1. Status: "waiting" no longer means "asking"

**Bug:** an agent that is merely waiting for a tool call / tool execution shows as
"asking" (as if it were asking the user a question).

**Cause:** `agentVMFromInput` maps the backend `SessionStatus` `"waiting"` directly to
the UI `AgentState` `"asking"` (`frontend/app/view/agents/agentsviewmodel.ts:277`).
The `"waiting"` status is derived from the reporter's amber badge
(`COLOR_WAITING`, `session-models/sessionviewmodel.ts:28,36`), which fires for
tool-execution / permission waits — not only for real questions. Genuine questions
arrive on a separate channel: the `agent:ask` event → `agentaskstore` → `withAsk`
(`agentsviewmodel.ts:439-445`), which is what should own the `"asking"` state.

**Fix:** in `agentVMFromInput`, map `"waiting"` → `"working"` (remove the
`"waiting" ? "asking"` branch). `"asking"` is then produced solely by `withAsk` when a
live, uncleared `agent:ask` exists.

**Downstream to verify (no expected behavior change, asking still exists):**
- `withAsk` still forces `state = "asking"` on a real ask — unchanged.
- `partitionBackgrounded` never receives asking agents (they live in the asks region) —
  still true; a formerly-"waiting" agent now counts as working and can be backgrounded.
- `blockedMs` vs `activeMs`: an agent without an ask now gets `activeMs` (working) instead
  of `blockedMs` (asking). Correct.
- Section headers / dot color (`statusdot.tsx`) — the amber "asking" pulse now only shows
  for real asks.

## 2. TUI text mangles when switching tabs

**Bug:** switching cockpit surfaces away from the Agent tab and back leaves the embedded
TUI (Claude Code CLI) distorted until a redraw.

**Cause:** `cockpitshell` mounts `AgentSurface` only while `surface === "agent"`. Leaving
the surface unmounts `AgentSurface` → `CockpitFocusPane` → the term view calls
`model.dispose()` (`frontend/app/cockpit/focus-pane.tsx:24`), destroying xterm. Returning
remounts and recreates the terminal, re-fitting against a container that has not been laid
out yet; the reconnected/replayed PTY frame is drawn at the wrong grid size until the next
full redraw.

**Fix (2A — keep the terminal mounted, hide with CSS):** keep the focused agent's terminal
in the DOM across surface switches instead of tearing it down.
- Hoist the Agent surface (or at minimum the `CockpitFocusPane`) mount point in
  `cockpitshell.tsx` so it stays mounted whenever a focused agent exists, toggling
  `display:none` (Tailwind `hidden`) when `surface !== "agent"` rather than conditionally
  rendering it. The other surfaces render in their normal slot; both are in the DOM with the
  inactive one hidden.
- Guard `termwrap` resize against a zero-size (hidden) container so xterm does not shrink the
  PTY while hidden (skip `handleResize` when the connect element has 0 width/height or
  `offsetParent == null`). Verify the current `handleResize` (`term/termwrap.ts`) and add the
  guard if absent.
- On re-show (surface becomes "agent"), fire one resize/refit after layout so xterm re-syncs
  to the (unchanged) size — a no-op in the common case, safety net if the window was resized
  while hidden.

Fallback (2B, not chosen): keep unmount/remount and add a post-layout refit + `term.refresh()`.
Smaller but the reconnect flash can persist. 2A fixes the cause.

## 3. Right-click toolbar on the agent panel

**Goal:** the Interrupt / Fullscreen / Close / Details cluster
(`frontend/app/view/agents/agentheader.tsx:103-179`) sits in the far top-right corner and is
awkward to click. Provide the same actions via a right-click context menu anywhere on the
agent panel.

**Fix:** follow the canonical context-menu pattern
(`ContextMenuModel.getInstance().showContextMenu(items, e)`, as in
`frontend/app/view/term/term.tsx:377-388`). Add an `onContextMenu` handler on the agent panel
(the AgentHeader container and the terminal area) that builds:
- Interrupt turn
- Toggle fullscreen
- Toggle details
- separator
- Close agent

Each item invokes the existing handler used by the corresponding header button (`interrupt()`,
`terminalFullscreenAtom` toggle, `railVisibleAtom` toggle, `closeTerminal()`).

## 4. Keyboard shortcuts for the tool group

**Goal:** make the header cluster fully keyboard-accessible so the far corner is unnecessary.

**Fix:** in `agentsurface.tsx` `onKeyDown` (active when not typing in an input/terminal;
`agentsurface.tsx:64-87`):
- `f` → toggle `terminalFullscreenAtom` (new).
- `d` → toggle details (exists).
- `Esc` → exit fullscreen / return to cockpit (exists); the header Interrupt button already
  sends ESC to the PTY when the terminal is focused.

Close is covered by #5. Fullscreen while the terminal is focused is reachable via the
right-click menu (#3).

## 5. Ctrl+C (double-press) closes the agent

**Goal:** bind the "terminate" gesture to the close-agent action without breaking the TUI's own
single-Ctrl+C interrupt.

**Fix:** in the terminal keydown path (`frontend/app/view/term/term-model.ts`
`handleTerminalKeydown`, ~line 686), detect Ctrl+C. A single Ctrl+C passes through unchanged
(forwarded to the PTY, so the TUI still interrupts). A **second** Ctrl+C within a short window
(~500ms) triggers the close-agent flow — the same `WorkspaceService.CloseTab(...)` +
confirmation path used by the header Close button (`agentheader.tsx:56-68`). Track the last
Ctrl+C timestamp on the term model; reset on any other key.

## 6. Usage panel: stop the single-usage dedup

**Bug:** the compact usage panel (top-right; `frontend/app/view/agents/cockpitsurface.tsx:631-670`)
shows only one usage entry.

**Cause:** `providerPlanUsage` (`agentsviewmodel.ts:243-258`) groups by provider and keeps only
the **first** agent's usage per provider (`if (!byProvider.has(provider)) byProvider.set(...)`),
discarding the rest.

**Fix:** return every agent that has rate data (not first-per-provider), labeled per agent, so
multiple usages render. To avoid literal duplicate rows when several same-provider agents share
identical account-level rate limits, dedup by a rate signature (`provider + fivehourpct +
weekpct + fivehourreset + weekreset`) rather than by provider alone. The compact panel bar
style is unchanged; it just renders all distinct entries.

## 7. Ctrl+1..8 — direct surface jump (global)

**Goal:** jump between cockpit surfaces even when the terminal is focused (the existing `[`/`]`
only work when the cockpit list has focus; `cockpitsurface.tsx:360-378`).

**Fix:** register a window-level keydown (the `cockpit-root.tsx:50-58` pattern) mapping
`Ctrl+1`…`Ctrl+8` to the eight surfaces in rail order
(`cockpit, agent, activity, channels, sessions, files, memory, usage` — from
`navrail.tsx:86-95`) by setting `model.surfaceAtom`. `preventDefault` to avoid WebView
interception.

## 8. Ctrl+Tab / Ctrl+Shift+Tab — cycle agents in the Agent tab

**Goal:** cycle the focused agent within the Agent tab, working even when the terminal is
focused.
- `Ctrl+Tab` → cycle focus through **all** agents (`order` list, wrapping).
- `Ctrl+Shift+Tab` → cycle focus through **only asking** agents.

**Fix:** reuse the existing stepper that advances `focusIdAtom` along `order`
(`agentsurface.tsx:60-63,77-82`). Because xterm captures keys while focused, intercept
`Ctrl+Tab` / `Ctrl+Shift+Tab` in `term-model.ts` `handleTerminalKeydown` (same seam as #5):
`preventDefault`, do **not** forward to the PTY, and advance `focusIdAtom`. Only act while
`surface === "agent"`. Ctrl+Shift+Tab filters `order` to asking agents before stepping.

## Testing

- Vitest is the FE harness; there is no render harness for the cockpit (visual checks use CDP
  against the live dev app).
- Pure logic gets unit tests: `agentVMFromInput` waiting→working (#1), `providerPlanUsage`
  dedup-by-signature (#6), and the agent-cycling stepper filtered to asking agents (#8) if it
  can be extracted as a pure helper.
- Keyboard/mount/context-menu behavior (#2, #3, #4, #5, #7) verified via CDP on the running dev
  app per the project's visual-verification flow.

## Out of scope

- No backend/Go changes (all items are frontend). #1 does not touch the reporter or
  `agentstatus` wire format; it only changes the FE interpretation of `"waiting"`.
- No new "waiting" UI state (the chosen approach folds waiting into working).
