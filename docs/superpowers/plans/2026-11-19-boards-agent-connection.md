# Boards and the agent, connected

**Spec:** `docs/superpowers/specs/2026-11-19-boards-agent-connection-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/boarddrawer ./pkg/boardforward ./pkg/boardstore ./pkg/boardthings ./pkg/agentsessions ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/board...`
**Final:** `node scripts/cdp/final-verify.mjs boards-ask boards-workspace boards-transcript`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\boards-agent-connection\project\A1-Flow.dc.html

The drawer (Sonnet) stops answering in words: each turn it either changes the drawing or flags the line as a
question, which Arc types into the board's agent as the user's own message, with a marker the transcript shows as a
chip. When that agent's turn ends, wavesrv copies its reply onto the board's turn. A board tied to an agent opens as
a tab in that agent's workspace pane (W1), and the pane's Expand gives it the full turns column (W2).

## Decisions beyond the spec

1. **The canvas folder's A boards are the superseded "Option A".** A1-A3 show two buttons (Draw, Ask the agent);
   the spec's one ask box with one Ask wins. What they show besides the buttons still holds and gets a scenario
   step: A2 is the Boards surface with routed turns and the agent chip (`boards-ask`), A3 and A1's "what reaches the
   agent" are the forwarded line in the agent's transcript and its one-line `wsh board draw` (`boards-transcript`);
   A1's draw path (a drawn card, no words reply) is in `boards-ask`.
   W1 and W2 are `boards-workspace`.
2. **Answer format.** A drawing is `{"title", "add", "update", "remove"}`; a question for the agent is
   `{"question": true}` with nothing else; a briefing on a board with earlier turns may still answer
   `{"elsewhere": true}`. A `reply` key is ignored. On your own ask, an answer that draws nothing and flags nothing
   counts as a question (the anti-goal: a question is never dropped). On an agent's request a question flag or an
   empty drawing fails the turn with its reason (Retry stays). A rerouted line forced to draw that draws nothing
   also fails.
3. **Send the other way makes a new turn**, `From` naming the original, which is left as it was: redo, never undo.
   A drawn (answered) turn of yours can be sent to the agent; a forwarded turn can be drawn. An agent's own
   requests (briefing turns) have no send-the-other-way.
4. **A forward's states:** `held` (the agent has a question, permission prompt or dialog open: the roster's
   `asking`), `sent`, `replied`, `needsagent` (the board has no agent, or its agent's tab is no longer a live
   agent; `Reason` says which). Forwarding types the message with the existing `typeAgentMessage` (the person's own
   message), so a mid-turn agent takes it as a message you type would.
5. **The reply** is the last agent text after the forward's user entry (found by its marker's turn id) and before
   the next user entry, read with `agentsessions.TurnsSince` at each turn end of that agent until found. Pending
   forwards (`held`, `sent`) are indexed in memory and rebuilt from the talk files after a wavesrv restart, so none
   is lost.
6. **The marker** is the first line of the typed text; `pkg/boardforward.Marker` is its one source and the
   frontend's parser mirrors it (as `arcmessage.ts` mirrors `agentmsg.Envelope`):
   `[From board "<board>" · on <labels> · turn <turnId>]` then a newline and the question; ` · on <labels>` is left
   out with nothing selected; board name and labels are collapsed to one line each.
7. **The tie** lives in the talk (`BoardTalk.Agent`) and only claude and pi agents are tied. It is set by
   `wsh board draw` on a new board or on a board with no agent, by Ask a board about this on a claude or pi agent,
   and by the chip. Another agent's draw on a board tied to someone else is drawn as that agent's request, keeps
   the tie, and does not join that agent's workspace. Changing the chip resets the drawer's transcript cursor to
   the change and sends the board's `needsagent` turns to the new agent.
8. **`--context`** is required only when the draw creates the board; later requests may pass `--ask` alone (a
   briefing with empty `Text` is a one-line request).
