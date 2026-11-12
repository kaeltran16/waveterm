# Agent-drawn boards: round 1 fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Spec:** `docs/superpowers/specs/2026-11-11-tldraw-in-arc-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/boardstore ./pkg/boardscribe ./pkg/boardthings ./pkg/agentsessions ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Setup:** `node scripts/worktree-junctions.mjs prepare && { ! grep -q '"@excalidraw/excalidraw"' package.json || test -d node_modules/@excalidraw/excalidraw || npm install --no-audit --no-fund; }`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs boards-surface boards-draw boards-follow`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\tldraw-in-arc

**Goal:** Fix what the run's Final and Task 9 found: the app crashes at boot in the command palette, a pending redraw
frame can land on top of another group, and a board's waiting draws stay in the inbox after the board is fixed and
opened.

**Architecture:** Three small fixes in the frontend the run built. The palette crash is a guard moved into a pure,
tested helper. Pending placement stays in the pure `boardmodel.ts`. The inbox drain hooks the existing live-board
registry in `boardstore.ts`, which the applier already reads.

**Tech Stack:** React 19, jotai, vitest, `@excalidraw/excalidraw` 0.18.1, the CDP scenario harness (`scripts/cdp/`).

## Global Constraints

- Every scenario check runs as `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario>`, never
  `task verify:ui`. Run one isolated app at a time: the machine ran out of memory with two.
- No new design tokens; copy as the original plan `docs/superpowers/plans/2026-11-12-agent-drawn-boards.md` fixes it.

## Review Focus

1. The palette with no board drill open (every boot): it must render, which is what Final could not reach.
2. A pending frame when the edited group has another group to its right: the frame must not cover it.
3. A board that would not open, fixed and opened with Retry: draws that waited in its inbox land then, not at the next
   draw or the next app start.

---

### Task 1: The palette boots, and the board drill's scenarios run

Final's `boards-surface`, `boards-draw` and `boards-follow` never got past boot: `command-palette.tsx:331` reads
`boardList?.channelId === boardChannelId ? boardList.data : null`. With no board drill open both sides are
`undefined`, the comparison is true, and it reads `null.data`, which throws in `CommandPalette` on every render. Task 10's
`boards-draw` scenario was skipped (low memory), so none of its steps have run yet.

**Files:**
- Modify: `frontend/app/cockpit/actions/boarddraw.ts`, `frontend/app/cockpit/actions/boarddraw.test.ts`
- Modify: `frontend/app/cockpit/command-palette.tsx` (the `listed` line, about line 331)
- Modify as the scenarios show: `scripts/cdp/scenarios-boards-draw.mjs`, `scripts/cdp/scenarios-boards-follow.mjs`, and
  the palette/board files those steps exercise

**Interfaces:**
- Produces: `listedBoards(list: { channelId: string; data: BoardListRtnData } | null, channelId: string | null | undefined): BoardListRtnData | null`
  in `boarddraw.ts`: the list's data only when a list is loaded and was read for that same non-empty channel.

- [ ] **Step 1: Write the failing test** in `boarddraw.test.ts`, `describe("listedBoards")`:
  - `listedBoards(null, undefined)` is `null` (the boot case);
  - `listedBoards(null, "ch1")` is `null`;
  - `listedBoards({ channelId: "ch1", data }, "ch2")` is `null` (a stale list for another channel);
  - `listedBoards({ channelId: "ch1", data }, "ch1")` is `data`.
- [ ] **Step 2:** `npx vitest run frontend/app/cockpit/actions/boarddraw.test.ts` fails (`listedBoards` not exported).
- [ ] **Step 3:** Implement `listedBoards`; `command-palette.tsx` uses it for `listed`.
- [ ] **Step 4:** The test passes, and Check passes.
- [ ] **Step 5:** Run `boards-draw`, then `boards-follow` (one at a time). The app boots, and every step of both passes.
  Fix what a step shows in the feature's own code; a step's assertion changes only where the step was wrong about the
  plan, and the report names each such change.
- [ ] **Step 6: Commit** `fix(boards): the palette boots with no board drill open`.

### Task 2: A pending frame clears other groups, and a fixed board takes its waiting draws

**Depends on:** Task 1 (its scenario cannot boot without the palette fix)

Two defects Task 9 found and left: a pending frame placed 80px right of the edited group (`boardmodel.ts`,
`applyPending`) lands on top of whatever group sits there; and the applier (`boardapplier.ts`) reads the inbox only at
start and on `draw` events, so after E1's Retry opens a fixed board its waiting draws land only at the next draw or the
next app start.

**Decision (pending placement):** the frame goes 80px right of the edited group, top-aligned, as before, when that box
(the placed elements plus the frame padding) overlaps no other live element. Otherwise it goes 120px right of the
board's content (`firstDrawSpot`'s spot), still top-aligned with the edited group. Why: it stays beside the group when
there is room, which is what the spec asks, and the fallback is the one spot sure to be clear. A later redraw still
reuses the existing frame's place.

**Decision (inbox drain):** opening a board drains its inbox. `registerLiveBoard` gains the channel and tells listeners
when a board registers; the applier listens and reads that board's inbox, so Retry (which re-mounts the canvas), a
first open and a re-open all pick up waiting draws.

**Files:**
- Modify: `frontend/app/view/boards/boardmodel.ts`, `boardmodel.test.ts`
- Modify: `frontend/app/view/boards/boardstore.ts`, `boardstore.test.ts`
- Modify: `frontend/app/view/boards/boardapplier.ts`, `boardapplier.test.ts`
- Modify: `frontend/app/view/boards/boardcanvas.tsx` (the `registerLiveBoard` call)
- Modify: `scripts/cdp/scenarios-boards-surface.mjs`

**Interfaces:**
- Changes: `registerLiveBoard(channelId: string, boardId: string, apply: LiveBoardApply): () => void`.
- Produces: `onLiveBoardRegistered(fn: (channelId: string, boardId: string) => void): () => void` in `boardstore.ts`.

- [ ] **Step 1: Write the failing tests.**
  - `boardmodel.test.ts`: "places a pending frame past the board's content when the spot beside the edited group is
    taken": an edited group A with a group B 40px to its right; a redraw of A comes back `pending`, its frame overlaps
    no element of B, its left edge is at least 120px right of B's right edge, and its top equals A's top (allowing the
    frame padding). The existing "80px right of it" test still passes unchanged.
  - `boardstore.test.ts`: `onLiveBoardRegistered` listeners get `(channelId, boardId)` on `registerLiveBoard`, and not
    after they unsubscribe.
  - `boardapplier.test.ts`: with `BoardInboxCommand` stubbed, registering a live board after start reads the inbox for
    that `{channelid, boardid}` and lands its draw.
- [ ] **Step 2:** `npx vitest run frontend/app/view/boards` fails on the three new tests.
- [ ] **Step 3:** Implement both decisions.
- [ ] **Step 4:** `npx vitest run frontend/app/view/boards` passes, and Check passes.
- [ ] **Step 5: Scenario steps** in `scenarios-boards-surface.mjs`:
  - The keep-pending step's board has a group right of the edited one; assert the pending frame's box overlaps no
    other group's box. Motion: none new (the frame enters as the canvas draws it).
  - The won't-open step: with a draw waiting in the stubbed inbox, Retry with the file fixed opens the board, and the
    draw's shapes are on the canvas. Motion: the open uses the surface's existing board fade.
  - Run `boards-surface`: every step passes.
- [ ] **Step 6: Commit** `fix(boards): pending frame clears other groups; open drains the inbox`.
