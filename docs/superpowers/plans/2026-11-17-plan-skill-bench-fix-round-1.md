# Fix round 1: the stale phone-page projectors bundle

**Effort:** effort:25e5eb18-863e-4e80-b585-60124822822b
**Spec:** `docs/superpowers/specs/2026-11-16-slim-superpowers-design.md`
**Verify:** `node scripts/verify.mjs ./cmd/...`

Verify on the merged result 4b43df2 failed one test: `pkg/remotemode/web/projectors.test.js > the committed bundle
is current`. The failure is on the base, not from this run's tasks. Main's d0c246462 ("background task notices")
added `isSubagentFinish` to `frontend/app/view/agents/transcriptprojection.ts`, but the generated
`pkg/remotemode/web/static/projectors.js` was not regenerated. None of this run's tasks touch either file.

Decision (lead): regenerate the bundle from its single source with the existing generator. The test is right and
stays as it is.

### Task 1: Regenerate the phone page's generated assets
**Files:** `pkg/remotemode/web/static/projectors.js`, `pkg/remotemode/web/static/markdown.js`

**What to build:** run `node scripts/sync-remote-web.mjs` from the tree root and commit what it changes in the two bundles above
(the generator also rewrites tokens.css, the fonts and the icon; leave those out unless their content truly changed). Never hand-edit a generated file. If the generator rewrites a file with only line-ending
or no content difference, leave that file out of the commit. Do not change the test or any source under `frontend/`.

**Acceptance:**
- `npx vitest run pkg/remotemode/web/projectors.test.js` passes, including "the committed bundle is current".
- `npx vitest run pkg/remotemode/web` passes.
- The diff touches only files under `pkg/remotemode/web/static/`.
