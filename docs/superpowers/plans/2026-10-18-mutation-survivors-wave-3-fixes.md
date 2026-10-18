# Mutation survivors, wave 3 of 5: fix round

The wave's tasks left six test files that were prettier-clean at the base (`3d7ebd9d5`) failing `prettier --check`:
lines over the width limit in the tests they added.

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`

### Task 1: Restore prettier-clean formatting on the six test files the wave made dirty

**Depends on:** none
**Files:** `frontend/app/view/agents/leadcardmodel.test.ts`, `frontend/app/view/agents/opencodetranscriptprojection.test.ts`, `frontend/app/view/agents/projectlabel.test.ts`, `frontend/app/view/agents/radarstoreload.test.ts`, `frontend/app/view/agents/runrail.test.ts`, `frontend/app/view/agents/runusage.test.ts`

Run `npx prettier --write` on exactly these six files, never on a directory or the tree, and touch no other file.
Other test files in `frontend/app/view/agents` also fail `prettier --check` but were already dirty at the base; leave them.

Acceptance:
- `npx prettier --check` on the six files passes.
- `git diff` changes only whitespace and line breaks in the six files: no assertion, test name or value changes.
- `npx vitest run` on the six files passes, with the same test count as before the change.
