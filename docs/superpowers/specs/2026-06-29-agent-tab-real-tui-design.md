# Agent tab: real Claude Code TUI as the center pane

Date: 2026-06-29
Scope: trivial (single tightly-coupled cluster; no new data flow). This doc is both the spec
and the implementation plan.

## Problem

The Agent (focus) tab's center pane renders `AgentTranscript` — a narration of the agent's
session derived from the transcript file + hook status. Every rostered agent is actually a
`claude` process running inside a Wave terminal block (`sessionsidebarmodel.ts:41-58`; the roster
admits only rows with a `termBlockOref`, `liveagents.ts:37`). So the real Claude Code TUI is
already live in `termBlockOref` for each agent, and pressing `t` already swaps the center pane to
it via `CockpitFocusPane`. The narration is a second rendering of that same PTY.

We want the real TUI to be the center pane by default, replacing the narration in this tab.

## Decisions (locked)

- Replace narration **entirely** in the Agent tab — no narration toggle in this surface.
- Answering questions happens **in the terminal** (normal Claude Code). No structured ask overlay
  on top of the TUI.
- Scoped to the **Agent (focus) tab only**. The Cockpit grid and its cards are **unchanged** —
  cards keep their narrated summaries, status chips, and ask-in-place answer bars.

## Architecture

`AgentSurface` today renders: `AgentTree │ (CockpitFocusPane | AgentTranscript) │ optional rail`,
where `centerIsTerminal = isPending || terminalTarget === blockId`. `AgentTranscript` bundles
three things: a header (identity + controls), the narrated transcript body, and the
composer/answer bar.

Target: the center pane is **always** the live terminal for the focused agent.

```
AgentTree │ [ AgentHeader + CockpitFocusPane ] │ (optional AgentDetailsRail)
```

- `CockpitFocusPane(blockId)` is the same component `t` already invokes — proven PTY render path.
  Booting/pending agents show their terminal as it boots, with no special-casing.
- The terminal has no header chrome of its own, so a small `AgentHeader` sits above it to keep the
  agent identity and the details-rail toggle visible.

## Components

1. **`agentheader.tsx` (new).** Extract the header block from `agenttranscript.tsx` (lines 90-146)
   into `<AgentHeader agent={...} />`. Keep: `StatusDot`, name, status badge, model chip, context%
   chip, project subtitle, and the details-rail toggle button. **Drop** the "Open terminal" button
   (the terminal is always shown now). Reads `railVisibleAtom` for the toggle, like today.

   **Revision (2026-06-29) — header terminal controls.** A later pass of the handoff
   (`Wave-cockpit-live.dc.html`) re-introduced terminal controls in the header, reversing the
   original "no controls" intent above. The header now carries a control cluster (shown only when
   `agent.blockId != null`), all FE-only over existing primitives:
   - **Interrupt** — sends `Esc` (`\x1b`) to the PTY via `ControllerInputCommand` (same write path as
     `AgentComposer`), cancelling the current Claude turn. This is the real backing for the mock's
     "Pause" label, which had no primitive (Claude Code cannot pause).
   - **Fullscreen** — toggles `terminalFullscreenAtom` (new, in `railstore.ts`, non-persisted); the
     surface hides `AgentTree` and the rail so the terminal fills the pane. This is the mock's
     renamed "Pop out ↗"; in a single-window cockpit it means fullscreen-in-place, not an OS window.
   - **Close terminal** — confirms via `modalsModel.pushModal("ConfirmModal", …)` then closes the
     agent's *session tab* with `getApi().closeTab(ws.oid, agent.id, false)` (reusing the sidebar's
     `closeGroup` path). Closes the whole agent, not an orphaned block — `launchAgent` mints a tab
     per agent.

2. **`agentsurface.tsx` (rewire).** Center = `AgentHeader` + `CockpitFocusPane` (in a vertical
   flex column) whenever `agent.blockId` exists. Remove:
   - the `AgentTranscript` import and branch,
   - `centerIsTerminal` / `isPending` / `terminalTarget` gating of the center,
   - the `t` key handler (terminal is always shown) and the "Escape collapses terminal back to
     transcript" branch — Escape now simply returns to the Cockpit surface.
   - the `pull keyboard focus to wrapper` effect's `centerIsTerminal` guard collapses (the center
     is always the terminal, which owns its own focus); keep ←/→/d/Esc on the wrapper.

   Keep `AgentTree` and the optional `AgentDetailsRail` exactly as-is.

   **Revision (2026-06-29) — fullscreen.** `AgentSurface` reads `terminalFullscreenAtom`; when set it
   renders neither `AgentTree` nor the rail (`railVisible && !fullscreen`), so header + terminal fill
   the surface. Rail is hidden by condition (not by mutating `railVisibleAtom`) so exiting fullscreen
   restores the prior rail state. `Esc` now exits fullscreen first; only when not fullscreen does it
   return to the Cockpit surface.

3. **Delete `agenttranscript.tsx` and `focustranscript.tsx`.** Verified the React component
   `AgentTranscript` is imported only by `agentsurface.tsx`, and `FocusTranscript` only by
   `agenttranscript.tsx`. **Keep** `AnswerBar`, `AgentComposer`, `livetranscript`, `markdownmessage`,
   `narrationtimeline`, and the narration utilities — the Cockpit cards (`agentrow.tsx`) and
   `idlesection.tsx` still consume them.

## Edge cases

- **No `blockId`.** The roster requires a `termBlockOref`, so `blockId` is effectively always
  present. Defensively, if `agent.blockId == null`, render a small centered "No live terminal for
  this agent" state instead of reviving narration.

## Vestigial state (not removed here)

- `openTerminal()` and `terminalTargetAtom` keep working: the cards' per-row terminal button calls
  `openTerminal`, which now just focuses the agent and switches to the Agent surface.
  `terminalTargetAtom` becomes unread by `AgentSurface`; left in place (harmless), removable in a
  later cleanup.

## Error handling

No new data flow, RPC, or store — so no new failure modes. The terminal block lifecycle, route
registration, and disposal are owned by `CockpitFocusPane` (unchanged).

## Testing / verification

- `npx vitest run` — stores/models stay green. None of the deleted files have tests (verified no
  `.test` imports `AgentTranscript`/`FocusTranscript`).
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `tsc`
  stack-overflows on this repo; baseline has ~3 pre-existing `api.test.ts` errors).
- CDP screenshot of the live dev app: focus the Agent tab and confirm the real Claude Code TUI
  renders in the center with `AgentHeader` above it and the roster/rail intact.

## Implementation steps

1. Create `frontend/app/view/agents/agentheader.tsx` with `<AgentHeader agent={AgentVM} />`,
   moving the header markup out of `agenttranscript.tsx` and dropping the "Open terminal" button.
2. Rewire `agentsurface.tsx`: import `AgentHeader`; render `AgentHeader` + `CockpitFocusPane` as
   the center; remove the transcript branch, `centerIsTerminal`/`isPending`/`terminalTarget`
   gating, the `t` handler, and the terminal-collapse Escape branch; add the no-`blockId` fallback.
3. Delete `frontend/app/view/agents/agenttranscript.tsx` and `focustranscript.tsx`.
4. Run vitest + tsc; fix any fallout (e.g. unused imports).
5. CDP-verify the live dev app.
