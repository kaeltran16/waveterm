# Agent-drawn boards (Excalidraw) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-11-11-tldraw-in-arc-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/boardstore ./pkg/boardscribe ./pkg/boardthings ./pkg/agentsessions ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Setup:** `node scripts/worktree-junctions.mjs prepare && { ! grep -q '"@excalidraw/excalidraw"' package.json || test -d node_modules/@excalidraw/excalidraw || npm install --no-audit --no-fund; }`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs boards-surface boards-draw boards-follow`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\tldraw-in-arc

**Goal:** Boards you name and keep per project, drawn on by a separate read-only scribe agent: a Boards surface over
per-project `.excalidraw` files, a Draw on a board… palette drill, `wsh board draw`, source groups that are replaced in
place until you edit them (then a pending version you Keep or Drop), and following an agent's turn ends until Stop.

**Architecture:** Go owns the files and the scribe; the frontend owns the scene. `pkg/boardstore` reads, lists, creates
and rev-guards saves of `<data>/boards/<project>/<id>.excalidraw`, and keeps an inbox of scribe results beside each
board. `pkg/boardscribe` runs one headless, read-only `claude -p` (Sonnet) pass per (board, source), merges wakes that
arrive mid-pass into the next pass, and drops the skeleton it returns into the inbox. `pkg/boardthings` renders the
thing a source names (an agent's or a session's turns since a cursor; a run, initiative or record whole) as text. In
the frontend, a pure `boardmodel.ts` decides in-place replace vs pending frame and Keep/Drop; a shell-level applier
converts inbox skeletons with Excalidraw's `convertToExcalidrawElements` and applies them (to the open canvas when the
board is open, else to the file), then toasts. Follows live on the agent's tab meta, so they end when the tab closes.

**Tech Stack:** Go (wavesrv, wsh, wshrpc + `task generate`), React 19, jotai, Tailwind 4, `@excalidraw/excalidraw`
0.18.1 (pinned exact), vitest, the CDP scenario harness (`scripts/cdp/`).

The prototype's chosen boards are in `project/` (F8-Tree, N1-NewBoard, N2-NoBoards, D1-DrawPicker, D2-Drawing,
A1-AgentRow, E1-LoadError); `unchosen/` is out of scope. Every board has a scenario step below.

**Setup's cost:** the main checkout's `node_modules` has no Excalidraw until this lands, so once Task 1 merges every
later tree's Setup replaces its junctioned `node_modules` with a full local `npm install` (checked: npm replaces the
junction and leaves the main checkout untouched). That includes the Go-only Tasks 2-6, which do not need it; Setup
cannot tell a Go task from a frontend one, so the run pays a few minutes per tree for a safe, uniform tree.

## Decisions beyond the spec, and why

1. **Skeleton JSON only, no Mermaid.** The scribe returns `{"skeleton":[...]}` and nothing else. Why: one output
   format to check and convert; Mermaid lands fully only for flowcharts, which skeletons draw as well; and the
   standalone `@excalidraw/mermaid-to-excalidraw` latest (3.6.0) pulls an unrelated-looking dependency (`pele`),
   which is not worth vetting for a second format. The spec leaves this to the builder.
2. **Excalidraw 0.18.1, pinned exact** (`"@excalidraw/excalidraw": "0.18.1"`); peer range covers React 19. Its
   fonts and assets are served from the app (no CDN: the Tauri CSP is `default-src 'self'`, and the app must work
   offline).
3. **The scribe is a headless `claude -p`, not a judging-session worker tab.** `consult.Run` with the claude spec
   plus `--model sonnet --tools Read,Grep,Glob --strict-mcp-config`, cwd = the project's repo, and a guard that
   fails the pass closed unless the stream's init event lists only those three tools (the `pkg/memhygiene/model.go`
   pattern). Why: the spec wants read and search only, no edits and no shell; a worker tab would need a shell to
   report (`wsh jarvis complete`) and would show up as an agent in the cockpit. One-shot per pass, Sonnet, as the
   spec's "like the brainstorm judge" intends. Timeout per pass: 10 minutes.
4. **Conversion runs in the frontend; results wait in an inbox.** wavesrv writes each pass's result to
   `<project dir>/<board id>.inbox/<draw id>.json` and publishes `board:update`; the frontend applier converts and
   applies it, saves the board, then acks (deletes) the inbox file. A draw survives a reload or restart until applied.
   Why: `convertToExcalidrawElements` is a browser-side JS function, and the app's window is always up while wavesrv
   runs.
5. **Two writers, one guard.** wavesrv writes a board file only on create; every other write is the frontend's
   `BoardSaveCommand` with the rev it read (sha256 of the bytes). A stale rev returns `conflict: true` and the writer
   re-reads and reapplies. A file that will not parse is never overwritten: save refuses, draws on it wait in the
   inbox, and Draw refuses with the reason.
6. **Board file layout.** Excalidraw's JSON with Arc's record as the **first** key:
   `{"arc":{...},"type":"excalidraw","version":2,"source":"arc","elements":[],"appState":{},"files":{}}`. Every
   scribe element carries `customData.arcSource = <source key>` and the source's group id in `groupIds`. The record
   (Go `wshrpc.BoardArcRecord`, generated to TS) holds the name, created/seen times and one entry per source. Why
   first: a file damaged at its end (the usual damage) still names itself, so E1 can show the board's name;
   `boardstore` falls back to a regex over the first 4 KB for the name, else the id.
7. **Board ids** are 8 lowercase hex chars (a uuid prefix, re-drawn on collision); every RPC validates
   `^[0-9a-f]{8}$` before touching a path. **Project dir** is the channel's name with `<>:"/\|?*` and trailing
   dots/spaces replaced by `_` (empty → `_`), under `wavebase.GetWaveDataDir()/boards/`. Names need not be unique.
8. **A source** is the thing plus the ask. Key: `<kind>:<ref>` plus `|<ask>` when there is an ask, the ask trimmed,
   lowercased and whitespace-collapsed. Kinds and refs: `agent` → tab id; `session` → `<runtime>:<id>` (with the
   transcript path in `path`); `run` → run id (with its channel in `channelid`); `effort` → effort oid; `record` →
   dossier id. Transcripts (agent, session) read only the turns since the source's cursor (the last turn ts read);
   run, effort and record are read whole each pass. A thing's text is capped at 60,000 chars, keeping the newest.
9. **Content edit detection.** Each source stores the `contenthash` of its group as drawn: a hash over the group's
   live elements' sorted `(id, type, text)` triples, so moving, resizing or restyling never changes it, and editing
   text, adding an element to the group or deleting one does. The canvas's autosave stamps `editedts` on a source
   the first time its hash differs. A redraw of a source whose hash is unchanged replaces it in place, keeping the
   group's current top-left and its scale (current bbox width / the bbox width as drawn, stored in `box`).
10. **Pending version, Keep, Drop.** A redraw of an edited source lands as an Excalidraw frame named
    `Pending redraw · <ask, or the source title>`, its elements at opacity 40, placed 80px right of the edited group,
    top-aligned; a later redraw replaces the pending frame's contents. **Keep**: the frame goes, its elements return
    to full opacity and become the source's group (new hash, `editedts` cleared); the edited group's elements lose
    their `arcSource` tag and count among Your shapes. **Drop**: the frame and its elements are deleted; the edited
    group stays the source's group, still edited.
11. **A first draw** of a source is placed 120px right of the board's content bbox, top-aligned (origin on an empty
    board), with new element ids (`regenerateIds`).
