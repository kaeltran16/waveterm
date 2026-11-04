# Verifying UI in the live dev app (CDP)

There is no jsdom/render-test harness for the cockpit: rendered UI is verified by screenshotting the
**live dev app** over the Chrome DevTools Protocol. Tauri renders through WebView2 (Chromium/Edge on
Windows), which speaks CDP.

## Attaching

- **Enable:** `src-tauri/src/main.rs` sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`,
  gated by `#[cfg(debug_assertions)]` (compiled out of `cargo tauri build`, so it never ships).
- **Capture:** `node scripts/cdp-shot.mjs [out.png] [port]` discovers the page target (port defaults to
  `9222`; it ignores `CDP_PORT`) and writes a PNG (the page is the Vite app inside WebView2,
  `http://localhost:5174/`). The same attach pattern drives full CDP (`Runtime.evaluate` to read the DOM /
  jotai atoms, `Input.dispatchKeyEvent` for keys). `claude-in-chrome` MCP can't attach (it needs Chrome and
  its extension); use raw CDP.
- **Two page targets share the port:** the cockpit and the hidden `attention-popup` window's `popup.html`,
  on the same origin. `attach` and `cdp-shot.mjs` never pick the popup as the main page; a scenario reaches
  it with `h.page("popup.html")`, which returns `ev`, `cdp`, `shot` and `close` for that target and records
  its shots with the run's. The popup's card can sit in the DOM of a hidden webview, so read
  `plugin:window|is_visible` on the popup's target to tell whether it is showing.

## Scenarios

`task verify:ui -- <name...>` (`scripts/cdp/verify.mjs`) runs each scenario listed in
`scripts/cdp/scenarios.mjs` as arrange → goto → shot → assert → teardown, prints a PASS/FAIL table, writes a
contact sheet to `cdp-shots/index.html`, and exits nonzero on failure. With no names it runs every scenario.
Prefer it over ad-hoc `cdp-shot.mjs` when a repeatable check exists; shared attach logic is in
`scripts/cdp/attach.mjs`.

- A scenario lives in its area's `scripts/cdp/scenarios-<area>.mjs` (Diff, Code, Agent, runs, palette, and
  so on), with helpers two areas use in `scenarios-shared.mjs`. Add a new one there and list it in
  `SCENARIOS`, never back into `scenarios.mjs` itself.
- A scenario that needs a run with a DAG follows `docs/reference/cdp-run-fixtures.md`: the arrange, seed and
  teardown helpers already exist in `scenarios-shared.mjs`.
- For a populated cockpit, inject test data first: `node scripts/inject-live-agents.mjs <scenario>` (see
  that script's header).
- **Scope element queries to a `data-*` container.** A document-wide `querySelectorAll('button')` filtered
  on `.font-mono` matches the app bar's global search button first (it has a `.font-mono` child), which
  opens the command palette instead of the row. Anchor on the owning container (e.g.
  `[data-code-project-picker]`), exclude the trigger, and record the selection as its own `steps.push(...)`
  so a miss is one clear FAIL rather than a cascade.

## Traps

- **An ad-hoc probe pins its own viewport.** `verify.mjs` sets 1600x950 (`VERIFY_VIEWPORT`) and clears the
  override when it ends, so the next probe sees the real dev window (~1000x700), where columns can collapse
  to icon-only marks and by-name clicks silently find nothing. Call `Emulation.setDeviceMetricsOverride`
  with `{width: 1600, height: 950, deviceScaleFactor: 1, mobile: false}` before selecting by name, clear it
  in a `finally`, and check `window.innerWidth` first when a by-name click unexpectedly misses.
- **Reload after moving frontend modules.** `git mv` of FE modules under a running `task dev` blanks the
  page with no Vite error overlay (`window.TabRpcClient` undefined, no nav buttons), so `task verify:ui`
  fails with `nav button "Cockpit" not found` / `reading 'wshRpcCall'`, which is not a code bug. Evaluate
  `location.reload()` over CDP, wait ~6s, re-probe, then re-run.

## A second dev app beside the main one

A worktree's dev app run beside the main checkout's needs its own everything:

- CDP port and WebView2 profile (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"`,
  `WEBVIEW2_USER_DATA_FOLDER`);
- Vite port (`task dev -- --config <json>` setting `build.devUrl` and a `beforeDevCommand` with
  `--port N --strictPort`);
- store (`ARC_DEV_DATA_DIR`, a short path: wavesrv binds `data\wave.sock` under it, and Windows caps a unix
  socket path at 108 bytes);
- its own `CARGO_TARGET_DIR` and `dist/bin` instead of the junctions, which a build writes through into the
  main checkout;
- `ARC_DEV_NO_GLOBAL_INSTALL=1`, which keeps it from installing its hooks and `~/.arc/bin/wsh` over yours.

`scripts/cdp/final-verify.mjs` does all of it; then `CDP_PORT=<port> task verify:ui`.