9. **The narrow tab lists the last 2 turns** (as W1); expanded lists them all, as the Boards surface does.
10. **The agent chip** sits in the board's header (the Boards surface toolbar beside the facts, the workspace tab's
    header line); the picker opens from it, and inline in a `needsagent` turn with Start an agent. An untied
    board's chip reads "No agent" and opens the same picker.
11. **A board joins a workspace only when its agent renders** (`rendersNow`); otherwise it stays on the Boards
    surface and the toast's Open goes there. "Looking at that agent's workspace" means the Agent surface shows that
    agent with its pane open or expanded; the drawer's toast shows otherwise.
12. **wavesrv announces a join** with `board:update` `what: "join"` and `agenttabid`, on every draw by the tied
    agent and on a chip change. The frontend adds the tab behind the active one, unseen, and closes the board's tab
    in any other agent's workspace.
13. **Board facts** read "N drawings · M shapes · drawn HH:MM" from `BoardInfo.Drawings` and `DrawnTs`. A board
    whose last turn needs an agent marks the switcher as asking you.
14. **Two mounts of one board** (the always-mounted workspace tab and the Boards surface): the live-canvas registry
    keeps a stack per board, the newest registration applies answers, and unregistering falls back to the one
    before.
15. **The new scenario files are created empty and registered in Task 1**, so the UI tasks that fill them run in
    parallel without sharing `scripts/cdp/scenarios.mjs`.
16. **Start an agent** (on a `needsagent` turn) opens the existing New agent dialog over the current surface, its
    project preset to the board's project (a new model atom the dialog reads as its initial choice); it does not
    switch surfaces itself. The new agent is not tied and the waiting question is not sent to it on its own: once it
    is live it shows in the turn's picker, and picking it sends the question (nothing chains on its own).
17. **A held forward is released** by the first agent status event for that agent whose roster state is `working`
    or `idle` (not `asking`); the forwarder hooks every agent status event in `publishEvent`, not only the turn-end
    states `noteAgentTurnEnded` reads.
18. **One helper per shared server step**, defined in Task 1 so Tasks 3 and 4 call the same code:
    `boardAgentOf(tab, project)` builds the `BoardAgent` (title as `agentSourceTitle`, runtime from the tab, `ReadTs`
    now) and reports false for a runtime other than claude or pi; `publishBoardJoin(channelId, boardId, tabId)`
    publishes the join update.

### Task 1: The routing contract
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_board.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/boarddrawer/drawer.go`, `pkg/wshrpc/wshserver/wshserver_boarddrawer.go`, `pkg/wshrpc/wshserver/wshserver_boardforward.go`, `pkg/boardforward/doc.go`, `pkg/boardforward/boardforward.go`, `pkg/boardforward/boardforward_test.go`, `scripts/cdp/scenarios-boards-workspace.mjs`, `scripts/cdp/scenarios-boards-transcript.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:** the types, wire strings and stubs every other task builds on, with no behavior change. Run
`task generate` after the type changes.

**Interfaces:**

```go
// wshrpc
type BoardAgent struct {
    TabId   string `json:"tabid"`
    Title   string `json:"title"`   // "claude · waveterm", as agentSourceTitle names it
    Runtime string `json:"runtime"` // "claude" | "pi"
    ReadTs  int64  `json:"readts,omitempty"` // the drawer has read the agent's turns up to here
}
type BoardForward struct {
    State   string `json:"state"` // held | sent | replied | needsagent
    TabId   string `json:"tabid,omitempty"` // the agent it went to; kept when the board's agent changes
    Title   string `json:"title,omitempty"`
    Runtime string `json:"runtime,omitempty"`
    Reason  string `json:"reason,omitempty"` // needsagent: no agent, or the agent's tab is gone
    SentTs  int64  `json:"sentts,omitempty"`
    Reply   string `json:"reply,omitempty"`
    ReplyTs int64  `json:"replyts,omitempty"`
}
// BoardTalk:       Agent *BoardAgent `json:"agent,omitempty"`
// BoardTurn:       Route string `json:"route,omitempty"` ("draw" | "agent"; "" on turns from before routing),
//                  From string `json:"from,omitempty"` (the turn a send-the-other-way redoes),
//                  Forward *BoardForward `json:"forward,omitempty"`
// BoardInfo:       AgentTabId string `json:"agenttabid,omitempty"`, Drawings int `json:"drawings,omitempty"`,
//                  DrawnTs int64 `json:"drawnts,omitempty"`
// BoardUpdateData: AgentTabId string `json:"agenttabid,omitempty"`; What gains "join"
type CommandBoardSetAgentData struct {
    ChannelId string `json:"channelid"`
    BoardId   string `json:"boardid"`
    TabId     string `json:"tabid"`
}
// BoardCommands gains:
//   BoardRerouteCommand(ctx, CommandBoardTurnData) error    // send the other way
//   BoardSetAgentCommand(ctx, CommandBoardSetAgentData) error
```

