# Boards and the agent, connected: round 1

**Spec:** `docs/superpowers/specs/2026-11-19-boards-agent-connection-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/boarddrawer ./pkg/boardforward ./pkg/boardstore ./pkg/boardthings ./pkg/agentsessions ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/board...`
**Final:** `node scripts/cdp/final-verify.mjs boards-ask boards-workspace boards-transcript`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\boards-agent-connection\project\A1-Flow.dc.html

The final stage passed. This round fixes two open issues the task reviews found and no task could take: the board
Escape hook is one global although a tied board can now be mounted twice (its workspace tab, which stays mounted
with the Agent surface, and the Boards surface), and the cockpit skill says every drawn board is tied to the agent.

## Decisions beyond the spec

1. **Escape follows the most recently mounted canvas that is still mounted.** Each mounted canvas registers its own
   clear function and its own "owns Escape" flag; unmounting one removes only its own registration. The flag that
   counts is the top registration's, so an off-screen canvas never sets `boardOwnsEscapeAtom` while another
   canvas is on top. This matches decision 14's stack for live-apply.
2. **The open ask form keeps first claim on Escape** (`setBoardFormEscape` is unchanged): one form exists, on the
   Boards surface only.

### Task 1: Escape per mounted canvas
**Depends on:** none
**Files:** `frontend/app/view/boards/boardstore.ts`, `frontend/app/view/boards/boardstore.test.ts`, `frontend/app/view/boards/boardcanvas.tsx`, `frontend/app/store/keybindings/bindings.test.ts`, `scripts/cdp/scenarios-boards-workspace.mjs`

**What to build:** replace the single-global `setBoardEscape` / `setCanvasOwnsEscape` in `boardstore.ts` with a
per-canvas registration kept as a stack (decision 1). `boardcanvas.tsx` registers on mount, reports its flag through
its own registration from `onChange`, and unregisters on unmount. `runBoardEscape` runs the form's Cancel first,
else the top registration's clear. `bindings.test.ts` moves to the new API with its assertions unchanged.

**Interfaces:**
```ts
export function registerBoardEscape(clear: () => void): { setOwns(owns: boolean): void; unregister(): void };
```

**Acceptance:**
- with two registrations, `runBoardEscape` runs the second's clear; after the second unregisters it runs the
  first's; after the first unregisters while the second is mounted, it still runs the second's
- `boardOwnsEscapeAtom` follows only the top registration's flag: the lower one setting owns true leaves it false;
  unregistering the top makes the lower one's last flag count; with none left it is false
- an open form still takes Escape first, and `boardOwnsEscapeAtom` is true while a form is open
- the existing `bindings.test.ts` Escape cases pass unchanged in what they assert
- scenario step "Escape with the board mounted twice" in `boards-workspace`: with a tied board's tab active in its
  agent's workspace and the same board open on the Boards surface, close that tab in the workspace (the workspace
  canvas unmounts), select a shape on the Boards canvas, press Escape: the selection clears and the surface stays
  Boards

### Task 2: The cockpit skill says who a board is tied to
**Depends on:** none
**Files:** `skills/cockpit/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/cockpit/SKILL.md`

**What to build:** the skill's line "The board is tied to you, and opens in your workspace" overstates decision 7: a
board is tied to the agent that created it (or drew on it while it had no agent), and a board already tied to
another agent stays tied to that agent, opens in that agent's workspace, and still draws your request. Reword the
line to say so, then `task sync:claudemod`.

**Acceptance:**
- the source and the tracked copy are identical (`task sync:claudemod` leaves no diff)
