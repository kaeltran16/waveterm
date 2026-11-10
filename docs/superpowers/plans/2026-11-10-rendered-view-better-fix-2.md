# Rendered view: know what it is doing now, fix round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-11-10-rendered-view-better-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentask`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered`

**Goal:** Close two gaps the run left in the `agent-rendered` scenario: an error toast that covers the later
screenshots, and the You label check lost when the 920px timeline step was replaced.

**Architecture:** Scenario-only changes in `scripts/cdp/scenarios-agent-rendered.mjs`. No product code changes.

**Tech Stack:** the CDP scenario harness (`scripts/cdp/`).

## Decisions

1. **Dismiss the toast, don't avoid it.** `rendered: picker flip` sends `/config` from A's composer. A has no
   controller by design, so `agentcomposer.tsx` raises the error toast "Message not sent", and it stays over the
   right edge of the timeline in every later shot (the now-line shots included). The flip is what the step
   checks, so the send stays; the step dismisses the toast after its shots by clicking it (a toast is a
   `[data-notification-toast]` button whose click calls `dismissToast`, `frontend/app/cockpit/notificationtoasts.tsx`).
2. **Restore the label check in the step that replaced it.** The old `rendered: timeline` step asserted the You
   bubble's label reads `You` (`flat(you?.previousElementSibling) === "You"`); `rendered: timeline fills` dropped
   it. Add it back to that step's measure and `fits`.

## Global Constraints

- Keep prettier off `scripts/*.mjs` (AGENTS.md): it reindents those hand-formatted 4-space files.
- Step names and shot numbers stay as they are.

## Review Focus

1. The dismissal waits until no `Message not sent` toast is in the DOM, so a later shot cannot catch its exit.

---

### Task 1: Clean the picker-flip toast and restore the You label check

**Files:** `scripts/cdp/scenarios-agent-rendered.mjs`

**Interfaces:**
- Consumes: the existing helpers in that file (`wait`, `h.ev`, `flatJs`/`flat`, `RV`).
- Produces: nothing new.

- [ ] **Step 1: Dismiss the toast in `rendered: picker flip`**

After the step's last shot (`SHOT(18, "picker-back")`), click every `[data-notification-toast="error"]` whose
`innerText` includes `Message not sent`, then `wait` until none is in the DOM. Add `toastGone` to the step's
result and its `ok`. A toast never raised (the send landed somehow) counts as gone.

- [ ] **Step 2: Restore the You label in `rendered: timeline fills`**

In the measure, add `youLabel: flat(you?.previousElementSibling)`; in `fits`, require `m.youLabel === "You"`.
Update the step name only if it must; it already covers the column.

- [ ] **Step 3: Run the scenario in the dev app**

Run: `node scripts/cdp/final-verify.mjs agent-rendered` (or `task verify:ui -- agent-rendered`) against a dev app.
Expected: every step passes, and the shots after `picker-back` (the now-line shots) show no toast.

- [ ] **Step 4: Commit**

```bash
git add scripts/cdp/scenarios-agent-rendered.mjs
git commit -m "test(cdp): dismiss picker-flip toast, restore You label check"
```