- `pkg/boarddrawer`: constants `StateForwarded = "forwarded"`, `RouteDraw = "draw"`, `RouteAgent = "agent"`,
  `ForwardHeld`, `ForwardSent`, `ForwardReplied`, `ForwardNeedsAgent` (the strings above), and a Deps field
  `Forward func(b Board, turnId string)`: called, outside any talk update, once a turn is saved as forwarded.
- `pkg/wshrpc/wshserver/wshserver_boardforward.go`: the two handlers return an error saying they are not built
  yet, and a var `forwardBoardTurn` (a stub that logs) that `newBoardDrawer` wires as `Deps.Forward`.
- `pkg/boardforward`: `Marker(board, on, turnId, question string) string`, the format in decision 6.
- `pkg/wshrpc/wshserver/wshserver_boarddrawer.go`: `boardAgentOf(tab *waveobj.Tab, project string)
  (wshrpc.BoardAgent, bool)` and `publishBoardJoin(channelId, boardId, tabId string)` (decision 18), unused until
  Tasks 3 and 4.
- The two scenario files export `BOARDS_WORKSPACE_SCENARIOS = []` and `BOARDS_TRANSCRIPT_SCENARIOS = []`, spread
  into the registry in `scripts/cdp/scenarios.mjs` beside `BOARDS_ASK_SCENARIOS`.

**Acceptance:**
- `Marker` gives exactly the decision 6 text for a question with and without a selection, collapses a multi-line
  name or label to one line, and the line it makes never starts with `/`.
- `boardAgentOf` gives the claude or pi tab's tab id, title and runtime with `ReadTs` set, and false for a codex
  tab; `publishBoardJoin` publishes `board:update` with `what: "join"` and the tab id.
- The Go build, `task check:ts` and the existing board tests pass unchanged.

### Task 2: The drawer draws or flags a question
**Depends on:** Task 1
**Files:** `pkg/boarddrawer/answer.go`, `pkg/boarddrawer/answer_test.go`, `pkg/boarddrawer/drawer.go`, `pkg/boarddrawer/drawer_test.go`, `pkg/boarddrawer/prompt.go`, `pkg/boarddrawer/prompt_test.go`, `pkg/boarddrawer/drawer-prompt.md`, `pkg/boarddrawer/doc.go`, `pkg/wshrpc/wshserver/wshserver_boarddrawer_test.go`

**What to build:** each drawer turn ends either drawn or forwarded, never in words (decision 2). The prompt (the
drawer's own words are this task's call) says the drawer never replies in words, draws when the line asks for a
picture or a change to it, and flags anything asked in words for the agent. On every turn of a board with an agent,
the drawer is handed what that agent said since `Agent.ReadTs` (through `Deps.ReadThing` with an agent source and
that cursor), and the cursor is saved after the turn. A turn passed in with `Route: "draw"` must draw. A briefing
with empty `Text` reads as the agent's one-line request.

