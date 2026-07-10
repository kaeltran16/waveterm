# Design — Automated CDP verification harness

**One line:** Consolidate the handful of one-off CDP scripts into a single
`node scripts/cdp/verify.mjs` runner that arranges known state, screenshots each
surface, asserts against backend RPC state and the rendered DOM, and exits
nonzero on failure — so "verify before done" is one repeatable command instead
of an ad-hoc manual step that gets skipped under velocity.

Status: design. Non-trivial scope → a separate implementation plan follows
(writing-plans). This spec folds into the implementing commit per repo
convention; it is not committed on its own.

---

## Problem

Features keep shipping "CDP-unverified." The memory log is full of it
(channels real-world fixes, the cockpit UX batch, ask-in-place, the hints
gate, the runs gate itself). The root cause is not laziness — it is that
verification is **manual and ad-hoc**: each check is a hand-written CDP script,
so under delivery pressure the step is skipped and regressions land silently.
There is also no jsdom/render harness for the cockpit (a deliberate stance in
CLAUDE.md — verify via CDP screenshots of the live dev app), so CDP is the
*only* mechanism available.

The mechanism already works and is duplicated five-plus times. Every one of
`scripts/cdp-shot.mjs`, `cdp-e2e-runs.mjs`, `cdp-e2e.mjs`, `cdp-test-channels.mjs`,
`cdp-goto-channels.mjs`, `cdp-profile-verify.mjs` re-implements the *same*
`pickTarget` (`/json/list`) + `cdp(wsUrl)` websocket wrapper, then diverges only
in what it arranges and asserts. So the transport is not a new capability to
build — it is an overdue extraction.

Every primitive the harness needs is already proven in those scripts:
- **Attach + evaluate:** `cdp-shot.mjs` / `cdp-e2e-runs.mjs` — open the Vite
  page target's `webSocketDebuggerUrl`, speak CDP 1.3 over it.
- **Read/act on the live app:** `cdp-e2e-runs.mjs` calls real backend RPCs via
  `window.TabRpcClient.wshRpcCall` and reads results — this is arrange + assert.
- **Screenshot:** `cdp-shot.mjs` — `Page.captureScreenshot` → PNG.
- **Switch surface without reload:** `cdp-goto-channels.mjs` — clicks the nav
  button, settles, shoots. (`Page.reload` breaks Tauri boot — a known gotcha.)
- **Safe teardown of a real run:** `cdp-e2e-runs.mjs` — isolated temp cwd as the
  worker cwd, delete worker blocks (kills claude in ~1s), delete the channel.

## Approach (chosen: A — spine + exemplars, grow organically)

Extract the shared transport, add a declarative scenario manifest and a runner,
and prove the pattern with **two exemplars** (one behavioral, one visual).
Coverage then grows one scenario at a time as features are built.

Rejected alternatives:

- **B — broad coverage now** (author scenarios for all ~8 surfaces + convert all
  five one-offs up front). Violates YAGNI: the right manifest shape is learned by
  converting two or three real scenarios, not front-loaded across eight; and a
  large diff is harder to review, which *lowers* hardening confidence. Coverage
  is added incrementally on top of A with no rework.
- **C — shared client only** (extract `cdp()`/`pickTarget` into one module the
  existing scripts import; no runner, no manifest). Stops the copy-paste but
  delivers **no green/red gate** — a human still eyeballs, which is the manual
  step that gets skipped. It is a *prerequisite of* A, not an alternative to it.
- **D — visual-first contact sheet** (emphasize a screenshot grid; asserts
  secondary). Misses the stated pain: a screenshot grid still needs a human to
  *notice* a regression. Screenshots are a byproduct; behavioral atom/DOM asserts
  are the actual gate.

A is the only option that (1) delivers the one-command green/red outcome,
(2) fits the documented CDP-only stance instead of fighting it, and (3) is
mostly *consolidation* of code that already exists across five scripts, so the
abstraction is justified by real duplication rather than speculation.

