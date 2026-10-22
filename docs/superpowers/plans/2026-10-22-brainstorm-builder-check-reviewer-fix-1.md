# Brainstorm builder check: final-stage fix round 1

Date: 2026-10-22. Fixes the final stage of run 2678342f, which failed before any scenario ran.

**Spec:** `docs/superpowers/specs/2026-10-22-brainstorm-builder-check-reviewer-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/jarvis ./pkg/waveobj ./pkg/wshrpc/... ./pkg/brainstormcheck/... ./cmd/...`
**Check:** `go build ./... && go vet ./pkg/orchestrate ./pkg/jarvis ./pkg/waveobj ./pkg/wshrpc/... ./pkg/brainstormcheck/... ./cmd/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brainstorm-builder-check brainstorm-builder-ask brainstorm-mode surface-smoke`

### Task 1: Final's dev app gets its own Vite dependency cache

**Depends on:** none

**Files:** `frontend/tauri/vite.config.ts`, `scripts/cdp/final-verify.mjs`, `scripts/cdp/final-verify.test.mjs`

What failed. Final's dev app booted, logged `cockpit rendered`, then threw on every load:

```
WINDOW ERROR: TypeError: Cannot read properties of null (reading 'useRef')
    at exports.useRef (.../node_modules/.vite/deps/chunk-VV4QCG7O.js?v=bf9879ec:956:35)
    at CockpitRoot (.../frontend/app/cockpit/cockpit-root.tsx:49:24)
    at ... (.../node_modules/.vite/deps/react-dom_client.js?v=8b38a1c1:18509:20)
```

so the nav never rendered and every scenario failed with `nav button "Agent" not found`. The two `?v=` hashes in
one page load mean React and react-dom came from two different Vite dependency optimizations: two copies of React.
The cause is the shared cache. `vite.config.ts` sets no `cacheDir`, so Vite uses `<repo>/node_modules/.vite`, and a
worktree's `node_modules` is a junction to the main checkout's. Every dev app on the machine (the human's main dev
app, other worktrees, other runs' Final slots) writes the same `node_modules/.vite/deps`, and one re-optimizing
mid-boot swaps the chunks under another. After the stage, `_metadata.json` there carried a third browserHash,
`b96cd787`. This run adds no third-party import, so its own diff did not trigger the re-optimization.

Do:

- `frontend/tauri/vite.config.ts`: set `cacheDir` from an env var (name it, for example `ARC_VITE_CACHE_DIR`), and
  leave it unset when the var is absent, so `task dev` in the main checkout keeps today's cache. Add a one-line
  "why" comment.
- `scripts/cdp/final-verify.mjs`: pass that var in the dev app's `env`, pointing at a per-slot directory built with
  the existing `slotPath(...)` helper (like `CARGO_TARGET_DIR`), so each slot reuses its own warm cache and never
  shares one with another dev app. A slot already holds a lock, so one dev app uses it at a time.
- `scripts/cdp/final-verify.test.mjs`: add a test, in that file's existing style, that the dev app's env names a
  per-slot Vite cache dir distinct per slot and not under `node_modules`. If the env is built inline in the spawn
  call, extract the smallest pure helper needed to test it.

Done when: the new test fails without the change and passes with it
(`npx vitest run scripts/cdp/final-verify.test.mjs`); `npx eslint` on the three files reports nothing new; and
`node scripts/cdp/final-verify.mjs surface-smoke` passes, with `dev-app.log` showing no `WINDOW ERROR`, and the
dev app's Vite cache in the slot directory instead of `node_modules/.vite`. Do not run prettier on `scripts/*.mjs`.