**Acceptance:**
- A drawing answer ends the turn `answered`, `Route: "draw"`, with the counts and title as today and no words
  reply, delivers it, and never calls `Deps.Forward` (nothing reaches the agent; A1's draw path).
- A question answer, or an empty answer on your ask, ends the turn `forwarded`, `Route: "agent"`, delivers
  nothing, and calls `Deps.Forward` once with that turn's id after the turn is saved.
- On a briefing turn, a question flag or an empty answer fails the turn with a reason; `elsewhere` still ends it
  `asks`.
- A `Route: "draw"` turn whose answer flags a question or draws nothing fails with a reason.
- A board with an agent: the prompt carries the agent's turns since the cursor, and the talk's `Agent.ReadTs`
  moves to the cursor `ReadThing` returned; a board without one reads no transcript.
- A briefing with empty `Text` and an ask makes a prompt with the ask and no empty `<briefing>` block.
- Turns saved before routing (words `reply`, no `Route`) still load and read as they did.

### Task 3: Questions reach the agent and its reply comes back
**Depends on:** Task 1
**Files:** `pkg/boardforward/boardforward.go`, `pkg/boardforward/boardforward_test.go`, `pkg/wshrpc/wshserver/wshserver_boardforward.go`, `pkg/wshrpc/wshserver/wshserver_boardforward_test.go`, `pkg/wshrpc/wshserver/wshserver.go`

**What to build:** the forwarder behind `forwardBoardTurn`, the reply copy, and the two new commands.
- Forwarding a turn resolves the board's agent in the agent roster: none, or not live, sets `needsagent` with its
  reason; `asking` sets `held`; otherwise it types `Marker(...)` with the board's name, the turn's `On` and its
  question through `typeAgentMessage` and sets `sent` with `SentTs`. Each change is saved and published as a talk
  update.
- On every agent status event (a new hook in `publishEvent`, beside `noteAgentTurnEnded`): a `held` forward to
  that agent is sent on the first event whose roster state is `working` or `idle` (decision 17); at a turn end, each `sent` forward to it looks for its reply (decision 5) and,
  when found, becomes `replied` with `Reply` and `ReplyTs`. Pending forwards survive a restart (decision 5).
- `BoardRerouteCommand` (decision 3): an answered turn of yours appends a forwarded turn with `From` and forwards
  it; a forwarded turn asks the drawer for a new turn with `From` and `Route: "draw"` (the drawer's busy refusal
  passes through); anything else is refused with a reason.
- `BoardSetAgentCommand`: the tab must be a live claude or pi agent in the board's project; it sets `talk.Agent`
  from `boardAgentOf`, sends each `needsagent` turn to it, publishes `list`, and calls `publishBoardJoin`. Earlier forwards keep the agent they went to.

`ReplyAfter(turns []agentsessions.Turn, turnId string) (reply string, ts int64, ok bool)` in `pkg/boardforward` is
the pure reply finder.

**Acceptance:**
- A forward to an idle live agent types exactly one message whose first line is the marker, and the turn reads
  `sent`; to an asking agent nothing is typed and it reads `held`; a later `asking` or `waiting` event sends
  nothing, and exactly one message goes on the first `working` or `idle` event.
- No agent, or a tab that is gone: `needsagent` with distinct reasons, nothing typed.
- `ReplyAfter` returns the last agent text between the marked user entry and the next user entry; no marked entry,
  or no agent text yet, is not found; an earlier turn's answer before the marked entry is never taken.
- At a turn end whose transcript holds the answer, the turn becomes `replied` with that text; before it does, it
  stays `sent`.
- After the pending index is dropped (a restart), a `sent` forward still gets its reply at the next turn end.
- Reroute of an answered turn appends a forwarded turn with `From` and leaves the original unchanged; of a forwarded
  turn, the drawer receives a `Route: "draw"` turn with `From`; of a failed turn, it errors.
- Set agent: a non-live tab, or a runtime other than claude or pi, is refused; a live one ties the board, sends its
  `needsagent` turns, and publishes `join` with the tab id.

### Task 4: Agents tie their boards
**Depends on:** Task 2
**Files:** `pkg/wshrpc/wshserver/wshserver_boarddrawer.go`, `pkg/wshrpc/wshserver/wshserver_boarddrawer_test.go`, `pkg/boardstore/boardstore.go`, `pkg/boardstore/boardstore_test.go`, `cmd/wsh/cmd/wshcmd-board.go`, `cmd/wsh/cmd/wshcmd-board_test.go`, `skills/cockpit/SKILL.md`, `cmd/wsh/cmd/claude-mod/skills/cockpit/SKILL.md`

**What to build:** the tie set from where boards start (decision 7), the one-line `wsh board draw` (decision 8),
the join announcement (decision 12), and the list facts (decision 13).
- `BoardAgentDrawCommand`: a new board, or one with no agent, is tied to the drawing agent through `boardAgentOf`
  when it is claude or pi; every draw by the tied agent calls `publishBoardJoin`, before the drawer's turn ends.
  `TestBoardAgentDrawNeedsContext` changes to decision 8 (this is why the task waits for Task 2: both edit
  `wshserver_boarddrawer_test.go`).
- `BoardStartCommand` with an `about` of kind `agent` and runtime claude or pi ties the new board to it.
- `boardstore.List` fills `AgentTabId`, `Drawings` (turns drawn), `DrawnTs` (the last one's time), and marks a
  board whose last turn needs an agent as `asks`.
- The cockpit skill's Boards section (source in `skills/`, then `task sync:claudemod` for the tracked copy): the
  first request carries `--context`; later ones are one `--ask` line; a message that starts with the board marker is
  the user's question from a board, answered in words; draw again only when the answer changes the picture.

**Acceptance:**
- A draw that creates a board, by a claude agent, ties it (tab id, title, runtime) and publishes `join`; a codex
  agent's leaves it untied.
- A second agent's draw on a tied board keeps the tie and publishes no `join` for the second agent; a draw on an
  untied board ties it.
- `wsh board draw --board X --ask "..."` without `--context` succeeds on an existing board and is refused with a
  message naming `--context` when X does not exist; with neither flag it is refused before any RPC.
- Starting a board about a claude agent ties it; about a run, untied.
- `List` reports `agenttabid`, `drawings` and `drawnts` from the talk, and `asks` for a trailing `needsagent` turn.

### Task 5: The forwarded line in the agent's transcript
**Depends on:** Task 1 (the marker format and the empty scenario file)
**Files:** `frontend/app/view/agents/arcmessage.ts`, `frontend/app/view/agents/arcmessage.test.ts`, `frontend/app/view/agents/arcmessagerow.tsx`, `frontend/app/view/agents/transcriptlayout.ts`, `scripts/cdp/scenarios-boards-transcript.mjs`

**What to build:** a user entry that starts with the board marker is an `ArcMessage` of kind `board`
(`{ board, on?, turnId, text }`), drawn as the user's own message with a "from <board> · on <shapes>" chip above it
(W1, A3); "· on" is left out with no selection. The parser mirrors `boardforward.Marker` with a comment pointing at
it. Since the line is Arc's, the box recall skips it, as it skips other Arc messages.

**Acceptance:**
- The parser reads board, labels, turn id and question from marker text with and without a selection, and leaves a
  user message that only mentions a board as a plain user message.
- Scenario `boards-transcript`, step "A3 forwarded question": a fixture agent in the Rendered view whose transcript
  holds a forwarded line, its answer and a one-line `wsh board draw` shows the chip text, the question as a user
  message and the answer below it (A3, W1's left half, A1's "what reaches the agent"), with a screenshot.

### Task 6: Routed turns on the Boards surface
**Depends on:** Task 1 (the generated types)
**Files:** `frontend/app/view/boards/boardtalkmodel.ts`, `frontend/app/view/boards/boardtalkmodel.test.ts`, `frontend/app/view/boards/boardtalk.tsx`, `frontend/app/view/boards/boardssurface.tsx`, `frontend/app/view/boards/boardstore.ts`, `frontend/app/view/boards/boardstore.test.ts`, `frontend/app/view/boards/boardview.tsx`, `frontend/app/view/boards/boardagentpicker.tsx`, `frontend/app/view/agents/agents.tsx`, `frontend/app/view/agents/newagentmodal.tsx`, `scripts/cdp/scenarios-boards-ask.mjs`

**What to build:** the Boards surface (A2, minus its second button) shows routed turns, one Ask, and the agent chip.
- `talkItems` gains a placement argument, `"beside" | "expanded" | "surface"`, and items for: a drawn turn (its
  card with Show and Send to the agent); a forwarded turn by forward state: `held` "waiting for <agent>", `sent`
  "sent to the agent" ("· answered in the transcript" when beside), `replied` "<agent> answered · HH:MM" with the
  copied reply where not beside, `needsagent` "needs an agent" with the picker and Start an agent; Draw instead on
  every forwarded turn; a rerouted turn names what it redoes. Earlier words replies still show as history.
- The ask box has one Ask, "Ask the board"; selection hint as today.
- The header's agent chip (decision 10) shows the board's agent and opens the picker of the project's live claude
  and pi agents (a pure choices function in the model); picking calls `BoardSetAgentCommand`. Open agent on a
  replied turn opens that agent through the router.
- Facts read "N drawings · M shapes · drawn HH:MM" (decision 13).
- Start an agent (decision 16): `AgentsViewModel` gains `newAgentProjectAtom` (a project name or null), which the
  New agent dialog takes as its initial project and clears on close.
- `loadBoardTalk` keeps `agent`.
- State changes and their moments: a forward's state line changing is moment 14; a needs-an-agent turn holds
  moment 3 until answered; a new routed turn enters with moment 1, as talk items do today.
- The open board's state and actions (selection, Show, ask, stop, retry, choice, reroute, set agent, the lazy
  canvas) move out of `boardssurface.tsx` into `boardview.tsx` as `useBoardView(channelId, boardId)` and
  `LazyBoardCanvas`, which Task 7 reuses.
- Migrate `boards-ask`'s stubs and steps to routed turns (they stub `BoardRerouteCommand` and `BoardSetAgentCommand`
  too).