## Non-goals (v1)

Named explicitly so the plan does not drift into them:

- **No pixel-diff baselines.** The UI is motion-heavy (a whole motion system);
  pixel baselines would be flaky unless motion is frozen for capture. Screenshots
  are for human review; **behavioral atom/DOM asserts are the regression gate.**
- **No jsdom / component isolation.** That is option #2 and a separate decision.
  This harness's ceiling is *assembled-app integration* — it cannot catch a
  component broken in isolation, only the running app misbehaving.
- **No jotai atom-read asserts.** `globalStore` and the agents view-model are
  **not** exposed on `window` (boot-core exposes only `globalAtoms`, `globalWS`,
  `TabRpcClient`). v1 asserts via backend RPC state and the rendered DOM — both
  reachable today with no app change. Reading atom values would need a one-line
  dev-only `window.globalStore` exposure; deferred as a clean future enhancement.
- **No CI wiring.** It needs a live dev app + WebView2 on `:9222`; it is a
  local, on-demand command for now.
- **No broad surface coverage.** Two exemplars; more scenarios added later.
- **No migration of the other one-off scripts** as a big move. `attach.mjs` is
  drop-in; the remaining scripts adopt it opportunistically when next touched.

## Design

**Where it lives.** A new `scripts/cdp/` directory holding three modules, plus a
`task verify:ui` wrapper. PNGs and the contact sheet write to the gitignored
`cdp-shots/` dir (already the convention in `cdp-shot.mjs`).

### 1. `scripts/cdp/attach.mjs` — shared transport

The extraction of the duplicated transport. `attach(port = 9222)` picks the Vite
page target, opens its websocket, enables `Runtime`/`Page`, and returns a handle:

| Method | CDP call / source pattern | Purpose |
|---|---|---|
| `h.ev(expr)` | `Runtime.evaluate` (returnByValue + awaitPromise, exception-unwrapped as in `cdp-e2e-runs.mjs`) | run JS inside the live app; read the DOM |
| `h.rpc(command, data)` | `h.ev("window.TabRpcClient.wshRpcCall(...)")` | call a real backend RPC (arrange + assert) |
| `h.shot(path)` | `Page.captureScreenshot` → PNG (from `cdp-shot.mjs`); records the path in `h.shots` for the contact sheet | visual capture |
| `h.goto(surface)` | click the nav-rail button by label (proven by `cdp-goto-channels.mjs`) | switch surface **without `Page.reload`** |
| `h.activeSurfaceLabel()` | read the active nav button's label (`text-accent-soft`) from the DOM | assert navigation landed |
| `h.close()` | close socket | cleanup |

`attach` exits with a clear message if no page target is found on the port
(dev app not running with the debug flag) — the single most common failure.

### 2. `scripts/cdp/scenarios.mjs` — the manifest

An array of declarative entries:

```js
{
  name: "runs-lifecycle",          // stable id; also the PNG basename
  surface: "channels",             // argument to h.goto()
  async arrange(h) { /* build state via h.rpc(...); return ctx for teardown */ },
  async assert(h, ctx) { /* return [{ step, ok, detail }] */ },
  async teardown(h, ctx) { /* always runs; delete blocks/channels */ },
}
```

`assert` returns the existing `{ step, ok, detail }` shape from
`cdp-e2e-runs.mjs`. `arrange` returns a context object threaded into `assert`
and `teardown` (e.g. the created channel/run ids). Data fixtures reuse the
existing `scripts/cockpit-fixtures/scenarios.mjs` `SCENARIOS` where useful.

### 3. `scripts/cdp/verify.mjs` — the runner

`node scripts/cdp/verify.mjs [name…]` (all scenarios by default; names filter).
For each scenario:

