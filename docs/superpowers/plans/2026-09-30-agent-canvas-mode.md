# Agent canvas mode Implementation Plan

**Verify:** `CGO_ENABLED=1 CC="zig cc -target x86_64-windows-gnu" node scripts/verify.mjs ./pkg/wshrpc/... ./pkg/orchestrate/... ./pkg/jarvis/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/wshrpc/... ./pkg/orchestrate/... ./cmd/wsh/... && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/wsh/...`
**Final:** `node scripts/cdp/final-verify.mjs canvas-swap surface-smoke`
**Prototype:** .superpowers/design/agent-canvas-mode/project/Main.dc.html

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** An agent's design-local canvas shows on the Agent surface in place of its terminal. The user marks parts of a board and sends them to that agent as one terminal line, and a canvas can start a build run with the canvas as its prototype.

**Architecture:** The frontend gets a per-agent canvas state (a jotai atom family), a `canvas:` address landed by the one router, a CanvasPane that swaps with the (still mounted) xterm, and keys in the Agent bindings. Tauri gets two native commands (a WebView2 window capture, and a detached python server spawn) plus a CSP `frame-src`. Go gets a run-level `prototype` that overrides the plan's, and `wsh ui reveal` sends its cwd.

**Tech Stack:** React 19 + jotai + Tailwind 4 (frontend), Rust/Tauri 2 + webview2-com (shell), Go (wavesrv/wsh), vitest, go test, cargo test.

**Spec:** `docs/superpowers/specs/2026-09-30-agent-canvas-mode-design.md`. Read it before your task. It owns the behaviour; the mockup owns the look.

**Mockup (the visual spec), read by absolute path** (the folder is gitignored, so a worktree has no copy):
`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\agent-canvas-mode\project\Main.dc.html` and `States.dc.html` in the same folder.

## Global Constraints

- Colours come from `@theme` tokens in `frontend/tailwindsetup.css` only; never raw hex/rgba. Marks are `accent`, never amber. Follow `DESIGN.md`.
- Reuse the primitives: `frontend/app/element/segmented.tsx`, `frontend/app/element/keycap.tsx`, AgentHeader's `ICON_BTN` and the pressed fullscreen classes (`border-accent bg-accentbg text-accent`), and the app bar's button classes (`frontend/app/cockpit/app-bar.tsx`).
- The xterm is never unmounted or remounted by canvas mode: hide it with `hidden`, as the subagent interior does.
- Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`, …). Change the Go type, then run `task generate`.
- `tsconfig` is not strict: an `{ok:true}|{ok:false;reason}` union does not narrow on `.ok`; narrow with `"reason" in result`.
- Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (never `npx tsc`; about 2 minutes). Prettier/eslint only on files you touched, never `--write` the tree.
- Canvas HTTP (the port probe, canvas.json, HEAD polls) goes through `@tauri-apps/plugin-http`'s `fetch` directly, **not** `frontend/util/fetchutil.ts`, which adds Arc's `X-AuthKey`.
- Constants: `CANVAS_PORT_FIRST = 8766`, `CANVAS_PORT_COUNT = 20`, `CANVAS_POLL_MS = 3000`, `MARK_MIN_PX = 10`, `DEFAULT_BOARD_W = 1440`.
- Commit messages carry no `Co-Authored-By` or other attribution trailer.

## Review Focus

1. A topic or board with path characters (`canvas:../x`, `canvas:a/b/c`, `canvas:a/..`) must parse to unsupported, never reach a file path (Task 3 tests it).
2. A feedback dir with other files (`notes.txt`, `12.png`, `007.png.bak`) must still yield the next `NNN.png` (Task 3 tests it).
3. A note with a newline or a `;` must not split the typed line or break the mark list (Task 3 tests the whitespace collapse; `;` in a note is kept verbatim, since only the line matters).
4. Switching the focused agent while in canvas mode must leave the other agent's terminal/canvas mode as it was (per-agent state; Task 3 tests `setCanvasMode` touches one id only).
5. The run's prototype must survive a plan-review resubmit that names a different `**Prototype:**` (Task 1 tests it).

---

### Task 1: Go: run prototype, reveal cwd, wsh flags, skill text
**Depends on:** none

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes_runs.go` (`CommandCreateRunData`)
- Modify: `pkg/waveobj/wtype.go` (`Run`)
- Modify: `pkg/wshrpc/wshserver/wshserver_runs.go` (`CreateRunCommand`, near `run.Parallelism = data.Parallelism`)
- Modify: `pkg/wshrpc/wshserver/wshserver_dag.go` (~line 277, `proposed.FinalCmd, proposed.Prototype = plan.Final, plan.Prototype`)
- Modify: `pkg/wshrpc/wshrpctypes_ui.go` (`CommandUiRevealData`)
- Modify: `cmd/wsh/cmd/wshcmd-runs.go`, `cmd/wsh/cmd/wshcmd-ui.go`
- Modify: `skills/design-local/SKILL.md` (The loop, step 3)
- Test: `pkg/wshrpc/wshserver/wshserver_dagplan_test.go`, `pkg/wshrpc/wshserver/wshserver_dagplanreview_test.go`, `cmd/wsh/cmd/wshcmd-runs_test.go`, and a CreateRun test beside `wshserver_landing_test.go`'s CreateRun tests
- Regenerated: run `task generate`

**Interfaces:**
- Produces: TS `CommandCreateRunData.prototype?: string`, `Run.prototype?: string`, `CommandUiRevealData.callercwd?: string` (from `task generate`). Tasks 4 and 7 rely on these names.

- [ ] **Step 1: Types.** Add to `CommandCreateRunData`:
```go
	// Prototype is the design canvas the run's final verifier compares against. It wins over the plan's
	// **Prototype:** line; an orchestrator run only.
	Prototype string `json:"prototype,omitempty"`
```
Add `Prototype string \`json:"prototype,omitempty"\`` to `waveobj.Run` (after `Parallelism`, with the same comment gist), and `CallerCwd string \`json:"callercwd,omitempty"\`` to `CommandUiRevealData`. Run `task generate`.

- [ ] **Step 2: Failing dag tests.** In `TestDagSubmitFromPlanPath`, add subtests: (a) a run whose `run.Prototype = "C:/canvas/Main.dc.html"` (set before `AppendRun`; give `newRun` an optional prototype parameter) submitting a plan with `**Prototype:** .superpowers/design/other/Main.dc.html` yields `g.Prototype == "C:/canvas/Main.dc.html"`; (b) a run with no prototype keeps the plan's (the existing subtest already covers it; leave it). In `wshserver_dagplanreview_test.go`, add a test that resubmits during the plan review a plan naming a different `**Prototype:**` and asserts the dag still carries the run's prototype. Model it on how that file's existing tests resubmit. Run `go test ./pkg/wshrpc/wshserver -run 'TestDagSubmitFromPlanPath|<your new test name>'` and expect FAIL.

