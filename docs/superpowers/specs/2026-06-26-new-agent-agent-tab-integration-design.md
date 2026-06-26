# New Agent → Agent tab integration — Design

**Date:** 2026-06-26
**Status:** Draft (awaiting review)
**Builds on:** `2026-06-26-projects-new-agent-launcher-design.md` (the launcher modal + `launchAgent`) and `2026-06-26-launcher-polish-design.md` (worktree opt-in). Those shipped; this closes the loop into the Agent tab.

## 1. Problem

The New Agent launcher works — it builds a term block running the chosen runtime in the chosen project dir — but the launched agent is **not integrated with the Agent tab**. Two concrete gaps, both verified against the code:

1. **It never becomes a roster row.** `launchAgent` calls `ObjectService.CreateBlock` (`cockpit-actions.ts:29`), which `wcore.CreateBlock`s the block into the **active tab** (`objectservice.go:90`, `uiContext.ActiveTabId`) — i.e. the Agents tab itself. The roster (`sessionSidebarViewModelAtom`) maps **one term block per tab** to **one** `AgentVM` keyed by `tabId` (`sessionsidebarmodel.ts:48-57`, `liveagents.ts:32-64`). A block dropped into the Agents tab is never a distinct session, so the agent never appears in the `AgentTree` list or the Cockpit grid. (This matches the launcher spec's untested assumption "the new session joins the roster.")
2. **You land in a detached full-pane terminal.** `launchAgent` sets `terminalTargetAtom`, and `AgentSurface` renders that block **full-pane** (`agentsurface.tsx:49-51`), wiping the `AgentTree`. While a new agent boots you lose sight of every other running agent — the opposite of the cockpit's purpose.

## 2. Two mechanics that constrain the design (verified)

- **A term block's process starts only when its terminal *view* is mounted.** Mount → `TermWrap` first resize → `resyncController()` → `ControllerResyncCommand` RPC → backend `ResyncController` → `controller.Start` (`termwrap.ts:559,586`; `wshserver.go:317`; `blockcontroller.go:264-282`). `wcore.CreateBlock` only persists the object (`block.go:65-108`) — it does **not** start the process. **Consequence:** a transcript-first "starting…" placeholder would never start `claude`. The boot phase must mount the terminal.
- **A roster row requires its own tab.** The established session-creation pattern is `WorkspaceService.CreateTab` → `SetMetaCommand` on the new tab's default block (`sessionsidebarmodel.ts:279-345`, `duplicateSession`/`openAgentsTab`).

These two facts are why the chosen design ("B′") shows the live terminal in-layout during boot, then swaps to the transcript — rather than a spinner placeholder.

## 3. Goals / Non-goals

**Goals**
- A launched agent becomes a **first-class roster row** (its own session tab), visible in the `AgentTree` and the Cockpit grid.
- After Launch you land on the **Agent tab** focused on the new agent, with **the roster (list) still visible**.
- During the ~1–3s boot the center pane shows the **live terminal** (which is what starts the process); it **auto-swaps to the narrated transcript** the moment the reporter registers the agent.
- The launch keeps the cockpit on the Agents tab (no `setActiveTab` jump to a bare block view).
- **Unify** terminal rendering: the terminal always renders **in-layout** (list + terminal + rail), removing the `terminalTarget` full-pane special case. This also fixes "`t` hides the roster."

**Non-goals**
- No backend / Go change. No new RPC, no `task generate`. (The launch reuses `WorkspaceService.CreateTab` + `SetMetaCommand` + the existing controller-start-on-mount path; worktree creation still uses the existing `CreateWorktreeCommand`.)
- No change to the New Agent / New Project modals or `buildLaunchMeta` (the block meta is unchanged; only *where* it's applied changes — a new tab's default block instead of `CreateBlock`).
- No multi-terminal / split view; the focus view shows one focused agent at a time.
- Dev-mock roster is not made to absorb launched agents (see §9).

## 4. Architecture

Three changes, all frontend, all in `frontend/app/view/agents/` + `frontend/app/cockpit/`.

### 4.1 Launch into a new session tab (`cockpit-actions.ts`)

`launchAgent` is rewritten to mirror `duplicateSession`'s create-a-session pattern instead of `ObjectService.CreateBlock`:

1. Resolve `cwd` (unchanged): optional `CreateWorktreeCommand` for the worktree opt-in, else the project path.
2. `const newTabId = await WorkspaceService.CreateTab(ws.oid, name, false)` — a new tab with one default `{view:"term", controller:"shell"}` block.
3. Read the new tab's default block id: `newTab.blockids[0]`.
4. `SetMetaCommand` on that block with `buildLaunchMeta({runtime, startupCommand, task, cwd})` (the existing pure builder) — turning the default shell block into the agent's cmd block (or leaving it a shell for the `terminal` runtime).
5. `SetMetaCommand` on the **tab** with `{ "session:agent": <runtime>, "session:label": <project or task-derived label> }` so the roster labels/projects the row and the transcript projector can pick the right agent family.
6. **Do not call `setActiveTab`.** Instead register a pending launch and focus it (§4.2). The cockpit stays on the Agents tab; the process starts when the booting terminal mounts in the focus pane (§4.3).

`ws.oid` comes from `globalStore.get(atoms.workspace)` (as in `duplicateSession`). The `terminal`-runtime path produces a shell block (no cmd) exactly as before — same `buildLaunchMeta` output.

> Why `CreateTab` over `CreateBlockCommand({tabid})`: a tab is the unit the roster scans. `CreateTab` applies the one-term-block default layout (`GetNewTabLayout`), and `SetMeta` before the tab/block renders is honored at controller start (the controller is lazy — §2). This is the verified, in-use pattern (`duplicateSession`).

### 4.2 Pending-launch overlay

A launched agent does not enter the base roster until the reporter emits a status (`liveAgentBaseAtom` skips status-less rows). To show it immediately, overlay a synthetic "booting" `AgentVM`:

- **State:** `model.pendingLaunchesAtom: PrimitiveAtom<PendingLaunch[]>`, where
  `PendingLaunch = { tabId: string; blockId: string; name: string; project: string; ts: number }`.
  The `tabId` is the id we just created — **the same id the real roster row will use** (`row.tabId`), so supersede needs no id migration.
- **`launchAgent`** appends `{ tabId: newTabId, blockId: newBlockId, name: label, project, ts }`, then sets `focusIdAtom = newTabId` and `surfaceAtom = "agent"`.
- **Merge:** `agentsAtom` becomes a derived atom:
  `mergePendingLaunches(get(baseRoster), get(pendingLaunchesAtom))`
  where `baseRoster` is `devRosterAtom` (dev) or `liveAgentsAtom` (prod). `mergePendingLaunches` is a **pure, unit-tested** helper in `agentsviewmodel.ts`:
  - maps each `PendingLaunch` to a booting `AgentVM` (`state: "working"`, `name`, `project`, `blockId`, no `transcriptPath`, `activeMs` from `now - ts`);
  - **drops** any pending entry whose `tabId` already exists in `baseRoster` (the real row supersedes it — reactive, automatic).
- **Self-heal (no timer needed).** A pending entry clears when (a) its `tabId` appears in the base roster (supersede, above) **or** (b) its `tabId` is no longer in `ws.tabids` (the user closed it). A small effect prunes (b). No timeout fallback is used: during boot the agent's terminal is the center pane, so a stuck/errored launch (e.g. `command not found`) is **visible and actionable**, never a silent ghost. (A ~20s timeout was considered and dropped as unnecessary given the always-visible terminal.)

### 4.3 In-layout terminal + auto-handoff (`agentsurface.tsx`)

Remove the full-pane `terminalTarget` branch. The Agent surface **always** renders the three panes — `AgentTree | center | AgentDetailsRail` — and the **center** is chosen per focused agent:

```
centerIsTerminal = isPending(agent) || terminalTargetBlockId === agent.blockId
```

- **`isPending`** = focused agent's `tabId` ∈ `pendingLaunchesAtom` ids. A booting agent shows its terminal *because it is pending* — no `terminalTarget` write at launch. When the reporter registers it, it leaves the pending set, `isPending` flips false, and (absent an explicit `t`) the center **auto-swaps to the transcript**. The handoff is therefore purely derived from pending membership — no auto-clear effect, no flag.
- **`terminalTargetAtom`** is repurposed as "show *this* agent's terminal in the center" (the explicit `t` / "Open terminal" path), no longer a full-pane switch. `openTerminal(id)` sets `focusIdAtom = id` (was `undefined`) + `terminalTargetAtom = blockId` so the list keeps the agent highlighted while its terminal shows in-layout.
- **Terminal pane** = `CockpitFocusPane blockId={agent.blockId} tabId={agent.id}` (the agent's **own** tabId — the tab its term block lives in; verify this is what the term tab-model needs, vs. today's outer-tabId pass at `agentsurface.tsx:50`). Mounting it starts the controller (§2). After swap to transcript the term view unmounts, but the **durable backend controller keeps running** — the process is unaffected.
- **Center = transcript** → existing `AgentTranscript` (unchanged).
- **`t` key / Esc:** `t` sets `terminalTarget` to the focused agent's block (toggle to terminal); `Esc` clears `terminalTarget` if set (back to transcript), else leaves the surface to `cockpit` (small refinement over today's always-to-cockpit).

