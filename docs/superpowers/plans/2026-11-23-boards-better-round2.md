# Boards, better: round 2 (guidance copy points at Edit)

**Effort:** effort:27c79c5d-a564-4361-84df-9521ea1505e6
**Spec:** `docs/superpowers/specs/2026-11-20-boards-better-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/boarddrawer ./pkg/boardstore ./pkg/wshrpc/...`
**Check:** `go build ./... && go vet ./pkg/boarddrawer ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs boards-ask boards-workspace`

Final found two lines of guidance copy written before boards opened in view mode. Every board now opens in view
mode with no toolbar, and in view mode the ask ignores the selection (the spec's ask hint reads "Press Edit to
ask about shapes" for this reason), so both lines tell you to do something you cannot do until you press Edit.

### Task 1: Empty-board and empty-talk copy points at Edit
**Depends on:** none
**Files:** `frontend/app/view/boards/boardssurface.tsx`, `frontend/app/view/boards/boardtalk.tsx`, `scripts/cdp/scenarios-boards-ask.mjs`

**What to build:** the empty board (`EmptyBoard` in `boardssurface.tsx`, "Draw on it with the tools above, or ask
the drawer on the left.") reads "Press Edit to draw on it, or ask the drawer on the left." The empty talk
(`boardtalk.tsx:517`, "Ask below. To ask about something you drew, select it first.") reads "Ask below. To ask
about something you drew, press Edit and select it." Nothing else changes.

**Acceptance:**
- The boards-ask empty-board step (B11) also checks that the empty board's text names Edit, and the step that
  shows the empty talk checks the same for its line.