- [ ] **Step 3: Override at submit.** In `wshserver_dag.go`, right after `proposed.FinalCmd, proposed.Prototype = plan.Final, plan.Prototype`:
```go
	// a prototype the run was started with (Build this… on a canvas) is the human's, not the lead's
	if run.Prototype != "" {
		proposed.Prototype = run.Prototype
	}
```
The plan-review replace (`planreview.go`: `g.FinalCmd, g.Prototype = proposed.FinalCmd, proposed.Prototype`) copies `proposed`, so it holds. Re-run the Step 2 tests and expect PASS.

- [ ] **Step 4: CreateRun.** After `engineLaunch` is known (and before anything persists), add:
```go
	if data.Prototype != "" && !engineLaunch {
		return nil, fmt.Errorf("prototype needs an orchestrator run: only the engine's final verifier reads it")
	}
```
and set `run.Prototype = data.Prototype` next to `run.Parallelism = data.Parallelism`. Add a test (in a new `wshserver_createrun_prototype_test.go`, built on the fixtures the existing CreateRun tests use) that a `Mode: quick` launch with a prototype fails with that error and persists no run. Also test that an orchestrator launch stores `run.Prototype`, if those fixtures can launch an orchestrator run cheaply (the landing tests do). Run with `-run` on the new test names.

- [ ] **Step 5: `wsh runs start --prototype`.** Add `f.String("prototype", "", "design canvas the final verifier compares against (orchestrator only)")`, a `prototype` field on `runsStartOpts`, and in `runsStartData` include it in the orchestrator-only check (`!engine && (... || o.prototype != "")`, and name `--prototype` in that error's flag list). Set `s.Prototype = o.prototype`. In `runsStartRun`, `data.Prototype, err = runsAbs(data.Prototype)`. Extend `TestRunsStartData` with: `--prototype` on a quick run errors; with `--mode orchestrator` it is carried. Run `go test ./cmd/wsh/cmd -run TestRunsStartData`.

- [ ] **Step 6: Reveal cwd.** In `uiRevealRun`, `cwd, _ := os.Getwd()` and pass `CallerCwd: cwd`. A failed Getwd sends empty, and the frontend then says to run it from the agent's terminal. Update `uiRevealCmd.Short` to list `canvas:<topic>[/<board>]`.

- [ ] **Step 7: Skill.** In `skills/design-local/SKILL.md` "The loop" step 3, start with: "If you run inside Arc (`wsh` is on PATH), run `wsh ui reveal canvas:<topic>` from your terminal: it opens the canvas beside you on the Agent surface, and the user marks it and sends the marks back to you as one line. If that command fails or `wsh` is missing, list the URLs:", then keep the existing URL / assumptions / states text as the fallback. Keep the file's voice.

- [ ] **Step 8: Commit.** `git add` the touched Go files, the generated files, and SKILL.md. `git commit -m "feat(runs): run-level prototype overrides the plan's; wsh ui reveal sends its cwd"`

### Task 2: Tauri: window capture, canvas server, CSP
**Depends on:** none

**Files:**
- Create: `src-tauri/src/canvas.rs`
- Modify: `src-tauri/src/main.rs` (`mod canvas;` and `generate_handler!`)
- Modify: `src-tauri/Cargo.toml` (`[target.'cfg(windows)'.dependencies]`)
- Modify: `src-tauri/tauri.conf.json` (CSP)

**Interfaces:**
- Produces: `invoke<ArrayBuffer>("capture_webview")` → the whole window as PNG bytes (a `tauri::ipc::Response`, so the JS side receives an `ArrayBuffer`); `invoke<void>("start_canvas_server", { dir: string, port: number })`, which rejects with a message string on error. Tasks 4 and 6 call these.

- [ ] **Step 1: Failing validation tests** in `canvas.rs` `#[cfg(test)]`, for `fn validate_server_args(dir: &Path, port: u16) -> Result<PathBuf, String>`: it rejects port 80 and 0; it rejects a dir that doesn't exist; it rejects an existing temp dir not named `.superpowers/design`; it accepts `<tmp>/.superpowers/design` (create it in the test); it rejects `<tmp>/.superpowers/design/../x`, because it compares the canonicalized path's last two components. Run `cargo test --manifest-path src-tauri/Cargo.toml canvas` and expect FAIL.

- [ ] **Step 2: `start_canvas_server`.**
```rust
const PORT_MIN: u16 = 1024;

pub fn validate_server_args(dir: &Path, port: u16) -> Result<PathBuf, String> {
    if port < PORT_MIN {
        return Err(format!("port {port} is below {PORT_MIN}"));
    }
    let real = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut tail = real.components().rev().map(|c| c.as_os_str().to_string_lossy().to_string());
    // only ever serve a design-local root, never an arbitrary folder
    if tail.next().as_deref() != Some("design") || tail.next().as_deref() != Some(".superpowers") {
        return Err(format!("{} is not a .superpowers/design folder", real.display()));
    }
    Ok(real)
}

#[tauri::command]
pub fn start_canvas_server(dir: String, port: u16) -> Result<(), String> {
    let real = validate_server_args(Path::new(&dir), port)?;
    let mut cmd = std::process::Command::new("python");
    cmd.args(["-m", "http.server", &port.to_string(), "--bind", "127.0.0.1", "--directory"])
        .arg(&real)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("starting python: {e}"))
}
```
Note `canonicalize` on Windows returns a `\\?\` path, which python accepts. Log failures with `applog::log_line` as `commands.rs` does. Run the tests and expect PASS.

- [ ] **Step 3: `capture_webview`.** Follow `C:\Users\kael02\AppData\Local\Temp\capture-probe\src\main.rs`, but write into an in-memory stream and hand the bytes back:
```rust
#[cfg(windows)]
#[tauri::command]
pub async fn capture_webview(window: tauri::WebviewWindow) -> Result<tauri::ipc::Response, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    window.with_webview(move |wv| unsafe {
        // runs on the main thread; CapturePreview completes asynchronously into the stream
        let result = (|| -> Result<(), String> {
            let core = wv.controller().CoreWebView2().map_err(|e| e.to_string())?;
            let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true).map_err(|e| e.to_string())?;
            let keep = stream.clone();
            let mut tx = Some(tx);
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |res| {
                let out = res.map_err(|e| e.to_string()).and_then(|_| read_all(&keep));
                if let Some(tx) = tx.take() { let _ = tx.send(out); }
                Ok(())
            }));
            core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler)
                .map_err(|e| e.to_string())
        })();
        if let Err(e) = result { log_line(&format!("[capture] {e}")); }
    }).map_err(|e| e.to_string())?;
    let bytes = rx.await.map_err(|_| "capture was dropped".to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}
