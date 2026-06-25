# Tauri Phase 4 — Packaging Mechanism (Pulled Forward) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Spec:** [`docs/superpowers/specs/2026-06-24-tauri-phase4-packaging-design.md`](../specs/2026-06-24-tauri-phase4-packaging-design.md)
>
> **Git workflow override (user CLAUDE.md, highest priority):** this plan does **NOT** commit per-task. All changes batch into **one** commit at the end (Task 5), folding in the spec + this plan, and **only after explicit user approval**. This deviates from the skill's per-task-commit convention by user instruction.

**Goal:** Build the content-agnostic packaging *mechanism* — bundle the Go `wavesrv` + `wsh` binaries and emit an unsigned Windows NSIS installer that runs against a persistent per-user data home. Verified against whatever `frontend/tauri/` currently builds.

**Architecture:** Ship `dist/bin/*` via Tauri `bundle.resources`; resolve the bin dir from `resource_dir()` (packaged) or the source tree (dev) in a pure, unit-tested Rust helper; wire `WAVETERM_APP_PATH` + persistent `WAVETERM_DATA_HOME`/`WAVETERM_CONFIG_HOME` and spawn the bundled wavesrv. Signing + updater are documented disabled seams (no code).

**Tech Stack:** Rust (Tauri v2, `cargo tauri` CLI 2.11.3), NSIS bundler, the unchanged Go backend behind `WAVETERM_APP_PATH`.

---

## ✅ Status — COMPLETED 2026-06-25 (executed after 5a + 5b landed)

Executed and committed once 5a + 5b were in. The work was **consolidated off the
`feat/tauri-phase4-packaging` worktree onto `feat/tauri-migration`** (which carries the
5a/5b cockpit): the phase4 `main.rs` edits were applied *on top of* 5a's
`tauri_plugin_http` builder line (not copied over it), `paths.rs` and the bundle
`tauri.conf.json` moved across unchanged. The worktree (branched from `0bf480ab`, pre-cockpit)
could not have packaged the real product, so building happened on the feature branch instead.

**T-1 (entry repoint) resolved as a no-op.** 5b kept `frontend/tauri/` as the build entry and
only swapped what `main.tsx` renders (harness → `CockpitRoot`), so `tauri.conf.json`'s
`devUrl`/`beforeDevCommand`/`beforeBuildCommand`/`frontendDist` already targeted the unified
cockpit. No repoint was needed — only verification that they pointed at the live entry.

**Gates:** `cargo test` **6/6** (3 `paths::` + 3 `estart::`). Gate 2 — `cargo tauri build`
produced `WaveTauri_0.1.0_x64-setup.exe` with `bin/wavesrv.x64.exe` +
`bin/wsh-0.14.5-windows.x64.exe` bundled (cross-arch wsh fleet excluded by the glob; cockpit
frontend embedded in the exe). Gates 1/4/5 verified via headless `cargo tauri dev`: cockpit
rendered, wavesrv ready with real endpoints, `wsh binary successfully copied` via
`WAVETERM_APP_PATH`, data/config homes created under `dev.waveterm.tauri` (sandboxed from the
real `waveterm` install). Gates 3 (spawn from the bundled resource path) + 6 (unsigned
SmartScreen) are the human's installer-run confirmation.

**T-2 (remove `emain/` + electron-builder) remains deferred** to a follow-up.

---

## ⚠️ Context for the executing agent — READ FIRST

**The roadmap was re-ordered (meta spec §8, decisions T9/T10/T11).** The full "Phase 4" per the meta spec now runs **last** (after 5a → 5b) and also includes removing `emain/` + electron-builder. **This plan executes only the *packaging mechanism* — the content-agnostic part — pulled forward now to de-risk the human-gated signing/packaging pipeline early.** Two sub-tasks are explicitly **deferred** (see "Deferred Tail Tasks" at the bottom) — do NOT do them.

**Why packaging can run now:** the bundler bundles *whatever `frontendDist` produces*. It never reads the frontend. So the installer/sidecar pipeline is independent of whether the webview shows the old bare-xterm harness or (once a parallel agent lands 5a) the real cockpit.

**A parallel agent is executing 5a/5b on this SHARED working tree.** Coordinate:

