# Leftovers review fixes, Final round 1 Implementation Plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Final stage pass: `agent-tree-rail` steps 0 and 3 fail because a run lead that failed to start
loses its Workflow mark in the Agent tree.

**Architecture:** One task. The lead row's mark keeps its Workflow shape for a run lead whatever its state; a
failed start becomes a tone of that mark (error) instead of replacing it with the red dot. The tone logic lives
in the pure `leadMark` with its tests.

**Tech Stack:** React 19 + jotai, vitest, CDP scenarios.

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\115f3492\docs\superpowers\specs\2026-11-06-leftovers-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/jarvisattrib ./pkg/storagereport ./pkg/notestore ./pkg/waveobj ./pkg/wshrpc/...`
**Check:** `go build ./... && go vet ./pkg/jarvisattrib ./pkg/storagereport ./pkg/notestore ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brief-contextual-map brief-profile jarvis-peek notification-toasts brief-act code-peek term-link-tooltip agent-tree-rail palette-notes surface-smoke`

## Global Constraints

- Colors from the `@theme` tokens only (`text-error` exists); no new tokens.
- Logic is extracted, not rendered: the tone decision goes in `leadcardmodel.ts` with its test beside it.
- Never stop `wave-tauri.exe` / `wavesrv.x64.exe` by image name; never touch the user's packaged Arc.
- Lint/format only the files you touched; keep prettier off `scripts/*.mjs`.

## Review Focus

- A non-lead agent that failed to start keeps today's red dot with `data-tree-start-error` and its title
  (the `agent-start-failed` scenario reads that dot's fill).
- A lead that failed to start must still read as failed: error tone, `data-tree-start-error`, title = the error.

---

### Task 1: A run lead that failed to start keeps its Workflow mark, in the error tone
**Depends on:** none
**Files:** `frontend/app/view/agents/leadcardmodel.ts`, `frontend/app/view/agents/leadcardmodel.test.ts`, `frontend/app/view/agents/agenttree.tsx`

Cause (checked by the lead in the Final's shot `final-shots/7369809c-.../1/cdp-shots/agent-tree-rail.png`): the
`agent-tree-rail` fixture lead has a fixture block id, so its terminal's controller resync is refused with
`error getting block: not found` and the lead gets `startError` (since 43835037e). `AgentRow`'s `<Slot>` checks
`agent.startError` before `mark`, so the lead's Workflow icon becomes a red `span` dot: step 3 reads `tag:"span"`,
and arrange's wait for the svg never clicks the lead, so step 0 reads `leadFocused` false. This fails on the base
too (Task 7 of this run reproduced it with its change stashed).

Decision (the lead's, autonomous run): the mark's shape says "run lead", its tone says the state. A lead that
failed to start keeps the Workflow icon in the error tone rather than turning into a generic dot. Do not change
the scenario's assertions or the fixture: the scenario's intent (the lead row shows the Workflow mark) is right.

- [ ] `leadcardmodel.ts`: `LeadMarkTone` gains `"error"`, `LEAD_MARK_CLASS.error = "text-error"`. `leadMark(run,
  lead)` returns `{ tone: "error", pulse: false }` when `lead?.startError != null`, checked after
  `runComplete(run)` (a complete run stays green) and before the standing-by / state branches.
- [ ] `leadcardmodel.test.ts`: a lead with `startError` set on an incomplete run → `{ tone: "error", pulse:
  false }`; the same lead on a complete run → `success`; a lead without `startError` keeps its existing result.
- [ ] `agenttree.tsx` `AgentRow` `<Slot>`: when `mark` is set, render the Workflow icon (with
  `data-tree-start-error` and `title={agent.startError}` when `agent.startError != null`); otherwise the
  existing order (start-error dot, commit tick, status dot) is unchanged. `RunGroupRow`'s mark (`leadMark(run,
  undefined)`) is untouched.
- [ ] Run `npx vitest run frontend/app/view/agents/leadcardmodel.test.ts`, then
  `node scripts/cdp/final-verify.mjs agent-tree-rail agent-start-failed`: every step of both passes (steps 0
  and 3 of `agent-tree-rail` included).
