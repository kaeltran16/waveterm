# Fix round 1: agent workers (orphan answers, worktree Done mark, stopped card)

The final stage failed on 4524410: Verify's vitest pass failed `pkg/remotemode/web/projectors.test.js > the committed
bundle is current`. The tracked `pkg/remotemode/web/static/projectors.js` predates its source's `thoughtOf` (assistant
thinking projected as a `thought` entry), so it is stale on the base; no task of this run caused it, and it holds the
land all the same. Task 2 closes a gap a worker reported: the palette's Needs you row for a `worker-orphan` opens
nothing.

### Task 1: Regenerate the committed phone projectors bundle
**Depends on:** none
**Files:** `pkg/remotemode/web/static/projectors.js`

Run the generator (`node scripts/sync-remote-web.mjs`, the `Taskfile.yml` step that owns the phone page's generated
assets) and commit only the generated files it changes; never hand-edit the bundle. If another generated asset it
writes also changes, it is stale the same way: commit it too and say so in the report.

Acceptance:
- `npx vitest run pkg/remotemode/web/projectors.test.js` passes.
- A second run of the generator leaves the tree clean.

### Task 2: The palette's Needs you row opens an orphaned worker's tab
**Depends on:** none
**Files:** `frontend/app/cockpit/palette-needs.ts`, `frontend/app/cockpit/palette-needs.test.ts`

`needsTarget` knows run, channel, dag and workflow-scan targets, so a `worker-orphan` row (no channel, ORef
`tab:<tabId>`) returns null and Enter says "Nothing to open from here". Give it an `open` target on its item's ORef,
parsed with `parseAddress` like the workflow-scan branch.

Acceptance:
- `needsTarget` of a `worker-orphan` row whose item ORef is `tab:<id>` returns an `open` target for that tab; the case
  joins the function's existing test table if it has one.
- A `worker-orphan` row with no ORef still returns null.