**Acceptance:**
- Model: each forward state and placement gives the item above; a drawn turn offers Send to the agent, a forwarded
  one Draw instead, a briefing turn neither; the picker's choices are the project's live claude and pi agents only.
- Scenario `boards-ask`, step "A2 routed turns": a board with a drawn turn, a forwarded `replied` turn and a
  `needsagent` turn shows the drawn card (title and "added N shapes", no words reply: A1's draw path) with Send to
  the agent, the copied reply with Open agent and Draw instead, the needs-an-agent picker, one Ask, the agent chip
  and the facts line, with a screenshot; clicking Send to the agent and Draw instead calls the reroute stub with the
  turn's id; picking an agent in the chip's picker calls the set-agent stub; clicking Start an agent opens the New
  agent dialog with the board's project chosen while the Boards surface stays the current surface.
- The migrated B-steps of `boards-ask` pass.

### Task 7: The board tab in the agent's workspace
**Depends on:** Task 6
**Files:** `frontend/app/view/agents/workspacemodel.ts`, `frontend/app/view/agents/workspacemodel.test.ts`, `frontend/app/view/agents/workspacepane.tsx`, `frontend/app/view/agents/workspaceboardtab.tsx`, `frontend/app/view/boards/boardstore.ts`, `frontend/app/view/boards/boardstore.test.ts`, `frontend/app/view/boards/boardview.tsx`, `frontend/app/view/boards/boardtalk.tsx`, `frontend/app/view/boards/boardtalkmodel.ts`, `frontend/app/view/boards/boardtalkmodel.test.ts`, `scripts/cdp/scenarios-boards-workspace.mjs`

**What to build:** `WorkspaceTab` gains `{ kind: "board"; channelId: string; boardId: string }`, key
`board:<boardId>`, label "Board · <name>".
- Beside the transcript (W1): the header line (name, agent chip, facts, the drawer's working state with its
  seconds), the canvas, the last 2 turns as one-liners (`"beside"` items) with Show and send-the-other-way, and the
  ask box.
- Expanded (W2): the full turns column (`"expanded"` items) on the left with the copied reply, Back to the
  transcript (un-expands the pane) and Draw instead, the canvas full width.
- The live-canvas registry keeps a stack per board (decision 14).
- State changes and their moments (`docs/reference/motion-system.md`): a turn joining the narrow list, the oldest
  leaving it, is moments 1 and 2 (item entrance, exit + reflow); a forward's state line changing (sent to replied,
  held to sent) is moment 14 (a value changed under you); a needs-an-agent turn is moment 3 (attention) until
  answered; the drawer's working seconds use moment 7 (status pulse).

