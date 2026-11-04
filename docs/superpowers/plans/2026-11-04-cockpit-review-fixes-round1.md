# Cockpit review fixes, round 1: Cockpit keys after a palette pick

> **For agentic workers:** this is a fix round for the run that landed `2026-11-04-cockpit-review-fixes.md`. The
> task carries its design decision, files and acceptance; you write the implementation.

**Goal:** Make the Cockpit's keys work right after the command palette navigates to it from the Agent surface, so
the one failing Final step passes.

**Architecture:** Final failed one step out of 81: `cockpit-keys-on-arrival` "Agent -> Ctrl+P 'cockpit' -> Enter: j
reaches the Cockpit" (`palette=true active=BODY`). It fails the same way on this plan's base `6a165d374`, so the run
did not cause it, but it holds the land.

Cause, from the code:
- The Cockpit's keys are its container's own `onKeyDown`. On mount it focuses that container unless
  `focusClaimed()` holds (`cockpitsurface.tsx`, the effect around line 182).
- After a palette pick, the surface switches while the palette's `ModalShell` is still registered, so `focusClaimed()`
  is true (`anyModalOpen()`) and the Cockpit skips taking focus.
- When the palette then closes, `takeModalFocus`'s restore (`frontend/app/modals/modalfocus.ts`) finds the previous
  element (the Agent surface's xterm textarea) hidden, blurs the panel, and leaves focus on `<body>`. Nothing claims it
  after that.

The fix lives in the shared restore, not in the palette, so every modal that closes onto a surface it did not open
over hands focus to that surface: a modal with no visible element to return to focuses the visible
`[data-focus-home]` element, which the Cockpit container carries.

**Tech Stack:** React 19, vitest.

**Verify:** `node scripts/verify.mjs ./pkg/blockcontroller`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs cockpit-composer-send cockpit-ask-keys cockpit-launch-stays cockpit-roster-counts cockpit-offgrid cockpit-card-layout cockpit-rail-help cockpit-empty-state context-menu surface-headers shell-tasks cockpit-keys-on-arrival cockpit-polish`

## Global Constraints

- No new design tokens; this task changes no styling.
- Logic goes in the pure `modalfocus.ts` with its test beside it; `cockpitsurface.tsx` only gains an attribute.

## Review Focus

- A modal closed over a still-visible previous element (a terminal, an input) must keep handing focus back to that
  element, not to the focus home. Pinned by the "returns focus to a visible previous element" test.
- Two visible `[data-focus-home]` elements should not occur. If one does, the first visible one wins; do not throw.
- A close with no previous element and no home keeps today's behavior: blur the panel, leave focus on `<body>`.

---

### Task 1: A closing modal hands focus to the visible surface's focus home

**Files:** `frontend/app/modals/modalfocus.ts`, `frontend/app/modals/modalfocus.test.ts`, `frontend/app/view/agents/cockpitsurface.tsx`

**Interfaces:**
- Produces: `takeModalFocus(panel: HTMLElement | null, previous: HTMLElement | null, home: () => HTMLElement | null = visibleFocusHome): () => void`
  and `visibleFocusHome(): HTMLElement | null` (the first element matching `[data-focus-home]` whose `checkVisibility()`
  is true, else null). `ModalShell`'s call keeps its two arguments.

- [ ] **Step 1: Write the failing tests** in `modalfocus.test.ts`'s `describe("takeModalFocus")`, using the file's `fakeNode`/`fakePanel` helpers and an injected `home`:
  - "hands focus to the focus home when the previous element is hidden": previous `fakeNode(true, false)`, home a `fakeNode(true)`; after restore, `home.focus` was called once and `previous.focus` was not.
  - "hands focus to the focus home when there was no previous element": previous `null`; `home.focus` called once.
  - "returns focus to a visible previous element, not the home": previous `fakeNode(true, true)`; `previous.focus` called, `home.focus` not.
  - "blurs the panel when there is no home": home returns null, panel contains the active element; the existing blur behavior holds (keep or extend the existing test that covers it).
- [ ] **Step 2: Run** `npx vitest run frontend/app/modals/modalfocus.test.ts`. Expected: the new tests fail.
- [ ] **Step 3: Implement** in `modalfocus.ts`: in the restore closure, after the visible-previous branch, blur the panel's active element as today, then focus `home()` when it returns an element. Export `visibleFocusHome`. Update the file's comment about the palette pick so it names the focus home.
- [ ] **Step 4:** In `cockpitsurface.tsx`, add `data-focus-home` to the container that already carries `data-cockpit-surface` and `tabIndex={0}`. Do not change the mount effect.
- [ ] **Step 5: Run** the vitest file again (pass), `task check:ts` (exit 0), and `npx eslint` + `npx prettier --check` on the three files.
- [ ] **Step 6: Live check:** `node scripts/cdp/final-verify.mjs cockpit-keys-on-arrival` in the dev app. Both steps pass: "Agent -> Ctrl+P 'cockpit' -> Enter: j reaches the Cockpit" now reports `active=DIV[cockpit]`. Also run `cockpit-polish` and `context-menu`, which open and close modals and menus on the Cockpit, and confirm they still pass.
- [ ] **Step 7: Commit** the three files with a subject such as `fix(modals): hand focus to the surface's focus home on close`.
