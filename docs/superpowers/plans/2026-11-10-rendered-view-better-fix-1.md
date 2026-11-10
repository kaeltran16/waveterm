# Rendered view: know what it is doing now, fix round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-11-10-rendered-view-better-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentask`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered`

**Goal:** Make Verify pass on the merged result by regenerating the phone page's committed projector bundle,
which went stale when Task 1 added `ts` to the claude transcript projection.

**Architecture:** `pkg/remotemode/web/static/projectors.js` is a generated esbuild bundle of the cockpit's claude
and pi projectors (`scripts/sync-remote-web.mjs`, Taskfile `sync:remoteweb`). Its test
`pkg/remotemode/web/projectors.test.js` "the committed bundle is current" rebuilds it in memory and compares it to
the committed file. Task 1 changed `frontend/app/view/agents/transcriptprojection.ts` (the `recTs` helper and the
`...recTs(rec)` spreads) without regenerating, so the committed bundle lacks those lines.

**Tech Stack:** esbuild, vitest.

## Decisions

1. **Regenerate, don't hand-edit.** The bundle is generated (AGENTS.md: edit the source, never the copy). The
   phone page gains `ts` on user, command and message entries; it ignores unknown fields, so its behavior is
   unchanged. Leaving `ts` out of the phone bundle would need a second projection or a build-time strip, which is
   more code for no user-visible gain.

## Global Constraints

- Commit only the regenerated files whose content changed; never `git add -A`.
- Do not hand-edit anything under `pkg/remotemode/web/static/`.

## Review Focus

1. The bundle test fails again if the source and the committed bundle diverge: it already does, no new test needed.

---

### Task 1: Regenerate the committed projector bundle

**Files:** `pkg/remotemode/web/static/projectors.js`

The file is generated. If `scripts/sync-remote-web.mjs` rewrites another file under `pkg/remotemode/web/static/`
with different content (expected: none), restore it and say so in the report rather than commit it.

**Interfaces:**
- Consumes: Task 1's `recTs` in `frontend/app/view/agents/transcriptprojection.ts` (already landed).
- Produces: nothing new.

- [ ] **Step 1: Confirm the failure**

Run: `npx vitest run pkg/remotemode/web/projectors.test.js`
Expected: FAIL in "the committed bundle is current", diff showing the missing `recTs` lines.

- [ ] **Step 2: Regenerate**

Run: `node scripts/sync-remote-web.mjs`, then `git status --short pkg/remotemode/web/static`.
Expected: `projectors.js` modified, containing `function recTs(rec)` and `...recTs(rec)` at the five entry sites.

- [ ] **Step 3: Run the test**

Run: `npx vitest run pkg/remotemode/web/projectors.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 4: Run Verify**

Run: `node scripts/verify.mjs ./pkg/agentask` (with `ARC_VERIFY_CHANGED` unset, so the full frontend suite runs).
Expected: exit 0, 0 failed tests.

- [ ] **Step 5: Commit**

```bash
git add pkg/remotemode/web/static/projectors.js
git commit -m "chore(remote): regenerate projector bundle for transcript ts"
```
