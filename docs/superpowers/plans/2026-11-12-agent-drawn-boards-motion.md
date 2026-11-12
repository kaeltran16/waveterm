# Agent-drawn boards: motion round

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Spec:** `docs/superpowers/specs/2026-11-11-tldraw-in-arc-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/boardstore ./pkg/boardscribe ./pkg/boardthings ./pkg/agentsessions ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Setup:** `node scripts/worktree-junctions.mjs prepare && { ! grep -q '"@excalidraw/excalidraw"' package.json || test -d node_modules/@excalidraw/excalidraw || npm install --no-audit --no-fund; }`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs boards-surface boards-draw boards-follow`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\tldraw-in-arc

**Goal:** The human asked for animations on the boards. The run built the moments its plan named (the tree's reveal,
the list reorder, the drawing pulse, the error nudge, the count tick, the change flash). Everything inside an open
board's tree still pops in and out: source rows, follow rows, the drawing, failed and pending blocks, the New chip,
and the board rows themselves. This round gives each of them the moment `docs/reference/motion-system.md` assigns.

**Architecture:** Motion only, in `frontend/app/view/boards/boardslist.tsx`, from the existing primitives in
`frontend/app/element/motiontokens.ts`, `drawcheck.tsx` and the moment table. No new tokens, durations or variants.

**Tech Stack:** React 19, `motion/react`, the CDP scenario harness (`scripts/cdp/`).

## Global Constraints

- Only the moment table's primitives (`docs/reference/motion-system.md`, "The moments" and "Guardrails"); no new
  variants, durations or keyframes. Every new `AnimatePresence` takes `initial={false}`, so opening a board or
  switching to Boards animates nothing that was already there.
- `AnimatePresence mode="popLayout"` needs a `motion.*` element as its direct child: a custom component as the child
  leaves a gap on exit.
- Scenario checks run as `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario>`, one app at a time.
- Not in scope: animating shapes on the Excalidraw canvas. Excalidraw draws its scene itself; fading a group in would
  mean re-sending the scene every frame, and the toast plus the row's changes already say a draw landed.

## Review Focus

1. Opening a board, switching to Boards and a reload: nothing animates in that was already there.
2. A follow stopped, a pending version dropped or kept, a failed draw retried: the leaving row or block exits and the
   rows below close the gap, with no jump.

---

### Task 1: Motion in the boards list and an open board's tree

**Files:** `frontend/app/view/boards/boardslist.tsx`, `scripts/cdp/scenarios-boards-surface.mjs`

**State changes and the moment each uses:**
- A board row added or removed: moment 1 entrance (`cardVariants`) and moment 2 exit with reflow (the list already
  has `popLayout` and `layout`; add the variants).
- A follow row added (a follow starts) or removed (Stop, the tab closes): moments 1 and 2, under `popLayout`, with
  `layout` on each row.
- A source row added (a first draw from a new source): moment 1. Rows that move or close up: moment 2 (`layout`).
- The drawing note, the failed block (with Retry) and the pending block (with Keep and Drop) appearing or going under
  their row: moment 6 (`composerReveal`).
- A draw lands on a source that was drawing: moment 16. A `DrawCheck` takes the drawing mark's place and draws once;
  it stays while the row is New. A row mounted already drawn shows no check.
- The New chip appearing or going: moment 1.

- [ ] **Step 1:** Implement the moments above in `boardslist.tsx`.
- [ ] **Step 2:** Check passes; `npx vitest run frontend/app/view/boards` still passes.
- [ ] **Step 3: Scenario steps** in `scenarios-boards-surface.mjs`, reusing its stubbed status and inbox:
  - "a draw lands": a source shown drawing gets its draw; the row shows the drawn check (`DrawCheck`'s element inside
    `[data-board-source="<key>"]`) and the New chip, and no drawing mark.
  - "stop a follow": Stop on a follow row; once its exit ends, `[data-board-follow]` is gone and the first source row's
    top sits where the follow row's top was (no gap left behind).
  - "nothing animates on open": right after opening a board, no element in its tree has an opacity below 1.
  - Step 5 ("drawing and failed"): its stubbed board list gives the drawing board `state: "drawing"`, as
    `BoardList` does in the product, and the step asserts the board row shows the drawing mark (D2), not "1 new".
    Final's verifier noted the row read "1 new" only because the stub had no state.
  - Run `boards-surface`: every step passes, the new ones included.
- [ ] **Step 4: Commit** `feat(boards): motion for the board tree's rows and blocks`.
