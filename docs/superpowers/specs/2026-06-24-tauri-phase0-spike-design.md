# Tauri Migration — Phase 0 Spike Spec (Tracer Bullet)

> Captured 2026-06-24. The first phase sub-spec under
> [`tauri-migration-meta-spec.md`](../../tauri-migration-meta-spec.md). The meta spec defines
> the runtime port at large; this defines the **tracer bullet** that exposes its biggest
> unknown first. Per the meta spec §12, each phase is `writing-plans → executing-plans`;
> this spec is the input to the Phase 0 plan.

## 1. Goal

A standalone Tauri window in which **Rust spawns the unchanged `wavesrv`**, hands the
frontend the websocket endpoint + authkey via a `get_init` command, and a **bare xterm.js
terminal runs a real PTY over the unchanged `wshrpc` websocket**. One spike, three proofs:

1. The sidecar **boot handshake** (spawn → parse `WAVESRV-ESTART` → `get_init` → connect).
2. The **authkey transport** over the websocket on WebView2 (no Electron session injection).
3. **xterm + WebGL in WebView2** behaves as it does in Electron's Chromium.

Phase 0 is the critical path (meta spec §8): it is front-loaded so the largest remaining
risk is observed on real hardware before any further phase begins.

## 2. Scope

**In scope:** the runtime seam and a minimal terminal harness, additive to the tree.
**Out of scope:** the native bridge (Phase 1), window chrome (Phase 2), net-new native
(Phase 3), packaging/bundling/updater (Phase 4), and frontend teardown (Phase 5). The
existing Electron app stays fully working in parallel — nothing in `emain/` is touched.

### 2.1 Render scope — minimal harness (decision P0-1)

The webview loads a **standalone harness**, not the real Terminal component and not the
full cockpit SPA. The risky seam is identical regardless of the UI on top of it, so the
harness exercises the exact production transport (`wshrpc`-over-websocket, meta spec T5)
while reusing none of the terminal's React/block/jotai coupling. Reusing the real Terminal
component would drag `getApi()`/preload stubbing — *Phase 1's job* — into the spike;
booting the full SPA would make a failure ambiguous between the seam and incidental
frontend coupling. A tracer bullet must fail loudly and unambiguously.

## 3. Layout (all additive)

```
src-tauri/                 Rust shell
  tauri.conf.json          devUrl → harness vite server; beforeDevCommand
  src/main.rs              spawn wavesrv, read stderr, capture endpoints/authkey/version
  src/init.rs              #[command] get_init() -> InitData
frontend/tauri/            the harness SPA (new, isolated)
  index.html               single mount point
  main.tsx                 invoke get_init → wire WSControl → mount <TerminalHarness/>
  terminal-harness.tsx     bare xterm.js + WebGL addon + shellproc byte pump
  vite.config.ts           reuses @/* → frontend/* alias; serves the harness
```

`wavesrv` binary: **reuse the dev-built `dist/bin/wavesrv.x64.exe`** (produced by
`task build:backend:quickdev:windows`), spawned by absolute path. Proper Tauri sidecar
*bundling* is a Phase 4 packaging concern; Phase 0 packages nothing.

## 4. The boot handshake (Rust mirrors `runWaveSrv`)

A near-line-by-line port of `emain/emain-wavesrv.ts:101-137` into Rust:

```
main.rs:
  authkey = uuid()                       // Rust-side, replaces emain/authkey.ts (AuthKey)
  spawn wavesrv with env {
    WAVETERM_AUTH_KEY = authkey,
    WAVETERM_DATA_HOME, WAVETERM_CONFIG_HOME,
    <app-path vars as today>
  }
  read child STDERR line-by-line:        // ESTART is on stderr, not stdout
     /WAVESRV-ESTART ws:(…) web:(…) version:(…) buildtime:(\d+)/ → store {ws, web, version, buildtime}
     skip "WAVESRV-EVENT:" lines          // same stream carries event JSON; reader must not choke
  on child exit → quit the window

#[command] get_init() -> { wsEndpoint, webEndpoint, authKey, version, buildTime }
```

The frontend then builds the websocket URL from `wsEndpoint`, passes `authKey` through the
existing `ElectronOverrideOpts` path, and the unchanged client connects.