```
`read_all`: `stream.Seek(0, STREAM_SEEK_SET)`, then `Read` into a `Vec` in chunks until 0 bytes. The shape is sketched; make it compile against the pinned crates, and if the setup `result` fails, send that error through `tx` (move `tx` so both paths can reach it). Add a `#[cfg(not(windows))]` twin that returns `Err("window capture is Windows-only")`. If `tokio` isn't a direct dependency, use `tauri::async_runtime` with a `std::sync::mpsc` + `spawn_blocking`, or add `tokio = { version = "1", features = ["sync"] }` pinned to the version in `Cargo.lock`.

- [ ] **Step 4: Dependencies.** Under `[target.'cfg(windows)'.dependencies]`: `webview2-com = "=0.38.2"` and `windows = { version = "=0.61.3", features = ["Win32_Foundation", "Win32_System_Com", "Win32_System_Com_StructuredStorage", "Win32_System_Memory"] }` (the exact versions `Cargo.lock` already resolves; check with `grep -A1 'name = "webview2-com"' src-tauri/Cargo.lock`). Add a one-line comment saying they are pinned so no duplicate copy is pulled, as the `windows-sys` line says.

- [ ] **Step 5: Register and CSP.** Add `canvas::capture_webview, canvas::start_canvas_server` to `generate_handler!`. In `tauri.conf.json`, append `; frame-src http://127.0.0.1:*` to `security.csp`.

- [ ] **Step 6: Build and test.** `cargo test --manifest-path src-tauri/Cargo.toml canvas` passes, and `cargo build --manifest-path src-tauri/Cargo.toml` succeeds. `src-tauri/target` is junctioned to the main checkout's, so a build there can wait on cargo's lock; that is expected.

- [ ] **Step 7: Commit.** `git commit -m "feat(tauri): capture_webview and start_canvas_server commands; allow 127.0.0.1 frames"`

### Task 3: Frontend models: canvas address, board list, marks, canvas state
**Depends on:** none

**Files:**
- Modify: `frontend/app/view/jarvis/address.ts` (+ `address.test.ts`)
- Modify: `frontend/app/view/jarvis/openref.ts` (`targetName` case + a temporary `land` stub, so the switches stay exhaustive; Task 4 replaces the stub)
- Create: `frontend/app/view/agents/canvasmodel.ts` + `canvasmodel.test.ts`
- Create: `frontend/app/view/agents/canvasmarks.ts` + `canvasmarks.test.ts`
- Create: `frontend/app/view/agents/canvasstore.ts` + `canvasstore.test.ts`

**Interfaces (Produces; Tasks 4–8 use exactly these names):**
```ts
// address.ts
OpenTarget |= { kind: "canvas"; topic: string; board?: string }
AddressHint gains caller?: { blockId: string; cwd: string }

// canvasmodel.ts
export const CANVAS_PORT_FIRST = 8766, CANVAS_PORT_COUNT = 20, CANVAS_POLL_MS = 3000, DEFAULT_BOARD_W = 1440;
export type CanvasBoard = { name: string; w: number };
export type ProbeResult = { port: number; status: number | "error" };
export function boardsFromCanvasJson(json: unknown): CanvasBoard[];
export function boardLabel(name: string): string;                 // "Main.dc.html" -> "Main"
export function stepBoard(boards: CanvasBoard[], current: string | null, delta: number): string | null; // wraps
export function classifyProbe(r: ProbeResult): "serving" | "free" | "taken";
export function pickServingPort(rs: ProbeResult[]): number | null;
export function pickFreePort(rs: ProbeResult[]): number | null;
export function paneState(s: CanvasState): "board" | "probing" | "server-down" | "removed";
export function isUnseen(s: CanvasState): boolean;
export function updatedAgo(nowMs: number, ms: number | null): string; // "updated 12s ago", "updated 4m ago", "updated 2h ago", "" for null
export function fitScale(paneWidth: number, boardWidth: number): number; // min(1, pane/board), 1 when either <= 0
export function boardUrl(port: number, topic: string, board: string): string;
export function canvasDir(cwd: string, topic: string): string;     // join with the cwd's own separator
export function buildGoal(dir: string, boards: CanvasBoard[]): string;
export function prototypePath(dir: string, boards: CanvasBoard[]): string;

// canvasmarks.ts
export const MARK_MIN_PX = 10;
export type Mark = { x: number; y: number; w: number; h: number; note: string };
export type Box = { x0: number; y0: number; x1: number; y1: number };
export function boxToMark(b: Box): Mark | null;                    // normalized; null unless w > 10 && h > 10
export function addMark(marks: Mark[], b: Box): Mark[];            // appends boxToMark(b), or returns marks unchanged
export function removeMark(marks: Mark[], i: number): Mark[];
export function setMarkNote(marks: Mark[], i: number, note: string): Mark[];
export function nextFeedbackName(entryNames: string[]): string;    // "001.png"
export function feedbackRelPath(topic: string, name: string): string; // ".superpowers/design/<topic>/feedback/<name>"
export function canvasHandoffLine(relPath: string, board: string, marks: Mark[]): string;
export function cropRect(board: DOMRectLike, innerWidth: number, bitmap: { width: number; height: number }): { sx: number; sy: number; sw: number; sh: number };

// canvasstore.ts
export type CanvasState = { topic: string; dir: string; projectDir: string; mode: "terminal" | "canvas";
  board: string | null; boards: CanvasBoard[]; port: number | null;
  status: "probing" | "ready" | "server-down" | "removed"; lastModifiedMs: number | null;
  lastViewedMs: number; marking: boolean; marks: Mark[]; reloadKey: number };
export const canvasStateAtom: (agentId: string) => PrimitiveAtom<CanvasState | null>; // atomFamily from jotai/utils
export function getCanvas(agentId: string): CanvasState | null;
export function updateCanvas(agentId: string, fn: (s: CanvasState) => CanvasState): void; // no-op when null
export function attachCanvas(agentId: string, a: { topic: string; dir: string; projectDir: string; board?: string }, now: number): void;
export function detachCanvas(agentId: string): void;
export function canvasOwner(topic: string): string | null;         // an agent id holding this topic
export function setCanvasMode(agentId: string, mode: "terminal" | "canvas", now: number): void;
export function stepCanvasBoard(agentId: string, delta: number): void;
export function selectCanvasBoard(agentId: string, board: string): void;
export function setMarking(agentId: string, on: boolean): void;
export function clearMarks(agentId: string): void;
export function focusedCanvasMode(model: AgentsViewModel): CanvasState | null; // the focused agent's state when mode === "canvas", else null
export function focusedCanvas(model: AgentsViewModel): CanvasState | null;     // the focused agent's state, any mode
```

