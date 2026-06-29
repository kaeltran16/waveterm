# Agent surface: toggleable, real details rail

**Date:** 2026-06-26
**Status:** approved design, ready for plan
**Scope:** non-trivial (toggle + persistence, live git branch/files, two live agent controls). FE-only — no new Go, no new RPCs.

## Problem

The Agent (focus) surface is a 3-pane layout: `AgentTree | center | AgentDetailsRail`
(`agentsurface.tsx`). The right pane (`AgentDetailsRail`, fixed `w-[296px]`) was Wave's only
detail view in the observe-only era — it echoed the external status reporter and filled the
gaps with fakes: `Branch` hardcoded `"main"`, `Files touched` a static `PLACEHOLDER_FILES`
array, `Resume`/`Stop` disabled stubs. The transcript chrome carries the same smell: a disabled
**Pause** button and disabled placeholder **suggestion chips**.

Now that the New Agent launcher spawns the actual claude/codex process as a block, two things
are true: (1) the rail duplicates what the agent's own TUI shows (reachable in-place via `t`),
so it shouldn't be forced on you; and (2) Wave owns the process (blockId, cwd), so the rail's
dead rows can become *real* instead of being deleted.

## Decision

Keep the rail but make it **toggleable (default off)** and **fully real**. Salvage the two
live numbers into the always-visible header so the default off-state isn't blind. Remove the
dead chrome.

Rejected: deleting the rail outright (loses the on-demand roll-up); hiding it only when the TUI
is open (keeps placeholders behind a second code path).

## Behavior

### 1. Toggle (default off, persisted, global)
- `railVisibleAtom = atomWithStorage("agent.rail.visible", false)` (jotai `jotai/utils`; first
  use of persisted prefs in `frontend/app` — keep it to this one atom).
- Toggle via **(a)** a button in the transcript header occupying the slot the removed Pause
  button vacates (a panel/sidebar glyph, highlighted when the rail is visible), and **(b)** the
  `d` key in `agentsurface.tsx`'s existing keydown handler (`Esc`/`←`/`→`/`t` are taken; `d` is
  free — verify no global keymodel conflict on the focus surface during implementation).
- `agentsurface.tsx` renders `<AgentDetailsRail>` only when `railVisibleAtom` is true. The
  `flex-1` center (`.cockpit-focus-pane { flex:1 }` / `AgentTranscript` root `flex-1`) self-heals
  to full width when the rail is off — no CSS change.

### 2. Header (`agenttranscript.tsx`)
- Add a **Model** chip (`agent.model`, mono/muted) and a **Context %** chip
  (`Math.round(agent.usage.contextpct)%`, text colored by `usageLevel(ctxPct)`:
  ok→accent / warn→warning / hot→error) after the state badge. Render each only when its data
  is present.
- Subline: drop the fake `· main`; show the project only (branch lives in the rail).
- Remove the disabled **Pause** button (replaced by the rail toggle).

### 3. Footer (`agenttranscript.tsx`)
- Remove the `PLACEHOLDER_SUGGESTIONS` chip block and the const; keep the composer.

### 4. Rail content made real (`agentdetailsrail.tsx`)
| Row | Source | Notes |
|---|---|---|
| Project | `projectOf(agent)` | already real |
| Branch | `GitChangesCommand({cwd}).branch` | **was fake `"main"`** |
| Model | `agent.model` | already real |
| Running | `formatAge(agent.activeMs)` | already real |
| Tokens | `round(contextpct% × contextmax)` | already real (context occupancy; see Deferred) |
| Cost | `agent.usage.costusd` | already real (`cost.total_cost_usd`) |
| Context gauge | `agent.usage.contextpct` | already real |
| Subagents | `getSubagentsAtom(block:…)` | already real |
| Tools used | `summarizeActions(recentActions(entries))` | already real |
| Files touched | `parseGitChanges(statusz, numstat).files` | **was static placeholder** |
| Stop | `ControllerInputCommand(blockid, ESC)` | **was disabled** — interrupts current turn |
| Resume | `ControllerInputCommand(blockid, "continue\r")` | **was disabled** — nudges from idle |

- **Stop = interrupt, not terminate** (confirmed): sends `ESC` (`\x1b`) so the agent goes idle
  and stays alive — that's the precondition for Resume to type into it. The exact interrupt
  byte (single `ESC` vs `Ctrl-C` `\x03`) is a live-CDP verification item.
- **Stop/Resume disabled** when `agent.blockId == null` (no live terminal to drive).
- **Files touched**: list of `{status, path}` colored by status (reuse the Files surface's
  `STATUS_COLOR` mapping); cap the visible count with a "+N more" (or scroll) since a narrow
  296px rail can't show a large worktree. Optional follow-on: a row click deep-links into the
  Files surface with that file selected.

### 5. Shared git load
Branch + Files-touched come from one `cwd → GitChangesCommand → parseGitChanges` load — the
same path `filesstore.ts::loadFilesForAgent` runs (cwd via `agentCwd()` + `GetAgentTranscriptCommand`;
git via `GitChangesCommand`). Factor the cwd resolution (currently private `resolveCwd` in
`filesstore.ts`) into a shared helper and add a thin rail-scoped loader/atom that fetches
`{cwd, branch, isRepo, changes}` **without** the per-file diff (the rail needs the list, not the
diff). Trigger on rail-open + focus change; guard against stale focus like `filesstore` does.

## RPCs used (all existing)
- `ControllerInputCommand` — Stop (ESC) and Resume ("continue\r").
- `GitChangesCommand` — branch + changed-file list (`branch`, `isrepo`, `statusz`, `numstat`).
- `GetAgentTranscriptCommand` — tail the transcript to resolve cwd (`agentCwd`).

## Deferred → `docs/deferred.md`
- **Cumulative session tokens.** The rail's "Tokens" shows live *context-window* occupancy, not
  cumulative tokens spent. `AgentUsage` (statusLine reporter) has no token-total field; a true
  cumulative figure needs a per-agent transcript scan (the Usage surface does this in aggregate).
  Log it; don't fake it.

## Verification
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` — no new errors beyond
  the 3 pre-existing `api.test.ts` baseline.
- `npx vitest run` — green (add/adjust tests for the new git loader + any pure helpers).
- CDP on the dev app (`scripts/cdp-shot.mjs`):
  - `d` toggles the rail; state persists across reload; rail off by default; center fills width.
  - Rail Branch + Files-touched match the Files surface for the same focused agent.
  - **Stop** interrupts a working agent (it returns to idle, process alive); **Resume** sends
    "continue" and the agent resumes. Confirm the interrupt byte that actually works.
  - Header shows Model + Context % chips; no Pause button; footer has only the composer.

## Out of scope
- Hard terminate / restart lifecycle controls (a separate "control surface" effort).
- Per-file diff *inside* the rail (the Files surface owns the diff view).
- Wiring branch/files into the always-on header (kept in the toggled rail to avoid an always-on
  git call on every focus change).