The empty-roster state (no agents, none pending) is unchanged.

## 5. Data flow (end to end)

```
Launch click
  └─ launchAgent: [worktree?] → CreateTab → SetMeta(block=launchMeta) → SetMeta(tab=session:agent/label)
       → pendingLaunchesAtom += {tabId,blockId,…}; focusId=tabId; surface="agent"
  └─ AgentSurface: focused = pending agent → center = CockpitFocusPane(blockId, tabId)
       → term view mounts → ControllerResync → claude starts in cwd
  └─ reporter emits status for blockOref (seconds later)
       → liveAgentBaseAtom gains a row id=tabId (+transcriptPath)
       → mergePendingLaunches drops the pending entry (tabId now in base)
       → isPending=false → center auto-swaps to AgentTranscript (live narration streams)
```

## 6. Components / interfaces

- `agentsviewmodel.ts` (pure, tested): `PendingLaunch` type; `mergePendingLaunches(base, pending): AgentVM[]`; `pendingToVM(p, now): AgentVM` (if extracted). No React.
- `agents.tsx` (`AgentsViewModel`): add `pendingLaunchesAtom`; change `agentsAtom` to the derived merge over the base roster; update `openTerminal` to keep `focusId`.
- `cockpit-actions.ts`: rewrite `launchAgent` (CreateTab+SetMeta; register pending; focus; no setActiveTab). Add a tiny helper to read `ws.oid` + the new tab's default block id (mirror `duplicateSession`).
- `agentsurface.tsx`: always-3-pane; `centerIsTerminal` rule; pass the agent's own tabId to `CockpitFocusPane`; `t`/Esc refinement; prune-on-tab-gone effect (or host the prune in a small effect here / in a store module).