**Acceptance:**
- Model: the board tab's key and label, and opening it twice keeps one tab.
- Registry: with two registrations of one board, an answer goes to the newer; unregistering it returns to the older.
- Scenario `boards-workspace`, step "W1 board tab": a fixture agent in the Rendered view with a board tab open shows
  the header line (board name, the agent chip naming the agent, "N drawings · M shapes · drawn HH:MM", and the
  drawer's working state with its seconds while a turn is answering), the canvas, the 2 last turns (a drawn one with
  Show, a forwarded one reading "sent to the agent · answered in the transcript" with Draw instead) and the ask box
  beside the transcript, with a screenshot; step "W1 new turn" shows a turn joining the list (moments 1 and 2), and
  a forward's line changing from "waiting for <agent>" to sent (moment 14).
- Step "W2 expanded": Expand shows the turns column with the agent's request row ("the agent asked"), the copied
  reply, Back to the transcript and Draw instead, and an in-progress row for the agent's request with its seconds,
  beside the full-width canvas, with a screenshot; Back to the transcript returns to the W1 layout.

### Task 8: Boards open where their agent is
**Depends on:** Task 7
**Files:** `frontend/app/view/boards/boardplacement.ts`, `frontend/app/view/boards/boardplacement.test.ts`, `frontend/app/view/jarvis/openref.ts`, `frontend/app/view/jarvis/openref.test.ts`, `frontend/app/view/boards/boardapplier.ts`, `frontend/app/view/boards/boardapplier.test.ts`, `frontend/app/view/agents/workspacestore.ts`, `frontend/app/view/agents/workspacestore.test.ts`, `frontend/app/view/boards/boardssurface.tsx`, `scripts/cdp/scenarios-boards-workspace.mjs`