12. **Follows live on the agent's tab meta**: `board:followid` (board id), `board:followchannel`,
    `board:followname` (board name, for the chip), `board:followask`. One follow per agent: ticking Keep following
    onto another board replaces it. Closing the agent deletes its tab and with it the follow; Stop clears the keys.
    The Boards surface and the Agent tree read follows from those keys over the live roster. A follow only wakes on
    turn ends (`agent:status` idle or waiting, the hook `noteAgentTurnEnded` already sees).
13. **Scribe status is in wavesrv memory** (`drawing` with what it reads and how many wakes are queued, or `failed`
    with the reason), not persisted: a restart cannot resume a pass, and a failed row's Retry needs the live pass.
    No global cap on concurrent passes: each (board, source) runs at most one, and follows are explicit.
14. **`wsh board draw --board <name> [--ask "..."]`** draws the calling agent's own session on the named board in
    its project (the channel at the agent's cwd, else one ensured from its session project and cwd). The name
    matches trimmed and case-insensitively, the most recently drawn match wins, and no match creates the board. Its
    first pass reads from the second-to-last human prompt on, so "put that on the board" carries the answer "that"
    names. It never follows and opens no UI. The `arc:cockpit` skill gets one line naming it for when the user asks
    to put something on a board (a reference, not an instruction to draw; the spec's no-drawing-in-context rule
    holds).
15. **The palette drill is a new `ActionInput` kind `board`**, with steps board → (name, New board only) → ask. Tab
    toggles Keep following only at the ask step and only for an agent; everywhere else Tab keeps switching scope.
16. **The draw toast has an Open action**: `ToastNotification` gains `action?: { label: string; run: () => void }`.
    Success: title `Scribe drew <n> shape(s) on <board>`, message `From <source title>` plus ` · following` for a
    follow's pass. Failure (error level): `Scribe couldn't draw on <board>`, message `<source title>: <reason>`.
    Shape count = skeleton entries.
17. **The Boards surface's project** is a subject (`surfacecontext` `{ project: "subject" }`): it shows the project
    a router landing named, else the cockpit's current project.
18. **Source rows** (D2): title = the ask, else the source title; second line = (the ask ? the source title :
    `no ask` plus `, read whole` for run, effort and record) · `<n> shapes` · drawn time. Your shapes row:
    text elements count as notes, others as shapes (`1 note`, `3 shapes`, `1 note, 2 shapes`) ·
    `the scribe never changes them`. Times are `HH:MM` today, else `MM-DD`.

## Global Constraints

- No new design tokens; colors come from the `@theme` tokens in `frontend/tailwindsetup.css`; follow `DESIGN.md`.
- Nothing draws unless the user asks (palette action, `wsh board draw` on the user's request, or a follow they ticked).
- Run milestones never wake the scribe; no skill or prompt tells a working agent to draw.
- Boards stay on the machine: under Arc's data folder, never in the vault, git or a sync.
- The scribe never touches shapes without its `arcSource` tag, and never rewrites a group you edited.
- `@excalidraw/excalidraw` stays pinned exact at `0.18.1`.
- Free g-leader letter for Boards: `w` (h a c s f u b . , are taken).
- Every task that changes a Go type wshrpc, waveobj or wconfig generates with `task generate` and commits the outputs.

## Review Focus

1. **A board edited by hand while the scribe's draw lands.** Expect the open canvas to take the draw live
   (`updateScene`), never a stale-rev overwrite of the hand edit. Pinned by Task 8's applier tests (conflict re-read)
   and Task 9's live-apply path.
2. **A damaged board file.** Expect E1: the list row reads `won't open`, the surface shows the reason, path and Retry,
   save refuses, draws wait. Pinned by Task 2's tests and Task 9's E1 step.
3. **A follow whose agent closes mid-pass.** Expect the pass to finish and land, and no further wakes; nothing errors.
   Pinned by Task 6's turn-end test (a tab with no follow keys wakes nothing).
4. **Turn ends arriving while the scribe draws.** Expect one queued pass reading everything new, not one pass per wake.
   Pinned by Task 4's scheduler tests.
5. **Path input from the RPC wire** (board id, project name). Expect a bad id refused before any path is built.
   Pinned by Task 2's id-validation test.

---

### Task 1: Board wire contract, dependency and scenario stubs
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_board.go`, `pkg/wshrpc/wshrpctypes.go`, `pkg/waveobj/wtypemeta.go`, `pkg/waveobj/metaconsts.go`, `pkg/wps/wpstypes.go`, `pkg/tsgen/tsgenevent.go`, `pkg/wshrpc/wshserver/wshserver_board.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `frontend/types/waveevent.d.ts`, `pkg/boardstore/doc.go`, `pkg/boardscribe/doc.go`, `pkg/boardthings/doc.go`, `package.json`, `package-lock.json`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-boards-surface.mjs`, `scripts/cdp/scenarios-boards-draw.mjs`, `scripts/cdp/scenarios-boards-follow.mjs`

Every later task builds on these names; implement exactly these shapes.

- [ ] **Step 1: `pkg/wshrpc/wshrpctypes_board.go`** with a `BoardCommands` interface embedded in `WshRpcInterface`
  (`wshrpctypes.go`), following `wshrpctypes_note.go`'s style:

```go
type BoardCommands interface {
	BoardListCommand(ctx context.Context, data CommandBoardListData) (*BoardListRtnData, error)
	BoardCreateCommand(ctx context.Context, data CommandBoardCreateData) (*BoardInfo, error)
	BoardReadCommand(ctx context.Context, data CommandBoardRefData) (*BoardReadRtnData, error)
	BoardSaveCommand(ctx context.Context, data CommandBoardSaveData) (*BoardSaveRtnData, error)
	BoardDrawCommand(ctx context.Context, data CommandBoardDrawData) error
	BoardAgentDrawCommand(ctx context.Context, data CommandBoardAgentDrawData) (*BoardAgentDrawRtnData, error)
	BoardRetryCommand(ctx context.Context, data CommandBoardSourceData) error
	BoardFollowStopCommand(ctx context.Context, data CommandBoardFollowStopData) error
	BoardStatusCommand(ctx context.Context, data CommandBoardRefData) (*BoardStatusData, error)
	BoardInboxCommand(ctx context.Context, data CommandBoardInboxData) ([]BoardDraw, error)
	BoardInboxAckCommand(ctx context.Context, data CommandBoardInboxAckData) error
}

type CommandBoardListData struct{ ChannelId string `json:"channelid"` }
type BoardListRtnData struct {
	Project string      `json:"project"` // the channel's name
	Boards  []BoardInfo `json:"boards"`  // most recently drawn first, never-drawn by created time
}
type BoardInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ChannelId   string `json:"channelid"`
	Path        string `json:"path"` // the .excalidraw file, absolute
	Groups      int    `json:"groups"`
	LastDrawnTs int64  `json:"lastdrawnts,omitempty"`
	CreatedTs   int64  `json:"createdts"`
	NewCount    int    `json:"newcount,omitempty"` // sources drawn after the record's seents
	State       string `json:"state,omitempty"`    // "drawing" | "failed" while the scribe works on it
	LoadError   string `json:"loaderror,omitempty"`
}
type CommandBoardCreateData struct {
	ChannelId string `json:"channelid"`
	Name      string `json:"name"`
}
type CommandBoardRefData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid"`
}
type BoardReadRtnData struct {
	Info BoardInfo      `json:"info"`
	Data string         `json:"data"` // the file's JSON text
	Rev  string         `json:"rev"`
	Arc  BoardArcRecord `json:"arc"`
}
type CommandBoardSaveData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid"`
	Data      string `json:"data"`
	BaseRev   string `json:"baserev"`
}
type BoardSaveRtnData struct {
	Rev      string `json:"rev,omitempty"`
	Conflict bool   `json:"conflict,omitempty"` // the file changed since BaseRev; nothing was written
}
// BoardSource is the thing a draw reads. Kind: agent | session | run | effort | record.
type BoardSource struct {
	Kind      string `json:"kind"`
	Ref       string `json:"ref"`
	ChannelId string `json:"channelid,omitempty"` // a run's channel
	Path      string `json:"path,omitempty"`      // a session's transcript
	Runtime   string `json:"runtime,omitempty"`   // a session's runtime
	Title     string `json:"title"`               // as rows and toasts name it: "claude · waveterm", "run 690cc20a"
}
type CommandBoardDrawData struct {
	ChannelId string      `json:"channelid"`
	BoardId   string      `json:"boardid"`
	Source    BoardSource `json:"source"`
	Ask       string      `json:"ask,omitempty"`
	Follow    bool        `json:"follow,omitempty"` // agent sources only
}
type CommandBoardAgentDrawData struct {
	BlockId string `json:"blockid"`
	Board   string `json:"board"`
	Ask     string `json:"ask,omitempty"`
}
type BoardAgentDrawRtnData struct {
	BoardId   string `json:"boardid"`
	BoardName string `json:"boardname"`
	Project   string `json:"project"`
	Created   bool   `json:"created,omitempty"`
}
type CommandBoardSourceData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid"`
	SourceKey string `json:"sourcekey"`
}
type CommandBoardFollowStopData struct{ TabId string `json:"tabid"` }
type BoardSourceStatus struct {
	SourceKey string      `json:"sourcekey"`
	Source    BoardSource `json:"source"`
	Ask       string      `json:"ask,omitempty"`
	State     string      `json:"state"`             // "drawing" | "failed"
	Reading   string      `json:"reading,omitempty"` // "the 16:09 turn end", "the run, read whole"
	Queued    int         `json:"queued,omitempty"`  // wakes that came in during this pass
	Reason    string      `json:"reason,omitempty"`
	Ts        int64       `json:"ts"` // when the pass started or failed
}
type BoardStatusData struct {
	ChannelId string              `json:"channelid"`
	BoardId   string              `json:"boardid"`
	Sources   []BoardSourceStatus `json:"sources"`
}
// BoardDraw is one scribe result waiting in a board's inbox.
type BoardDraw struct {
	ID        string      `json:"id"`
	ChannelId string      `json:"channelid"`
	BoardId   string      `json:"boardid"`
	SourceKey string      `json:"sourcekey"`
	Source    BoardSource `json:"source"`
	Ask       string      `json:"ask,omitempty"`
	Skeleton  string      `json:"skeleton"` // JSON array text of Excalidraw element skeletons
	Shapes    int         `json:"shapes"`
	CursorTs  int64       `json:"cursorts,omitempty"`
	Follow    bool        `json:"follow,omitempty"`
	Ts        int64       `json:"ts"`
}
type CommandBoardInboxData struct { // both empty: every board's waiting draws
	ChannelId string `json:"channelid,omitempty"`
	BoardId   string `json:"boardid,omitempty"`
}
type CommandBoardInboxAckData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid"`
	DrawId    string `json:"drawid"`
}
// BoardArcRecord is the board file's "arc" key (its first key). Go reads it; the frontend writes it.
type BoardArcRecord struct {
	Name      string           `json:"name"`
	CreatedTs int64            `json:"createdts"`
	SeenTs    int64            `json:"seents,omitempty"`
	Sources   []BoardArcSource `json:"sources,omitempty"`
}
type BoardArcSource struct {
	Key         string           `json:"key"`
	Source      BoardSource      `json:"source"`
	Ask         string           `json:"ask,omitempty"`
	GroupId     string           `json:"groupid"`
	DrawnTs     int64            `json:"drawnts"`
	Shapes      int              `json:"shapes"`
	ContentHash string           `json:"contenthash"`
	EditedTs    int64            `json:"editedts,omitempty"`
	Box         *BoardBox        `json:"box,omitempty"` // the group's bbox as drawn
	Skeleton    string           `json:"skeleton"`      // the scribe's last skeleton for this group
	CursorTs    int64            `json:"cursorts,omitempty"`
	Pending     *BoardArcPending `json:"pending,omitempty"`
}
type BoardBox struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}
type BoardArcPending struct {
	DrawId   string `json:"drawid"`
	DrawnTs  int64  `json:"drawnts"`
	FrameId  string `json:"frameid"`
	Shapes   int    `json:"shapes"`
	Skeleton string `json:"skeleton"`
	CursorTs int64  `json:"cursorts,omitempty"`
}
// BoardUpdateData is board:update's payload. What: list | status | draw | failed.
type BoardUpdateData struct {
	ChannelId string `json:"channelid"`
	BoardId   string `json:"boardid,omitempty"`
	What      string `json:"what"`
	SourceKey string `json:"sourcekey,omitempty"`
	Reason    string `json:"reason,omitempty"`
}
```

- [ ] **Step 2: Tab meta keys** in `pkg/waveobj/wtypemeta.go`, beside the brainstorm keys: `board:followid`,
  `board:followchannel`, `board:followname`, `board:followask` (all `string`, comment `// tab (...)`).
