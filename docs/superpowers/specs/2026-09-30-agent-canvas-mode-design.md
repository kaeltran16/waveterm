# Agent canvas mode

An agent's design-local canvas (`.dc.html` boards) shows inside Arc on the Agent surface. The user
marks parts of a board and sends the marks to that agent as one terminal line, and a canvas can
start a build run with the canvas as the run's prototype.

**The approved mockup is the spec for everything visual:**
`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\agent-canvas-mode\project\Main.dc.html`
(interactive: its `start` prop switches between terminal, canvas and mark) and `States.dc.html`
(edge states). The folder is gitignored, so a worktree reads it by that absolute path. Where this
spec and the mockup disagree on a look, the mockup wins; this spec owns behaviour and wiring.

Follow `DESIGN.md`. Reuse the primitives the mockup copies: `element/segmented.tsx` (the swap and
the board tabs), `element/keycap.tsx`, the AgentHeader `ICON_BTN` and the pressed fullscreen
button (`border-accent bg-accentbg text-accent`) for the Mark toggle, and the app bar's button
classes for Open in browser / Build this… / Send. Colours are `@theme` tokens only; marks are
accent, not amber (the capture probe's amber was throwaway).

Out of scope: freehand drawing, sending to an agent other than the canvas owner, mapping marks to
elements inside the iframe, and persisting a canvas across an Arc restart.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Address `canvas:<topic>[/<board>]`, parsed in `address.ts`, landed by `openref.ts`, reachable as `wsh ui reveal canvas:<topic>`. | One router; reveal already carries the caller's block id. |
| 2 | `wsh ui reveal` also sends the caller's working directory (`callercwd`). The canvas directory is `<callercwd>/.superpowers/design/<topic>`. | design-local writes the canvas relative to the agent's cwd; the frontend has no other reliable way to find it on disk. |
| 3 | Per-agent canvas state is a jotai atom family keyed by agent id, in memory only. After an Arc restart the agent re-runs reveal. | Chosen by the user: session-only. |
| 4 | Canvas mode swaps the terminal for the canvas; it doesn't dock. The rail hides; the tree and the header stay, so another agent is one click away; the xterm stays mounted and hidden. | Mockup; the xterm must never remount. The tree first hid too, which made every trip to another agent a round trip through the terminal. |
| 5 | Every board is drawn at its canvas.json frame (x, y, w, h), the whole canvas scaled to fit the pane width, never above 100%. The toolbar shows the scale. | Chosen by the user. One board at a time left a narrow board (a 640 px sheet) in a pane of empty space while its sibling variants sat behind tabs. |
| 6 | Server port: probe 8766 upward for the topic's `Main.dc.html`, as the skill does, through `@tauri-apps/plugin-http` **without** Arc's auth key. | The plugin bypasses CORS (python's server sends none). `fetchutil.fetch` adds `X-AuthKey`, which must not reach a third-party local server. |
| 7 | Updates come from polling the served files' `Last-Modified` every 3 s, for the focused agent only, while the Agent surface is mounted. | Decided in the goal; one agent is on screen at a time. |
| 8 | "Canvas folder deleted" comes from disk (`FileInfoCommand` on the canvas dir, not-found), not HTTP. | A 404 can mean a server rooted elsewhere; the disk is the truth. |
| 9 | Capture: a new Tauri command returns the whole window's PNG bytes from WebView2 `CapturePreview`. The frontend crops to the board rect and writes the file through the existing file RPCs. | No image crate in Rust; the crop needs DOM rects, which only the frontend has. |
| 10 | Start server: a new Tauri command spawns `python -m http.server <port> --bind 127.0.0.1 --directory <project>/.superpowers/design`, detached and windowless. | Decided in the goal; this resolves the open question on States.dc.html. |
| 11 | Run prototype: `CommandCreateRunData.Prototype` → `Run.Prototype`, and at dag submit the run's value replaces the plan's `**Prototype:**`. `wsh runs start --prototype <path>` sets it. | Decided in the goal. |
| 12 | Keys that change label with state (`c` canvas/terminal, `m` mark/stop marking) are two bindings each, with exclusive `when()`s, so every footer chip has a static label. | `FooterHint.label` is static; the footer shows a chip iff its binding is active. |

## Address and reveal

`parseAddress` gains `canvas`: `canvas:<topic>` or `canvas:<topic>/<board>`. The topic must match
`^[A-Za-z0-9][A-Za-z0-9._-]*$` (a design-local topic; no separators, no `..`). The board is
optional; a bare name gets `.dc.html` appended, and a board must match the same pattern. Anything
else parses to unsupported. `OpenTarget` gains `{ kind: "canvas"; topic: string; board?: string }`.

`AddressHint` gains `caller?: { blockId: string; cwd: string }`. `CockpitUiClient.handle_uireveal`
fills it from `callerblockid` / `callercwd`. `CommandUiRevealData` gains
`CallerCwd string \`json:"callercwd,omitempty"\``; `wsh ui reveal` fills it from `os.Getwd()`.
Regenerate with `task generate`. The reveal help text lists `canvas:<topic>[/<board>]`.

`landCanvas(model, target, caller)`:

1. **With a caller:** the agent is the roster entry (agents and background terminals, as the
   agent landing reads it) whose `blockId` equals the caller's block id.
   None: unavailable, "Run wsh ui reveal canvas:<topic> from the agent's terminal". The canvas dir
   is `join(caller.cwd, ".superpowers/design", topic)`. If `<dir>/project` doesn't exist
   (`FileInfoCommand`, not-found): unavailable, "No canvas at <dir>/project".
2. **Without a caller** (a palette or citation open): the first agent whose canvas state has this
   topic. None: unavailable, "No agent has the canvas <topic> open".
3. With a caller, attach only: write the agent's canvas state (topic, dir, the board if given,
   else keep the current one) and return OK. The mode, the focus and the surface stay as they are:
   the agent reveals on every revision, and switching the user to it each time pulled them off
   whatever they were doing. The reveal's trail toast and the header's Canvas toggle say it is
   there. Without a caller (the user asked), set the owner's mode to `canvas`, then `jumpToAgent`
   (focus + surface `agent`).

## Canvas state (`canvasstore.ts`)

`canvasStateAtom(agentId)` (jotai `atomFamily`) holds `CanvasState | null`:

```ts
type CanvasState = {
    topic: string;
    dir: string;            // absolute: <cwd>/.superpowers/design/<topic>
    projectDir: string;     // the caller cwd, for the relative feedback path and Start server
    mode: "terminal" | "canvas";
    board: string | null;   // file name; null = first in order
    boards: CanvasBoard[];  // { name, w } in canvas.json order; w defaults to 1440
    port: number | null;
    status: "probing" | "ready" | "server-down" | "removed";
    lastModifiedMs: number | null; // newest Last-Modified across boards + canvas.json
    lastViewedMs: number;  // set on entering canvas mode and on every poll while in it
    marking: boolean;
    marks: Mark[];
    reloadKey: number;      // bumped when any board's Last-Modified moves, to reload the iframes
};
```

Removing an agent from the roster doesn't have to clear its entry (in memory, small). "Back to
terminal" from the removed state sets the state to `null`, so the swap control disappears.

**Poller** (a small hook in the Agent surface, like the other pollers): while the surface is
mounted and the focused agent has a canvas, every 3 s (`CANVAS_POLL_MS`):

1. `FileInfoCommand(<dir>/project)`: not-found → `status: "removed"`, stop.
2. With no port, or after a failed request: probe ports `8766 … 8785` (`CANVAS_PORT_FIRST`,
   `CANVAS_PORT_COUNT = 20`) with `HEAD /<topic>/project/Main.dc.html`. The first `200` is the
   port. None → `status: "server-down"`.
3. `GET /<topic>/project/canvas.json` → `boards` (the model below), then `HEAD` each board →
   `lastModifiedMs` = newest `Last-Modified`. If that moved past the previous newest while in canvas
   mode, bump `reloadKey`: every board is on screen, so any change reloads them. `status: "ready"`.
4. In canvas mode, `lastViewedMs = now`.

## Pure models (each with a `.test.ts` beside it)

`canvasmodel.ts`:

- `boardsFromCanvasJson(json)`: `order` filtered to names present in `boards` and ending in
  `.dc.html`; with no usable `order`, the `boards` keys with `Main.dc.html` first; malformed →
  the one Main board. Each entry is `{ name, x, y, w, h, title? }`: `w`/`h` default to 1440/900 when
  missing or not positive; a board with no `x`/`y` goes 80 px right of every board placed before it.
  `boardLabel(name)` strips `.dc.html`.
- `canvasLayout(boards, paneWidth)`: every board's frame in screen px, shifted so the top-left board
  sits at the origin and scaled by `fitScale(paneWidth, canvas width)`.
- `stepBoard(boards, current, delta)`: wraps.
- `classifyProbe(result)`: `200` → `serving`, network error → `free`, any other status → `taken`.
  `pickServingPort(results)` / `pickFreePort(results)`.
- `paneState(state)` → `"removed" | "server-down" | "probing" | "board"`: `removed` wins over
  `server-down`, which wins over `probing`; a `ready` status shows the `board`.
- `isUnseen(state)`: `mode === "terminal" && lastModifiedMs != null && lastModifiedMs > lastViewedMs`.
- `updatedAgo(now, ms)`: "updated 12s ago" / "4m" / "2h", matching the mockup's copy.
- `fitScale(paneWidth, width)`: `min(1, paneWidth / width)`. The toolbar shows `Math.round(scale*100)%`.
- `boardUrl(port, topic, board)`: `http://127.0.0.1:<port>/<topic>/project/<board>`.
- `buildGoal(dir, boards)`: `Build the design in <dir>/project (boards: Main, States)`.
- `prototypePath(dir, boards)`: `<dir>/project/<first board>`, absolute (a worktree has no copy of
  the gitignored folder).

`canvasmarks.ts`:

- The marks functions: `boxToMark(box)` keeps a box only if it is over 10 × 10 px (mockup), and
  `addMark(marks, box)` appends it. `removeMark(marks, i)` renumbers; `setMarkNote(marks, i, text)`.
  Clearing is the store's `clearMarks(agentId)`. A board switch clears the marks.
- `nextFeedbackName(entries)`: the highest `NNN.png` in the feedback dir + 1, zero-padded to 3
  (`001.png` when empty). Other names are ignored.
- `canvasHandoffLine(relPath, board, marks)`: built on `codehandoff.handoffLine`, so it gets the
  same single-line guarantee: `look at <relPath> — marks on <Board>.dc.html: 1 <note>; 2 <note>`.
  An empty note reads `(no note)`. `relPath` is
  `.superpowers/design/<topic>/feedback/NNN.png` with forward slashes, relative to the agent's cwd.
- `cropRect(boardRect, viewport, bitmap)`: board rect in CSS px × (`bitmap.width / innerWidth`),
  clamped to the bitmap.

## UI

**AgentSurface.** `canvasMode = state?.mode === "canvas"`. The tree renders when `!fullscreen`, the
details rail when `!fullscreen && !canvasMode`. The terminal stack keeps rendering, with the focused pane
`hidden` in canvas mode, and `CanvasPane` renders below the header in its place. The terminal
wrapper is never unmounted.

**AgentHeader.** When the agent has a canvas: a `Segmented` Terminal | Canvas left of the
fullscreen button, with an accent dot (6 px, `aria-label="updated since you last looked"`) on
Canvas when `isUnseen`. `Segmented` gains `ReactNode` labels, a per-option `title`, and
`aria-pressed`, a small additive change; its existing callers don't change. With no canvas, the
header is exactly today's (States 1).

**AgentTree row.** A `canvas` tag (mockup line 87: mono 10.5, `border-edge-mid`,
`text-accent-soft`) when the agent has a canvas. It is a toggle button: it focuses the agent and shows
its canvas, or, when that canvas is the one showing, goes back to the terminal. It carries the
`isUnseen` dot too.

**CanvasPane** (`canvaspane.tsx`, thin; logic in the models):

- Toolbar: topic, board tabs (`Segmented`, `role=tablist`, title "Previous and next board ([ and
  ])"), spacer, "updated Ns ago · NN%", the Mark toggle, and, while not marking, Open in browser
  (`openExternal(boardUrl)`) and Build this….