- [ ] **Step 1: address tests (failing).** In `address.test.ts`: `canvas:agent-canvas-mode` → `{kind:"canvas", topic:"agent-canvas-mode"}`; `canvas:t/States` → board `States.dc.html`; `canvas:t/States.dc.html` is kept; unsupported for `canvas:`, `canvas:../x`, `canvas:a/b/c`, `canvas:a/..`, `canvas:.hidden`, `canvas:a b`. Run `npx vitest run frontend/app/view/jarvis/address.test.ts` and expect FAIL.

- [ ] **Step 2: address impl.** In `parseAddress`'s switch:
```ts
        case "canvas":
            return parseCanvas(id);
```
```ts
// a design-local topic and board are single path segments; anything that could walk the tree is refused here
const CANVAS_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BOARD_EXT = ".dc.html";

function parseCanvas(id: string): OpenTarget | Unsupported {
    const [topic, board, ...rest] = id.split("/");
    if (rest.length > 0 || !CANVAS_SEGMENT.test(topic) || topic.includes("..")) {
        return { kind: "unsupported", message: CANNOT_OPEN };
    }
    if (board == null) {
        return { kind: "canvas", topic };
    }
    if (!CANVAS_SEGMENT.test(board) || board.includes("..")) {
        return { kind: "unsupported", message: CANNOT_OPEN };
    }
    return { kind: "canvas", topic, board: board.endsWith(BOARD_EXT) ? board : board + BOARD_EXT };
}
```
Add `caller?: { blockId: string; cwd: string }` to `AddressHint`. `openref.ts`'s `targetName` switch must stay exhaustive: add `case "canvas": return \`canvas ${target.topic}\``, and add a `case "canvas"` in `land` that returns `unavailable("Canvas mode is not wired yet")` for now. Task 4 replaces it. Run the tests and expect PASS.

- [ ] **Step 3: canvasmodel tests (failing), then impl.** Cover: `boardsFromCanvasJson` on the real shape (`{"boards":{"Main.dc.html":{"w":1440},"States.dc.html":{"w":1440}},"order":["Main.dc.html","States.dc.html"]}`), on `order` naming a missing board (dropped), with no `order` (keys, Main first), on `null`/`"x"` (→ `[{name:"Main.dc.html", w:1440}]`), and on a board with no `w` (1440). `stepBoard` wraps both ways, and `null` current means index 0. `classifyProbe`: 200 → serving, `"error"` → free, 404 → taken. `pickFreePort` returns the lowest free port. `paneState` precedence: removed > server-down > probing > board (ready). `isUnseen` is false in canvas mode, false with null lastModified, and true when modified > viewed in terminal mode. `updatedAgo` covers 0s, 59s, 60s → "1m", 3600s → "1h", and null → "". `fitScale(1200, 1440)` = 1200/1440, `fitScale(2000, 1440)` = 1, `fitScale(0, 1440)` = 1. `canvasDir("C:\\p", "t")` → `C:\p\.superpowers\design\t`, and `"/p"` → `/p/.superpowers/design/t`. `buildGoal("C:\\p\\.superpowers\\design\\t", boards)` → `Build the design in C:\p\.superpowers\design\t\project (boards: Main, States)`. `prototypePath` → `<dir>\project\Main.dc.html`, the first board. Use the dir's own separator (backslash if it contains one). Implement each as a small pure function. Run `npx vitest run frontend/app/view/agents/canvasmodel.test.ts`.

