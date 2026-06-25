# Tauri Migration — Phase 4 Packaging + Sidecar Spec

> Captured 2026-06-24. The fifth phase sub-spec under
> [`tauri-migration-meta-spec.md`](../../tauri-migration-meta-spec.md), following
> [`2026-06-24-tauri-phase2-chrome-design.md`](./2026-06-24-tauri-phase2-chrome-design.md).
> Covers the meta spec §8 row **"4 · Packaging + updater"**. Per meta spec §12 each phase is
> `writing-plans → executing-plans`; this spec is the input to the Phase 4 plan.
>
> **Phase 3 (net-new native) is skipped for now** — Phase 4 runs directly after Phase 2, in
> parallel with another agent's Phase 5 (frontend teardown). See §9 for the coordination seam.

## 1. Goal

Turn the Phase 0–2 **dev spike** into an **installable Windows application**: bundle the Go
`wavesrv` + `wsh` binaries into the package, switch `main.rs` off its hardcoded dev path +
temp data-home onto a packaged-binary path + a persistent per-user data home, and emit an
unsigned **NSIS** installer that installs and runs. Code-signing and the auto-updater are left
as **documented, disabled seams** (§5, §6) — they require a code-signing certificate and a
release feed this POC fork does not own (meta spec §5 "updater deferrable", §12.2 "human
bottleneck"). This is decision **P4-1** (scope = Option A).

## 2. Scope

**In scope:** bundle `wavesrv.x64.exe` + `wsh-{version}-windows.x64.exe` via Tauri
`bundle.resources` (§3, §7); dev-vs-packaged binary path resolution in Rust (§3.2); the
`WAVETERM_APP_PATH` + persistent `WAVETERM_DATA_HOME`/`WAVETERM_CONFIG_HOME` env wiring (§3.3,
§3.4); the `tauri.conf.json` bundle config + app-identity de-spike (§4); an NSIS installer
artifact; the disabled signing seam (§5); the documented (code-free) updater path (§6);
unit tests for path resolution + the install/run observe-gates (§10).

**Out of scope:** code-signing execution and any real certificate (§5 — seam only); the
updater plugin, release feed, and update-artifact signing (§6 — documented, no code); macOS /
Linux bundles (meta spec T7, Windows-only); Phase 3 net-new native (tray/notifications/
file-dialog/spawn-editor); the **frontend teardown + real-cockpit boot** (Phase 5, the other
agent); cross-architecture `wsh` binaries for remote hosts (decision P4-3). The existing
Electron app and its `electron-builder.config.cjs` are untouched and keep working in parallel.

### 2.1 Verification vehicle — the current harness (decision P4-2)

Phase 4 packages **whatever the current Tauri frontend build produces** — today the bare-xterm
+ titlebar harness (`frontend/tauri/`), *not* the production cockpit. The packaging pipeline
is content-agnostic: it bundles the sidecar + the frontend `dist` regardless of what the
frontend contains. Phase 5 repoints the build target to the real cockpit (§9); until then the
installer wrapping the harness is a *pipeline proof*, exactly as Phases 0–2 verified on the
harness. This is what lets Phase 4 and Phase 5 run in parallel.

## 3. The sidecar bundling problem (the core)

### 3.1 What ships, and the exact filenames

The Go backend discovers its sibling binaries by **filename** under `WAVETERM_APP_PATH/bin`
(`wavebase.GetWaveAppBinPath` = `WAVETERM_APP_PATH` + `"bin"`). Two binaries ship:

| Binary | Built by (Taskfile) | On-disk name | Consumer |
|---|---|---|---|
| `wavesrv` | `task build:server:windows` | `dist/bin/wavesrv.x64.exe` | spawned by `main.rs` (boot seam) |
| `wsh` | `task build:wsh` (windows/amd64) | `dist/bin/wsh-{version}-windows.x64.exe` | copied into data-home/bin by wavesrv on shell-integration init |

The `wsh` name is exact and load-bearing: `shellutil.GetLocalWshBinaryPath` normalizes
`amd64`→`x64` (`shellutil.go:339`) and builds `wsh-{version}-windows.x64.exe` — matching the
`build:wsh:internal` output `wsh-{VERSION}-{GOOS}.{NORMALIZEDARCH}{EXT}` (`Taskfile.yml:345`).
`{version}` is baked at build time (`wavebase.WaveVersion`), so the bundle config globs
`wsh-*-windows.x64.exe` rather than hardcoding the version (§4).

`wsh` failures are **non-fatal** (`shellutil.go:446,449` log and continue), so a missing wsh
degrades to "terminal works, no shell integration" rather than a crash — but we bundle it so
integration is real (decision P4-3 keeps wsh; cross-arch fleet excluded by the glob).

### 3.2 Dev-vs-packaged path resolution (decision P4-4)

`resource_dir()` resolves to the bundled-resources root in a packaged app but to the build
target dir under `tauri dev` — so we branch on dev mode rather than fight dev-resource
placement, keeping the spike's working dev path intact:

| Mode | bin dir | `WAVETERM_APP_PATH` |
|---|---|---|
| **dev** (`cfg!(debug_assertions)`) | `CARGO_MANIFEST_DIR/../dist/bin` (today's spike path) | `CARGO_MANIFEST_DIR/../dist` |
| **packaged** | `app.path().resource_dir()? + "/bin"` | `app.path().resource_dir()?` |

The resolver is a small pure function `resolve_app_path(is_dev, manifest_dir, resource_dir) ->
PathBuf` so it is unit-testable without a running app (§10). `main.rs` then spawns
`{app_path}/bin/wavesrv.x64.exe` and sets `WAVETERM_APP_PATH = {app_path}`. The packaged
layout is defined by §4's `resources` mapping: `dist/bin/*` → `{resource_dir}/bin/`, so
`{WAVETERM_APP_PATH}/bin` holds both binaries in both modes.

### 3.3 The env contract

`wavesrv` hard-requires `WAVETERM_CONFIG_HOME` + `WAVETERM_DATA_HOME` (errors if unset,
`wavebase.go:90`) and optionally reads `WAVETERM_APP_PATH`. The spike set only the two homes,
which is *why* wsh discovery silently no-ops today. Phase 4 adds the third:

```
WAVETERM_AUTH_KEY    = <uuid>                  (unchanged from spike)
WAVETERM_APP_PATH    = <app_path>              (NEW — enables wsh discovery, §3.2)
WAVETERM_DATA_HOME   = <data_home>/data        (NEW location, §3.4)
WAVETERM_CONFIG_HOME = <data_home>/config      (NEW location, §3.4)
```

This mirrors Electron's `emain-wavesrv.ts:67` (`WAVETERM_APP_PATH = getElectronAppUnpackedBasePath()`)
— the var is a **backend input contract** (consumed by the untouched Go side per meta spec
T5), not Electron-specific machinery (decision P4-7).

### 3.4 Data-home location (decision P4-5)

Packaged data lives in a **dedicated, persistent per-user dir** keyed off the Tauri identifier
— `app.path().app_local_data_dir()?` (≈ `%LOCALAPPDATA%/<identifier>`), with `data/` and
`config/` subdirs created on boot. Not temp (the spike's dir — non-persistent, gets swept) and
**not** the real Wave dir (`%LOCALAPPDATA%/waveterm` — would collide with a real Wave install's
DB/socket/lock). The distinct identifier (§4) guarantees the POC stays sandboxed from a real
Wave install. Used in both dev and packaged (the spike's temp dir is retired).

## 4. Bundler config — `tauri.conf.json`

```jsonc
{
  "productName": "WaveTauri",                 // de-spiked from "wave-tauri-spike" (P4-6)
  "identifier": "dev.waveterm.tauri",         // de-spiked from "dev.waveterm.tauri.spike"
  "version": "0.1.0",
  "build": {
    "devUrl": "http://localhost:5174",
    "beforeDevCommand": "npx vite --config frontend/tauri/vite.config.ts",
    "beforeBuildCommand": "npx vite build --config frontend/tauri/vite.config.ts", // NEW
    "frontendDist": "../frontend/tauri/dist"
  },
  "bundle": {                                 // NEW
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.ico"],              // existing src-tauri/icons from the spike
    "resources": { "../dist/bin/wavesrv.x64.exe": "bin/wavesrv.x64.exe",
                   "../dist/bin/wsh-*-windows.x64.exe": "bin/" }
  }
}
```

- `beforeBuildCommand` is the **build-target seam** Phase 5 repoints to the real cockpit (§9).
- `resources` maps only the **Windows** binaries into `{resource_dir}/bin/` — the glob excludes
  the cross-arch wsh fleet even if present in `dist/bin` (satisfies P4-3 at the bundle layer).
- **Build prerequisite:** `dist/bin/` must contain the two Windows binaries before `tauri
  build`; produced by the existing `task build:server:windows` + `task build:wsh`. No new build
  task is added (the glob selects the right files).
- Icons reuse the spike's `src-tauri/icons/` (already present); no new icon work.

## 5. Signing seam — disabled (decision P4-1)

The installer is **unsigned**. Tauri's Windows signing reads `bundle.windows.certificateThumbprint`
(+ optional `signCommand`/`digestAlgorithm`); both are **left unset** → unsigned `.exe`. An
unsigned installer installs and runs; Windows SmartScreen shows a one-time "unknown publisher"
prompt. The spec documents the two config keys to populate when a real cert exists (mirroring
`electron-builder.config.cjs`'s `windowsShouldSign` gate), but adds **no signing config or
script** now — a self-signed cert would not remove the SmartScreen prompt for distribution, so
it buys nothing for the POC.

## 6. Updater seam — deferred, documented only (decision P4-1)

**No updater code, plugin dependency, or config is added** (YAGNI — the fork owns no release
feed). The spec records the future path so it slots in without rework: add
`tauri-plugin-updater`, set `bundle.createUpdaterArtifacts: true`, generate a minisign keypair
(`tauri signer generate` — separate from code-signing), and set `plugins.updater.{endpoints,
pubkey}` to a feed (GitHub Releases or a self-hosted `latest.json`, the analog of
`electron-builder`'s `publish.url`). Adding a disabled plugin now would be dead speculative
infra; the seam is this paragraph, not code.

## 7. Mechanism — `bundle.resources`, not `externalBin`/sidecar (decision P4-8)

We bundle via Tauri's generic **`bundle.resources`** (find via `resource_dir()`), **not**
Tauri's `externalBin`/sidecar mechanism, because the latter is coupled to assumptions that
fight the untouched backend:

1. **Naming.** `externalBin` requires target-triple names (`wsh-x86_64-pc-windows-msvc.exe`);
   the Go backend scans for its own `wsh-{version}-windows.x64.exe` convention and knows
   nothing of Tauri triples — routing wsh through `externalBin` would break discovery or force
   a post-build rename hack.
2. **Spawn model.** `externalBin` pairs with `app.shell().sidecar()` (the shell plugin); the
   boot seam (meta spec §4) spawns `wavesrv` via `std::process::Command` and parses its stderr
   `ESTART` line itself — no shell plugin needed.

`resources` keeps the Tauri shell a thin spawner and lets the backend keep its own discovery —
*less* coupling, and it preserves the load-bearing filenames. This is the same call as P2-2:
satisfy a backend contract with the lower-coupling primitive rather than adopt a framework
default and patch around it.

## 8. Rust changes

- **`src-tauri/src/paths.rs` (new):** `resolve_app_path(is_dev, manifest_dir, resource_dir) ->
  PathBuf` (§3.2) + `data_home_dirs(app_local_data_dir) -> (data, config)` (§3.4) — pure,
  unit-tested. No Tauri imports, so testable headless.
- **`src-tauri/src/main.rs` (modify):** `spawn_wavesrv` takes the resolved `app_path` +
  `data_home`; sets the four env vars (§3.3); spawns from `{app_path}/bin/wavesrv.x64.exe`. The
  `setup` closure resolves `is_dev` / `resource_dir()` / `app_local_data_dir()` from the Tauri
  app handle and creates the data/config dirs. The stderr `ESTART` parsing is unchanged.
- **No backend (`pkg/`, `cmd/`) changes** (meta spec T5).

## 9. Coordination with Phase 5 (shared `tauri.conf.json`)

Both phases edit `tauri.conf.json`, but disjoint keys — partition by ownership:

| Keys | Owner |
|---|---|
| `bundle.*`, `productName`, `identifier`, `build.beforeBuildCommand` | **Phase 4 (this spec)** |
| `build.devUrl`, `build.frontendDist`, `build.beforeDevCommand` (flip harness → real cockpit) | **Phase 5** |

Phase 4 performs the **identity de-spike** (`productName`/`identifier`, §4) — Phase 5 must
rebase onto those values, not re-introduce the `spike` names. Phase 4's *final* observe-gate
(packaging the real product) is only meaningful once Phase 5's build-target flip lands; until
then Phase 4 validates the pipeline against the harness (§2.1). No other files overlap (Phase 4
= Rust + bundle config; Phase 5 = frontend TS deletions).

## 10. Verification (per meta spec §12)

**Unit tests (`paths.rs`, headless `cargo test`):**
- `resolve_app_path(is_dev=true, …)` → `{manifest}/../dist`; `(is_dev=false, …)` →
  `{resource_dir}` (so `+/bin` reaches the binaries in each mode).
- `data_home_dirs(base)` → `{base}/data` + `{base}/config`.
- Existing `estart::parse_estart` tests stay green.

**Observe-gates (Windows dev machine):**
1. **Dev unchanged** — `tauri dev` (or `cargo run`) still launches the harness, wavesrv spawns
   from the dev path, terminal PTY works (no regression to the Phase 0–2 spike).
2. **Build** — `tauri build` produces an NSIS `.exe` under
   `src-tauri/target/release/bundle/nsis/`, with `bin/wavesrv.x64.exe` + `bin/wsh-*-windows.x64.exe`
   present in the bundled resources.
3. **Install + run** — the installer installs; the installed app launches; wavesrv spawns from
   the **bundled** resource path; the terminal PTY works.
4. **wsh discovery** — the installed app's logs show wsh resolved (no
   `could not resolve wsh binary` non-fatal warning); wavesrv copies wsh into data-home/bin.
5. **Data-home** — `data/` + `config/` are created under `%LOCALAPPDATA%/dev.waveterm.tauri`,
   persist across a restart, and the real Wave data dir (`%LOCALAPPDATA%/waveterm`) is untouched.
6. **Unsigned** — the installer is unsigned (SmartScreen "unknown publisher" prompt is the
   expected, accepted behavior — confirms the signing seam is off, not broken).

## 11. Layout

```
src-tauri/
  tauri.conf.json        + bundle{}, beforeBuildCommand, de-spiked productName/identifier (§4)
  src/
    paths.rs (new)       resolve_app_path + data_home_dirs (pure, unit-tested) (§8)
    main.rs (modify)     resolve dev/packaged path + data-home; set 4 env vars; spawn bundled wavesrv
    estart.rs            UNCHANGED
    init.rs, commands.rs UNCHANGED
  icons/                 UNCHANGED (reused for bundle icon)
dist/bin/                build prerequisite: wavesrv.x64.exe + wsh-*-windows.x64.exe (existing tasks)
electron-builder.config.cjs   UNCHANGED (Electron app keeps working in parallel)
pkg/, cmd/               UNCHANGED (meta spec T5)
```

## 12. Decision log

- **P4-1 — Scope = Option A:** unsigned NSIS installer with bundled sidecar; signing + updater
  are documented disabled seams. *POC fork owns no cert/feed; both are human-gated (§12.2) and
  reversible config, not architecture.*
- **P4-2 — Verification vehicle:** package the current harness frontend; Phase 5 flips the
  target. *Packaging is content-agnostic, which is what enables parallel Phase 4 / Phase 5.*
- **P4-3 — Bundle wsh, Windows only:** ship `wsh-*-windows.x64.exe`; exclude the cross-arch
  fleet. *wsh enables shell integration (cheap, one file); cross-arch binaries serve remote
  hosts — out of scope for a Windows-only single-window POC.*
- **P4-4 — Dev-vs-packaged resolution:** branch on `cfg!(debug_assertions)` — dev keeps the
  spike's `CARGO_MANIFEST_DIR/../dist` path, packaged uses `resource_dir()`. *Sidesteps
  dev-resource placement friction; no regression to the working spike.*
- **P4-5 — Data-home:** dedicated persistent `app_local_data_dir()/{data,config}`. *Temp isn't
  persistent; the real Wave dir would collide with a real install. The distinct identifier
  sandboxes the POC.*
- **P4-6 — Identity de-spike:** `productName: WaveTauri`, `identifier: dev.waveterm.tauri`.
  *A coherent installer needs a real identity; this is the shared seam with Phase 5 (§9).*
- **P4-7 — `WAVETERM_APP_PATH` is a backend contract, not Electron residue:** it is consumed by
  the untouched Go backend (T5); Electron was merely a supplier. *Any shell must provide it.*
- **P4-8 — `bundle.resources`, not `externalBin`:** ship the bin dir as-is, resolve via
  `resource_dir()`, spawn via `std::process::Command`. *`externalBin`'s triple naming + shell-
  plugin spawn fight the backend's filename contract and the existing boot seam (§7).*

## 13. Spec coverage

§1 goal → §3 sidecar (the core) + §4 bundler config. §2 scope (in/out) + §2.1 vehicle map to
the §9 parallel-with-Phase-5 seam. §3.1 filenames → §4 `resources` glob + gate 2; §3.2
resolution → §8 `paths.rs` + unit tests + gate 1/3; §3.3 env → gate 4 (wsh) ; §3.4 data-home →
gate 5. §5 signing seam → gate 6. §6 updater → documented, no gate (no code). §7 mechanism
rationale → §8 Rust + P4-8. Each observe-gate in §10 maps to a §3–§5 deliverable; §12 logs
every decision referenced inline.
