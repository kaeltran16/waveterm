# Brainstorm canvas connection, round 1 fix plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the one step that failed the final stage, so `brainstorm-mode` passes on the merged result.

**Architecture:** One task. Find the root cause of step 2g's failure, either in the scenario's input helpers or in the part edit box in the pane, and fix it there.

**Tech Stack:** Node CDP scenarios (`scripts/cdp`), React 19 + TypeScript (`frontend/app/view/agents`).

**Spec:** C:\Users\kael02\AppData\Local\arc-wt\b27cb9f4\docs\superpowers\specs\2026-11-03-brainstorm-canvas-connection-design.md

Decisions beyond the design:

1. The step is fixed even though Task 4 found it already failing on the base. A failing Final step holds the land wherever it came from.
2. 2g's assertion stays as strict as it is. The fix makes the edit really send, or makes the scenario really type and press Enter; it never loosens what 2g checks. The step checks that the line was sent once, to the agent's block, shows in the terminal, and that the box closes.

## Global Constraints

- Never run prettier on `scripts/*.mjs`. Those files are hand-formatted with 4-space indents.
- Only `@theme` tokens. Typecheck with `task check:ts`.
- The edit box's product behaviour is unchanged: Enter sends `brainstorm: edit <part>: <text>` as one line and closes the box, and Escape closes it and sends nothing.

## Review Focus

1. A fix that passes 2g without a real send. For example, the step reads its own injected value back instead of the pane's `agentprompt` call. The `sent` list must come from the wrapped `wshRpcCall`.
2. A timing fix (a fixed wait) where an event-driven wait exists. Wait on a condition (`polishWaitFor`), not on a nap.

---

### Task 1: brainstorm-mode 2g sends the edited part

**Depends on:** none

**Files:** `scripts/cdp/scenarios-brainstorm.mjs`, `frontend/app/view/agents/brainstormpane.tsx`

The failure, from Final round 1 (`final-shots/ea4025f5-.../1/shots.json`):

```
brainstorm-mode | fail | 2g. Edit, new text, Enter sends the edit as one line and closes the box
{"want":"brainstorm: edit constraints: Alerts go through the existing Alertmanager only. No new service.","sent":[],"inTerminal":false,"termError":null,"editClosed":true,"keys":"set"}
```

What is known:

- Task 4 reran `brainstorm-mode` with the frontend at d6c6a865, before this run's UI changes. 2g failed the same way there.
- 2f, which runs just before it (Edit, then Escape), passes.
- `keys: "set"` means `bsFill`'s `Input.insertText` did not land in the textarea, so the value went through `bsSetValue` and Enter went through `bsKey`'s synthetic keydown on the element.
- The box closed, yet nothing was sent. The pane's textarea (`brainstormpane.tsx`, the `data-brainstorm-edit` element under `PaneReveal`) closes on its own only after a successful `send`. A close with no send points at the textarea leaving the DOM some other way.
- Lead's hypothesis, not verified: `bsFill`'s `bsMouseClick` lands while the reopened row is still animating in `PaneReveal` (f76ecec0 added the motion). The click hits the row toggle and folds the part, which removes the textarea. Then `bsSetValue` and Enter find nothing, and `!BS_EDIT` reads as closed. Confirm or refute this with a probe before you fix anything.

- [ ] **Step 1: Reproduce.** Start a worktree dev app the way `scripts/cdp/final-verify.mjs` does and run `brainstorm-mode`. Confirm 2g fails with `sent: []`. Record what the textarea and the constraints part's `data-state` and `aria-expanded` read at each point between `bsClick(... "Edit")` and the Enter.
- [ ] **Step 2: Fix the root cause where it lives.**
  - If the scenario acts before the box is ready, make the helper wait on the condition that makes it ready, then act. For example, wait for the textarea's box to be stable and focused. Apply this in the shared helper (`bsFill` or `bsMouseClick`), so every edit field the scenarios fill gets it, not only 2g.
  - If the pane loses the box or the typed value, fix `brainstormpane.tsx`.
  - Don't change what 2g asserts.
- [ ] **Step 3: Verify.** Run `brainstorm-mode` and `brainstorm-answer-boards` against the worktree dev app. Every step must pass in two runs in a row. Run `task check:ts` if `brainstormpane.tsx` changed. In the report, give the root cause you found and which part of the hypothesis held.
- [ ] **Step 4: Commit** only the files changed. Subject: `fix(cdp): brainstorm-mode 2g sends the part edit` (or `fix(brainstorm): ...` if the fix is in the pane).