- [ ] **Step 3: Event** `Event_BoardUpdate = "board:update" // type: wshrpc.BoardUpdateData` in
  `pkg/wps/wpstypes.go`, added to `AllEvents`, with its `WaveEventDataTypes` entry (`wshrpc.BoardUpdateData`) in
  `pkg/tsgen/tsgenevent.go` (`TestWaveEventDataTypesCoverage` guards the pair).
- [ ] **Step 4: Stubs** in `pkg/wshrpc/wshserver/wshserver_board.go`: every `Board*Command` returns
  `errors.New("boards: not implemented yet")` (Tasks 3 and 6 replace them), so the server compiles.
- [ ] **Step 5: Package docs** `pkg/boardstore/doc.go`, `pkg/boardscribe/doc.go`, `pkg/boardthings/doc.go`: a
  package comment saying what each owns (store: board files and inbox; scribe: prompt, reply check, runner,
  scheduler; things: a source's text). Verify's package list needs them to exist.
- [ ] **Step 6: `task generate`**; confirm the generated TS (`BoardInfo`, `BoardArcRecord`, `RpcApi.BoardDrawCommand`,
  `"board:update"` in `waveevent.d.ts`) and the meta consts appear.
- [ ] **Step 7: Dependency**: `npm install --save-exact @excalidraw/excalidraw@0.18.1` (this tree's junctioned
  `node_modules` is replaced by a local install; that is expected). `package.json` must read `"0.18.1"` exactly.
- [ ] **Step 8: Scenario stubs**: `scenarios-boards-surface.mjs`, `scenarios-boards-draw.mjs`,
  `scenarios-boards-follow.mjs` each `export const BOARDS_<AREA>_SCENARIOS = [];` with a header comment naming the
  task that fills it (Task 9, 10, 11), spread into `SCENARIOS` in `scripts/cdp/scenarios.mjs`. Each later task fills
  only its own file, so `scenarios.mjs` is edited once.
- [ ] **Step 9:** `go build ./pkg/... ./cmd/wsh/...` and the Check command pass.

### Task 2: Board files and inbox (`pkg/boardstore`)
**Depends on:** Task 1 (the wshrpc board types and the package doc)
**Files:** `pkg/boardstore/boardstore.go`, `pkg/boardstore/boardstore_test.go`

Pure file operations over a project dir; no wstore, no RPC. Signatures (all take the project dir so tests use
`t.TempDir()`):

```go
func Root() string                       // wavebase.GetWaveDataDir()/boards
func ProjectDir(project string) string   // Root()/<sanitized project>, decision 7
func ValidID(id string) bool             // ^[0-9a-f]{8}$
func List(dir, channelId string, state func(boardId string) string) ([]wshrpc.BoardInfo, error)
func Create(dir, channelId, name string, now int64) (wshrpc.BoardInfo, error)
func Read(dir, channelId, id string) (wshrpc.BoardReadRtnData, error)
func Save(dir, id, data, baseRev string) (wshrpc.BoardSaveRtnData, error)
func PutDraw(dir string, d wshrpc.BoardDraw) error
func Draws(dir, boardId string) ([]wshrpc.BoardDraw, error)   // oldest first; "" boardId: every board in dir
func AckDraw(dir, boardId, drawId string) error               // a missing draw is not an error
func Previous(dir, boardId, key string) (skeleton string, cursorTs int64, err error)
```

- Missing project dir lists as no boards. `Create` trims the name; empty → error `Type a name first`. It writes the
  decision-6 layout with `arc` first, `0o644`, via temp file + rename, and creates the dir.
- `List`/`Read`: an unparseable file is listed with `LoadError` =
  `its file is not valid Excalidraw JSON (<json error>, at line <n>)` (line from the error offset), its name from
  the first-4KB regex fallback else the id; `Read` of it returns that error text. `Groups` = len(sources),
  `LastDrawnTs` = max `drawnts`, `NewCount` = sources with `drawnts > seents`, `State` from the callback.
- `Save` refuses an invalid id, data whose JSON lacks an `arc` object with a non-empty name, and a current file that
  will not parse (error naming the load error); returns `Conflict` without writing when `baseRev` is not the current
  rev. Rev = hex sha256 of the bytes. Saves on one dir are serialized (a mutex per dir).
- `PutDraw` writes `<dir>/<board>.inbox/<draw id>.json`; draw ids are uuids. `Previous` returns the newest unacked
  inbox draw's skeleton and cursor for `key`, else the file's source entry's, else `"", 0`.
- [ ] **Tests** (`go test ./pkg/boardstore -run 'TestBoardStore'`): `TestBoardStoreCreateListRead` (create two, draw
  times order the list, `NewCount` counts after `seents`); `TestBoardStoreCreateRefusesEmptyName`;
  `TestBoardStoreSaveConflict` (stale rev → `Conflict`, file unchanged); `TestBoardStoreDamagedFile` (a file cut in
  half lists `LoadError` with a line and the name from the arc prefix, `Save` refuses, bytes unchanged);
  `TestBoardStoreRejectsBadIDs` (`../x`, `ABCDEF12`, `7c1e0b4` refused before any path is built);
  `TestBoardStoreProjectDirSanitizes` (`a:b?` → `a_b_`); `TestBoardStoreInbox` (put two, list oldest first, ack
  one, ack missing is nil, `Previous` prefers the inbox over the file).

### Task 3: Board file RPCs
**Depends on:** Task 2 (boardstore)
**Files:** `pkg/wshrpc/wshserver/wshserver_board.go`, `pkg/wshrpc/wshserver/wshserver_board_test.go`

The boardstore-backed handlers, early, so the UI tasks' scenarios run against real RPCs in their own trees.

- Replace Task 1's stubs for `BoardListCommand`, `BoardCreateCommand`, `BoardReadCommand`, `BoardSaveCommand`,
  `BoardInboxCommand`, `BoardInboxAckCommand` and `BoardFollowStopCommand`; leave the Draw, AgentDraw, Retry and
  Status stubs for Task 6.
- A channel id resolves to the channel object (`wstore.DBMustGet[*waveobj.Channel]`): its name gives the project dir
  (`boardstore.ProjectDir`). Every handler validates ids (`boardstore.ValidID`) first. `List` passes the seam
  `var boardState = func(channelId, boardId string) string { return "" }` as the state callback (Task 6 points it at
  the scheduler). `Create`, `Save` and `InboxAck` publish `board:update` with `what: "list"` through
  `wps.Broker.Publish`. `BoardInboxCommand` with both ids empty walks every project dir under `boardstore.Root()`.
- `BoardFollowStopCommand` clears the four `board:follow*` keys on the tab (`wstore.UpdateObjectMeta` with nils) and
  broadcasts it (`wcore.SendWaveObjUpdate`), as `setBrainstormRecord` does.
- [ ] **Tests**: `go test ./pkg/wshrpc/wshserver -run 'TestBoardFiles|TestBoardFollowStopClearsMeta'`:
  `TestBoardFilesCreateListReadSave` (round trip through the handlers on a temp data dir; a stale rev returns
  `conflict`), `TestBoardFilesRejectBadIds`, `TestBoardFilesInboxAllProjects`, `TestBoardFollowStopClearsMeta`.

### Task 4: The scribe (`pkg/boardscribe`)
**Depends on:** Task 1 (the wshrpc board types and the package doc)
**Files:** `pkg/boardscribe/scribe.go`, `pkg/boardscribe/scribe-prompt.md`, `pkg/boardscribe/runner.go`, `pkg/boardscribe/scheduler.go`, `pkg/boardscribe/scribe_test.go`, `pkg/boardscribe/scheduler_test.go`

Pure half plus runner plus scheduler; it reads nothing itself (the thing reader, store and publisher are injected).

```go
func SourceKey(src wshrpc.BoardSource, ask string) string                // decision 8
type PromptInput struct {
	BoardName, Ask, SourceTitle, ThingText, Reading string
	Previous string // the group's current skeleton, "" on a first draw
}
func Prompt(in PromptInput) string                                        // fills the embedded scribe-prompt.md
func CheckReply(reply string) (skeleton string, shapes int, err error)
var RunModel = func(ctx context.Context, cwd, prompt string) (string, error) // decision 3; tests replace it
type Pass struct {
	ChannelId, BoardId, BoardName, ProjectPath, Key string
	Source wshrpc.BoardSource
	Ask    string
	Follow bool
	FromTs int64 // > 0: read from here instead of the source's cursor (wsh board draw's first pass)
}
type Deps struct {
	ReadThing func(ctx context.Context, src wshrpc.BoardSource, sinceTs int64) (text, reading string, cursorTs int64, err error)
	Previous  func(channelId, boardId, key string) (skeleton string, cursorTs int64, err error)
	Deliver   func(d wshrpc.BoardDraw) error
	Publish   func(u wshrpc.BoardUpdateData)
	Run       func(ctx context.Context, cwd, prompt string) (string, error)
	Now       func() int64
}
func NewScheduler(d Deps) *Scheduler
func (s *Scheduler) Wake(p Pass)
func (s *Scheduler) Retry(channelId, boardId, key string) error
func (s *Scheduler) Status(channelId, boardId string) []wshrpc.BoardSourceStatus
func (s *Scheduler) BoardState(channelId, boardId string) string // "drawing" if any source draws, else "failed" if any failed, else ""
```

- **Prompt** (`scribe-prompt.md`): it is a scribe drawing onto the board `[BOARD]` what `[SOURCE]` explains, focused
  on `[ASK]` (or the whole thing); it may read and search the repo (its cwd) only to check code the thing mentions;
  on a redraw it gets `[PREVIOUS]` and returns the whole replacement group, keeping what still holds; its reply is
  one JSON object `{"skeleton":[...]}` and nothing else. It lists the skeleton vocabulary: `rectangle`, `ellipse`,
  `diamond`, `text`, `line`, `arrow`; containers with `label: {text}`; arrows bound with `start: {id}` / `end: {id}`;
  every shape with a unique string `id`; at most 200 entries.
- **CheckReply**: trims; accepts the object alone or inside one ```` ```json ```` fence; empty →
  `NoDrawingReason = "the scribe session ended without returning a drawing"`; otherwise errors start
  `"the scribe's drawing is not usable: "` for: not one JSON object, no `skeleton` array, an empty array, more than
  `MaxShapes = 200`, a type outside the list, a missing or duplicate id, an arrow `start`/`end` id that names no
  entry. Returns the array re-marshalled compactly and its length.
- **RunModel** default: `consult.SpecFor("claude")` + `--model sonnet --tools Read,Grep,Glob --strict-mcp-config`,
  a 10-minute context, and an init guard that fails closed unless the init event's tools are a subset of
  `Read, Grep, Glob` (mirror `pkg/memhygiene/model.go`'s `modelGuard`).
- **Scheduler**: one pass at a time per `(channel, board, key)`. `Wake` during a pass counts `Queued` and keeps the
  newest `Pass`; when the pass ends with wakes queued it runs once more, reading what is new. A pass: publish
  `status`; read the thing from `FromTs` or the cursor (`Previous` on first use after start, then remembered); empty
  text (nothing new) ends the pass silently; else prompt, `Run`, `CheckReply`, `Deliver` a `BoardDraw` (new uuid,
  `Follow` from the pass), remember skeleton and cursor, publish `draw`. Any failure records `failed` with the
  reason (read and run errors as their text), publishes `failed` with the reason, and keeps the last Pass for
  `Retry`. `Retry` of a key with no failed pass errors. A delivered pass clears the key's status.
- [ ] **Tests** (`go test ./pkg/boardscribe -run 'TestSourceKey|TestCheckReply|TestPrompt|TestScheduler'`):
  `TestSourceKey` (`agent:t1`, `agent:t1|the data model` from `"  The   Data model "`); `TestCheckReply` table (plain,
  fenced, empty → `NoDrawingReason`, prose around the object, bad type, dangling arrow id, 201 entries);
  `TestPromptRedrawCarriesPrevious`; `TestSchedulerMergesWakesDuringAPass` (a blocking fake `Run`, three wakes →
  `Queued` 3 in `Status`, exactly two `Run` calls, the second reading from the first's cursor);
  `TestSchedulerNothingNewSkipsModel`; `TestSchedulerFailureAndRetry` (empty reply → failed with
  `NoDrawingReason`, a `failed` publish, `Retry` delivers); `TestSchedulerFromTsOverridesCursor`.

### Task 5: A source's text (`pkg/boardthings`) and turns since a time
**Depends on:** Task 1 (the wshrpc board types and the package doc)
**Files:** `pkg/boardthings/boardthings.go`, `pkg/boardthings/boardthings_test.go`, `pkg/agentsessions/turns.go`, `pkg/agentsessions/turns_test.go`

```go
// pkg/agentsessions/turns.go
type Turn struct { Role string; Text string; Ts int64 } // Role "user" | "assistant"
func TurnsSince(path, runtime string, sinceTs int64) []Turn // claude and pi; main chain only, text blocks only
// pkg/boardthings
const MaxThingChars = 60000
func Read(ctx context.Context, src wshrpc.BoardSource, sinceTs int64) (text, reading string, cursorTs int64, err error)
```

- `TurnsSince` reuses the line parsing `lastanswer.go` and `humanprompts.go` already do (human prompts as `user`,
  `claudeReplyText` answers as `assistant`; pi through `pisession`), keeping turns with `Ts > sinceTs`.
- `Read` by kind: `agent` (ref = tab id → its first block's transcript path, the block meta the server's
  `blockTranscriptMeta` reads, and the tab's `session:agent` runtime) and `session` (`path` + `runtime`) render the
  turns as `User:` / `Agent:` paragraphs, `reading` = `the HH:MM turn end` of the last turn, `cursorTs` = the last
  turn's ts, no turns → `"", "", sinceTs, nil`; `run` (`wstore.GetRun(ctx, src.ChannelId, src.Ref)`): goal, status, tasks and
  report, `reading` = `the run, read whole`; `effort` (`effortstore.Get(ctx, src.Ref)`): title, status, chunks, notes, `reading`
  = `the initiative, read whole`; `record` (the dossier, loaded the way the record RPCs load it): summary, state,
  decisions, `reading` = `the record, read whole`. Over `MaxThingChars`, keep the newest end and prefix
  `[earlier part cut]`. An unknown kind or missing thing errors naming the kind and ref.
- [ ] **Tests**: `go test ./pkg/agentsessions -run 'TestTurnsSince'` (a claude fixture with a sidechain and a
  tool-only turn: only main-chain text, only after `sinceTs`; a pi fixture); `go test ./pkg/boardthings -run
  'TestReadSession|TestReadCapsToNewest|TestReadUnknownKind'` (session read from a temp transcript: text, reading,
  cursor; nothing new returns empty text and the same cursor).

### Task 6: The scribe in wavesrv: Draw, follows, turn ends and `wsh board draw`
**Depends on:** Task 3 (the board file RPCs and the boardState seam), Task 4 (the scheduler), Task 5 (boardthings.Read)
**Files:** `pkg/wshrpc/wshserver/wshserver_board.go`, `pkg/wshrpc/wshserver/wshserver_boardscribe.go`, `pkg/wshrpc/wshserver/wshserver_boardscribe_test.go`, `pkg/wshrpc/wshserver/wshserver.go`, `cmd/wsh/cmd/wshcmd-board.go`, `cmd/wsh/cmd/wshcmd-board_test.go`, `skills/cockpit/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/cockpit/SKILL.md`

- In `wshserver_boardscribe.go`: one package-level scheduler (`boardscribe.NewScheduler`) wired to
  `boardthings.Read`, `boardstore.Previous`/`PutDraw` on the board's project dir, `wps.Broker.Publish` of
  `board:update`, and `boardscribe.RunModel`; a `var` seam so tests swap it. Point Task 3's `boardState` seam at
  `scheduler.BoardState`. Move the Draw, AgentDraw, Retry and Status handlers here, deleting their stubs from
  `wshserver_board.go`. The channel's `ProjectPath` is the scribe's cwd.
- `Draw` refuses a board that won't open (its load error), a `Follow` on a non-agent source, and an empty source;
  with `Follow` it writes the four `board:follow*` keys on the agent's tab (replacing any earlier follow) and
  broadcasts the tab; then `Wake`s. `BoardRetryCommand` → `Retry`. `BoardStatusCommand` → `Status`.
- `BoardAgentDrawCommand`: block → tab → the agent's cwd and session project → channel (decision 14) → board by
  name or created → `Wake` with `Source{Kind:"agent", Ref:<tab id>, Title:<the tab's agent label>}` and `FromTs` =
  the second-to-last human prompt's ts (`agentsessions.HumanPrompts`), 0 when it has fewer than two.
- Turn ends: in `publishEvent` after `noteAgentTurnEnded`, `noteBoardFollowTurnEnded(ctx, &data)` resolves the
  status event's tab (block or tab oref, as `noteAgentTurnEnded` does), and when it carries `board:followid` wakes
  that board with the agent source, the follow's ask and `Follow: true`. A tab without the key wakes nothing.
- `cmd/wsh/cmd/wshcmd-board.go`: `wsh board draw --board <name> [--ask "<what to draw>"]` (`--board` required),
  `PreRunE: preRunSetupRpcClient`, the caller's block from `resolveBlockArg`, a testable
  `boardDrawStart(blockId, board, ask string, send func(wshrpc.CommandBoardAgentDrawData) (*wshrpc.BoardAgentDrawRtnData, error)) (string, error)`
  returning the printed line `drawing on <board> in <project>` (`, a new board` when created). It returns as soon as
  the pass is queued.
- `skills/cockpit/SKILL.md`: one short section: when the user asks you to put something on a board, run
  `wsh board draw --board "<name>" --ask "<what>"`; a separate scribe draws your latest turn; never draw unasked.
  Then `task sync:claudemod` to refresh the tracked copy.
- [ ] **Tests**: `go test ./pkg/wshrpc/wshserver -run 'TestBoardScribe'`: `TestBoardScribeDrawFollowWritesTabMeta`,
  `TestBoardScribeDrawRefusesDamagedBoard`, `TestBoardScribeDrawRefusesFollowOnRun`,
  `TestBoardScribeTurnEndWakesOnlyFollowedTabs` (a fake scheduler records wakes),
  `TestBoardScribeAgentDrawCreatesByName` (unknown name creates; a case-different existing name reuses the
  newest-drawn), `TestBoardScribeListShowsDrawingState`. `go test ./cmd/wsh/cmd -run 'TestBoardDraw'`: missing
  `--board` errors before any RPC; the printed line for created and existing boards.

### Task 7: Board scene model (frontend, pure)
**Depends on:** Task 1 (the generated `BoardArcRecord`, `BoardDraw`, `BoardSourceStatus` types and the Excalidraw dependency)
**Files:** `frontend/app/view/boards/boardmodel.ts`, `frontend/app/view/boards/boardmodel.test.ts`

No React, no RPC, no Excalidraw runtime import (types only, from `@excalidraw/excalidraw`'s element types).

```ts
export const ARC_SOURCE = "arcSource"; // customData key on scribe elements
export interface BoardScene { arc: BoardArcRecord; elements: readonly ExcalidrawElement[]; appState: Record<string, unknown>; files: Record<string, unknown> }
export class BoardFileError extends Error {}
export function parseBoardFile(text: string): BoardScene;           // throws BoardFileError
export function serializeBoard(scene: BoardScene): string;          // "arc" first (decision 6)
export function contentHash(elements: readonly ExcalidrawElement[], groupId: string): string; // decision 9
export function markEdits(scene: BoardScene, now: number): BoardScene; // stamps editedts on sources whose hash moved
export type ApplyOutcome = "new" | "replaced" | "pending";
export function applyDraw(scene: BoardScene, draw: BoardDraw, converted: readonly ExcalidrawElement[], now: number): { scene: BoardScene; outcome: ApplyOutcome };
export function keepPending(scene: BoardScene, key: string, now: number): BoardScene;
export function dropPending(scene: BoardScene, key: string): BoardScene;
export interface BoardSourceRow { key: string; kindIcon: string; title: string; subline: string; isNew: boolean; state: "drawn" | "drawing" | "failed" | "pending"; pending?: { editedTs: number; drawnTs: number }; status?: BoardSourceStatus }
export function sourceRows(arc: BoardArcRecord, status: BoardSourceStatus[], seenTs: number): BoardSourceRow[]; // drawn sources newest first, then status-only (first draw in progress) rows
export function yourShapesLabel(elements: readonly ExcalidrawElement[]): string;   // decision 18
export function headerFacts(arc: BoardArcRecord, seenTs: number, now: number): string; // "4 groups · 1 new since you looked · last drawn 16:04"
export function newestSinceSeen(arc: BoardArcRecord, seenTs: number): string | null;  // source key to select on open
export function groupElementIds(scene: BoardScene, key: string): string[];
export interface BoardFollowMeta { boardId: string; channelId: string; boardName: string; ask: string }
export function followOf(meta: MetaType | undefined): BoardFollowMeta | null;
export function boardTime(ts: number, now: number): string; // HH:MM today, else MM-DD
```

`applyDraw` implements decisions 9-11 (tagging every converted element with `customData.arcSource` and the source's
group id, recording `box`, `contenthash`, `shapes`, `skeleton`, `cursorts`, `drawnts`). `kindIcon` names the
`KIND_ICONS` key in `palette-rows.tsx` (`agent`, `run`, `effort`, `record`, `session`).

- [ ] **Tests** (`npx vitest run frontend/app/view/boards/boardmodel.test.ts`): round-trip keeps `arc` first;
  `contentHash` unchanged by move/resize, changed by text edit, added and deleted element; first draw placed 120px
  right of content; unedited redraw → `replaced` at the group's current top-left and scale (resize the group 2x, the
  redraw comes back 2x); edited redraw → `pending` frame named `Pending redraw · <ask>` at opacity 40, 80px right;
  a second redraw replaces the pending contents; `keepPending` untags the edited group and makes the redraw the group;
  `dropPending` leaves the edited group edited; user shapes are never touched by any of these; `sourceRows` subline
  per decision 18 (`no ask, read whole · 6 shapes · 15:20` for a run); `yourShapesLabel` (`1 note`,
  `1 note, 2 shapes`); `headerFacts` omits the new clause at zero; `followOf` needs `board:followid`.

### Task 8: Board store, draw applier, router target and the surface key
**Depends on:** Task 7 (applyDraw, parseBoardFile, serializeBoard, followOf)
**Files:** `frontend/app/view/boards/boardstore.ts`, `frontend/app/view/boards/boardstore.test.ts`, `frontend/app/view/boards/boardapplier.ts`, `frontend/app/view/boards/boardapplier.test.ts`, `frontend/app/view/boards/boardconvert.ts`, `frontend/app/cockpit/notificationstore.ts`, `frontend/app/cockpit/notificationstore.test.ts`, `frontend/app/view/agents/agents.tsx`, `frontend/app/view/agents/navrail.tsx`, `frontend/app/view/agents/surfacecontext.ts`, `frontend/app/view/agents/surfacecontext.test.ts`, `frontend/app/cockpit/uiapi.ts`, `frontend/app/cockpit/uiapi.test.ts`, `frontend/app/view/jarvis/address.ts`, `frontend/app/view/jarvis/openref.ts`, `frontend/app/view/jarvis/openref.test.ts`, `frontend/app/view/agents/cockpitshell.tsx`

Plumbing only; no new rendered UI (the rail button and surface come in Task 9).

- `SurfaceKey` gains `"boards"` (not in `SURFACE_ORDER`); `navrail.tsx` `ICON.boards = <Shapes .../>` (the button is
  Task 9's); `SURFACE_CONTEXT.boards = { project: "subject" }`; `uiapi.ts` `SURFACES` accepts `surface:boards`.
- `OpenTarget` gains `{ kind: "board"; channelId: string; boardId: string }` (built in code only, like `code`);
  `openref.ts` lands it: load = `BoardListCommand` proves the board is listed (else `unavailable("This board is gone")`),
  select = `selectBoard(channelId, boardId)` then `landOn(model.surfaceAtom, "boards")`; `targetName` → `board <id>`.
- `boardstore.ts` exports: `boardsChannelAtom` (the surface's explicit project, null = the cockpit's current one),
  `openBoardByChannelAtom: Record<channelId, boardId>`, `selectBoard(channelId, boardId)`,
  `boardListAtom(channelId)` + `loadBoardList(channelId)`, `boardStatusAtom(boardId)` + `loadBoardStatus(channelId, boardId)`,
  `boardViewportAtom(boardId)` (`{scrollX, scrollY, zoom}` in memory), `useAgentFollow(tabId): BoardFollowMeta | null`
  (WOS tab meta through `followOf`), `useBoardFollows(model, boardId): { tabId: string; agentName: string; ask: string }[]`
  (live roster agents whose follow names the board), `registerLiveBoard(boardId, apply: (draw: BoardDraw) => Promise<ApplyOutcome>): () => void`,
  `boardOwnsEscapeAtom` (a boolean atom: the open canvas has a selection or an active tool; Task 9's canvas sets it and
  `bindings.ts` reads it, so the keybindings never import Excalidraw) with `setBoardEscape(fn: (() => void) | null)`
  and `runBoardEscape()` (the canvas registers what clearing its selection or tool means; the Escape binding runs it),
  and a `board:update` subscription that reloads the list (`list`, `draw`, `failed`) and status (`status`, `draw`,
  `failed`) for loaded channels and boards.
- `boardconvert.ts`: `convertSkeleton(skeleton: string): ExcalidrawElement[]` via `convertToExcalidrawElements(JSON.parse(skeleton), { regenerateIds: true })`.
- `boardapplier.ts`: `startBoardApplier(model: AgentsViewModel): () => void`, mounted once from `cockpitshell.tsx`.
  On start and on each `draw` event it fetches `BoardInboxCommand` and applies each draw in order: to a registered
  live board through its handler, else read → `parseBoardFile` → `applyDraw` → `serializeBoard` → `BoardSaveCommand`
  with the read rev, re-reading and reapplying on `conflict` (up to 3 tries); then `BoardInboxAckCommand` and the
  success toast (decision 16) whose Open lands `{kind:"board"}`. A board that won't open leaves its draws waiting,
  silently. On a `failed` event it raises the error toast (decision 16) with Open. One draw in flight per board.
- `notificationstore.ts`: `ToastNotification.action?: { label: string; run: () => void }`.
- [ ] **Tests**: `npx vitest run frontend/app/view/boards/boardapplier.test.ts frontend/app/view/boards/boardstore.test.ts frontend/app/cockpit/notificationstore.test.ts frontend/app/view/agents/surfacecontext.test.ts frontend/app/cockpit/uiapi.test.ts frontend/app/view/jarvis/openref.test.ts`
  (RPC and conversion mocked): a draw for a closed board is saved then acked then toasted, in that order; a conflict
  re-reads and saves once more; a live board's handler gets the draw and nothing is saved by the applier; a board
  that won't open is not acked; a `failed` event toasts `Scribe couldn't draw on <board>` with an Open action;
  `useBoardFollows` drops an agent that left the roster; `parseSurfaceAddress("surface:boards")`; a board landing on
  a missing board says so and stays put.

### Task 9: The Boards surface
**Depends on:** Task 8 (the store, applier hook, router target and surface key), Task 3 (its scenario makes and reads boards through the real board file RPCs)
**Files:** `frontend/app/view/boards/boardssurface.tsx`, `frontend/app/view/boards/boardslist.tsx`, `frontend/app/view/boards/boardcanvas.tsx`, `frontend/app/view/boards/boardcanvas.css`, `frontend/app/view/agents/cockpitshell.tsx`, `frontend/app/view/agents/navrail.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/store/keybindings/store.test.ts`, `docs/keyboard-shortcuts.md`, `frontend/app/cockpit/notificationtoasts.tsx`, `frontend/tauri/vite.config.ts`, `src-tauri/tauri.conf.json`, `scripts/cdp/scenarios-boards-surface.mjs`

Read `DESIGN.md`, the spec's "Where a board opens" and boards F8, N1, N2, D2, E1 before building; match them.

- **Wiring**: rail button `Boards` in the bottom group above Setup; `cockpitshell.tsx` renders `BoardsSurface` for
  `"boards"`; `GO_TARGETS` `{ letter: "w", surface: "boards", label: "Boards" }`; `boards` joins `ESC_HOME_SURFACES`;
  the go-home guard also requires `!globalStore.get(boardOwnsEscapeAtom)`, and a boards-surface Escape binding runs `runBoardEscape()`, which clears
  Excalidraw's selection or active tool while that atom is true (the Diff compare pattern); `docs/keyboard-shortcuts.md`
  lists `g w`; `store.test.ts`'s `SURFACES` gains `"boards"` so the conflict invariant covers it.
- **Header**: `Boards / <board>` with `headerFacts`, and on the right `Following <agent>` (one follow) or
  `Scribe drawing · following <agent>` while a pass runs (D2).
- **List** (264px, `bg-surface`): New board, `<n> boards in <project>`, boards newest-drawn first; folded rows show
  time, `N new`, `drawing`, `failed`, `won't open`; the open board unfolds into its tree: follows on top (agent name,
  `redraws at each turn end`, Stop → `BoardFollowStopCommand`), then `sourceRows` with the kind icon, title, subline
  and New pill; a drawing row shows `drawing`, `Reading <reading>` and `The group stays as drawn until the redraw
  lands.` plus the queued line (`1 more turn end came in; it joins the next pass.` / `N more turn ends came in; they
  join the next pass.`); a failed row shows `The HH:MM redraw failed: <reason>. The group keeps its HH:MM version.`
  and Retry → `BoardRetryCommand`; a pending row shows `You edited it at HH:MM, so the HH:MM redraw waits beside it.`
  with Drop and Keep; last, Your shapes. Clicking the open board's row folds it; clicking a source row selects its
  group (Excalidraw selection, scrolled into view).
- **New board**: a focused `Name this board` field at the top (N1); Enter/Create → `BoardCreateCommand` → opens the
  new empty board; Esc/Cancel drops it; empty stays open with `Type a name first`. An empty board shows `Nothing on
  this board yet` and how to fill it (draw with the tools, or Draw on a board… on any agent, run or initiative).
- **No boards**: `SurfaceEmptyState` `No boards in <project> yet` with the N2 copy and New board as its action.
- **Won't open**: `SurfaceError` `Couldn't open <name>: <loaderror>. Arc has not changed the file.`, `The file:` and
  its path, `Fix or restore it, then Retry. Nothing draws on this board until it opens.`, Retry re-reads (E1).
- **Canvas** (`boardcanvas.tsx`): plain Excalidraw, dark theme, canvas on `background`, controls mapped to `@theme`
  tokens in `boardcanvas.css`, main menu (export/open/save) hidden, no overlays. Loads with `BoardReadCommand`; on
  open stamps `seents` and selects `newestSinceSeen`; restores and keeps `boardViewportAtom`; autosaves debounced
  (500 ms) through `markEdits` → `serializeBoard` → `BoardSaveCommand`, re-reading on conflict; registers
  `registerLiveBoard` so draws apply live via `updateScene`; sets `boardOwnsEscapeAtom`. Keep/Drop call
  `keepPending`/`dropPending` on the live scene. Fonts and assets load from the app origin (no network; adjust the
  Vite config and the CSP only as far as Excalidraw needs, e.g. `worker-src`/`font-src`).
- **Toast**: `notificationtoasts.tsx` renders a toast's `action` as a button that runs it and dismisses the toast.
- **Motion** (`docs/reference/motion-system.md`): the open board's tree unfolds with moment 6b (`paneReveal`); the New
  board field with moment 6 (`composerReveal`); `Type a name first` with moment 13 (`errorNudge`); a `drawing` mark
  with moment 7 (`pulseDot`); a source row whose draw lands with moment 14 (`changeFlash`); the header's group count
  with moment 12 (`TickNumber`); the list reordering with moment 2.
- [ ] **Scenario** `boards-surface` in `scripts/cdp/scenarios-boards-surface.mjs` (boards made through the real
  board RPCs in the isolated store, the scribe never run: draws come from importing the applier's apply path with a
  fixture skeleton, status and follows from an in-page fixture). Steps, each with a screenshot:
  `no boards` (N2 copy, New board action); `new board` (the name field, `Type a name first` on an empty Enter, the
  new empty board, N1); `board open` (a board with three sources, a follow on top with Stop, a pending row with Keep
  and Drop, the pending frame on the canvas, the draw toast with Open; F8); `keep pending` (Keep turns the frame into
  a group, the row loses its pending line); `drawing and failed` (a drawing row with its queued line, a failed row
  with Retry, the error toast; D2); `won't open` (a truncated file: the row says `won't open`, the error, path and
  Retry; E1); `source row selects group` (clicking a row selects its elements); `escape` (Escape with a selection
  clears it and stays; again goes home).

### Task 10: Draw on a board… in the palette
**Depends on:** Task 1 (the board RPCs and the generated types), Task 3 (its scenario creates and lists boards through the real board file RPCs)
**Files:** `frontend/app/cockpit/actions/types.ts`, `frontend/app/cockpit/actions/types.test.ts`, `frontend/app/cockpit/actions/boarddraw.ts`, `frontend/app/cockpit/actions/boarddraw.test.ts`, `frontend/app/cockpit/actions/agent.ts`, `frontend/app/cockpit/actions/agent.test.ts`, `frontend/app/cockpit/actions/run.ts`, `frontend/app/cockpit/actions/run.test.ts`, `frontend/app/cockpit/actions/initiative.ts`, `frontend/app/cockpit/actions/initiative.test.ts`, `frontend/app/cockpit/actions/session.ts`, `frontend/app/cockpit/actions/session.test.ts`, `frontend/app/cockpit/actions/record.ts`, `frontend/app/cockpit/actions/record.test.ts`, `frontend/app/cockpit/palette-scope.ts`, `frontend/app/cockpit/palette-scope.test.ts`, `frontend/app/cockpit/palette-actionrows.ts`, `frontend/app/cockpit/palette-actionrows.test.ts`, `frontend/app/cockpit/palette-chrome.tsx`, `frontend/app/cockpit/command-palette.tsx`, `scripts/cdp/scenarios-boards-draw.mjs`

Read the spec's "How something gets onto a board" and board D1.

- `ActionInput<T>` gains `{ kind: "board"; target: (thing: T) => BoardDrawTarget }` with
  `BoardDrawTarget = { channelId: string; source: BoardSource; followable: boolean }`. `boarddraw.ts` exports
  `drawOnBoardAction<T>(target: (thing: T) => BoardDrawTarget | null): ThingAction<T>` (id `<kind>:draw-board`, label
  `Draw on a board…`, group `open`, applies when `target` is non-null) and `boardDrawEcho(...)`. Each of agent, run,
  initiative, session, record adds it. Channel: a run's own; an agent's or session's the channel whose project path
  matches its cwd/project path, else the palette's current project; an initiative's or record's the current
  project. Titles: agent `<agent name>` (e.g. `claude · waveterm`), run `run <first 8 of id>`, others their title.
  `followable` is true for agents only.
- `ActionDrill.input` gains `board?: { step: "board" | "name" | "ask"; boardId?: string; boardName?: string; follow: boolean }`;
  `palette-scope.ts` gets the step transitions (open at `board`, `name` only from New board…, ← and Backspace on an
  empty field step back one).
- Steps (D1): **board**: the project's boards from `BoardListCommand` (name, `<n> groups · <time>`), then
  `New board…`; typing filters; a typed name matching none shows `New board “<typed>”…`, carrying it into **name**;
  **name**: Enter creates (`BoardCreateCommand`) and moves to ask; empty Enter shows `Type a name first`; **ask**:
  optional text, and for agents the `Keep following` tick under it with its line (`Redraw at each of <agent>'s turn
  ends until it closes or you press Stop. Each redraw is a scribe session.`), Tab toggles it at this step only;
  Enter → `BoardDrawCommand` and closes the palette; an RPC error stays open on the error band.
- Chip: `<Noun> › <title> › Draw on a board… › <board>`; footer echo says what Enter does, e.g.
  `Draw claude · waveterm: the escalation flow on Brainstorm internals, and keep following`.
- Motion: steps slide with moment 10 (`StepSwap`, forward/back by direction); `Type a name first` with moment 13.
- [ ] **Tests**: `npx vitest run frontend/app/cockpit/actions/boarddraw.test.ts frontend/app/cockpit/palette-scope.test.ts frontend/app/cockpit/palette-actionrows.test.ts frontend/app/cockpit/actions/agent.test.ts frontend/app/cockpit/actions/run.test.ts`:
  each kind lists `Draw on a board…`; the run target carries its channel and `run <8>` title; only agents are
  followable; step transitions and back-steps; an unmatched typed name becomes the New board row with the name
  carried; the echo with and without an ask and a follow.
- [ ] **Scenario** `boards-draw` in `scripts/cdp/scenarios-boards-draw.mjs` (`BoardDrawCommand` stubbed in page to
  record its call; boards created through the real RPC): steps `pick a board` (the list with counts and New board…,
  D1), `new board from typed name` (the name carried, created on Enter), `ask and keep following` (the tick toggled
  by Tab, the footer echo), `enter draws` (the recorded call carries board, source, ask and follow, and the palette
  closed), each with a screenshot.

### Task 11: The follow on an agent's row
**Depends on:** Task 8 (useAgentFollow and the board router target), Task 3 (Stop calls the real BoardFollowStopCommand)
**Files:** `frontend/app/view/agents/agenttree.tsx`, `scripts/cdp/scenarios-boards-follow.mjs`

Read board A1.

- A followed agent's Agent-tree row shows, beside `PaneTag`, a chip naming the board (`useAgentFollow`), styled like
  `PaneChip`, whose click opens the board through `openTarget({ kind: "board", ... })`, and a `Stop` chip that calls
  `BoardFollowStopCommand`; both stop propagation to the row. No follow, no chips. The chips enter with moment 1.
- [ ] **Scenario** `boards-follow` in `scripts/cdp/scenarios-boards-follow.mjs` (the follow keys set on a fixture
  agent's tab, by `SetMetaCommand` on a real tab or priming WOS for a fixture roster agent): steps `followed row`
  (the board chip and Stop on the row, A1), `chip opens board` (the landing only: `surfaceAtom` reads `boards` and `openBoardByChannelAtom` names the board; the surface itself is Task 9's),
  `stop ends follow` (Stop removes both chips and the keys), each with a screenshot.