**What to build:** where a tied board opens and when it joins (decisions 11, 12).
- A pure `boardplacement.ts` decides, from the board's `agenttabid`, the roster and the agent's view: open in that
  agent's workspace when it renders, else on the Boards surface; and whether the drawer's toast shows (not looking
  at that agent's workspace).
- `openTarget` for a board follows it: the Agent surface with that agent selected and the board tab active, or the
  Boards surface. The Boards surface's switcher pick of a tied board, and a board just started from Ask a board
  about this on an agent, open through the router.
- A `join` update adds the board's tab behind the active one, unseen, in that agent's workspace when it renders,
  and closes the board's tab in every other agent's workspace (a chip change moves it). Closing a board tab stores
  nothing, so the next join adds it again.
- The applier's toast for an agent's request ("The drawer drew on <board>" and its failure) shows only when
  placement says so; its Open goes through the router.

**Acceptance:**
- Placement: a tied board whose agent renders opens in the workspace; terminal view, ended, a codex runtime, no
  agent, or a gone agent opens on Boards; the toast shows unless the Agent surface shows that agent with its pane
  open or expanded.
- Workspace store: a join adds the tab unseen without changing the active tab; a join for another agent moves the
  tab; closing then joining again adds it back.
- Router: opening a tied board lands on the Agent surface with that agent and tab active; an untied one lands on
  Boards.
- Scenario `boards-workspace`, step "join on draw": a `join` update for the shown agent adds the board tab behind
  the active one with its unseen mark and no toast; step "open from Boards": picking the tied board in the Boards
  switcher lands on the Agent surface with the board tab active, with a screenshot; step "toast off-screen": with
  the Boards surface shown, a tied agent's request turn answering raises the drawer's toast (screenshot), and its
  Open lands on the Agent surface with that agent and the board tab active.