- **Files this plan owns (safe to edit):** `src-tauri/src/paths.rs` (new), `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, the two Phase 4 docs.
- **Files the 5a/5b agent owns — DO NOT TOUCH:** `frontend/wave.ts`, `frontend/app/cockpit/*`, `frontend/tauri/main.tsx`, `frontend/tauri/bootids.ts`, `frontend/tauri/terminal-harness.tsx` (it gets deleted by 5a), `src-tauri/capabilities/default.json`. There is **no file overlap** with this plan — keep it that way.
- **Before editing, re-check `git status` / `git log`** — the tree may have advanced (the harness may already be the cockpit if 5a landed).
- **Do not run two `cargo tauri dev` instances against the same data home at once** — wavesrv takes a lock on its data home; a second instance will collide (orphan-lock).

**This plan supersedes the spec's §2.1 "packages the harness in parallel" and §9 "parallel coordination" framing** (written before the T10 pivot). The spec's *mechanism design* (§3–§8) is still accurate and is the reference for Tasks 1–3.

---

## File Structure

- **Create** `src-tauri/src/paths.rs` — two pure functions (`resolve_app_path`, `data_home_dirs`) + unit tests. No Tauri imports, so headless-testable.
- **Modify** `src-tauri/src/main.rs` — declare `mod paths;`; resolve dev/packaged app path + per-user data home; set the four env vars; spawn the bundled wavesrv. (`estart.rs`, `init.rs`, `commands.rs` unchanged.)
- **Modify** `src-tauri/tauri.conf.json` — add `bundle{}` (NSIS + resources + icon), add `build.beforeBuildCommand`, de-spike `productName`/`identifier`.
- **No change** `Cargo.toml` (no new deps), `pkg/`, `cmd/`. **`emain/` + `electron-builder.config.cjs` stay untouched** (their removal is a deferred tail task — the Electron app must keep working for the 5a agent's side-by-side comparison).

**Build prerequisite (one-time, before Task 4):** `dist/bin/` must hold the Windows binaries `wavesrv.x64.exe` and `wsh-*-windows.x64.exe`, produced by `task build:server:windows` + `task build:wsh`.

---

### Task 1: Pure path helpers (`paths.rs`) — TDD

**Files:**
- Create: `src-tauri/src/paths.rs`
- Modify: `src-tauri/src/main.rs` (add `mod paths;`)
- Test: inline `#[cfg(test)]` in `src-tauri/src/paths.rs`

- [ ] **Step 1: Write `paths.rs` with `todo!()` bodies + the failing tests**

```rust
// src-tauri/src/paths.rs
use std::path::{Path, PathBuf};

// WAVETERM_APP_PATH: the dir whose `bin/` subdir holds the bundled wavesrv + wsh
// (wavebase.GetWaveAppBinPath = WAVETERM_APP_PATH + "/bin"). Dev keeps the spike's
// source-tree path; packaged uses Tauri's resource dir.
pub fn resolve_app_path(is_dev: bool, manifest_dir: &Path, resource_dir: &Path) -> PathBuf {
    let _ = (is_dev, manifest_dir, resource_dir);
    todo!()
}

// wavesrv hard-requires both WAVETERM_DATA_HOME and WAVETERM_CONFIG_HOME; split the
// per-user base dir into those two homes.
pub fn data_home_dirs(base: &Path) -> (PathBuf, PathBuf) {
    let _ = base;
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_uses_source_tree_dist() {
        let got = resolve_app_path(true, Path::new("C:/proj/src-tauri"), Path::new("C:/ignored"));
        assert_eq!(got, Path::new("C:/proj/src-tauri").join("..").join("dist"));
    }

    #[test]
    fn packaged_uses_resource_dir() {
        let got = resolve_app_path(false, Path::new("C:/ignored"), Path::new("C:/app/res"));
        assert_eq!(got, PathBuf::from("C:/app/res"));
    }

    #[test]
    fn data_home_splits_into_data_and_config() {
        let base = Path::new("C:/u/AppData/Local/dev.waveterm.tauri");
        let (data, config) = data_home_dirs(base);
        assert_eq!(data, base.join("data"));
        assert_eq!(config, base.join("config"));
    }
}
```

Also add the module declaration in `src-tauri/src/main.rs` alongside the existing `mod estart; mod init; mod commands;`:

```rust
mod estart;
mod init;
mod commands;
mod paths;
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from project root): `cargo test --manifest-path src-tauri/Cargo.toml paths::`
Expected: FAIL — all three tests panic with `not yet implemented` (the `todo!()` bodies).

- [ ] **Step 3: Implement the real bodies**

Replace the two function bodies in `src-tauri/src/paths.rs`:

```rust
pub fn resolve_app_path(is_dev: bool, manifest_dir: &Path, resource_dir: &Path) -> PathBuf {
    if is_dev {
        manifest_dir.join("..").join("dist")
    } else {
        resource_dir.to_path_buf()
    }
}

pub fn data_home_dirs(base: &Path) -> (PathBuf, PathBuf) {
    (base.join("data"), base.join("config"))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from project root): `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — the three `paths::tests` plus the existing `estart::tests` all green.

---

### Task 2: Wire `main.rs` to bundled paths + persistent data home + env

No unit test (integration with the Tauri app handle); verified by Task 4 gate 1 (dev still launches) and gates 3–5 (packaged). Per spec §3.3 the change adds `WAVETERM_APP_PATH` and moves the data/config homes off temp.

**Files:**
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add the `PathBuf` import**

At the top of `src-tauri/src/main.rs`, change the `std` use lines to include `PathBuf`:

```rust
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
```

- [ ] **Step 2: Replace `spawn_wavesrv` to take the resolved app path + data base**

Replace the entire current `spawn_wavesrv` function (signature + the exe/home setup; keep the stderr-reading thread body unchanged) with:

```rust
fn spawn_wavesrv(auth_key: String, app_path: PathBuf, data_base: PathBuf, state: tauri::State<InitState>) {
    // Packaged: app_path = resource_dir(); dev: app_path = src-tauri/../dist (paths::resolve_app_path).
    // wavesrv + wsh both live under {app_path}/bin; wavesrv discovers wsh via WAVETERM_APP_PATH.
    let exe = app_path.join("bin").join("wavesrv.x64.exe");
    let (data_home, config_home) = paths::data_home_dirs(&data_base);
    let _ = std::fs::create_dir_all(&data_home);
    let _ = std::fs::create_dir_all(&config_home);
    let mut child = Command::new(&exe)
        .env("WAVETERM_AUTH_KEY", &auth_key)
        .env("WAVETERM_APP_PATH", &app_path)
        .env("WAVETERM_DATA_HOME", &data_home)
        .env("WAVETERM_CONFIG_HOME", &config_home)
        // inherit stdout (we only read stderr) so an unread stdout pipe can't fill and deadlock wavesrv.
        .stdout(Stdio::inherit())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("failed to spawn wavesrv at {:?}: {}", exe, e));

    let stderr = child.stderr.take().unwrap();
    let state_data = state.0.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if line.starts_with("WAVESRV-EVENT:") {
                continue; // same stream carries event JSON; ignore for the spike
            }
            if let Some(info) = estart::parse_estart(&line) {
                let mut d = state_data.lock().unwrap();
                d.ws_endpoint = info.ws;
                d.web_endpoint = info.web;
                d.version = info.version;
                d.build_time = info.buildtime;
                println!("[tauri] wavesrv ready: {:?}", *d);
            } else {
                println!("[wavesrv] {}", line);
            }
        }
    });
}
```

- [ ] **Step 3: Resolve the paths in `setup` and pass them to `spawn_wavesrv`**

In `main()`'s `.setup(move |app| { … })` closure, replace the single `spawn_wavesrv(auth_key.clone(), app.state::<InitState>());` line with:

```rust
            let is_dev = cfg!(debug_assertions);
            let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
            // resource_dir() only matters when packaged; avoid calling it in dev.
            let resource_dir = if is_dev { PathBuf::new() } else { app.path().resource_dir()? };
            let app_path = paths::resolve_app_path(is_dev, manifest_dir, &resource_dir);
            let data_base = app.path().app_local_data_dir()?;
            spawn_wavesrv(auth_key.clone(), app_path, data_base, app.state::<InitState>());
```

(`app.path()` comes from `tauri::Manager`, already imported. The seed-identity block above it is unchanged.)

- [ ] **Step 4: Verify it compiles cleanly**

Confirm VS Code shows no Rust errors in `src-tauri/src/main.rs` and `paths.rs` (per project rule: no `cargo build` needed; absence of editor errors == compiles). Optionally run `cargo check --manifest-path src-tauri/Cargo.toml`.
Expected: no errors.

---

### Task 3: `tauri.conf.json` — bundle config + beforeBuildCommand + de-spike identity

**Files:**
- Modify: `src-tauri/tauri.conf.json`

**Note:** the `build.beforeBuildCommand`/`frontendDist` below point at `frontend/tauri/vite.config.ts` — correct now and through 5a (5a keeps that separate entry). **5b** unifies the entry and will repoint these; that repoint is a deferred tail task, NOT this plan. The 5a agent does **not** edit `tauri.conf.json`, so there is no collision — but re-check `git status` before editing in case the tree advanced.

- [ ] **Step 1: Replace the file with the bundle-enabled config**

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "WaveTauri",
  "version": "0.1.0",
  "identifier": "dev.waveterm.tauri",
  "build": {
    "devUrl": "http://localhost:5174",
    "beforeDevCommand": "npx vite --config frontend/tauri/vite.config.ts",
    "beforeBuildCommand": "npx vite build --config frontend/tauri/vite.config.ts",
    "frontendDist": "../frontend/tauri/dist"
  },
  "app": {
    "windows": [
      { "label": "main", "title": "Wave Tauri", "width": 1000, "height": 700, "decorations": false }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.ico"],
    "resources": {
      "../dist/bin/wavesrv.x64.exe": "bin/wavesrv.x64.exe",
      "../dist/bin/wsh-*-windows.x64.exe": "bin/"
    }
  }
}
```

Notes for the executor:
- `productName`/`identifier` are de-spiked (decision P4-6).
- The `resources` glob deliberately selects only the **Windows** binaries — the cross-arch wsh fleet, even if present in `dist/bin`, is excluded.
- `app.windows[0].title` updated off "Wave Tauri Spike" to match the de-spike; `decorations:false` is retained from Phase 2.

- [ ] **Step 2: Verify the JSON is valid**

Run (from project root): `node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

---

### Task 4: Build + verify the packaging mechanism (observe-gates)

The unit step is agent-runnable; the build/install gates run on the **Windows dev machine** (the human, per meta spec §12.2). These gates verify the **packaging mechanism**, not a specific frontend — they hold whether `frontend/tauri/` currently builds the bare-xterm harness or (if 5a has landed) the real cockpit. Phrase the "terminal works" check against whatever is present: the harness terminal pre-5a, or the cockpit's inline-terminal focus pane post-5a.

**Files:** none (verification only).

- [ ] **Step 1: Ensure the build prerequisite binaries exist**

Run (from project root): `task build:server:windows` then `task build:wsh`
Expected: `dist/bin/wavesrv.x64.exe` and `dist/bin/wsh-*-windows.x64.exe` exist (`ls dist/bin`).

- [ ] **Step 2: Run the Rust unit tests**

Run (from project root): `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — `paths::tests` (3) + `estart::tests` (3).

- [ ] **Step 3: Gate 1 — dev unchanged**

Run (from project root): `cargo tauri dev` (ensure no other `cargo tauri dev` is running against the same data home — orphan-lock).
Expected: the window opens, wavesrv spawns from the dev path (`[tauri] wavesrv ready: …` in console), the terminal PTY works (harness terminal, or cockpit inline terminal if 5a landed). No regression.

- [ ] **Step 4: Gate 2 — build produces an NSIS installer with the bundled binaries**

Run (from project root): `cargo tauri build`
Expected: an NSIS `.exe` under `src-tauri/target/release/bundle/nsis/`. Confirm `bin/wavesrv.x64.exe` and `bin/wsh-*-windows.x64.exe` are present in the bundled resources (or in the installed app after Step 5).

- [ ] **Step 5: Gates 3–6 — install, run, wsh, data-home, unsigned**

Run the NSIS installer, then launch the installed app. Confirm:
- **Gate 3 (install+run):** app launches; wavesrv spawns from the **bundled** resource path; the terminal PTY works.
- **Gate 4 (wsh):** the app's logs show wsh resolved — **no** `could not resolve wsh binary` warning; wavesrv copies wsh into the data-home `bin/`.
- **Gate 5 (data-home):** `data/` + `config/` are created under `%LOCALAPPDATA%/dev.waveterm.tauri`, persist across a restart, and `%LOCALAPPDATA%/waveterm` (a real Wave install's dir) is untouched.
- **Gate 6 (unsigned):** the installer is unsigned — a one-time SmartScreen "unknown publisher" prompt is the expected, accepted behavior (confirms the signing seam is off, not broken).

If any gate fails, stop and debug before Task 5.

---

### Task 5: Commit (await explicit approval)

Per the user's git workflow (CLAUDE.md), this is **one** commit folding in the spec, this plan, and the code — and only after explicit approval.

- [ ] **Step 1: Show the change set + proposed message, then ask for approval**

Run (from project root): `git status --short` and `git diff --stat`
Present the files with status (M/A/D) and this proposed message, then ask "Awaiting approval. Proceed? (yes/no)":

```
feat(tauri): phase-4 packaging mechanism + wavesrv/wsh sidecar bundle

Bundle the Go wavesrv + wsh binaries via Tauri bundle.resources, resolve
the bin dir from resource_dir() (packaged) or the source tree (dev), and
wire WAVETERM_APP_PATH + a persistent per-user data home so the app runs
installed. Emit an unsigned NSIS installer; signing + updater stay
documented disabled seams. Content-agnostic mechanism pulled forward of
the T10-reordered Phase 4; entry-repoint + emain/electron-builder removal
are deferred to after 5b. Backend (pkg/, cmd/) and emain/ untouched.
```

- [ ] **Step 2: On approval, commit**

```bash
git add docs/superpowers/specs/2026-06-24-tauri-phase4-packaging-design.md \
        docs/superpowers/plans/2026-06-24-tauri-phase4-packaging.md \
        src-tauri/src/paths.rs src-tauri/src/main.rs src-tauri/tauri.conf.json
git commit
```

(Do not push unless explicitly asked.)

---

## Deferred Tail Tasks — DO NOT EXECUTE IN THIS PLAN (gated on 5b)

Documented here so the future Phase 4 revision is mechanical. **Do not do these now** — they depend on the parallel agent's 5a/5b landing first.

- **T-1 · Repoint the build target to the unified entry.** 5b "unifies the Tauri vite entry" (folds `frontend/tauri/` into the main app build). When that lands, update `tauri.conf.json` `build.devUrl` / `build.beforeDevCommand` / `build.beforeBuildCommand` / `build.frontendDist` to the unified entry's paths. Blocked until 5b defines those paths.
- **T-2 · Remove `emain/` + electron-builder.** The meta spec §8 assigns the Electron-shell teardown to Phase 4. It is blocked until **after 5b**: 5a keeps the Electron app working for side-by-side comparison, and 5b is what deletes the shared render path (`Workspace`) that breaks Electron. Removing `emain/` + `electron-builder.config.cjs` + Electron deps/scripts earlier would destroy the 5a comparison baseline.
- **Re-verification.** After T-1, re-run the Task 4 gates against the unified real-cockpit build to confirm the shippable product (not just the mechanism) packages and runs.

---

## Self-Review

**Spec coverage (mechanism — §3–§8):**
- §3.1 filenames / what ships → Task 3 `resources` glob + Task 4 gate 2/4. ✓
- §3.2 dev-vs-packaged resolution → Task 1 `resolve_app_path` + tests; Task 2 step 3. ✓
- §3.3 env contract (4 vars incl. `WAVETERM_APP_PATH`) → Task 2 step 2. ✓
- §3.4 persistent data-home → Task 1 `data_home_dirs` + Task 2 (`app_local_data_dir`) + gate 5. ✓
- §4 bundler config + beforeBuildCommand + identity de-spike → Task 3. ✓
- §5 signing seam (unset, unsigned) → no code; Task 4 gate 6 confirms. ✓
- §6 updater (documented, no code) → intentionally no task. ✓
- §7 mechanism (`resources` not `externalBin`) → Task 3 `resources` + Task 2 `std::process::Command` spawn. ✓
- §8 Rust changes → Tasks 1–2. §10 gates → Task 4. ✓
- Spec §2.1/§9 "parallel/harness" framing → **superseded** by the T10 pivot; replaced by the "Context" block + "Deferred Tail Tasks" (entry-repoint, emain removal). ✓

**Placeholder scan:** no TBD/TODO; all code is concrete; wsh version is globbed, not hardcoded. ✓

**Type consistency:** `resolve_app_path(is_dev, manifest_dir, resource_dir) -> PathBuf` and `data_home_dirs(base) -> (PathBuf, PathBuf)` are used identically in Task 1 (definition/tests) and Task 2 (calls). `spawn_wavesrv(auth_key, app_path, data_base, state)` signature in Task 2 step 2 matches its call in step 3. ✓
