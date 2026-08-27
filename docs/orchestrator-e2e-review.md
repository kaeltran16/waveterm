# Orchestrator e2e — review (CDP user-driven, real dispatch)

Date: 2026-08-27 · Capture: `scripts/cdp/orchestrator-e2e.mjs` (CDP 1440×900, :9222) · Channel `#orchestrator-e2e-40739` (latest) · Run goal "Scaffold a tiny orchestrator demo: 3 dependent tasks…"

This is the honest delta between what the capture *claims* ("end-to-end, real dispatch") and what the frames actually prove. Every item below is observable in `cdp-shots/orchestrator-e2e/*.png` + `docs/orchestrator-e2e.md` as of the last run (15/15 steps ok, but no TaskGroup in frame).

## Blocking — the "end-to-end" claim is not fully proven

- [ ] **Live DAG not in frame.** Shots `12-live-dag-open.png` / `13-dispatch.png` show no `TaskGroup` — note is `lead still decomposing (no TaskGroup yet)`. Dispatch is real (deferred `Run` in `wstore`, lead worker `pi / gpt-5.3-codex-spark` running), but the proof the reader expects — ReactFlow nodes with `data-dag-node-route`, 1–8 `TaskNode` cards, per-task workers — is absent. Wait in 13 was ~15s (10×1500ms); a mid-tier `JarvisPlanDag` call can take 30–60s, or fall back instantly — we stopped polling before either landed.
  - *Fix:* extend 13 to poll `querySelectorAll('[data-dag-node-route]').length` + `getchannels` for `TaskGroup` up to 60s, re-shoot 12/13 when it appears; if fallback lands, capture the one-task draft and label it `Fallback=true`.

- [ ] **Contradictory captions for draft vs live.** 10 says "draft review visible (feature branch)" while 11 says "no draft modal on this build (main), graph present=false". Both match `document.body.innerText` probes that also hit the Graph peek fixture, not the `DagModal`. Reader sees two opposite notes for the same state.
  - *Fix:* replace probes with `document.querySelector('[data-dag-modal-kind]')` checks only; expected on `main` is *no* draft modal — document that as correct and point to the feature branch plan (`docs/superpowers/plans/2026-08-21-orchestrator-fast-approval.md`).

## Functional — capture is fragile / not idempotent

- [ ] **No teardown / stale fixtures left behind.** Four demo channels remain in dev `wstore`: `orchestrator-e2e-46884` (first attempt), `4995`, `71007`, `40739` (latest). `scripts/cdp/scenarios.mjs: runs-lifecycle` does `deleteChannel` + `deleteblock` + `rmSync(tmpdir)`; this script does none. Re-running creates a new channel each time (channel name is `Date.now()%100000`); subjects column accumulates.
  - *Fix:* add `teardown` that `deleteChannel` for the demo channel (gate behind `KEEP=1 env`), and clean the three older channels now.

- [ ] **Project picker selector is position-based and header-leaky.** Step 03 originally picked `All projects▾` (header) because filter was `r.x > 300` + `t !== '+ Channel'`. Fix now prefers exact `waveterm` but falls back to `btns[0]` still filtered only by `r.x`. A project named `rw-test-checkpoint` or a narrow layout (jarvislayout.ts collapses subjects <1034px) breaks it.
  - *Fix:* scope to `[data-jarvis-region="subjects"]` pane, filter `!t.includes('All projects') && !t.includes('SWITCH PROJECT') && !t.includes('New project')`, enumerate candidates and log them on failure.

- [ ] **Route selection is first-available, not deterministic.** Step 05 clicks the first `[data-testid^="route-option-"]` that is `offsetParent !== null` — on this machine that's `pi-openai-codex/gpt-5.3-codex-spark`. On another dev box with different harnesses it picks a different model, so the capture is not reproducible and the caption leaks the internal test id.
  - *Fix:* prefer `pi` + `cheap` tier when available, else first `installed` with `supportsOperation(run-worker)`, and caption as `route: pi · gpt-5.3-codex-spark` without the test id.

- [ ] **Submission detection uses global `document.body.innerText`.** Step 07 polls `/Arc.*All projects.*Global.*Search agents/` (the top bar) and reports it as `body head`. It never actually asserts that a run row appeared. Step 08 re-probes correctly but would have been missed if 07 had failed.
  - *Fix:* make 07's success condition the run row itself (`ch.nextElementSibling` list contains the goal prefix), not body text.

## Polish — docs read as debug logs

- [ ] **Debug ids in user-facing prose.** 05 caption `route picked: route-option-pi-openai-codex/...` is a test id. 07's note dumps the whole top bar.
  - *Fix:* map to `modelFace(route)` (`harness.label + ' · ' + model`) and drop raw body dumps.

- [ ] **No contact sheet / no failure gate.** `verify.mjs` writes `cdp-shots/index.html` via `contactSheetHtml` and exits via `exitCode(results)`. This script always exits 0 when `15/15 ok`, even though no `TaskGroup` was seen. There is no `cdp-shots/orchestrator-e2e/index.html`.
  - *Fix:* generate `cdp-shots/orchestrator-e2e/index.html` and make exit code reflect whether a `TaskGroup` was observed, not just step count.

- [ ] **Not linked / not discoverable.** `docs/orchestrator-e2e.md` is not referenced from `docs/jarvis-tour.md` or `docs/README.md`, and the polished `docs/orchestrator-e2e.md` (124 lines) diverges from the auto `cdp-shots/orchestrator-e2e/README.md` — the latter still had the pre-polish notes until the last `sed` sync.
  - *Fix:* add one line to `docs/jarvis-tour.md` ("For the orchestrator dispatch path, see `orchestrator-e2e.md`") and keep the two markdowns in sync via the `sed` step already in the driver (or make the driver write both from one template).

- [ ] **Viewport not restored on failure.** `attach.mjs` pattern is `Emulation.setDeviceMetricsOverride(VERIFY_VIEWPORT)` at start + `clearDeviceMetricsOverride` at end. This driver sets 1440×900 but only clears on success; a thrown `attach` or early exit leaves the dev window zoomed.
  - *Fix:* `try/finally` around the whole tour for `clearDeviceMetricsOverride`.

## What to do next (ordered)

1. Re-shoot with the longer TaskGroup poll and capture the live DAG when it lands (validates the whole "real dispatch" claim).
2. Swap the probe for `[data-dag-modal-kind]`-only and rewrite captions to human text.
3. Add teardown (and clean the four stale `orchestrator-e2e-*` channels).
4. Generate the contact sheet and gate exit code on TaskGroup presence.
5. Link from `jarvis-tour.md` and keep the two markdowns in sync.

---
*Source: `scripts/cdp/orchestrator-e2e.mjs` (user-driven CDP, no RPC for channel/run), `cdp-shots/orchestrator-e2e/*.png` (15 frames), `docs/orchestrator-e2e.md` (polished, 124 lines). Reproduce: `task dev` + `node scripts/cdp/orchestrator-e2e.mjs`.*
