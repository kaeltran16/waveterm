# Boards: a place to ask and understand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-11-12-boards-ask-to-understand-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/boardstore ./pkg/boarddrawer ./pkg/boardthings ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs boards-ask`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\boards-ask\project

**Goal:** A board is a conversation: a per-board drawer session you ask on the Boards surface (talk column left,
Excalidraw right), which answers each question in a few words plus changes to the drawing, remembers the talk by
resuming its claude session, hands a board over to a new one, and takes briefings from agents' `wsh board draw`.
The transcribing scribe, following, source groups and Keep/Drop are removed.

**Architecture:** wavesrv owns the conversation and the drawer; the frontend owns the scene. A new `pkg/boarddrawer`
(built from `pkg/boardscribe`'s runner, tool guard and reply check) runs one turn at a time per board as a headless
read-only `claude -p` started with `--session-id` and resumed with `--resume`. Each board's talk lives in a sidecar
`<id>.talk.json` that only wavesrv writes; answers wait in an `<id>.answers/` inbox until the frontend applies them to
the scene (one Excalidraw undo step) and acks them with the shape ids it touched. The Boards surface is rebuilt as the
talk column plus the canvas, with the board switcher in the header.

**Tech Stack:** Go (wavesrv, wsh, wshrpc + `task generate`), React 19, jotai, Tailwind 4, `@excalidraw/excalidraw`
0.18.1 (pinned, no new dependency), vitest, the CDP scenario harness (`scripts/cdp/`).

The prototype's boards are `project/B1`…`B12`; `project/unchosen/` is out of scope. Every board has a step in the
`boards-ask` scenario (Task 10), listed under "The boards-ask scenario" below.

## Decisions beyond the spec, and why

1. **The talk lives in a sidecar, `<project dir>/<id>.talk.json`, written only by wavesrv; the board file's `arc`
   record shrinks to `{name, createdts}`.** Why: the frontend saves the board file on every autosave under a rev;
   if Go also wrote turns into it, every answer would race the canvas's saves. One writer per file: Go owns the talk
   and the drawer session, the frontend owns the scene. (The spec names the `arc` record as "the obvious place" and
   leaves it to the builder.)
2. **The drawer is `claude -p --model sonnet --tools Read,Grep,Glob --strict-mcp-config`**, the scribe's runner and
   init-event guard unchanged, plus `--session-id <uuid>` on a board's first turn and `--resume <uuid>` after. Its env
   adds `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`, because a wavesrv started from an agent terminal can inherit the
   child-session marker that stops sessions from being saved, and then every `--resume` would fail. A failed resume
   fails the turn with its reason; it is never retried silently. Turn timeout: 10 minutes, as the scribe's pass.
3. **Reply format** (one JSON object): `{"reply": "<1-3 sentences>", "title": "<what the drawing shows, a few
   words>", "add": [<skeletons>], "update": [{"id", "x"?, "y"?, "width"?, "height"?, "text"?, "label"?,
   "strokeColor"?, "backgroundColor"?}], "remove": ["<id>"], "elsewhere": false}`. Coordinates are absolute board
   coordinates, so "add a drawing under the first" needs no placement logic of ours. `add` keeps the scribe's
   skeleton vocabulary and checks (arrows bind only to ids inside `add`). `update` and `remove` name ids from the
   scene the drawer was shown; `text` patches a text element, `label` a container's or arrow's bound text. At most
   200 entries across `add`, `update` and `remove`. `elsewhere: true` (allowed only for a briefing on a board that
   already has turns) carries no drawing and makes the turn "asks". An answer with words and no drawing is valid.
   Code, not the drawer, decides whether an answer is usable (`CheckAnswer`); an unusable one fails the turn.
4. **The drawer sees the board as a scene summary built in Go from the board file**: one compact JSON line per live
   element (id, type, x, y, w, h, text or label, arrow start/end ids, stroke, fill, `"selected": true`), bound text
   folded into its container's `label`. The frontend flushes the canvas's pending autosave before it asks, so the file
   is current. Every turn's prompt carries the summary as it is now (the drawer reads your edits as part of what you
   ask, and `update`/`remove` are checked against it), not only the first. Why Go: `wsh board draw` asks on boards that
   are not open, so the summary cannot depend on the canvas.
5. **Selection goes as ids plus a label.** The ask carries `selectedids` (marked in the summary) and `on`, the label
   the talk shows ("wavesrv"; "wavesrv and 2 more"; "3 shapes" when none has text), computed in the frontend.
6. **An answer is one undo step**: the frontend applies `add` (converted with `convertToExcalidrawElements`,
   `regenerateIds`), `update` (patch, version bump, a moved container's bound text moves with it, changed text is
   re-measured) and `remove` (deleted with its bound text) in a single `updateScene` with
   `CaptureUpdateAction.IMMEDIATELY`. Ids the board no longer has (you deleted them meanwhile) are skipped. Arrows
   bound to a shape the drawer moved are not re-routed; the prompt tells the drawer to move or redraw them itself.
7. **Show outlines with Excalidraw's own selection** of the turn's `shapeids` (added plus changed ids, sent back with
   the ack) and scrolls to them; pressing Show again clears it. The board stays plain Excalidraw, no overlays.
8. **Card words:** "drew N shapes" for the first answered turn that only added shapes, otherwise the non-zero parts of
   "added N shapes", "changed N", "removed N", then " · HH:MM". Shape counts are skeleton entries (a labelled box is
   one shape); the header's shape count skips bound text the same way.
9. **One turn at a time per board.** Your Ask is refused while a turn runs ("the drawer is answering; ask once this
   answer lands"), and the ask box is disabled. An agent's briefing never fails for that: it queues ("waiting") and
   runs after the current turn. Stop cancels only the running turn: state "stopped", no answer delivered, board
   unchanged. A turn found "answering" or "waiting" that the drawer is not running (wavesrv restarted) is marked
   failed, "Arc restarted before the drawer answered", and Retry works on it.
10. **Slow is past 90 s** (`SLOW_AFTER_MS = 90_000`): the 11-11 live check drew 16 shapes in about 16 s, and a
    follow-up that reads code takes longer; 90 s leaves room before "Still answering" offers Stop.
11. **Handoff summary: the earlier drawer, forked.** On a handed-over board's first turn, wavesrv resumes the earlier
    board's session with `--fork-session` and asks for a summary of the conversation (what was asked, what the
    drawing shows, what was concluded), so the earlier session and its talk stay exactly as they were. The summary is
    stored in the new talk's `handoff` and goes into the new drawer's first prompt. No earlier session (no
    questions): no summary. The copied drawing is copied in the frontend (fresh element ids, bindings, groups and
    containers remapped) and sent with `BoardStartCommand`, which writes it into the new board file.
12. **The first question is optional in every ask form.** Ask with a name and no question makes an empty board you
    can draw on by hand (B11); with a question, the board's first turn starts at once. An empty name says "Type a
    name first", as the 11-11 build.
13. **Keys:** the ask box asks on Enter (Shift Enter is a new line), like the agent composer; the forms ask on
    Ctrl Enter and cancel on Esc, as the mockups say, since they have two fields.