- [ ] **Step 4: canvasmarks tests (failing), then impl.** Cover: `boxToMark` normalizes a right-to-left drag, and returns null at 10×40 and at 40×10 but a mark at 11×11. `addMark` appends an 11×11 box and leaves the list as it was for a 10×40 one. `removeMark` keeps order. Clearing is `[]` (the store's `clearMarks`), not a marks-module function. `nextFeedbackName([])` → `001.png`; `["001.png","003.png","notes.txt","12.png","007.png.bak"]` → `004.png` (only `/^\d{3}\.png$/` counts); `["999.png"]` → `1000.png`. `canvasHandoffLine(".superpowers/design/t/feedback/003.png", "Main.dc.html", [{note:"too wide"},{note:"  "},{note:"a\nb"}])` → `look at .superpowers/design/t/feedback/003.png — marks on Main.dc.html: 1 too wide; 2 (no note); 3 a b`. Build it on `handoffLine` from `frontend/app/view/code/codehandoff.ts`:
```ts
export function canvasHandoffLine(relPath: string, board: string, marks: Mark[]): string {
    const parts = marks.map((m, i) => `${i + 1} ${m.note.replace(/\s+/g, " ").trim() || "(no note)"}`);
    return handoffLine({ rel: relPath, note: `marks on ${board}: ${parts.join("; ")}` });
}
```
`cropRect({left:100, top:50, width:640, height:400}, 1600, {width:3200, height:1900})` → scale 2 → `{sx:200, sy:100, sw:1280, sh:800}`, clamped so `sx+sw <= bitmap.width`. `feedbackRelPath` uses forward slashes.

- [ ] **Step 5: canvasstore tests (failing), then impl.** Use `atomFamily` from `jotai/utils` (as `livetranscriptatoms.ts` does). Read and write through `globalStore` (`@/app/store/jotaiStore`). Keep a module `Set<string>` of attached ids so `canvasOwner` can scan them. Tests (with the real globalStore; `detachCanvas` everything in `afterEach`):
  - `attachCanvas` starts `{mode:"terminal", status:"probing", marks:[], marking:false, board: a.board ?? null, boards: [], port: null, lastModifiedMs: null, lastViewedMs: now, reloadKey: 0}`. A second attach for a new topic resets the board and marks, and one for the same topic keeps the port.
  - `setCanvasMode(id, "canvas", 500)` sets `lastViewedMs = 500`. `setCanvasMode(id, "terminal", …)` clears `marking` and `marks`. It changes only that id (Review Focus 4: attach two ids, flip one).
  - `stepCanvasBoard` and `selectCanvasBoard` clear marks.
  - `setMarking(id, false)` clears the marks; `clearMarks(id)` empties them and keeps marking on.
  - `detachCanvas` → `getCanvas` null and `canvasOwner(topic)` null.
  - `focusedCanvasMode(model)` reads `model.focusIdAtom` (a stub `{ focusIdAtom: atom("a1") }` cast as `any`).
Run `npx vitest run frontend/app/view/agents/canvasstore.test.ts`.

- [ ] **Step 6: Commit.** `git commit -m "feat(canvas): canvas address, board/mark models and per-agent canvas state"`

### Task 4: Canvas pane, header swap, tree tag, router landing, poller
**Depends on:** Task 1, Task 2, Task 3

**Files:**
- Create: `frontend/app/view/agents/canvaspane.tsx`, `frontend/app/view/agents/canvaspoller.ts` (+ `canvaspoller.test.ts` for its pure step)
- Modify: `frontend/app/view/jarvis/openref.ts` (`landCanvas`) + `openref.test.ts`, `frontend/app/cockpit/uiclient.ts` (pass `caller`)
- Modify: `frontend/app/view/agents/agentsurface.tsx`, `agentheader.tsx`, `agentrow.tsx` (or wherever the tree row renders its trailing tags; read `agenttree.tsx` first)
- Modify: `frontend/app/element/segmented.tsx` (additive: `label: ReactNode`, optional `title`, `aria-pressed`, optional `role`)

**Interfaces:**
- Consumes: everything Task 3 produces; `invoke("start_canvas_server", {dir, port})` (Task 2); `CommandUiRevealData.callercwd` (Task 1).
- Produces: `CanvasPane({ model, agent })`, exported from `canvaspane.tsx`. Task 7 adds Build this… to the toolbar's right cluster, and Task 6 adds Send to the tray's button row; build neither here. `pollCanvasOnce` and `useCanvasPoller(model, agent)` are exported from `canvaspoller.ts`.

- [ ] **Step 0: Failing router tests.** In `frontend/app/view/jarvis/openref.test.ts`, add `FileInfoCommand: vi.fn()` to the hoisted `rpc` mock, give `makeModel`'s agents a `blockId` (`block-<id>`), and add a `describe("canvas landing")`. It uses `openAddress(model, "canvas:t", { caller: { blockId, cwd: "C:\\p" } }, report)` and `detachCanvas` in `afterEach`:
  - A caller whose block id matches no roster agent → `{ok:false, reason:"unavailable"}`, the message names `wsh ui reveal canvas:t`, and neither the surface nor the canvas state changes.
  - `FileInfoCommand` resolving `{ notfound: true }` → unavailable, and the message names `C:\p\.superpowers\design\t\project`.
  - Success → `getCanvas("a1")` has topic `t`, `dir` `C:\p\.superpowers\design\t`, `mode: "canvas"`; `focusIdAtom` is `a1`; the surface is `agent`.
  - No caller, and `a1` already attached to `t` → lands on `a1` in canvas mode. No caller and no owner → unavailable "No agent has the canvas t open".
  - `canvas:t/States` with a caller sets `board: "States.dc.html"`.
Run `npx vitest run frontend/app/view/jarvis/openref.test.ts -t "canvas landing"` and expect FAIL.

- [ ] **Step 1: Router.** Replace Task 3's stub `case "canvas"` in `land` with `landCanvas(model, target, hint caller)`. Thread the hint: `openAddress` already has `hint`, so pass `hint?.caller` through `openTarget(model, target, report, caller?)` as an optional 4th parameter, not into `OpenTarget`. Implement per the spec's "Address and reveal" steps 1–3: roster lookup by `blockId`; `canvasDir(caller.cwd, topic)`; `RpcApi.FileInfoCommand(TabRpcClient, { info: { path: dir + sep + "project" } })` and treat `info.notfound` as missing; `attachCanvas`; `setCanvasMode(id, "canvas", Date.now())`; `jumpToAgent(model, id)`. Check `current()` after each await. In `uiclient.ts` `handle_uireveal`, pass `{ anchor, caller: data.callerblockid && data.callercwd ? { blockId: data.callerblockid, cwd: data.callercwd } : undefined }`. Run the Step 0 tests and the whole `openref.test.ts`, and expect PASS.

- [ ] **Step 2: Poller.** `canvaspoller.ts` exports a pure `async function pollCanvasOnce(s: CanvasState, io: CanvasIO, now: number): Promise<Partial<CanvasState>>`, with an injected `CanvasIO = { dirExists(path): Promise<boolean>; get(url): Promise<{ status: number | "error"; lastModified: number | null; json?: unknown }>; head(url): Promise<{ status: number | "error"; lastModified: number | null }> }`. It implements the spec's poller steps 1–4. Test it with a fake IO: a removed dir → `{status:"removed"}`; no port and every probe `"error"` → `server-down`; port 8767 serving → `port: 8767, status: "ready"`, boards from json, newest `lastModified`; the shown board's Last-Modified moves while in canvas mode → `reloadKey + 1`; a failed HEAD on a known port → re-probe. The real IO uses `fetch` from `@tauri-apps/plugin-http` (dynamic import, as `fetchutil.ts` does; `lastModified` from `Date.parse(res.headers.get("last-modified"))`) and `FileInfoCommand`. `useCanvasPoller(model, agent)` runs it on mount and every `CANVAS_POLL_MS` while the agent has a canvas, drops stale results if the agent changed, merges with `updateCanvas`, and sets `lastViewedMs = now` in canvas mode. Call it from `AgentSurface`, which is mounted only while the Agent surface shows.

- [ ] **Step 3: Surface.** In `agentsurface.tsx`: `const canvas = useAtomValue(canvasStateAtom(agent?.id ?? ""))`; `const canvasMode = canvas?.mode === "canvas"`. Render the tree and rail only when `!fullscreen && !canvasMode`. Give the focused terminal pane `hidden` when `canvasMode`, never unmounting it. After the terminal map, render `{canvasMode ? <CanvasPane model={model} agent={agent} /> : null}`. When entering canvas mode, focus the `data-cockpit-surface-wrap` element so `c`, `[` `]` and `m` fire. When returning to terminal (from any source), focus the terminal the way the fallback code does. Match the existing focus idiom and don't invent a new one.

- [ ] **Step 4: Header.** In `agentheader.tsx`, when `canvas != null`, render before the fullscreen button (mockup lines 112–121):
```tsx
<Segmented
    value={canvas.mode}
    options={[
        { key: "terminal", label: "Terminal", title: `Terminal (${formatChordString("c")})` },
        { key: "canvas", label: <>Canvas{isUnseen(canvas) ? <span aria-label="updated since you last looked" className="h-[6px] w-[6px] rounded-full bg-accent" /> : null}</>, title: `Canvas (${formatChordString("c")})` },
    ]}
    onChange={(m) => setCanvasMode(agent.id, m, Date.now())}
/>
```
Extend `Segmented` additively. `label` becomes `ReactNode`; a button with a node label gets `flex items-center gap-[6px]`. Add optional per-option `title`, `aria-pressed={value === o.key}`, and optional `role`/`ariaLabel` props on the group (the swap: `role="group"`, "Show terminal or canvas"; the boards: `role="tablist"`, whose buttons get `role="tab"` + `aria-selected`). Existing callers compile unchanged. In canvas mode the fullscreen button still renders, as in the mockup.

- [ ] **Step 5: Tree tag.** In the agent tree row, when `canvasStateAtom(a.id)` is non-null, render the mockup's tag (Main.dc.html line 87): `rounded-[5px] border border-edge-mid px-[6px] py-[1px] font-mono text-[10.5px] font-semibold text-accent-soft`, title "Has a design canvas", text `canvas`.

- [ ] **Step 6: CanvasPane.** Copy the mockup (Main.dc.html lines 156–251) into Tailwind with tokens:
  - Toolbar: topic (mono 12 semibold `text-secondary`); board tabs `Segmented` (`role="tablist"`, title "Previous and next board ([ and ])", labels `boardLabel`) → `selectCanvasBoard`; spacer; `{updatedAgo(now, lastModifiedMs)} · {Math.round(scale*100)}%` (mono 10.5 `text-muted`; tick `now` every second while mounted); the **Mark** toggle (the lucide `SquareDashed`/`Scan` icon at 15/1.8, whichever matches the mockup's corner path) → `setMarking`; resting `border-edge-mid bg-surface-raised text-primary`, pressed `border-accent bg-accentbg text-accent`; while not marking, **Open in browser** → `getApi().openExternal(boardUrl(...))`.
  - Board: a centred container that measures its width (`ResizeObserver`). The iframe is `width = board.w`, `height = containerHeight / scale`, `transform: scale(scale)`, `transformOrigin: "0 0"`, and the wrapper is sized `board.w * scale` wide. Use `key={reloadKey + board}`, `sandbox="allow-scripts allow-same-origin"`, `title={board}`, `rounded-[8px] border border-edge-mid bg-background`.
  - Mark overlay (while marking) over the wrapper: crosshair, `outline outline-2 outline-accent -outline-offset-1`, the empty-state pill, numbered boxes (`border-2 border-accent bg-accentbg rounded-[6px]`, number chip `bg-accent text-background`), and a dashed draft. Take pointer coordinates relative to the overlay's `getBoundingClientRect()`. On mouseup, `updateCanvas(id, s => ({ ...s, marks: addMark(s.marks, box) }))`.
  - Tray (while marking): the "No marks yet…" line, one row per mark (number chip, `<input aria-label="Note for mark N" placeholder="What should change here? (optional)">` → `setMarkNote`, remove button `aria-label="Remove mark N"` → `removeMark`), **Clear** (→ `clearMarks`), and the explainer "Saves a picture of the board with your marks, then types one line into the agent." Leave room left of Clear for Task 6's Send button: build the right column as a flex row Task 6 adds to.
  - Edge states by `paneState` (States.dc.html panels 3 and 4): **probing** shows nothing but the toolbar and an empty board frame. **server-down**: the error dot + "Can't reach 127.0.0.1:{port ?? CANVAS_PORT_FIRST}", the explainer, and an accent **Start server** button. It probes the range, picks `pickFreePort`, calls `invoke("start_canvas_server", { dir: <projectDir>/.superpowers/design, port })`, then polls `pollCanvasOnce` every 500 ms for up to 5 s. Show the rejection message or "Started, but nothing answered on <port>" below the button. **removed**: "{topic} was removed", the explainer, **Back to terminal** → `detachCanvas(agent.id)`.
  - Export `data-canvas-pane` on the root and `data-canvas-board` on the board wrapper (the Task 6 crop reads it; Task 8's scenario queries both).

- [ ] **Step 7: Verify.** `npx vitest run frontend/app/view/agents/canvaspoller.test.ts frontend/app/view/jarvis/address.test.ts frontend/app/view/jarvis/openref.test.ts` passes, and so does the typecheck. If a dev app is available, run `wsh ui reveal canvas:agent-canvas-mode` from an agent terminal whose cwd is the main checkout, and check the swap, the tag, the board and the edge states against the mockup.

- [ ] **Step 8: Commit.** `git commit -m "feat(canvas): canvas mode on the Agent surface: pane, swap control, tree tag, reveal landing"`

### Task 5: Keys and footer hints
**Depends on:** Task 3

**Files:**
- Modify: `frontend/app/store/keybindings/bindings.ts` (`buildAgentBindings`, and `surface:next`/`surface:prev` + `cycle-agent-next`/`cycle-agent-prev` in `buildGlobalBindings`)
- Modify: `frontend/app/cockpit/footerhints.ts`
- Modify: `docs/keyboard-shortcuts.md`
- Test: `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/cockpit/footer-visible.test.ts`, `frontend/app/cockpit/footerhints.test.ts`

**Interfaces:**
- Consumes: `canvasStateAtom`, `getCanvas`, `focusedCanvas`, `focusedCanvasMode`, `setCanvasMode`, `stepCanvasBoard`, `setMarking`, and `paneState` from Task 3.
- Produces: binding ids `agent:canvas-open`, `agent:canvas-close`, `agent:canvas-prev`, `agent:canvas-next`, `agent:mark-start`, `agent:mark-stop`. (Task 6 adds `agent:canvas-send`.)

- [ ] **Step 1: Failing tests.** In `bindings.test.ts`, with a model stub whose `focusIdAtom` is `"a1"` and `attachCanvas("a1", { topic: "t", dir: "C:\\p\\.superpowers\\design\\t", projectDir: "C:\\p" }, 0)`, then `updateCanvas("a1", s => ({ ...s, status: "ready", boards: [{ name: "Main.dc.html", w: 1440 }, { name: "States.dc.html", w: 1440 }] }))`:
  - `agent:canvas-open` is active in terminal mode on a nav ctx, and inactive with no canvas or when `editable` (the terminal holds focus).
  - After `setCanvasMode("a1", "canvas", 1)`: `agent:canvas-close`, `agent:canvas-prev/next` (status `ready`) and `agent:mark-start` are active. `surface:next`/`surface:prev`, `agent:prev/next/prev-k/next-j`, `agent:toggle-rail`, `agent:fullscreen`, `agent:fullscreen-chord`, `agent:back` and `cycle-agent-next/prev` are inactive.
  - After `setMarking("a1", true)`: `agent:mark-stop` is active; `agent:mark-start` and `agent:canvas-prev/next` are inactive.
  - Running `agent:canvas-next` changes the board; running `agent:canvas-open` sets the mode to canvas.
In `footer-visible.test.ts`, check the visible glyph+label list for the three states: terminal mode with a canvas includes `c canvas`; canvas mode is exactly `c terminal`, `[ ] board`, `m mark` + the globals; marking is `m stop marking`, `c terminal` (Task 6 adds `Ctrl Enter send` in front). Run `npx vitest run frontend/app/store/keybindings/bindings.test.ts frontend/app/cockpit/footer-visible.test.ts` and expect FAIL.

- [ ] **Step 2: Bindings.** In `buildAgentBindings`:
```ts
    const canvas = () => focusedCanvas(model);
    const inCanvas = (ctx: KeyContext) => agentNav(ctx) && canvas()?.mode === "canvas";
    const boardReady = (ctx: KeyContext) => inCanvas(ctx) && !canvas()!.marking && paneState(canvas()!) === "board";
    const focusId = () => globalStore.get(model.focusIdAtom);
```
Add `agent:canvas-open` (`c`, label "Show the agent's canvas", when `agentNav(ctx) && canvas()?.mode === "terminal"`), `agent:canvas-close` (`c`, "Back to the terminal", `inCanvas`), `agent:canvas-prev` (`[`, "Previous board", `boardReady`), `agent:canvas-next` (`]`, "Next board", `boardReady`), `agent:mark-start` (`m`, "Mark parts of the board", `boardReady`), `agent:mark-stop` (`m`, "Stop marking", `inCanvas(ctx) && canvas()!.marking`), all `group: "Agent"`, running the Task 3 actions with `Date.now()`. Wrap the existing `when`s of `agent:prev`, `agent:next`, `agent:prev-k`, `agent:next-j`, `agent:toggle-rail`, `agent:fullscreen`, `agent:fullscreen-chord` and `agent:back` with `&& focusedCanvasMode(model) == null`. In `buildGlobalBindings`, add the same guard to `surface:next`, `surface:prev`, `cycle-agent-next` and `cycle-agent-prev`, only when `ctx.surface === "agent"` (other surfaces are unaffected). Add a comment: canvas mode hides their targets, and `[` `]` belong to the boards there.

- [ ] **Step 3: Footer.** In `SURFACE_HINTS.agent`, append (the footer filters by `when`, so order within a state is what renders):
```ts
        { ids: ["agent:canvas-close"], glyph: "c", label: "terminal" },
        { ids: ["agent:canvas-prev", "agent:canvas-next"], glyph: "[ ]", label: "board" },
        { ids: ["agent:mark-start"], glyph: "m", label: "mark" },
        { ids: ["agent:mark-stop"], glyph: "m", label: "stop marking" },
        { ids: ["agent:canvas-open"], glyph: "c", label: "canvas" },
```
Place `agent:canvas-open` between `f full` and `esc back`, per the mockup's terminal-mode order (`↑↓ move, d rail, f full, c canvas, esc back, Ctrl Tab cycle`). The mockup's marking order is `Ctrl Enter send, m stop marking, c terminal`, so put `mark-stop` before `canvas-close`. Arrange the array so every state renders in the mockup's order, and assert that order in the Step 1 test.

- [ ] **Step 4: Docs.** Add an "Agent: canvas mode" block to `docs/keyboard-shortcuts.md` with `c`, `[` / `]`, `m`, and `Ctrl+Enter` (send the marks, from mark mode). Match the file's table style.

- [ ] **Step 5: Run.** `npx vitest run frontend/app/store/keybindings/bindings.test.ts frontend/app/cockpit/footer-visible.test.ts frontend/app/cockpit/footerhints.test.ts` passes.

- [ ] **Step 6: Commit.** `git commit -m "feat(canvas): c, [ ], m keys for canvas mode with footer hints"`

### Task 6: Send marks to the agent
**Depends on:** Task 2, Task 4, Task 5

**Files:**
- Create: `frontend/app/view/agents/canvassend.ts`
- Modify: `frontend/app/view/agents/canvaspane.tsx` (Send button + error line in the tray)
- Modify: `frontend/app/store/keybindings/bindings.ts` (`agent:canvas-send`), `frontend/app/cockpit/footerhints.ts`, `docs/keyboard-shortcuts.md` if Task 5 didn't list Ctrl+Enter
- Test: `frontend/app/view/agents/canvassend.test.ts`, `bindings.test.ts`, `footer-visible.test.ts`

**Interfaces:**
- Consumes: `invoke("capture_webview")` (Task 2); `cropRect`, `nextFeedbackName`, `feedbackRelPath`, `canvasHandoffLine` (Task 3); the `data-canvas-board` element (Task 4).
- Produces: `sendCanvasMarks(agent: AgentVM, io?: SendIO): Promise<void>`, which throws `Error` with a user-facing message on failure.

- [ ] **Step 1: Failing test.** `sendCanvasMarks` takes an injectable `SendIO = { capture(): Promise<Blob>; crop(png: Blob, rect): Promise<Blob>; boardRect(): DOMRectLike | null; mkdir(path); list(path): Promise<string[]>; write(path, bytes: Uint8Array); type(blockId, text) }`, defaulting to the real one. Tests with a fake IO: the happy path writes `<dir>/feedback/004.png` when `001–003` exist, types exactly `canvasHandoffLine(".superpowers/design/<topic>/feedback/004.png", board, marks) + "\r"` to `agent.blockId`, then leaves the state `mode:"terminal", marking:false, marks:[]`. A capture failure, a write failure or a missing board rect throws and calls **no** `type`, and the marks stay. No marks, or an agent with no `blockId`, throws "Nothing to send" / "This agent has no terminal to type into". Run `npx vitest run frontend/app/view/agents/canvassend.test.ts` and expect FAIL.

- [ ] **Step 2: Implement.** The real IO: `capture` = `new Blob([await invoke<ArrayBuffer>("capture_webview")], {type:"image/png"})`. `crop` = `createImageBitmap(blob)`, then `cropRect(rect, window.innerWidth, bitmap)`, then `OffscreenCanvas(sw, sh)`, `drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)`, `convertToBlob({type:"image/png"})`. `boardRect` = `document.querySelector("[data-canvas-board]")?.getBoundingClientRect()`. `mkdir`/`list`/`write` use `RpcApi.FileMkdirCommand`, `FileReadCommand` (a directory read returns `entries`; if it doesn't, use the directory-listing RPC `wshclientapi.ts` offers), and `FileWriteCommand({ info: { path }, data64 })`. `frontend/util` has no bytes-to-base64 helper, so encode with a small local chunked `btoa` over the bytes. `type` = `RpcApi.ControllerInputCommand(TabRpcClient, { blockid, inputdata64: stringToBase64(text) })`. Capture **before** anything else changes the DOM (the overlay and marks must be in the shot). Then `setCanvasMode(agent.id, "terminal", Date.now())`, which clears the marks.

- [ ] **Step 3: Button and key.** In the tray's button row, after Clear (the mockup's order is Clear, then Send), add "Send to {agent.name}", `disabled` with no marks (mockup `sendBg`/`sendFg`: `bg-surface-hover text-muted` disabled, `bg-accent text-background` enabled), a `sending` flag, and a `text-error` line with the thrown message. Add a binding `agent:canvas-send` (`Ctrl:Enter`, "Send the marks to the agent", when `ctx.surface === "agent" && !ctx.modalOpen && focusedCanvasMode(model)?.marking && marks.length > 0`, deliberately live inside a note input) that clicks the Send button through a `data-canvas-send` attribute, the clickThrough shape `buildJarvisBindings` uses. Add the footer chip `{ ids: ["agent:canvas-send"], keys: "Ctrl:Enter", label: "send" }` first in the marking order. Extend the Task 5 footer test for marking: `Ctrl Enter send, m stop marking, c terminal`.

- [ ] **Step 4: Run.** `npx vitest run frontend/app/view/agents/canvassend.test.ts frontend/app/store/keybindings/bindings.test.ts frontend/app/cockpit/footer-visible.test.ts`, and the typecheck.

- [ ] **Step 5: Commit.** `git commit -m "feat(canvas): send marks: capture, save feedback/NNN.png, type one line into the agent"`

### Task 7: Build this… starts a run with the canvas as prototype
**Depends on:** Task 1, Task 4, Task 6

**Files:**
- Modify: `frontend/app/view/jarvis/newruncontrol.tsx` (`NewRunModal` consumes a prefill through `prefillToLaunch`; a Prototype line)
- Modify: `frontend/app/view/jarvis/newrun.ts` (`LaunchOpts.prototype`, `launchOptsFromConfig`), `frontend/app/view/agents/runactions.ts` (`createRunPayload` carries `prototype`)
- Modify: `frontend/app/view/agents/canvaspane.tsx` (Build this… button)
- Test: `frontend/app/view/jarvis/newrun.test.ts` (and `runactions` payload test if one exists)

**Interfaces:**
- Consumes: `buildGoal`, `prototypePath` (Task 3); TS `CommandCreateRunData.prototype` (Task 1).
- Produces, in `frontend/app/view/jarvis/newrun.ts` (pure, beside `initialPick`):
```ts
export type NewRunPrefill = { projectName: string; goal: string; prototype: string };
// what the modal's state becomes when it opens on a prefill: the project only if it is registered
export function prefillToLaunch(prefill: NewRunPrefill, projectNames: string[]):
    { picked: string | null; shape: "orchestrator"; start: "goal"; goal: string; prototype: string };
```
  and `newRunPrefillAtom: PrimitiveAtom<NewRunPrefill | null>`, exported from `newruncontrol.tsx` (where `lastPickedProjectAtom` lives).

- [ ] **Step 1: Failing tests.** In `newrun.test.ts`:
  - `launchOptsFromConfig({...orchestrator config, prototype: "C:/p/x/project/Main.dc.html"})` includes `prototype`; a `quick` config drops it.
  - `prefillToLaunch({ projectName: "waveterm", goal: "Build the design in …", prototype: "C:/p/…/Main.dc.html" }, ["waveterm", "other"])` → `{ picked: "waveterm", shape: "orchestrator", start: "goal", goal: "Build the design in …", prototype: "C:/p/…/Main.dc.html" }`.
  - An unregistered or empty `projectName` → `picked: null`, the rest unchanged.
  - Test `createRunPayload` carrying `prototype` if it's exported.
Run `npx vitest run frontend/app/view/jarvis/newrun.test.ts` and expect FAIL.

- [ ] **Step 2: Carry prototype.** Add optional `prototype?: string` to `RunConfig`'s input where `launchOptsFromConfig` reads it (or pass it as a second argument; pick whichever keeps `config` the single source). Include it only for orchestrator. Thread it through `CreateRunOpts` → `createRunPayload` → `prototype`. Run the tests and expect PASS.

- [ ] **Step 3: Prefill.** Implement `prefillToLaunch` (the tests pass). In `NewRunModal`, on mount: if `newRunPrefillAtom` is set, `const p = prefillToLaunch(prefill, entries.map(([n]) => n))`. When `p.picked` is non-null, `setPicked(p.picked)`. Call `setStart(p.start)`, set the shape via the runconfigstore setter `ShapeCards` uses, `setGoal(p.goal)`, keep `p.prototype` in state, and clear the atom. The component does no mapping of its own. Under the goal field, when a prototype is set and the shape is orchestrator, render one muted line: `Prototype · {path}` (mono 11 `text-muted`, truncated with a full-path `title`) with an × (`aria-label="Remove prototype"`) that clears it. Pass it into the launch opts.

- [ ] **Step 4: Button.** In `CanvasPane`'s toolbar (while not marking, after Open in browser): **Build this…**, with the same classes as Open in browser. On click: `globalStore.set(newRunPrefillAtom, { projectName: agent.project ?? "", goal: buildGoal(canvas.dir, canvas.boards), prototype: prototypePath(canvas.dir, canvas.boards) })`, then `globalStore.set(model.newRunOpenAtom, true)`.

- [ ] **Step 5: Run.** The tests and the typecheck.

- [ ] **Step 6: Commit.** `git commit -m "feat(canvas): Build this… opens New run as an orchestrator run with the canvas as prototype"`

### Task 8: CDP scenario `canvas-swap`
**Depends on:** Task 4, Task 5

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (new scenario, registered like the others)

**Interfaces:**
- Consumes: `data-canvas-pane`, `data-canvas-board` (Task 4); `uireveal` on the cockpit route with `callerblockid`/`callercwd` (Task 1); the tree tag text `canvas`.

- [ ] **Step 1: Read** `scripts/cdp/scenarios.mjs` (the header and two scenarios that `h.rpc`), `scripts/cdp/attach.mjs` (how `h.rpc` routes, and whether it can target the `cockpit` route), and the memories on CDP: scope queries to a `data-*` container, and pin the viewport to 1600×950 before by-name clicks.

- [ ] **Step 2: Scenario.** `name: "canvas-swap"`, `surface: "agent"`. **arrange:** create a temp dir with `.superpowers/design/verify-canvas/project/{canvas.json, Main.dc.html}` (a canvas.json with one board, and a plain HTML page). Find the first live agent with a block id (from the cockpit's roster through an RPC the other scenarios use, or `wsh ui state`). If there is none, return a ctx that makes the scenario report "could not verify: no live agent" the way other scenarios skip (read how `final-verify.mjs` maps that to exit 3). Otherwise send `uireveal` with `{ address: "canvas:verify-canvas", callerblockid, callercwd: tmp }` to the cockpit route. **assert:** `[data-canvas-pane]` is present; the agent tree is absent; the header has buttons "Terminal" and "Canvas". Remember the terminal container's DOM node identity (tag it with a `data-verify-mark` attribute via `Runtime.evaluate` before the swap). Press `c` (focus the page first); the pane is gone, and the tagged terminal node is still the same node (the attribute is still there, so it was not remounted). Press `c` again → the pane is back. Delete the temp canvas folder and wait up to 5 s for the text "verify-canvas was removed". **teardown:** click "Back to terminal" if present, and delete the temp dir.

- [ ] **Step 3: Run** it against a dev app if one is running (`CDP_PORT=<port> task verify:ui -- canvas-swap`). If none is available, say so in your report: the Final stage runs it.

- [ ] **Step 4: Commit.** `git commit -m "test(cdp): canvas-swap scenario"`