**Most likely silent failure:** reading stdout instead of stderr, or panicking on a
`WAVESRV-EVENT:` line. The plan builds and runs *this* first, before any terminal wiring.

## 5. The authkey transport (decision P0-2 — flagged bend to meta spec T5)

A browser `WebSocket` cannot set the `X-AuthKey` header from JS (`wsutil.ts:19-25` drops
the headers in the browser branch); Electron only works because it injects that header at
the session layer (`emain/authkey.ts` `configureAuthKeyRequestInjection`). WebView2 has no
reliable equivalent for WebSocket upgrade requests. Resolution — **query-param fallback**:

- **Go (`pkg/authkey/authkey.go`):** `ValidateIncomingRequest` gains a fallback — when the
  `X-AuthKey` header is empty, read `r.URL.Query().Get("authkey")`. ~3 lines, **additive**;
  the existing header path is unchanged and still preferred.
- **Frontend (`frontend/app/store/ws.ts`):** when `eoOpts.authKey` is set, append
  `&authkey=<key>` to the ws URL (today that authKey is passed as a header the browser
  silently drops). One line on the *existing* client.

This makes the meta spec's "the existing websocket client connects unchanged" literally
true, and lets Phase 0 prove the **real** auth path rather than a disabled one.

**Override flagged:** meta spec **T5** ("backend & transport untouched") becomes
"untouched *except* a minimal, additive query-param auth fallback." Forward-useful for any
non-Electron client; not silent.

Rejected alternatives: replicating header injection via the WebView2 `WebResourceRequested`
COM API (unreliable/undocumented for WS upgrades — *adds* an unknown to a spike meant to
*remove* them); disabling auth for the spike (proves less; punts the question).

## 6. The terminal path

The harness uses the **real** `frontend/app/store` websocket + `wshrpc` client to open a
shellproc PTY and pump bytes ⇄ xterm.js, with the **WebGL addon active** to verify §9's one
residual xterm risk (WebGL-in-WebView2). Pinning the exact shellproc RPC and the byte/resize
protocol is the plan's first and riskiest task.

**Coupling risk to discover empirically:** the real ws/`wshrpc` client has transitive
imports that may call `getApi()` (the Electron preload) for logging/platform/identity. The
harness will need a **minimal `window.api` shim** covering only what the *connect +
shellproc* path actually reaches — a bounded preview of Phase 1's bridge. The plan discovers
the reached-set by running it and stubs nothing more.

## 7. Dev loop & Tauri version

- `task build:backend:quickdev:windows` (produces `dist/bin/wavesrv.x64.exe`) →
  `cargo tauri dev` → window opens, harness vite server serves the page, Rust spawns the
  sidecar and the terminal connects.
- **Pin Tauri to the latest stable 2.x** at scaffold time; record the exact pinned version
  in the plan (resolves meta spec §10 "Tauri version").

## 8. Success criteria (the §12 verification gate)

Phase 0 is **done** when, observed on the Windows dev machine:

1. `cargo tauri dev` opens a window containing a terminal.
2. Typing `dir` (or `ls`) shows real PTY output streamed from `wavesrv`.
3. The websocket handshake authenticated via the **query-param** path with the header
   absent — confirmed in the `wavesrv` log.
4. xterm's **WebGL renderer is active** (not the DOM/canvas fallback) — confirmed via the
   addon's context check / absence of a fallback warning.
5. Resizing the window reflows the PTY correctly (cols/rows propagate to the backend).

## 9. Risks

- **Shellproc wiring** (the §6 unknown) — most likely place for surprise; built first.
- **`getApi()` transitive reach** (§6) — bounded by "stub only what the connect path hits."
- **WebGL fallback** — low (WebView2 is Chromium, §9), but explicitly gated by criterion 4.
- **stderr parse** (§4) — low once written, high cost if wrong; built and run first.

## 10. Decision log

- **P0-1 — Render scope:** minimal standalone harness (not the real Terminal component, not
  the full SPA). *Proves 100% of the seam risk with ~10% of the surface; keeps Phase 1's
  bridge work out of the spike.*
- **P0-2 — Authkey transport:** query-param fallback (additive Go change + one-line ws URL
  tweak). *Overrides meta spec T5 minimally and explicitly; proves the real auth path.*