1. `ctx = await arrange(h)`
2. `await h.goto(surface)`; brief settle
3. `await h.shot("cdp-shots/<name>.png")`
4. `results = await assert(h, ctx)`
5. `await teardown(h, ctx)` — **in a `finally`**, so it runs even if arrange or
   assert throws. This guarantees no leaked worker processes or channels.

Then: print the PASS/FAIL table (the `cdp-e2e-runs.mjs` output format), write a
`cdp-shots/index.html` contact sheet linking every PNG for a quick skim, and
`process.exit(0)` iff every step of every scenario passed (nonzero otherwise, so
it composes into scripts).

**Surface navigation.** `h.goto` clicks the nav-rail button by label — the
mechanism `cdp-goto-channels.mjs` already proves — because `globalStore`/the
agents model are not exposed on `window`, so setting the surface atom directly
is not reachable without an app change. It **never** calls `Page.reload` (reload
breaks Tauri boot). `h.activeSurfaceLabel()` then reads the active button back so
a scenario can assert navigation landed.

**Arrange transport.** Standardize on **RPC-over-CDP** (`h.rpc`), as in
`cdp-e2e-runs.mjs`, rather than the `wsh` injector: the injector needs an
authenticated terminal, RPC-over-CDP does not, so it is the better automation
primitive. The `inject-live-agents.mjs` fixture path remains available for
manual use but is not the harness's arrange mechanism.

### Two exemplars (one per assertion mode)

Chosen so the manifest schema is validated against **both** modes on day one:

- **`runs-lifecycle` (behavioral).** Reparent `cdp-e2e-runs.mjs` into a manifest
  entry: `arrange` creates a channel + run in an isolated temp cwd and drives
  CreateRun → complete → gate → approve → cancel; `assert` checks phase states at
  each step; `teardown` deletes worker blocks and the channel. Proves
  RPC-arrange + behavioral-assert + safe teardown.
- **`surface-smoke` (visual + DOM).** `goto` each key surface, `shot` it, and
  `assert` the active nav label matches **and** the content region
  (`nav.nextElementSibling`) rendered non-empty text. Proves goto + screenshot +
  DOM-assert across surfaces, with no arrange needed — and catches a surface that
  blanks out on render. A *populated-roster* visual still relies on the manual
  `inject-live-agents` path (needs authenticated `wsh`), which is out of the
  harness's automation scope; noted, not silently dropped.

## Scope guard

Pure dev tooling under `scripts/` — **no** change to `frontend/`, `pkg/`, or
`src-tauri/` application code. The only seams into the app are read-only and
already present: `h.goto` clicks an existing nav button, `h.activeSurfaceLabel`
reads existing DOM, and scenarios call existing RPCs. We deliberately do **not**
expose `globalStore` in v1 (which would unlock richer atom-read asserts) to keep
this strictly tooling; that stays a documented one-line future enhancement.

## Testing

- **Unit (Vitest):** the two *pure* pieces of the runner — the PASS/FAIL
  formatter and the contact-sheet (`index.html`) assembler. Feed synthetic
  `results` arrays; assert rendered output and the derived exit code
  (all-pass → 0, any-fail → nonzero). These are the only deterministic
  contracts; keep them as pure functions, importable without attaching.
- **Integration (acceptance):** the `attach`/`ev`/`shot`/`goto` transport is
  inherently integration — it needs a live app on `:9222` and cannot be
  unit-tested. Its acceptance test is that **both exemplars pass** against a
  running dev app. This is an explicit, honest limitation, not a silent skip.

## Prerequisites & known gotchas (carried into the plan)

- Dev app must be running with the debug flag (`task dev`; the flag is dev-only
  in `main.rs`). Headless runs need `tail -f /dev/null | task dev` (stdin-EOF
  otherwise kills wavesrv).
- `Page.reload` breaks Tauri boot — the runner must never reload.
- The reporter/status fixture path needs authenticated `wsh`; the harness avoids
  it by arranging via RPC.