## 7. Error handling

- **CreateTab / SetMeta failure** → surface in the New Agent modal's existing error line; do not register a pending launch; keep the modal open. (`launchAgent` already `try/catch`es and the modal renders `error`.)
- **Worktree failure** → unchanged (existing inline error; no tab created).
- **Process fails to start** (bad `cmd`, `command not found`) → the booting terminal (center) shows the shell error; the pending row remains visible (state "working") until the user closes the tab. No silent failure — the terminal is the escape hatch. Documented behavior, not an error path we intercept.
- **Boundary**: all RPC errors carry a message; nothing swallowed.

## 8. Testing

- **Pure unit (vitest)** in `agentsviewmodel.test.ts`:
  - `mergePendingLaunches`: pending overlays as booting VMs; a pending entry whose `tabId` exists in base is dropped (supersede); ordering/stability; empty cases.
  - `pendingToVM`: field mapping (state, name, project, blockId, activeMs from now-ts).
  - center rule (if extracted as a pure predicate): pending → terminal; terminalTarget match → terminal; neither → transcript.
- **No jsdom** for the surface (project constraint) — verify in the live dev app via CDP (`scripts/cdp-shot.mjs`, `:9222`): launch an agent, confirm (a) the list stays visible with a booting row, (b) the center shows the live terminal, (c) the process actually starts (claude banner), (d) on the live path the center swaps to the transcript. Dev-mock caveat per §9 — full auto-handoff is verified in prod / via the live injector.
- Full `npx vitest run` green; `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` shows only the 3 pre-existing `api.test.ts` errors.

## 9. Dev-mock caveat

In `dev`, `agentsAtom`'s base is the static `devRosterAtom`, so a launched agent's **real** row never appears there and the pending entry never supersedes — the booting row + its live terminal persist until the tab closes. The launch, tab, and process are all real (dev runs a real `wavesrv`), so the terminal works; only the roster handoff is mock-blind. The auto-swap to transcript is verified in prod / via `scripts/inject-live-agents.mjs`. This is an accepted, pre-existing limitation of the dev mock, noted in `docs/deferred.md`.

## 10. File inventory

- `frontend/app/view/agents/agentsviewmodel.ts` (+ `.test.ts`) — `PendingLaunch`, `mergePendingLaunches`, `pendingToVM`.
- `frontend/app/view/agents/agents.tsx` — `pendingLaunchesAtom`; derived `agentsAtom`; `openTerminal` focus fix.
- `frontend/app/cockpit/cockpit-actions.ts` — `launchAgent` rewrite.
- `frontend/app/view/agents/agentsurface.tsx` — always-3-pane, center rule, tabId pass, t/Esc, prune effect.
- `docs/deferred.md` — dev-mock handoff caveat.

## 11. Decisions (resolved during brainstorming)

- Land in the Agent tab focus view with the roster visible (not full-pane terminal, not the Cockpit grid).
- Boot pane is the **real terminal** (forced by the controller-starts-on-mount mechanic), auto-swapping to the transcript when tracked — not a spinner placeholder (which couldn't start the process).
- Launch creates a **new session tab** (roster citizenship) and does **not** `setActiveTab` (cockpit stays put).
- **Unify** terminal rendering in-layout; drop the full-pane `terminalTarget` special case (also fixes `t` hiding the roster).
- Self-heal via supersede + tab-gone prune; **no timeout** (visible terminal is the escape hatch).

## 12. Open questions

- **`CockpitFocusPane` tabId:** confirm the term tab-model needs the agent's *own* tabId (this design) rather than the Agents view's tabId (today's pass). If today's full-pane `t` path works with the outer tabId, verify the in-layout path does too, or fix it here.
- **Label source for the booting row:** project name vs. a task-derived short label. Default: project name; revisit if it reads poorly next to real auto-titled rows.