- Boards: `canvasLayout` places one frame per board, each an `<iframe src={boardUrl}
  key={reloadKey}>` at the board's natural size scaled by the layout's scale, with
  `sandbox="allow-scripts allow-same-origin"` (its own origin, never Arc's), and a label above it
  (name and canvas.json title). The canvas scrolls in the pane (`scrollbar-gutter: stable`, so the
  scrollbar can't change the fit scale), never inside an iframe. One board is selected (`board`):
  the one the tabs, `[` `]`, Mark and Open in browser act on, outlined in accent. The others wear a
  transparent cover, so the first click on one selects it rather than operating it. Picking a board
  whose top edge is off screen scrolls it into view, label included. Send captures only the part of
  the board inside the pane (`visibleRect`). CSP: add `frame-src http://127.0.0.1:*` in `src-tauri/tauri.conf.json`.
- Mark mode: an absolutely positioned overlay over the board: crosshair, accent outline, the
  "Drag a box around what you want changed" pill when empty, numbered boxes, a dashed draft. It
  covers the iframe, so the iframe can't take focus while marking. The tray below has one note
  input per mark, remove, Clear, "Send to <agent name>" (disabled with no marks), and the one-line
  explainer. All of it is copied from the mockup.
- Edge states (States 3 and 4), in place of the board:
  - **server-down:** `serverDownText(port)`: "Can't reach 127.0.0.1:<port>" for a port that
    stopped answering, "Nothing serves this canvas on 127.0.0.1:8766–8785" when none ever did; the explainer, and **Start server**
    (accent). It picks the first `free` port, calls `start_canvas_server`, then re-probes every
    500 ms for up to 5 s. On failure the message shows the error.
  - **removed:** "<topic> was removed", the explainer, **Back to terminal**. That button clears
    the agent's canvas state, so the control disappears.

**Send** (button or Ctrl+Enter, only with ≥ 1 mark):

1. `invoke("capture_webview")` → PNG bytes; `createImageBitmap`; crop with `cropRect` on an
   `OffscreenCanvas`; encode PNG.
2. `FileMkdirCommand(<dir>/feedback)`, list it, `nextFeedbackName`, then `FileWriteCommand`
   (`data64`).
3. `ControllerInputCommand(agent.blockId, line + "\r")`, as `codepathbar.tsx` does.
4. Clear the marks, marking off, mode `terminal`, focus the terminal.

Any failure shows the error in the tray and stops **before** typing anything. The marks stay,
so the user can retry.

**Build this…** writes `newRunPrefillAtom = { projectName: agent's project, goal:
buildGoal(...), prototype: prototypePath(...) }` and opens `newRunOpenAtom`. On mount,
`NewRunModal` consumes the prefill (then clears it): it picks that project, sets shape
`orchestrator` and start `goal`, and fills the goal. It shows one muted line under the goal,
"Prototype · <path>", with a remove ×. `launchOptsFromConfig`'s result carries `prototype`
through `createRun` into `CommandCreateRunData.prototype`. A user who switches the shape away
from orchestrator drops the prototype (the server rejects it on a quick run).

## Keys (`bindings.ts`, activated by the Agent surface's `useKeybindings`)

New in `buildAgentBindings`; `canvasOf(focused agent)` reads the atom:

| id | keys | when |
|---|---|---|
| `agent:canvas-open` | `c` | Navigate posture (`agentNav`), the agent has a canvas, mode `terminal` |
| `agent:canvas-close` | `c` | `agentNav`, mode `canvas` |
| `agent:canvas-prev` / `agent:canvas-next` | `[` / `]` | `agentNav`, mode `canvas`, not marking, status `ready` |
| `agent:mark-start` | `m` | `agentNav`, mode `canvas`, not marking, status `ready` |
| `agent:mark-stop` | `m` | `agentNav`, marking |
| `agent:canvas-send` | `Ctrl:Enter` | surface `agent`, `!modalOpen`, marking, ≥ 1 mark (live in a note input on purpose) |

No terminal chord for `c`, as decided. `surface:next` / `surface:prev` (`[` `]`) get
`&& focusedCanvasMode(model) == null` on the Agent surface, so the board keys can fire. While in canvas mode, the bindings
whose targets are hidden are gated off: `agent:toggle-rail`, `agent:fullscreen`,
`agent:fullscreen-chord` and `agent:back`. The agent switches (`agent:prev/next/prev-k/next-j`,
`cycle-agent-next/prev`) stay live, since the tree stays. The
footer then matches the mockup exactly (Main.dc.html `hints`).

`SURFACE_HINTS.agent` gains chips: `c canvas` (canvas-open), `c terminal` (canvas-close),
`[ ] board`, `m mark`, `m stop marking`, and `Ctrl Enter send`, in the mockup's order. Their
`when()`s decide visibility. `docs/keyboard-shortcuts.md` gains the rows.

## Tauri (`src-tauri`)

- `capture_webview(window) -> tauri::ipc::Response` (raw PNG bytes): `with_webview` →
  `controller().CoreWebView2()` → `CapturePreview(PNG)` into an in-memory stream
  (`CreateStreamOnHGlobal`), completion through a oneshot channel, bytes read back. It follows the
  probe at `C:\Users\kael02\AppData\Local\Temp\capture-probe\src\main.rs`. Windows-only
  (`#[cfg(windows)]`); elsewhere it returns an error. Dependencies: `webview2-com = "0.38"` and
  `windows = "0.61"` (features `Win32_Foundation`, `Win32_System_Com`,
  `Win32_System_Com_StructuredStorage` and `Win32_System_Memory`, for `CreateStreamOnHGlobal` / `HGLOBAL`) under `cfg(windows)`, pinned to the
  versions already in `Cargo.lock`, so there are no duplicate copies.
- `start_canvas_server(dir, port)`: `port` in 1024–65535; `dir` must be an existing directory whose
  path ends in `.superpowers\design` (or `/`). It spawns `python` with exactly the arguments
  above, with `CREATE_NO_WINDOW | DETACHED_PROCESS` and no inherited stdio. It returns an error
  (e.g. python not on PATH) rather than failing silently. Unit tests cover the argument validation.
- Register both in `generate_handler!`.

## Go

- `wshrpc.CommandCreateRunData.Prototype string \`json:"prototype,omitempty"\``, and
  `waveobj.Run.Prototype string \`json:"prototype,omitempty"\``, copied by CreateRun. CreateRun
  rejects a prototype on a non-orchestrator run with a clear error.
- Dag submit (`wshserver_dag.go`, where `proposed.Prototype = plan.Prototype`): if
  `run.Prototype != ""`, it wins. The plan-review replace path copies `proposed.Prototype`, so it
  holds across resubmits.
- `wsh runs start --prototype <path>`: `runsAbs` it, needs an orchestrator run (the same rule shape
  as `--parallelism`), and is validated in `runsStartData`.
- `wshrpc.CommandUiRevealData.CallerCwd`; `wsh ui reveal` sets it.
- `task generate` after the type changes.
- `SweepCanvasFeedback` (`wshserver_files.go`), in wavesrv's startup-then-every-4h cleanup loop:
  in each registered project, removes `.superpowers/design/*/feedback/NNN.png` older than 7 days.
  Only regular files with that name; a `feedback` dir that is a link or junction is skipped. A
  canvas in an unregistered folder is not swept. Nothing else deletes the pictures.

## Skill

`skills/design-local/SKILL.md`, loop step 3: after serving, run `wsh ui reveal canvas:<topic>`
from the agent's terminal, which attaches the canvas to the agent in Arc. If `wsh` is missing or
the command fails (not in Arc), fall back to listing the URLs as today. The line about each board,
the assumptions, and the states mapping stay.

## Errors

Every failure has a reason on screen: reveal errors go back to the calling agent's `wsh` (the
existing `revealError`). Pane failures show in the pane (edge states) or in the tray (Send). Start
server errors show under the button. Poll failures are not toasted; they become the server-down
state.

## Tests

- vitest: `address.test.ts` (canvas addresses, including rejects), `canvasmodel.test.ts`,
  `canvasmarks.test.ts` (reducer, `nextFeedbackName`, the handoff line, `cropRect`),
  `footerhints.test.ts` / `footer-visible.test.ts` (each new chip shows only when its binding
  fires, and the hidden-target bindings are off in canvas mode), `bindings.test.ts` (`[`/`]`
  yield to the board keys in canvas mode), `openref.test.ts` (the canvas landing: unknown caller,
  missing folder, owner lookup without a caller, success), `newrun.test.ts` (`prefillToLaunch`,
  and the prototype into the launch opts).
- Go: `runsStartData` (`--prototype` needs orchestrator), CreateRun rejects a prototype on a
  quick run, and dag submit: the run's prototype replaces the plan's, the plan's is kept when the
  run has none, and it holds across a plan-review resubmit.
- Rust: `start_canvas_server` validation; a `capture_webview` test is not practical headless.
- CDP `verify:ui` scenario `canvas-swap`: it writes a fixture canvas (`canvas.json` + a trivial
  `Main.dc.html`) under a temp dir, opens a plain terminal tab in the (isolated, agent-less) app,
  waits for it in the roster, and sends `uireveal` with that terminal's block id.
  It asserts: the reveal attaches without switching (the row's tag shows, the pane doesn't), the
  tag opens the pane, the tree stays, the swap control shows, and `c` returns to the terminal with the same
  xterm element (same DOM node). It then deletes the fixture and asserts the removed state. It
  reports it could not verify only if the terminal launch fails.