- **P0-3 — wavesrv source:** reuse the dev-built `wavesrv.x64.exe`, spawn by path; defer
  sidecar bundling to Phase 4.
- **P0-4 — Tauri version:** pin latest stable 2.x at scaffold time; exact version recorded
  in the plan.
- **P0-5 — Electron untouched:** the spike is purely additive; teardown is Phase 5.

## 11. Next step

`writing-plans` → [`../plans/2026-06-24-tauri-phase0-spike.md`](../plans/2026-06-24-tauri-phase0-spike.md),
then `executing-plans` on the Windows dev app.

## 12. Phase 0 result (2026-06-24 — PASSED)

All five §8 criteria verified on the Windows dev machine: window + terminal, real PTY
output (`dir`), query-param auth (header absent), WebGL renderer active, resize reflow.

- **Tauri version (closes meta spec §10):** pinned `tauri-cli 2.11.3` (latest stable 2.x via
  `^2.0`); `tauri`/`tauri-build` crates `"2"`.
- **Toolchain prerequisite (new):** the dev machine had only the Rust **GNU** toolchain,
  whose bundled MinGW `ld` cannot link the Tauri crates. Required installing **VS 2022 Build
  Tools (Desktop C++)** + `rustup default stable-x86_64-pc-windows-msvc`. Tauri-on-Windows is
  MSVC-only; this is a hard setup step for any machine building this.
- **tabid source:** `RpcApi.WorkspaceListCommand(client)[0].workspacedata.activetabid`. A
  fresh wavesrv data dir bootstraps a starter workspace + active tab via
  `wcore.EnsureInitialData()`, which **wavesrv itself** runs at startup
  (`cmd/server/main-server.go:538`) — no Electron layer needed.
- **getApi() reached-set (the §6 unknown — small):** the connect+terminal path needed only
  `getApi().getEnv()` (fed the endpoints from `get_init`). A `harness_log` Tauri command was
  added to bridge the harness console to the Rust stdout (WebView2 console isn't observable in
  the dev loop) — this, not broad preload stubbing, is what made the seam debuggable.
- **Minimal-harness validated, with a key Phase-1 finding:** the real `TabRpcClient` /
  `@/app/store/wshrpcutil` couple to `@/store/global` (the whole app graph) **only** via
  `tabrpcclient.ts`. The base `WshClient` + `initElectronWshrpc` (imported from
  `wshrpcutil-base`) + `wps`/`wshclientapi`/`ws`/`wshrouter` are all global-free. The harness
  drove a bare `WshClient` directly and proved the full seam with **zero** global coupling —
  so Phase 1's bridge can treat the wshrpc transport as cleanly separable from the global store.
- **WPS file pump:** `getFileSubject` is only a local rxjs subject; data flow requires the
  `"blockfile"` WPS subscription (replicated from `global.ts:84-93`) plus the router's
  `eventrecv → handleWaveEvent` dispatch (`wshrouter.ts:91`) — both available without global.
- **WebGL:** active in WebView2, no fallback. The one residual xterm risk (§9) is closed.
- **Plan vs reality — build-observe-fix corrections (all minor, none invalidated the design):**
  dropped the mobile-template `[lib]` from `Cargo.toml` (desktop-only binary crate);
  `tauri-build` requires `src-tauri/icons/icon.ico` on Windows (reused `build/icon.ico`);
  the spawned binary's cwd is `src-tauri/`, so resolve wavesrv via `env!("CARGO_MANIFEST_DIR")`
  + `../dist/bin/...`; wavesrv **hard-requires** `WAVETERM_DATA_HOME`/`WAVETERM_CONFIG_HOME`
  (no defaults) — pointed at an isolated `%TEMP%\wave-tauri-spike` so the spike can't touch the
  real app's data dir; wavesrv stdout must be `inherit` (unread pipe deadlocks it);
  `InitState` needs `Arc<Mutex<…>>` and `InitData` needs `#[derive(Debug)]`; `CreateBlock`
  returns an `ORef` **string** (`"block:<id>"`), not an object; the harness vite config needs
  the granular `@/*` aliases hard-coded (`vite-tsconfig-paths` was flaky on HMR re-transform).
