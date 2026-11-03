# Brainstorm canvas connection, round 2 fix plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `brainstorm-mode` step 2f fail when Escape closes the whole design, not just the part's edit box.

**Architecture:** One task. Make one scenario assertion stricter. No product code changes.

**Tech Stack:** Node CDP scenarios (`scripts/cdp`).

**Spec:** C:\Users\kael02\AppData\Local\arc-wt\b27cb9f4\docs\superpowers\specs\2026-11-03-brainstorm-canvas-connection-design.md

Decisions beyond the design:

1. Task 5 (round 1) found that 2f passed vacuously before its click fix. Escape closed the whole design, and `escClosed` (`!BS_EDIT`) reads true either way. The round tightens the check so that this regression fails 2f, and changes nothing else.

## Global Constraints

- Never run prettier on `scripts/*.mjs`. Those files are hand-formatted with 4-space indents.
- The pane's behaviour is unchanged. Escape in a part's edit box closes only that box, so the design stays open on the same part.

## Review Focus

1. A stricter 2f that still passes when the design closes. The new condition must read the design view itself, for example `[data-brainstorm-back]` in the pane and the constraints part still present, not only the textarea's absence.

---

### Task 1: brainstorm-mode 2f checks that Escape closed only the edit box

**Depends on:** none

**Files:** `scripts/cdp/scenarios-brainstorm.mjs`

- [ ] **Step 1: Tighten 2f.** In `brainstorm-mode`, step 2f ("Edit on Constraints opens prefilled with its body; Escape closes it and sends nothing") also requires two things after Escape:
  - the design is still open: `!!${BS_PANE}?.querySelector("[data-brainstorm-back]")`, the condition 2r already uses;
  - `bsPartSel("constraints")` is still present and its row is still expanded.

  Add both to the step's pass condition and to its detail object (for example `designOpen`, `partOpen`). Leave every other assertion as it is.
- [ ] **Step 2: Prove the check fails when it should.** Against a worktree dev app (started as `scripts/cdp/final-verify.mjs` does), temporarily make Escape in the edit box also close the design. One way is to have its handler in `brainstormpane.tsx` call the pane's back step. Another is to let the key reach `agent:brainstorm-back` in `bindings.ts`; pick whichever applies. Confirm 2f now fails with `designOpen: false`. Revert that edit; it is never committed.
- [ ] **Step 3: Verify.** Run `brainstorm-mode` against the worktree dev app. Every step passes.
- [ ] **Step 4: Commit** only `scripts/cdp/scenarios-brainstorm.mjs`, with the subject `test(cdp): brainstorm-mode 2f checks Escape closes only the edit box`.