14. **Toasts are for briefings only** (B10): when a turn that carries a briefing is answered, asks you, or fails. Your
    own asks get none: you asked on the surface where the answer shows. `board:update` carries the briefing's sender
    in `from`, so the toast needs no extra read. Failure: "The drawer couldn't answer on <board>", the reason.
15. **"Keep it here"** records the choice on the asking turn and runs a new turn (`kept: true`, its question the
    briefing's ask) that answers the briefing on this board; the talk shows "Kept here" on the asking turn and no new
    message of yours. **"New board from this"** there opens the form with the briefing as About and its ask as the
    first question, no drawing copied; once the new board starts, the asking turn records "new" ("Moved to a new board").
16. **About kinds** extend `BoardSource.kind` with `project` (the project's code alone; also an empty kind) and
    `briefing` (`title` = the sending agent's name, `text` = the briefing). A thing (agent, session, run, effort,
    record) is read once with `boardthings.Read(src, 0)` for the first prompt; later turns rely on the session.
17. **New wire names, then removal.** The new commands are added beside the old ones (Task 1) so every task compiles
    on its own; the old commands, types, meta keys and the scribe go in the last task, after their last caller.
    Names: `BoardStartCommand`, `BoardTalkCommand`, `BoardAskCommand`, `BoardAskStopCommand`,
    `BoardAskRetryCommand`, `BoardAskChoiceCommand`, `BoardAnswerInboxCommand`, `BoardAnswerAckCommand`;
    `BoardListCommand`, `BoardReadCommand`, `BoardSaveCommand` and `BoardAgentDrawCommand` stay.
18. **The palette action has no drill.** "Ask a board about this…" is a plain action that lands on Boards with the
    form open (through the router's new `openBoardAsk`); the board, name and question are typed there. The palette's
    board drill (`ActionInput` kind `board`, its steps, Keep following on Tab) is removed.
19. **Motion moments** (`docs/reference/motion-system.md`): a talk item entering (1); the ask form revealed in the
    talk column (6b); the drawer answering or a board answering in the switcher (7, `pulseDot`); a turn that asks you
    and the switcher's "asks you" mark (3, `breatheGlow`); the answer card settling when it lands (4); the header's
    question and shape counts (12, `TickNumber`); the switcher popover entering (1).

## Global Constraints

- No new design tokens: colors from the `@theme` tokens in `frontend/tailwindsetup.css`, layout per `DESIGN.md`.
- Nothing draws or chains on its own: the drawer runs only on your ask, Retry, Keep it here, or an agent's
  `wsh board draw` (which the agent runs only when you ask it to).
- The drawer reads and searches only (`Read,Grep,Glob`, `--strict-mcp-config`), and the init-event guard fails a
  turn closed when the session loaded any other tool or sent no init event.
- Boards stay on the machine, under Arc's data folder; never in the vault, git or a sync.
- `@excalidraw/excalidraw` stays pinned at `0.18.1`; no new dependency.
- A task that changes a wshrpc or waveobj Go type runs `task generate` and commits its outputs.
- UI copy is the mockups' wording, quoted in the tasks.

## Review Focus

1. **An agent's briefing arriving while the drawer answers, or while you type.** Expect the briefing to queue and run
   next, and your ask to be refused with "ask once this answer lands", never two sessions on one board at once.
   Pinned by Task 3's `TestDrawerBriefingQueuesBehindTurn` and `TestDrawerRefusesAskWhileBusy`.
2. **You edit or delete shapes while an answer is on its way.** Expect the answer to land live on the open canvas,
   skipping ids that are gone, and nothing you drew meanwhile lost. Pinned by Task 5's
   `applyAnswer skips ids the board no longer has` and the B1 step (Task 10).
3. **Arc restarts mid-answer.** Expect the turn to read "Couldn't answer" with "Arc restarted before the drawer
   answered", and Retry to work. Pinned by Task 3's `TestDrawerTalkFailsStaleTurns`.
4. **A resume that fails** (the session file is gone). Expect a failed turn naming the reason, not a silent new
   session that has lost the talk. Pinned by Task 3's `TestDrawerResumeFailureFailsTurn`.
5. **An unusable answer** (not JSON, an unknown id in `update`, 201 entries, `elsewhere` with a drawing). Expect a
   failed turn with the reason and an unchanged board. Pinned by Task 3's `TestCheckAnswer`.

## The boards-ask scenario

One scenario, `boards-ask` in `scripts/cdp/scenarios-boards-ask.mjs`, written in Task 10 once the surface (Task 9) and
the real handlers (Task 8) have landed; every UI task names the steps that prove its work. It makes real boards through `boardstart` with no question (so no drawer runs) in a throwaway
project, and stubs in page only what would start a drawer or needs a fixed talk (`BoardTalkCommand`,
`BoardAskCommand`, the stop/retry/choice commands, the answer inbox and ack), feeding `board:update` events to the
page's own handlers, as the 11-11 scenarios did. Steps:

1. **B12 no boards**: "No boards in <project> yet", the lead line, the inline form (First question, Name, About the
   <project> code, Ask) and the palette hint naming "Ask a board about this…".
2. **B3 ask something new**: the form in the talk column (Ask something new, Name, First question, About the
   <project> code, "the drawer reads the project's code", "Ctrl Enter asks · Esc cancels"), the canvas reading "The
   drawer draws here once you ask."; an empty name says "Type a name first"; Esc cancels and Boards stays.
3. **B11 empty board**: Ask with a name and no question makes the board: talk "Nothing asked on this board yet",
   canvas "Nothing on this board yet", header "empty · created HH:MM".
4. **B1 talk**: a board with two answered turns: About, both questions with "on wavesrv", replies with cards; Show
   selects exactly the card's shape ids; selecting a shape shows "Selected <label>"; Ask sends question, `on` and
   `selectedids`; a fed answer lands live, the ack carries its shape ids, header facts read "2 questions · N shapes
   · answered HH:MM"; one Excalidraw undo removes the whole answer.
5. **B4 answering**: "Answering N s" under the message; Ask disabled with "You can ask once this answer lands".
6. **B5 slow**: past 90 s "Still answering", "This is taking longer than most answers…", Stop calls
   `BoardAskStopCommand`.
7. **B6 failed**: "Couldn't answer", the reason, "Nothing on the board changed.", Retry calls `BoardAskRetryCommand`
   with the turn id.
8. **B7 new info**: the briefing item (sender, "sent a briefing", time, text, "Ask: …") and the drawer's question
   with New board from this and Keep it here; Keep calls `BoardAskChoiceCommand` with `keep`; New board from this opens
   the form with the briefing as About, its ask as the question, and no copied drawing.
9. **B2 switcher**: the header's board name opens the list: "+ Ask something new" first, "N boards in <project>",
   rows newest first with "N questions · <about>" and the answering, asks you and failed marks.
10. **B8 handoff**: New board from this in the header: "New board from <board>", "It starts with", the summary line,
    "Its drawing, copied: N shapes, free to change", "<board> and its talk stay as they are."; the canvas still shows
    the drawing; Ask calls `BoardStartCommand` with `fromboardid` and N elements whose ids are all new.
11. **B9 from palette**: on a fixture agent, the palette's "Ask a board about this…" lands on Boards with the form
    titled "Ask a board about this", About the agent's name with its runtime dot and "The drawer starts from this
    agent's session and reads the project's code.", the first question focused.
12. **B10 toasts**: a briefing turn answered raises "The drawer answered on <board>" / "From <agent>'s briefing" with
    Open; a briefing turn that asks raises "The drawer asks you on <board>" / "Does <agent>'s briefing belong on a new
    board?"; Open lands on that board.
13. **E1 load error**: a damaged board file shows the reason, its path and Retry over the canvas; its talk still shows
    and the ask box says the board won't open.

---

### Task 1: The board talk wire contract
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_board.go`, `pkg/wshrpc/wshserver/wshserver_boarddrawer.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

Add the new commands and types beside the old ones (decision 17); change nothing old. Every new field is
`omitempty` unless noted, so existing TS fixtures keep compiling.

**Interfaces (produces):** in `wshrpctypes_board.go`, added to `BoardCommands`:

```go
BoardStartCommand(ctx context.Context, data CommandBoardStartData) (*BoardInfo, error)
BoardTalkCommand(ctx context.Context, data CommandBoardRefData) (*BoardTalk, error)
BoardAskCommand(ctx context.Context, data CommandBoardAskData) error
BoardAskStopCommand(ctx context.Context, data CommandBoardRefData) error
BoardAskRetryCommand(ctx context.Context, data CommandBoardTurnData) error
BoardAskChoiceCommand(ctx context.Context, data CommandBoardChoiceData) error
BoardAnswerInboxCommand(ctx context.Context, data CommandBoardInboxData) ([]BoardAnswer, error)
BoardAnswerAckCommand(ctx context.Context, data CommandBoardAnswerAckData) error
```

Types (json tags lowercase of the field name, as the file's convention):
- `BoardSource` gains `Text string` (a briefing's text); its kind comment adds `project | briefing`.
- `BoardInfo` gains `Questions int`, `About string` (the talk's about title; empty = the project's code),
  `AnsweredTs int64`, `ActiveTs int64` (last turn or answer, else created). `State`'s comment becomes
  `"answering" | "asks" | "failed"`.
- `BoardTalk {ChannelId, BoardId string; About BoardSource; SessionId string; Handoff *BoardHandoff; Turns []BoardTurn}`
  (`turns` not omitempty).
- `BoardHandoff {FromBoardId, FromName, Summary string; Shapes int}`.
- `BoardBriefing {From, Text, Ask string}`.
- `BoardTurn {ID string; Ts int64; Question, On string; SelectedIds []string; Briefing *BoardBriefing; Kept bool;
  State string; Reply, Title string; Added, Changed, Removed int; ShapeIds []string; AnsweredTs int64; Reason,
  Choice string}`. State: `waiting | answering | answered | asks | failed | stopped`; Choice on an asks turn:
  `keep | new`.
- `CommandBoardStartData {ChannelId, Name, Question string; About BoardSource; FromBoardId string; Elements string}`
  (`Elements`: a JSON array of Excalidraw elements, the copied drawing).
- `CommandBoardAskData {ChannelId, BoardId, Question, On string; SelectedIds []string}`.
- `CommandBoardTurnData {ChannelId, BoardId, TurnId string}`; `CommandBoardChoiceData {ChannelId, BoardId, TurnId,
  Choice string}`.
- `BoardAnswer {ID, ChannelId, BoardId, TurnId string; Add, Update string /* JSON arrays */; Remove []string;
  Ts int64}`.
- `CommandBoardAnswerAckData {ChannelId, BoardId, AnswerId, TurnId string; ShapeIds []string}`.
- `CommandBoardAgentDrawData` gains `Context string`.
- `BoardUpdateData` gains `TurnId`, `State` and `From string` (the briefing's sender); its What comment adds
  `talk | answer`.

- [ ] Add the types and methods; in the new `wshserver_boarddrawer.go`, implement each new method as a stub returning
      `errors.New("boards: the drawer is not wired yet")` (Task 8 replaces them).
- [ ] Run `task generate`; commit the regenerated `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`.
- [ ] Acceptance: `go vet ./pkg/wshrpc/...` passes, Check passes, and `wshclientapi.ts` has the eight new methods.

### Task 2: Board talk sidecar, answer inbox and list facts in `pkg/boardstore`
**Depends on:** Task 1 (uses the BoardTalk, BoardTurn and BoardAnswer types it adds)
**Files:** `pkg/boardstore/boardstore.go`, `pkg/boardstore/boardstore_test.go`, `pkg/wshrpc/wshserver/wshserver_board.go`, `pkg/wshrpc/wshserver/wshserver_boardscribe.go`

Add to `pkg/boardstore` (decision 1); keep the old inbox functions (`PutDraw`, `Draws`, `AckDraw`, `Previous`) for
Task 11 to remove.

**Interfaces (produces):**
```go
func ReadTalk(dir, boardId string) (wshrpc.BoardTalk, error)          // no file: an empty talk (Turns non-nil), no error
func UpdateTalk(dir, boardId string, fn func(*wshrpc.BoardTalk) error) (wshrpc.BoardTalk, error) // read-modify-write under the dir lock, atomic write; fn's error writes nothing
func Create(dir, channelId, name, elements string, now int64) (wshrpc.BoardInfo, error)         // elements "" = none, else a JSON array or refused
func PutAnswer(dir string, a wshrpc.BoardAnswer) error                  // <dir>/<id>.answers/<answer id>.json
func Answers(dir, boardId string) ([]wshrpc.BoardAnswer, error)        // oldest first; "" = every board in dir; an unreadable file is logged and skipped
func AckAnswer(dir, boardId, answerId string) error                    // already gone is not an error
```
`List` keeps its signature (`state func(boardId string) string` says whether the drawer is busy) and now fills
`Questions` (turns with a question or briefing, `kept` turns excluded), `About` (`talk.About.Title`), `AnsweredTs`,
`ActiveTs`, and `State`: `state(id)` when non-empty, else from the last turn: `asks` (no choice yet), `failed`, or
`failed` for an `answering`/`waiting` turn (nothing runs it). It sorts by `ActiveTs` newest first, then id.
The talk file is `<id>.talk.json`, the answers dir `<id>.answers`; board ids and answer ids (uuid) are validated
before any path is built.

- [ ] Write the failing tests in `boardstore_test.go`: `TestTalkMissingIsEmpty`, `TestUpdateTalkRoundTrip`,
      `TestUpdateTalkSerializesConcurrentUpdates` (20 goroutines each append a turn: 20 turns survive),
      `TestUpdateTalkErrorWritesNothing`, `TestTalkRefusesBadId`, `TestCreateWritesElements` (elements land in
      `elements`; `"{}"` and `"nope"` are refused, nothing written), `TestAnswersPutListAck` (order by ts, unreadable
      skipped, ack twice ok, a bad answer id refused), `TestListTalkFacts` (questions excludes kept turns; state from
      the last turn; a stale answering turn reads failed; `state()` wins; sorted by ActiveTs).
- [ ] Implement; update the two `Create` callers (`wshserver_board.go`, `wshserver_boardscribe.go`) to pass `""`.
- [ ] `go test ./pkg/boardstore -run 'Talk|Create|Answers|ListTalk'` passes.

### Task 3: The drawer engine, `pkg/boarddrawer`
**Depends on:** Task 1 (uses the BoardTalk, BoardTurn, BoardAnswer and BoardUpdateData types it adds)
**Files:** `pkg/boarddrawer/doc.go`, `pkg/boarddrawer/runner.go`, `pkg/boarddrawer/runner_test.go`, `pkg/boarddrawer/answer.go`, `pkg/boarddrawer/answer_test.go`, `pkg/boarddrawer/scene.go`, `pkg/boarddrawer/scene_test.go`, `pkg/boarddrawer/prompt.go`, `pkg/boarddrawer/prompt_test.go`, `pkg/boarddrawer/drawer-prompt.md`, `pkg/boarddrawer/drawer.go`, `pkg/boarddrawer/drawer_test.go`

A new package built from `pkg/boardscribe` (copy its runner, tool guard and skeleton checks; do not import or delete
it: Task 11 deletes it). It imports neither `boardstore` nor `wshserver`: everything outside goes through `Deps`.
Decisions 2-4, 9, 11 and 16 apply.

**Interfaces (produces):**
```go
const TurnTimeout = 10 * time.Minute
const MaxShapes = 200
const RestartedReason = "Arc restarted before the drawer answered"
const BusyReason = "the drawer is answering; ask once this answer lands"
// turn states: StateWaiting "waiting", StateAnswering "answering", StateAnswered "answered", StateAsks "asks",
// StateFailed "failed", StateStopped "stopped"

type Board struct{ ChannelId, BoardId, Name, ProjectPath string }
type Call struct {
    SessionId string
    Resume    bool // --resume SessionId, else --session-id SessionId
    Fork      bool // with Resume: --fork-session (the handoff summary leaves SessionId as it was)
    Prompt    string
}
type Deps struct {
    LoadTalk   func(b Board) (wshrpc.BoardTalk, error)
    UpdateTalk func(b Board, fn func(*wshrpc.BoardTalk) error) (wshrpc.BoardTalk, error)
    ReadBoard  func(b Board) ([]byte, error) // the board file
    ReadThing  func(ctx context.Context, src wshrpc.BoardSource, sinceTs int64) (text, reading string, cursorTs int64, err error)
    Deliver    func(a wshrpc.BoardAnswer) error
    Publish    func(u wshrpc.BoardUpdateData)
    Run        func(ctx context.Context, cwd string, c Call) (string, error) // nil: RunModel
    Now        func() int64
    NewId      func() string // nil: uuid.NewString
}
var RunModel func(ctx context.Context, cwd string, c Call) (string, error)
func New(d Deps) *Drawer
func (d *Drawer) Ask(b Board, t wshrpc.BoardTurn) (wshrpc.BoardTurn, error) // fills ID, Ts, State; refuses with BusyReason while busy unless t.Briefing != nil (queued as waiting)
func (d *Drawer) Stop(b Board) error
func (d *Drawer) Retry(b Board, turnId string) error                // failed or stopped turns only
func (d *Drawer) Choose(b Board, turnId, choice string) error       // "keep": records it, runs a kept turn; "new": records it
func (d *Drawer) Answered(b Board, turnId string, shapeIds []string) error // the ack: the turn's ShapeIds
func (d *Drawer) Talk(b Board) (wshrpc.BoardTalk, error)             // stale answering/waiting turns failed with RestartedReason, persisted
func (d *Drawer) Busy(channelId, boardId string) bool

type Scene struct{ Text string; Types map[string]string; Shapes int }
func SceneSummary(boardFile []byte, selected []string) (Scene, error)
type Answer struct{ Reply, Title, Add, Update string; Remove []string; Added, Changed, Removed int; Elsewhere bool }
func CheckAnswer(reply string, scene Scene, allowElsewhere bool) (Answer, error)
```

A turn: the first one (no `SessionId`) makes a session id, builds the first prompt (role, what the talk is about:
`ReadThing(src, 0)`'s text for agent/session/run/effort/record, the briefing text, or "the project's code"; the
handoff summary; the reply format) and runs with `Resume: false`; later turns resume with the turn section only. The
turn section, on every turn, holds the board as it is now (`SceneSummary`, selected ids marked), the selection, and the
question or briefing. The
session id is saved before the first run, so a crashed first turn still resumes. A handed-over board's first turn
first asks the earlier board's session for a summary (`Resume: true, Fork: true`) and saves it in `Handoff.Summary`.
Each turn: `ReadBoard` → `SceneSummary(file, t.SelectedIds)` → prompt → `Run` (cwd = `ProjectPath`) →
`CheckAnswer` → when the answer has a drawing, `Deliver` a `BoardAnswer` → the turn becomes `answered` (or `asks`
when `elsewhere`) with reply, title, counts and `AnsweredTs`. Publish `board:update` `talk` on every state change
(with `TurnId`, `State`, and `From` for a briefing turn) and `answer` after a delivery. Failure reasons:
`the drawer's session exited before it replied (<err>)`, `the drawer ran past its 10 minutes`,
`the drawer's answer is not usable: <why>`, `the board's file won't open: <why>`; the init guard's reasons as the
scribe's.

- [ ] Port the guard test as `TestToolGuardFailsClosedOnExtraTools`; add `TestDrawerArgs` (first turn:
      `--session-id X`; follow-up: `--resume X`; summary: `--resume X --fork-session`; always `--model sonnet --tools
      Read,Grep,Glob --strict-mcp-config`; env has `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`).
- [ ] `TestCheckAnswer`: a valid answer (counts right, compacted JSON); words only is valid; empty reply, not one JSON
      object, an `update` id not in the scene, `text` on a non-text element, `label` on a text element, an unknown
      update key, a `remove` id not in the scene, an arrow binding outside `add`, 201 entries, a drawing without a
      title, and `elsewhere` with a drawing or when not allowed are each refused with a reason naming it.
- [ ] `TestSceneSummary`: bound text folds into its container's label, deleted elements are left out, selected ids
      are marked, arrows carry their start/end ids, `Shapes` skips bound text; a file that won't parse is an error.
- [ ] `TestPrompt`: the first prompt has the about material, the handoff summary, the reply format and the turn; a
      follow-up has only the turn section, and that section carries the current scene summary with the selected ids
      marked (assert a shape added between turns shows in the follow-up); a briefing on a board with turns carries the elsewhere instruction, on a new
      board it does not; a kept turn says you chose to keep it here; a selection lists the selected shapes.
- [ ] Drawer tests with `Run` stubbed: `TestDrawerFirstTurnThenResume`, `TestDrawerRefusesAskWhileBusy`,
      `TestDrawerBriefingQueuesBehindTurn`, `TestDrawerStopLeavesBoardUnchanged` (no Deliver, state stopped),
      `TestDrawerRetryReasks`, `TestDrawerResumeFailureFailsTurn`, `TestDrawerUnusableAnswerFails`,
      `TestDrawerElsewhereAsks`, `TestDrawerKeepRunsKeptTurn`, `TestDrawerHandoffSummaryForks`,
      `TestDrawerTalkFailsStaleTurns`, `TestDrawerAnsweredRecordsShapeIds`.
- [ ] `go test ./pkg/boarddrawer` passes.

### Task 4: "Ask a board about this…" in the palette, and the router landing
**Depends on:** none
**Files:** `frontend/app/cockpit/actions/boarddraw.ts`, `frontend/app/cockpit/actions/boarddraw.test.ts`, `frontend/app/cockpit/actions/boardask.ts`, `frontend/app/cockpit/actions/boardask.test.ts`, `frontend/app/cockpit/actions/types.ts`, `frontend/app/cockpit/actions/agent.ts`, `frontend/app/cockpit/actions/agent.test.ts`, `frontend/app/cockpit/actions/run.ts`, `frontend/app/cockpit/actions/run.test.ts`, `frontend/app/cockpit/actions/session.ts`, `frontend/app/cockpit/actions/session.test.ts`, `frontend/app/cockpit/actions/record.ts`, `frontend/app/cockpit/actions/record.test.ts`, `frontend/app/cockpit/actions/initiative.ts`, `frontend/app/cockpit/actions/initiative.test.ts`, `frontend/app/cockpit/palette-scope.ts`, `frontend/app/cockpit/palette-scope.test.ts`, `frontend/app/cockpit/palette-actionrows.ts`, `frontend/app/cockpit/palette-actionrows.test.ts`, `frontend/app/cockpit/palette-chrome.tsx`, `frontend/app/cockpit/command-palette.tsx`, `frontend/app/view/jarvis/openref.ts`, `frontend/app/view/jarvis/openref.test.ts`, `frontend/app/view/boards/boardformrequest.ts`

Decision 18. Delete `boarddraw.ts` and its test; the channel helpers it holds (`boardChannelFor`,
`pickBoardChannel`) move to `boardask.ts` unchanged. Remove the board drill entirely: `ActionInput`'s `board` kind,
`BoardDrawTarget`, `BoardStep`/`BoardDrill`/`openBoardInput`/`boardPick`/`boardNew`/`boardTried`/
`toggleBoardFollow` and the board placeholders in `palette-scope.ts`, `boardDrillAt`/`boardDrillGroups`/`makeBoard`
in `palette-actionrows.ts`, `PaletteBoardStep` and the drill chip in `palette-chrome.tsx`, and the drill's list
loading, step slide and Tab-follow handling in `command-palette.tsx`. Grep each removed name across `frontend/` and
`scripts/` before deleting (the old `scripts/cdp/scenarios-boards-*.mjs` go in Task 10).

**Interfaces (produces):**
```ts
// boardformrequest.ts: the Boards surface's ask form, requested from anywhere
export type BoardFormRequest =
    | { kind: "new"; channelId: string }
    | { kind: "about"; channelId: string; about: BoardSource }
    | { kind: "handoff"; channelId: string; fromBoardId: string }
    | { kind: "briefing"; channelId: string; fromBoardId: string; turnId: string; about: BoardSource; ask: string };
export const boardFormAtom: PrimitiveAtom<BoardFormRequest | null>;
// openref.ts: pins the project (boardsChannelAtom), sets boardFormAtom to { kind: "about", ... }, lands on "boards"
export function openBoardAsk(model: AgentsViewModel, channelId: string, about: BoardSource): void;
// boardask.ts
export const ASK_BOARD_LABEL = "Ask a board about this…";
export interface BoardAskTarget { channelId: string; about: BoardSource }
export function askBoardAction<T>(kind: string, target: (thing: T) => BoardAskTarget | null): ThingAction<T>; // id `${kind}:ask-board`, group "open", no input
```
Abouts: agent `{kind: "agent", ref: tabId, title: name, runtime: the agent's runtime}` (not for terminals or agents
without a block, as today); session, run, effort, record as today's draw targets. Uses `boardsChannelAtom` from
`frontend/app/view/boards/boardstore.ts` (unchanged export).

- [ ] Update the five kinds' tests: the action is `<kind>:ask-board`, labelled "Ask a board about this…", applies
      where Draw on a board… applied, and its target's `about` is as above (the agent carries its runtime).
- [ ] `boardask.test.ts`: running the action calls `openBoardAsk` with the target's channel and about; no target, no
      action. `pickBoardChannel` tests move here from `boarddraw.test.ts`.
- [ ] `openref.test.ts`: `openBoardAsk` sets `boardFormAtom` to the about request, pins `boardsChannelAtom`, and
      lands on `boards`.
- [ ] `palette-actionrows.test.ts` / `palette-scope.test.ts`: the board-drill cases are removed; Enter on Ask a board
      about this… runs it and closes the palette (no input level).
- [ ] `npx vitest run frontend/app/cockpit frontend/app/view/jarvis/openref.test.ts` passes; Check passes.
- [ ] Acceptance in the running app: the `boards-ask` scenario's step 11 (B9 from palette, proved by the scenario Task 10 writes).

### Task 5: Applying an answer, copying a drawing, naming a selection (scene ops)
**Depends on:** Task 1 (uses the BoardAnswer type in gotypes.d.ts)
**Files:** `frontend/app/view/boards/boardmodel.ts`, `frontend/app/view/boards/boardmodel.test.ts`, `frontend/app/view/boards/boardconvert.ts`

Decisions 5, 6, 8 and 11 (the copy). Add to `boardmodel.ts` (pure); keep the existing exports, which the 11-11
surface still uses until Task 9.

**Interfaces (produces):**
```ts
export interface AnswerResult { scene: BoardScene; shapeIds: string[]; textIds: string[] } // shapeIds: added + changed; textIds: text to re-measure
export function applyAnswer(scene: BoardScene, answer: BoardAnswer, added: readonly ExcalidrawElement[], now: number): AnswerResult;
export function copyElements(elements: readonly ExcalidrawElement[], newId?: () => string): ExcalidrawElement[];
export function selectionLabel(elements: readonly ExcalidrawElement[], selectedIds: readonly string[]): string | null;
export function shapeCount(elements: readonly ExcalidrawElement[]): number; // live, bound text not counted
// boardconvert.ts (loads Excalidraw): converts answer.add, applies, re-measures changed text
export function landAnswer(scene: BoardScene, answer: BoardAnswer, now: number): AnswerResult;
```

- [ ] Tests in `boardmodel.test.ts`: `applyAnswer adds the converted shapes`; `applyAnswer patches an update and
      bumps its version`; `applyAnswer moves a container's bound text with it`; `applyAnswer sets a label on the
      container's bound text`; `applyAnswer removes a shape with its bound text`; `applyAnswer skips ids the board no
      longer has` (deleted or missing: no throw, not in shapeIds); `copyElements gives every element a new id and
      remaps containers, bindings, groups and frames` (no id shared with the source; deleted ones dropped);
      `selectionLabel names the first selected shape` (container label, text, "wavesrv and 2 more", "3 shapes",
      null when none; a selected container's own bound text is not counted again); `shapeCount skips bound text and
      deleted elements`.
- [ ] `npx vitest run frontend/app/view/boards/boardmodel.test.ts` passes; Check passes.
- [ ] Acceptance in the running app: `boards-ask` steps 4 (an answer lands live as one undo step; Show selects its
      shapes) and 10 (the copied drawing has all-new ids), proved by the scenario Task 10 writes.

### Task 6: The talk model
**Depends on:** Task 1 (uses BoardTalk, BoardTurn and BoardInfo's new fields)
**Files:** `frontend/app/view/boards/boardtalkmodel.ts`, `frontend/app/view/boards/boardtalkmodel.test.ts`

Pure: what the talk column, the ask box, the header and the switcher say. Decisions 8, 10, 15.

**Interfaces (produces):**
```ts
export const SLOW_AFTER_MS = 90_000;
export type TalkItem =
    | { kind: "question"; turnId: string; text: string; on?: string }
    | { kind: "briefing"; turnId: string; from: string; time: string; text: string; ask?: string }
    | { kind: "reply"; turnId: string; text: string; card?: { title: string; summary: string; shapeIds: string[] } }
    | { kind: "working"; turnId: string; slow: boolean; elapsed: string; waiting: boolean }
    | { kind: "failed"; turnId: string; time: string; text: string }
    | { kind: "stopped"; turnId: string }
    | { kind: "asks"; turnId: string; text: string; choice?: "keep" | "new" };
export function talkItems(talk: BoardTalk, now: number): TalkItem[];
export function elapsedText(ms: number): string;                 // "18 s", "2 min 05 s"
export function talkTime(ts: number, now: number): string;       // "15:20" today, else "11 Nov"
export function aboutTitle(about: BoardSource | undefined, project: string): string; // "the waveterm code" | "claude · waveterm"
export function aboutLine(about: BoardSource | undefined): string; // "the drawer reads the project's code" | "The drawer starts from this agent's session and reads the project's code."
export function askBox(talk: BoardTalk | null, boardName: string, selection: string | null, busy: boolean, wontOpen: boolean): { disabled: boolean; hint: string; placeholder: string };
export function boardFacts(info: BoardInfo, shapes: number, now: number): string;
export interface SwitcherRow { id: string; name: string; time: string; sub: string; mark: "answering" | "asks" | "failed" | "wontopen" | null }
export function switcherRows(boards: BoardInfo[], project: string, now: number): { heading: string; rows: SwitcherRow[] };
```
Copy, verbatim: question items show `on <label>` under the text; a working item reads `Answering <elapsed>`, past
`SLOW_AFTER_MS` `Still answering <elapsed>` with `This is taking longer than most answers. Stop it to ask something
narrower; nothing on the board changes.`, and a waiting turn `Waits for the answer above`; a failed item `Couldn't
answer` + time, text `<Reason, first letter capitalized>. Nothing on the board changed. Retry asks the same question
again.`; stopped `Stopped. Nothing on the board changed.`; asks choice lines `Kept here` / `Moved to a new board`;
briefing `<from>` `sent a briefing · <time>` and `Ask: <ask>`; ask box placeholder `Ask the drawer about <board>`,
hints `You can ask once this answer lands` (busy), `This board won't open, so the drawer can't answer on it`,
`Selected <label>`, `Select shapes to ask about them`; facts `N question(s) · M shape(s) · answered HH:MM`, and
`empty · created HH:MM` with no questions and no shapes; switcher heading `N boards in <project>`, row sub
`N question(s) · <about title>`. A kept turn shows no question item.

- [ ] Tests: `talkItems` for each state (answered with card words per decision 8, answering, slow at 90 s, waiting,
      failed, stopped, asks with and without a choice, a briefing turn, a kept turn); `elapsedText` (18 s, 59 s,
      2 min 05 s); `talkTime` today and an older day; `aboutTitle`/`aboutLine` per kind; `askBox` precedence (won't
      open, busy, selection, none); `boardFacts` (empty, singular, plural, no answer yet); `switcherRows` (order kept,
      marks, `wontopen` from `loaderror`).
- [ ] `npx vitest run frontend/app/view/boards/boardtalkmodel.test.ts` passes; Check passes.

### Task 7: The talk column and the ask forms (components)
**Depends on:** Task 6 (renders its TalkItem, askBox and about lines)
**Files:** `frontend/app/view/boards/boardtalk.tsx`, `frontend/app/view/boards/boardaskform.tsx`

Presentational components, props in and callbacks out; no RPC and no store reads. Layout per the mockups
(`B1`, `B3`-`B9`, `B11`, `B12`), tokens per `DESIGN.md`. Motion: items enter with moment 1, the working dot pulses
(7), an asks item breathes (3), a landed card settles (4), the form reveals with moment 6b.

**Interfaces (produces):**
```ts
export interface BoardTalkProps {
    about: string;                // "About the waveterm code"
    items: TalkItem[];            // empty: "Nothing asked on this board yet" / "Ask below. To ask about something you drew, select it first."
    ask: { disabled: boolean; hint: string; placeholder: string };
    shownTurnId: string | null;   // whose Show is on
    onAsk: (question: string) => void;           // Enter asks, Shift Enter new line; empty does nothing
    onShow: (turnId: string, shapeIds: string[]) => void;
    onStop: () => void;
    onRetry: (turnId: string) => void;
    onChoice: (turnId: string, choice: "keep" | "new") => void;
}
export function BoardTalk(props: BoardTalkProps): JSX.Element;
export interface BoardAskFormProps {
    title: string;                // "Ask something new" | "Ask a board about this" | "New board from <board>"
    about: { title: string; line: string; runtime?: string }; // runtime: the agent's runtime dot
    startsWith?: { summary: string | null; drawing: string | null; keep: string }; // handoff only
    initialQuestion?: string;
    variant: "column" | "empty"; // empty: B12's order (First question, Name, About, Ask) and no Cancel
    onAsk: (name: string, question: string) => Promise<void>; // a rejection shows its message in the form (moment 13)
    onCancel?: () => void;
}
export function BoardAskForm(props: BoardAskFormProps): JSX.Element;
```
The form focuses the first question when `about` came from a thing (`B9`) and the name otherwise; Ctrl Enter asks,
Esc cancels (and does not reach the surface's Escape-home binding); an empty name shows `Type a name first`; the
footer reads `Ctrl Enter asks · Esc cancels`. `startsWith` lines: `A summary of <board>'s N questions, written by its
drawer` (omitted with no questions), `Its drawing, copied: N shapes, free to change` (omitted for a briefing), and
`<board> and its talk stay as they are.`. Every item and control carries a `data-board-*` attribute the scenario
reads (`data-board-talk`, `data-board-turn=<id>`, `data-board-show`, `data-board-stop`, `data-board-retry`,
`data-board-choice=keep|new`, `data-board-ask-box`, `data-board-ask-form`).

- [ ] Check passes; `npx eslint` on the two files is clean.
- [ ] Acceptance in the running app: `boards-ask` steps 1-8, 10, 11 and 13 (proved by the scenario Task 10 writes).

### Task 8: Wire the drawer into wavesrv, and `wsh board draw --context`
**Depends on:** Task 2, Task 3 (wires the Drawer it builds)
**Files:** `pkg/wshrpc/wshserver/wshserver_boarddrawer.go`, `pkg/wshrpc/wshserver/wshserver_boarddrawer_test.go`, `pkg/wshrpc/wshserver/wshserver_board.go`, `pkg/wshrpc/wshserver/wshserver_boardscribe.go`, `pkg/wshrpc/wshserver/wshserver_boardscribe_test.go`, `cmd/wsh/cmd/wshcmd-board.go`, `cmd/wsh/cmd/wshcmd-board_test.go`, `skills/cockpit/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/cockpit/SKILL.md`

Replace Task 1's stubs with real handlers over one `boarddrawer.Drawer` (Deps from `boardstore` and
`boardthings.Read`; publish on `wps.Event_BoardUpdate`). The old scribe stays wired until Task 11, but
`BoardAgentDrawCommand`, `boardByName`, `agentChannel`, `boardAgentCwd` and `agentSourceTitle` move into
`wshserver_boarddrawer.go` (with their tests), and `agentDrawFromTs` is deleted. `boardState` becomes
`"answering"` when `drawer.Busy`, else "".

- `BoardStartCommand`: name required (`Type a name first`); about kind one of `"" project agent session run effort
  record briefing`; `FromBoardId` validated and must be a board of the same channel; `Create` with `Elements`; write
  the talk (`About`, `Handoff{FromBoardId, FromName, Shapes}`); publish `list`; a non-empty question starts the first
  turn. Returns the new `BoardInfo`.
- `BoardTalkCommand` → `drawer.Talk`. `BoardAskCommand`: question required; refuses a board whose file won't open
  (its load error); refuses while busy (`BusyReason`). `BoardAskStopCommand`, `BoardAskRetryCommand`,
  `BoardAskChoiceCommand` (choice `keep` or `new`).
- `BoardAnswerInboxCommand`: one board, one project, or every project (each answer names its channel), as the old
  inbox. `BoardAnswerAckCommand`: `AckAnswer`, then `drawer.Answered`, publish `talk`.
- `BoardAgentDrawCommand`: `Context` required (`pass the briefing with --context`); the board by name (trimmed, any
  case, newest active first) or a new one whose about is `{kind: briefing, ref: tabId, title: <agent title>, text:
  context}`; the turn carries `Briefing{From: <agent title>, Text: context, Ask: ask}` and `Question: ask`, and queues
  behind a running turn. Returns at once.
- `wsh board draw --board <name> --context "<briefing>" [--ask "<question>"]`: `--board` and `--context` required
  before the RPC setup; prints `the drawer has your briefing on <board> in <project>`, plus `, a new board`.
- `skills/cockpit/SKILL.md` Boards section, then `task sync:claudemod` and commit the copy: "When the user asks you to
  put something on a board, run `wsh board draw --board "<name>" --context "<briefing>" --ask "<question>"`. Write
  the briefing yourself: what the user asked, the facts, and the files involved. A separate drawer answers on that
  board and the user carries on the talk on Boards; you draw nothing yourself."

- [ ] Tests with the drawer's `Run` stubbed and the board root in a temp data dir: `TestBoardStartEmptyMakesNoTurn`,
      `TestBoardStartWithQuestionStartsTurn`, `TestBoardStartCopiesElementsAndHandoff`,
      `TestBoardStartRefusesBadFromBoard`, `TestBoardAskRefusesWontOpen`, `TestBoardAskRefusesWhileBusy`,
      `TestBoardAnswerAckRecordsShapeIds`, `TestBoardAnswerInboxAllProjects`, `TestBoardAgentDrawNewBoardFromBriefing`,
      `TestBoardAgentDrawQueuesOnExistingBoard`, `TestBoardAgentDrawNeedsContext`, `TestBoardListShowsAnswering`; in
      `wshcmd-board_test.go`: missing `--context` fails before the RPC setup, and the printed line.
- [ ] `go test ./pkg/wshrpc/wshserver -run 'Board' ` and `go test ./cmd/wsh/cmd -run 'BoardDraw'` pass.

### Task 9: The Boards surface: talk column, switcher, forms, canvas and applier
**Depends on:** Task 4 (reads the ask form request boardFormAtom it adds), Task 5, Task 7 (renders BoardTalk and BoardAskForm)
**Files:** `frontend/app/view/boards/boardssurface.tsx`, `frontend/app/view/boards/boardswitcher.tsx`, `frontend/app/view/boards/boardslist.tsx`, `frontend/app/view/boards/boardcanvas.tsx`, `frontend/app/view/boards/boardstore.ts`, `frontend/app/view/boards/boardstore.test.ts`, `frontend/app/view/boards/boardapplier.ts`, `frontend/app/view/boards/boardapplier.test.ts`, `frontend/app/view/boards/boardmodel.ts`, `frontend/app/view/boards/boardmodel.test.ts`, `frontend/app/view/agents/agenttree.tsx`, `docs/keyboard-shortcuts.md`

Rebuild the surface per `B1`-`B12` and decisions 5-7, 9, 12-15; remove the 11-11 surface's scribe parts.

- **Layout:** header `Boards / <board> ▾` (the switcher trigger), `boardFacts` (moment 12 on its counts), and `New
  board from this` on the right; in form mode `Boards / New board in <project>` or `New board from <board>`. Body:
  the talk column (400px) left, the canvas right. No boards: `B12`'s empty state with `BoardAskForm variant="empty"`.
- **The switcher** (`boardswitcher.tsx`, `B2`): `+ Ask something new` first, then `switcherRows`; the answering mark
  pulses (7), asks you breathes (3); a row opens its board; Esc or a click outside closes it.
- **Forms:** `boardFormAtom` (Task 4) decides the talk column's form: `new` and `about` leave the canvas empty with
  `The drawer draws here once you ask.`; `handoff` keeps the current board's canvas showing and, on Ask, sends
  `copyElements` of it with `fromboardid`; `briefing` copies nothing and, once the board starts, sends
  `BoardAskChoiceCommand` `new`. Ask calls `BoardStartCommand`, clears the form and opens the new board.
- **The talk:** `BoardTalkCommand` per open board in a jotai atom keyed by board id, reloaded on `board:update`
  `talk`/`answer`/`list`, with a 1 s tick only while a turn is answering (for the elapsed time and the 90 s switch).
  Ask flushes the canvas's autosave, then `BoardAskCommand` with `on` = `selectionLabel` and `selectedids`. Show
  selects the turn's `shapeids` (decision 7). Stop, Retry and the choices call their commands; a failure toasts
  `Couldn't <what>` with the reason.
- **The canvas:** drop `seents`, source selection, pending, Keep and Drop; keep autosave, live apply, viewport and the
  Escape hook. Control: `{ show(ids: string[]): void; flush(): Promise<void>; elements(): readonly ExcalidrawElement[] }`;
  it reports selection changes (ids) to the surface. Live apply takes a `BoardAnswer` through `landAnswer` in one
  `updateScene` with `CaptureUpdateAction.IMMEDIATELY`, then saves.
- **The applier:** same `startBoardApplier(model)` signature. It reads `BoardAnswerInboxCommand` (at start, on
  `board:update` `answer`, and when a board opens), lands each answer live or into the file under its rev
  (`landAnswer`, the existing re-read on conflict), and acks with `shapeIds`. Toasts only for briefing turns
  (decision 14): `The drawer answered on <board>` / `From <from>'s briefing`; `The drawer asks you on <board>` /
  `Does <from>'s briefing belong on a new board?`; `The drawer couldn't answer on <board>` / the reason (error);
  each with Open (`openTarget` `board`).
- **The store** keeps `selectBoard`, `loadBoardList`, `boardListAtom`, `boardsChannelAtom`, `openBoardByChannelAtom`,
  `boardOwnsEscapeAtom`, `setBoardEscape`, `runBoardEscape`, `subscribeBoardUpdates`, `registerLiveBoard` and
  `liveBoardApply` (for `BoardAnswer`); it drops statuses and follows.
- **Removal:** delete `boardslist.tsx`; remove `followOf`, `sourceRows`, `applyDraw`, `keepPending`, `dropPending`,
  `markEdits`, `contentHash`, `headerFacts`, `newestSinceSeen`, `groupElementIds`, `yourShapesLabel`, `boardTime` and
  `ARC_SOURCE` from `boardmodel.ts` and their tests; remove the Agent tree's follow chips (`FollowChips`,
  `useAgentFollow`). Grep every removed name across `frontend/` and `scripts/` first (the 11-11 scenarios that use
  them are deleted in Task 10); no frontend code may still call `BoardCreateCommand`,
  `BoardDrawCommand`, `BoardRetryCommand`, `BoardFollowStopCommand`, `BoardStatusCommand`, `BoardInboxCommand` or
  `BoardInboxAckCommand`, or read `arc.sources`/`arc.seents` or `board:follow*` meta.
- `docs/keyboard-shortcuts.md` Boards section: `Enter` asks in the ask box, `Ctrl`+`Enter` asks in an ask form,
  `Esc` cancels an ask form.

- [ ] `boardstore.test.ts`: the talk atom reloads on `talk` and `answer` events for a loaded board and ignores
      others; the latest of two overlapping reads wins.
- [ ] `boardapplier.test.ts`: an answer lands live when the board is open, else into the file under the rev read
      (a conflict re-reads and reapplies); the ack carries `shapeIds`; a failed landing leaves it in the inbox for the
      next read; the three briefing toasts and their copy; no toast for a turn without `from`.
- [ ] `npx vitest run frontend/app/view/boards` passes; Check passes. The new commands are Task 1's stubs in this
      task's tree, so the vitest tests mock `RpcApi`.
- [ ] Acceptance in the running app: `boards-ask` steps 1-13, proved by the scenario Task 10 writes.

### Task 10: The boards-ask scenario
**Depends on:** Task 8 (makes real boards with the boardstart handler it builds), Task 9 (drives the surface it builds)
**Files:** `scripts/cdp/scenarios-boards-ask.mjs`, `scripts/cdp/scenarios-boards-surface.mjs`, `scripts/cdp/scenarios-boards-draw.mjs`, `scripts/cdp/scenarios-boards-follow.mjs`, `scripts/cdp/scenarios.mjs`

Write the scenario described under "The boards-ask scenario"; delete the three 11-11 scenario files and their imports
in `scenarios.mjs` (they drive the surface Task 9 replaced).

- [ ] Write `scripts/cdp/scenarios-boards-ask.mjs` (scenario `boards-ask`, export `BOARDS_ASK_SCENARIOS`, registered in
      `scenarios.mjs`) with the 13 steps, each with a screenshot named for its board (`boards-ask-B1-talk.png`, …).
- [ ] `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs boards-ask` passes every step. A step that fails on
      the UI is a defect in Task 9's or Task 7's work: fix it in the component, not by loosening the step.

### Task 11: Remove the scribe, following and the old board wire
**Depends on:** Task 8, Task 9 (removes the last frontend callers of the commands this deletes), Task 10 (deletes the 11-11 scenarios that call boardcreate, which this removes)
**Files:** `pkg/wshrpc/wshrpctypes_board.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/waveobj/wtypemeta.go`, `pkg/waveobj/metaconsts.go`, `pkg/wshrpc/wshserver/wshserver.go`, `pkg/wshrpc/wshserver/wshserver_board.go`, `pkg/wshrpc/wshserver/wshserver_board_test.go`, `pkg/wshrpc/wshserver/wshserver_boardscribe.go`, `pkg/wshrpc/wshserver/wshserver_boardscribe_test.go`, `pkg/boardstore/boardstore.go`, `pkg/boardstore/boardstore_test.go`, `pkg/boardscribe/doc.go`, `pkg/boardscribe/runner.go`, `pkg/boardscribe/scheduler.go`, `pkg/boardscribe/scheduler_test.go`, `pkg/boardscribe/scribe-prompt.md`, `pkg/boardscribe/scribe.go`, `pkg/boardscribe/scribe_test.go`

Delete `pkg/boardscribe` and `wshserver_boardscribe.go` (+ test). Remove the commands `BoardCreateCommand`,
`BoardDrawCommand`, `BoardRetryCommand`, `BoardFollowStopCommand`, `BoardStatusCommand`, `BoardInboxCommand`,
`BoardInboxAckCommand` and their handlers (with `allBoardDraws`), and the types `BoardDraw`, `BoardSourceStatus`,
`BoardStatusData`, `CommandBoardCreateData`, `CommandBoardDrawData`, `CommandBoardSourceData`,
`CommandBoardFollowStopData`, `CommandBoardInboxAckData`, `BoardArcSource`, `BoardArcPending`, `BoardBox`; trim
`BoardArcRecord` to `{Name, CreatedTs}` and `BoardInfo` of `Groups`, `LastDrawnTs`, `NewCount`. Remove the
`board:follow*` meta keys from `wtypemeta.go` and the `noteBoardFollowTurnEnded` call in `wshserver.go`. In
`boardstore`, remove `PutDraw`, `Draws`, `AckDraw`, `Previous`, the `.inbox` dir and the sources facts in
`infoFromFile`. Per AGENTS.md, hand-remove the deleted commands' functions from `wshclient.go` before `task generate`,
or generate fails on the missing types; then commit every regenerated file. Grep each removed symbol across `pkg/`,
`cmd/`, `frontend/` and `scripts/` (json names too: `boardcreate`, `boardstatus`, `board:followid`) before deleting;
`agentsessions.HumanPrompts` stays (`pkg/orchestrate/told.go` uses it).

- [ ] `wshserver_board_test.go` keeps the list, read, save, bad-id and damaged-board tests over `BoardStartCommand`
      instead of `BoardCreateCommand`; the inbox and follow tests go.
- [ ] `go vet ./pkg/... ./cmd/...` and Check pass; `go test ./pkg/boardstore ./pkg/wshrpc/wshserver -run 'Board'`
      passes; `git grep -n "boardscribe\|BoardFollow\|board:follow\|BoardDrawCommand" -- . ':!docs'` finds nothing.
