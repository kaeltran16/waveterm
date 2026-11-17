# Rendered view: messages sent mid-turn, command output, and two fixes

**Effort:** effort:f283ad11-bcef-4053-b3f8-cda2e04998a2
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\f860511c\docs\superpowers\specs\2026-11-17-rendered-midturn-and-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/... ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/agentctl/... ./pkg/agentsessions/... ./pkg/orchestrate/... ./pkg/wshrpc/... ./cmd/wsh/cmd`
**Final:** `node scripts/cdp/final-verify.mjs agent-queued agent-rendered transcript-base transcript-arc`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\rendered-midturn\project\Queued.dc.html

> **For agentic workers:** each task states its decisions, files, interfaces and acceptance; you write the
> implementation and pick the tests. The spec holds the facts and the why of every decision: read it first, then
> the decisions below, which settle what the spec left to the builder.

**Goal:** a message typed into an agent's box while it works shows at once as Queued, can be taken back with ↑ until
the agent reads it, and is read exactly once; messages typed in the terminal and Arc's own mid-turn messages show
too; a slash command's output shows under it; a session opened with `!` gets a clean title; the file-peek check stops
flaking.

**Architecture:** the arc mod holds every text that arrives mid-turn and joins it at the next tool result (or sends
it as the next prompt at the turn's end). It reports the person's held messages through `wsh agentqueue set` to
wavesrv, which keeps them per block in `pkg/agentctl` and publishes an `agent:queue` event. The Rendered view draws
those, plus Claude Code's own queue read from the transcript's queue-operation records, at the foot of the
transcript. ↑ is a synchronous take-back RPC the mod answers. Pure rules live in `*model.ts` / `*-core.ts` files
beside their tests.

## Decisions beyond the design

1. **The mod holds every mid-turn text, Arc's included, until the next tool result** (spec "Other messages sent
   mid-turn", as amended for this run). Only the person's messages (sent with `queue`) are reported and takeable;
   Arc's are held silently and never show as Queued. Why: "no message is read twice" holds only if a text joins at
   the moment the next request is about to go out, which is the tool-result door; today's join-at-once plus `unread`
   tracking is what reads a late text twice.
2. **Prompts join at the next step; commands wait for the turn's end.** At a tool result every held prompt joins, in
   arrival order; a held slash command stays held. At the turn's end the rest goes in arrival order: consecutive
   person prompts as one prompt joined by `\n`, each Arc text as its own prompt, each command run as a command.
   Why: a command joined as text is read instead of run (spec), and Claude Code merges its queued prompts into one
   turn.
3. **Only the box sets `queue`.** A new `sendTypedText` sends `AgentPromptCommand` with `queue: true`, and
   `useAgentComposer` / `submitComposer` default to it, which covers the Rendered box and every agent card's
   `AgentComposer`. Canvas, comment, brainstorm, code handoff, channel and header sends keep `sendAgentText` and are
   Arc's messages. Without a mod stream wavesrv types the text as today, so it lands in Claude Code's own queue and
   draws through decision 7.
4. **Report and loss.** The mod reports its whole held list plus the ids that left and how (`joined`, `sent`,
   `takenback`) after every change, and once (empty) at `session.start`. wavesrv marks as lost every previously
   held item that is missing from a report without being in its `left`, and every held item when the block's
   stream ends with no newer stream registered. The `agent:queue` event (Persist 1, scoped to the block oref)
   carries `held` and `lost`. Why: a reload or session end can't drop a message silently, and no timer decides it.
5. **Take-back is synchronous.** `AgentTakeBackCommand` errors at once when the block has no mod stream. Otherwise it
   sends `{"takeback":"<request id>"}` down the stream and waits up to 4 s, under wshrpc's 5 s default, for the
   mod's report naming that request. A report that arrives after the wait gets an error, and the mod keeps those
   items held and reports them again. Why: a message is never in both the box and the queue, and none is lost.
6. **Joined records draw by their text.** A user record with `isMeta: true` and `origin {kind: "plugin", name:
   "arc"}` projects as a mid-turn user entry (`queued: true`), so the existing Arc classification
   (`arcMessageOf`) draws a wake as a wake and a brainstorm line as a brainstorm line, a new `agent` kind draws an
   enveloped agent message, and any other text draws as the person's bubble, as it would have at idle. The mod's
   `read mid-turn` notice (a `system` record) keeps drawing nothing. Why: the transcript does not say who wrote a
   joined row, and the same text draws the same way however it arrived. A joined entry is never a run's brief.
7. **Claude Code's own queue comes from queue-operation records.** An `enqueue` with prompt or slash-command content
   waits; `remove` (`absorbed_mid_turn`) and `dequeue` (no content: oldest first) take it; `popAll` drops every
   waiting one. Content-less enqueues and `<task-notification>` content are counted for the FIFO but never drawn.
   A taken message is already drawn by its own record (the `queued_command` attachment, or the next user record).
8. **Queued items draw at the foot, above the working line,** through `NarrationTimeline`'s `tail` slot: the
   person's bubble (or the command row for a slash command), then one `Queued · Esc to stop and send now` /
   `N queued · Esc to stop and send now` line under the last one, counting mod and terminal items together.
   A mod item that left as `joined` or `sent` keeps drawing, without the Queued line, until the projected
   transcript holds, after the item's `ts`, an entry that matches it: a `user` entry whose text lines contain the
   item's text lines as a contiguous run (so a turn-end prompt `a\nb` matches both `a` and `b`), or, for an item
   that is a slash command, a `command` entry whose `name` plus ` args` (when it has args) equals the item's
   trimmed text. So no frame shows it twice or not at all.
9. **↑ and the placeholder concern the mod's queue only.** The placeholder reads `Press ↑ to edit queued messages`
   only while the mod holds something for this block. With only Claude Code's own queue waiting, ↑ recalls history.
   Why: ↑ can only take back what the mod holds (spec), so naming it otherwise would mislead.
10. **History is the session's typed prompts:** projected `user` entries that `arcMessageOf` does not classify, and
    `command` entries, newest first, consecutive duplicates once. Shell runs are not prompts. The box is in recall
    while its text equals the recalled entry; an edit leaves recall.
11. **Lost messages are never dropped.** On receipt the store toasts a warning naming the agent and how many queued
    messages did not reach it, and keeps the lost items per block, unapplied, until that agent's Rendered box is
    mounted and appends their texts, one per line; then they are applied. Each lost id is toasted and applied once,
    because a persisted event can be delivered again on reconnect, and a later report must not clear lost items not
    yet applied.
12. **Scenarios:** a new `agent-queued` scenario holds the Queued board's states and the box keys; command output
    joins `transcript-base`; joined Arc rows join `transcript-arc`; the flake fix stays in `agent-rendered`. The
    fixture agent in `agent-queued` has no mod: the scenario drives reports with `SetAgentQueueCommand`, and for ↑ it
    opens the block's `AgentControlCommand` stream from the page itself and answers each `{"takeback":id}` with a
    `SetAgentQueueCommand` report naming it. The canvas folder holds only the two boards in `canvas.json` (Queued,
    CommandOutput); the rejected brainstorm alternatives were moved out of it.

Rules for every task:
- After changing a wshrpc, waveobj or baseds event type run `task generate`. After editing `claude/arc-mod/`, run
  `task sync:claudemod` and include the copies in `cmd/wsh/cmd/claude-mod/`.
- Colours come from the `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens. UI follows `DESIGN.md`.
  Box-local keys stay in the composer; nothing goes in `bindings.ts`.
- A task that writes scenario steps runs its scenario before it completes, and the scenario passes:
  `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario>` (never `task verify:ui`: a run tree has no
  dev app). Append steps; do not reorder existing ones.
- A state change a task adds names its moment from `docs/reference/motion-system.md`.
- A Depends on line with no reason is an edge between tasks that share a file.

### Task 1: Queue wire
**Depends on:** none
**Files:** `pkg/baseds/baseds.go`, `pkg/wps/wpstypes.go`, `pkg/tsgen/tsgenevent.go`, `pkg/wshrpc/wshrpctypes_agents.go`, `pkg/agentctl/agentctl.go`, `pkg/wshrpc/wshserver/wshserver_agents.go`, `pkg/wshrpc/wshserver/wshserver_agentqueue.go`, `cmd/wsh/cmd/wshcmd-agentqueue.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `frontend/types/waveevent.d.ts`

**What to build:** the contract the mod, wavesrv and the frontend share, so Task 2 and Task 5 can run beside each
other. The types and fields below, the `agent:queue` event registered (event list and tsgen), `agentctl.Msg`'s new
fields passed through `AgentControlCommand` to the stream, `wsh agentqueue set` (hidden, block from
`WAVETERM_BLOCKID` as `wsh claudecmds set` does, reads the report on stdin and exits non-zero with wavesrv's error),
and the two server methods in a new `wshserver_agentqueue.go` answering a "not built yet" error until Task 2.
`task generate`.

**Interfaces:**
```go
// pkg/baseds; payload of wps.Event_AgentQueue = "agent:queue" (Persist 1, scope: the block oref)
type QueuedPrompt struct { Id string `json:"id"`; Text string `json:"text"`; Ts int64 `json:"ts"` } // Ts: UnixMilli the mod took it
type AgentQueueData struct { ORef string `json:"oref"`; Held []QueuedPrompt `json:"held"`; Lost []QueuedPrompt `json:"lost,omitempty"` }
// pkg/wshrpc
CommandAgentPromptData.Queue bool `json:"queue,omitempty"`            // typed into an agent's box
AgentControlMsg.Queue bool `json:"queue,omitempty"`; AgentControlMsg.TakeBack string `json:"takeback,omitempty"`
type QueueLeft struct { Id string `json:"id"`; How string `json:"how"` } // "joined" | "sent" | "takenback"
type CommandSetAgentQueueData struct { BlockId string `json:"blockid"`; Held []baseds.QueuedPrompt `json:"held"`; Left []QueueLeft `json:"left,omitempty"`; TakeBack string `json:"takeback,omitempty"` }
type CommandAgentTakeBackData struct { BlockId string `json:"blockid"` }
type CommandAgentTakeBackRtnData struct { Items []baseds.QueuedPrompt `json:"items"` } // in the order they were sent
SetAgentQueueCommand(ctx context.Context, data CommandSetAgentQueueData) error
AgentTakeBackCommand(ctx context.Context, data CommandAgentTakeBackData) (*CommandAgentTakeBackRtnData, error)
// pkg/agentctl.Msg gains Queue bool and TakeBack string
```
`wsh agentqueue set` stdin: `{"held":[...],"left":[...],"takeback":"<id>"}` (the `CommandSetAgentQueueData` fields
without `blockid`). Stream lines the mod reads: `{"text":"…","midturn":true,"queue":true}` and `{"takeback":"<id>"}`.

**Acceptance:**
- A `Msg{Queue: true}` and a `Msg{TakeBack: "r1"}` sent with `agentctl.Send` reach an `AgentControlCommand` stream as
  `queue: true` and `takeback: "r1"`.
- `wsh agentqueue set` with a JSON body calls `SetAgentQueueCommand` for its block; bad JSON exits non-zero naming
  the parse error.
- `task generate` output is committed; tsc and `go vet` pass.

### Task 2: wavesrv queue state, loss and take-back
**Depends on:** Task 1
**Files:** `pkg/agentctl/agentctl.go`, `pkg/agentctl/agentctl_test.go`, `pkg/agentctl/queue.go`, `pkg/agentctl/queue_test.go`, `pkg/wshrpc/wshserver/wshserver_agentqueue.go`, `pkg/wshrpc/wshserver/wshserver_agentqueue_test.go`, `pkg/wshrpc/wshserver/agentcontrol_test.go`, `pkg/wshrpc/wshserver/wshserver_agentmsg.go`, `pkg/wshrpc/wshserver/wshserver_agentmsg_test.go`, `pkg/orchestrate/wake.go`, `pkg/orchestrate/wake_test.go`

**What to build:** decisions 3 to 5 in wavesrv. `AgentPromptCommand` with `queue` hands the text to the block's mod
stream with `Queue` set, through a new `orchestrate.QueueToSession` beside `SendToSession` (same stream or typed
fallback, `MidTurn` decided as `overStream` does), held in a package var as `deliverAgentMessage` is so tests capture
it. `pkg/agentctl` keeps each block's held list, computes lost per decision 4 (stream end: in the close `Register`
returns, only when that stream is still the block's current one), publishes `agent:queue`, and runs the take-back
wait.

**Acceptance:**
- `AgentPromptCommand{queue: true}` on a block with a stream delivers one message with `Queue` set and nothing typed;
  without a stream it is typed exactly as a plain `AgentPromptCommand` is; without `queue` nothing changes.
- A report publishes `agent:queue` with the new `held`; an item dropped without a `left` entry comes back in `lost`;
  ending the block's only stream publishes every held item as `lost`; ending a stream a newer one replaced publishes
  nothing.
- `AgentTakeBackCommand` on a block with no stream errors at once; with a stream it sends one `takeback` message and
  returns the items of the report that names its request id; with no such report within 4 s it errors and the held
  list is unchanged; a report naming a request no longer awaited errors.

### Task 3: A session opened with `!` takes no raw tags as its title
**Depends on:** none
**Chunk:** Fix: a session that starts with ! takes '<bash-input>…</bash-input>' as its title
**Files:** `cmd/wsh/cmd/wshcmd-agenthook.go`, `cmd/wsh/cmd/wshcmd-agenthook_test.go`, `pkg/agentsessions/agentsessions.go`, `pkg/agentsessions/agentsessions_test.go`, `pkg/agentsessions/humanprompts.go`, `pkg/agentsessions/humanprompts_test.go`

**What to build:** spec "Title of a session that starts with !". The sources found: the hook's no-ai-title fallback
(`readFirstUserPrompt` / `titleFromPrompt` in `wshcmd-agenthook.go`, which feeds the status title behind the header,
tree, card and box placeholder, and the status detail behind the events feed), the session index title and started
text (`sessionTitle` / `claudeSessionFrom` / `claudeEventsFrom` in `agentsessions.go`), and `HumanPrompts`. A
`<bash-input>` record is a shell run: it titles the session as `! <command>` only until a typed prompt exists, as a
bare slash command does today (`isBareCommand`); `<bash-stdout>` / `<bash-stderr>` records are never a title or a
prompt. If the hook's status detail on `UserPromptSubmit` carries the raw tags for a `!` run, it reads `! <command>`
too. Confirm against a real transcript that starts with `!` (there are some under `~/.claude/projects`).

**Acceptance:**
- A transcript whose first user record is `<bash-input>ls</bash-input>`, then its output, then the prompt `fix the
  build`, titles as `fix the build` in the hook fallback and the session index; with no typed prompt yet it titles
  `! ls`.
- No title, started text, status detail or `HumanPrompts` entry contains `<bash-`.

### Task 4: Slash command output under its command
**Depends on:** none
**Chunk:** Slash command output shown under the command
**Files:** `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `scripts/cdp/scenarios-transcript-base.mjs`

**What to build:** spec "Slash command output", CommandOutput board. A `<local-command-stdout>` (and
`<local-command-stderr>`) user record attaches its text, colour codes stripped, to the entry right before it when
that entry is a command other than `/compact` that has no output yet; otherwise it draws nothing (a `/compact`
output, an output after another entry, an output with no command). `CommandChip` draws the output under the command
row, aligned with it, in mono and muted ink, unclamped. A command with no output draws its row alone.

**Interfaces:** the command entry gains `output?: string` in `AgentEntry` (`agentsviewmodel.ts`).

**Acceptance:**
- `/mcp` followed by `<local-command-stdout>\x1b[1mAuthentication successful.\x1b[22m Connected to
  siem-portal.</local-command-stdout>` projects one command entry with `output: "Authentication successful.
  Connected to siem-portal."`; `/compact` followed by its stdout projects no output; a stdout with no command before
  it adds nothing; `/clear` alone has no output.
- `transcript-base` step (new) shows the CommandOutput board: `/mcp` with its line under the row, `/config` with its
  line, and `/clear` with nothing under it beside a compaction divider with no output block.

### Task 5: The arc mod holds mid-turn texts, reports and takes back
**Depends on:** Task 1 (uses `wsh agentqueue set` and the `queue` / `takeback` stream fields it adds)
**Files:** `claude/arc-mod/hooks/control-core.ts`, `claude/arc-mod/hooks/control-core.test.ts`, `claude/arc-mod/hooks/queue-core.ts`, `claude/arc-mod/hooks/queue-core.test.ts`, `claude/arc-mod/hooks/register.ts`, `cmd/wsh/cmd/claude-mod/hooks/control-core.ts`, `cmd/wsh/cmd/claude-mod/hooks/queue-core.ts`, `cmd/wsh/cmd/claude-mod/hooks/register.ts`

**What to build:** decisions 1, 2, 4 and 5 in the mod. Read `docs/agents/claude-mods.md` first. `controlMsg`
parses `queue` and `takeback`. A new pure `queue-core.ts` owns the held list and its rules (hold, join at a tool
result, the turn-end plan, take-back, the report payload); `register.ts` wires it to the stream, the
`session.append` tool-result door (main agent only), `turn.complete` and `session.start`, and replaces today's
`turn.unread`. Outside a turn a `queue` text runs at once as today. Each person item gets an id unique within the
session. Reports are sent one at a time, in order; a failed report or an erroring take-back report puts the taken
items back in the held list. Joined Arc texts keep their `read mid-turn` notice. Check live behaviour with the pty
harness in `C:\Users\kael02\IdeaProjects\waveterm\.superpowers\probes\claude-mods\compactprobe\` (`drive.cjs`; strip
`WAVETERM_BLOCKID` / `WAVETERM_JWT`, rename a scratch copy of the mod); the live checks need no wavesrv, since a
failed report is only logged.

**Acceptance:**
- Pure rules (vitest): a queued text while a turn runs is held and reported; at a tool result held prompts join in
  order and commands stay; at the turn's end `[a, b, /x, c]` plans prompt `a\nb`, command `/x`, prompt `c`, and an
  Arc text is its own prompt; take-back returns every held person item in order and leaves Arc texts; a text never
  appears in both a join and a turn-end plan.
- Live (probe): a message held during a running Bash call is in the request that carries that call's result (the
  model's next reply knows it) and is not submitted again at the turn's end; joined rows never split the tool
  results of a parallel batch; Esc (interrupt) ends the turn and the held messages then go as the next prompt; a
  held message taken back never reaches the model.
- `task sync:claudemod` copies committed.

### Task 6: Messages read mid-turn draw where they were read
**Depends on:** Task 4
**Files:** `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `frontend/app/view/agents/arcmessage.ts`, `frontend/app/view/agents/arcmessage.test.ts`, `frontend/app/view/agents/arcmessagerow.tsx`, `scripts/cdp/scenarios-transcript-arc.mjs`

**What to build:** decision 6 and spec "Other messages sent mid-turn". The arc-origin `isMeta` user record projects
as a `queued: true` user entry; other `isMeta` records stay skipped. `ArcMessage` gains `{ kind: "agent"; sender:
string; tabId: string; text: string }` for the `agentmsg.Envelope` shape (`[Message from agent "<name>" (tab <id>),
sent with wsh agents send. …]\n<text>`), drawn by `ArcMessageRow` as a message from that agent, its body the text
after the envelope line, in the existing Arc row style. A joined entry never counts as a run's first user (brief) in
`transcriptlayout.ts`, and does not start a turn.

**Interfaces:** `ArcMessage`'s `agent` variant above.

**Acceptance:**
- A joined record `t-5 passed review` projects as a user entry with `queued: true` placed where it was written; a
  joined `wake: task 3 failed (...)` lays out as a wake row; a joined envelope lays out as an `agent` Arc row with
  the sender and body; a non-arc `isMeta` record (skill body) is still skipped; the `system` notice draws nothing.
- An agent envelope that arrives as a normal prompt also draws as the `agent` row.
- `transcript-arc` step (new): a turn with a joined wake and a joined agent message between its steps shows the wake
  row and the agent-message row at those points, and a joined plain text as the person's bubble.

### Task 7: Queued bubbles at the foot of the transcript
**Depends on:** Task 2 (its scenario drives `SetAgentQueueCommand` and `AgentPromptCommand{queue}`, which Task 2 implements, on Task 1's types), Task 4, Task 6 (uses joined records projecting as user entries to retire a joined bubble)
**Files:** `frontend/app/view/agents/agentqueuestore.ts`, `frontend/app/view/agents/agentqueuestore.test.ts`, `frontend/app/view/agents/queuedprompts.ts`, `frontend/app/view/agents/queuedprompts.test.ts`, `frontend/app/boot/boot-core.ts`, `frontend/app/view/agents/livetranscript.ts`, `frontend/app/view/agents/livetranscriptatoms.ts`, `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/narrationtimeline.tsx`
**Files:** `frontend/app/view/agents/renderedmode.ts`, `frontend/app/view/agents/renderedmode.test.ts`, `frontend/app/view/agents/renderedcomposer.tsx`, `frontend/app/view/agents/agentsend.ts`, `frontend/app/view/agents/agentsend.test.ts`, `frontend/app/view/agents/agentcomposer.tsx`, `frontend/app/view/agents/agentcomposer.test.ts`, `scripts/cdp/scenarios-agent-queued.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:** the Queued board's first, second and fourth artboards, and decisions 3, 7, 8 and 9 in the
frontend. `sendTypedText` and the composer default (decision 3). `agentqueuestore.ts` subscribes to `agent:queue`
(installed at boot as `setupAgentAskSubscription` is) and keeps each block's latest `held`. A pure `queuedprompts.ts`
computes Claude Code's waiting queue from records (decision 7; `livetranscript.ts` stores it per agent beside the
entries) and the foot list from both sources with decision 8's retirement rule. The Rendered view draws the foot list
in the tail slot with the person's bubble and command row styles, exported from `narrationtimeline.tsx` rather than
copied. `composerBox` takes whether the mod holds anything and sets the placeholder (decision 9). The working line,
the Esc interrupt and the Send/Stop button are unchanged.

**Interfaces:** `sendTypedText(blockId: string, text: string): Promise<void>` (`agentsend.ts`);
`getAgentQueueAtom(oref: string): Atom<AgentQueueData | null>` (`agentqueuestore.ts`, oref `block:<id>`).

**Acceptance:**
- The box's Send and Enter, and an agent card's composer, call `AgentPromptCommand` with `queue: true`; the other
  senders do not.
- Model: enqueue `x` then nothing → `x` waits; then `remove absorbed_mid_turn` → not waiting; enqueue `x`, `y` then
  `dequeue` → `y` waits; `popAll` → none; a content-less enqueue is never drawn and still shifts the FIFO.
- Model: a mod item gone from `held` with no matching entry still draws, without the Queued line; items `a` and `b`
  retire once a later user entry `a\nb` exists; an item `/x arg` retires on a later command entry `{name: "/x",
  args: "arg"}`; an entry from before the item's `ts` retires nothing; a `lost` item does not draw.
- `agent-queued` steps (new scenario, a fixture claude agent shown Rendered with no mod, reports driven through
  `SetAgentQueueCommand`): one queued message shows its bubble with `Queued · Esc to stop and send now` above the
  working line and the placeholder `Press ↑ to edit queued messages`; a second shows `2 queued · Esc to stop and send
  now` under the last bubble; a queued slash command shows as its command row with the line; a transcript `enqueue`
  record shows a Queued bubble too and its `remove absorbed_mid_turn` keeps the bubble and drops the line; "taken at
  the next step": the report drops both as `joined` and joined records land, the bubbles stay in place, the line goes
  and the placeholder is the working one again.

### Task 8: ↑ takes the queue back, recalls history, and lost messages return
**Depends on:** Task 7
**Chunk:** Queued messages: bubble, ↑ take-back and recall, Esc stops and sends
**Files:** `frontend/app/view/agents/renderedcomposer.tsx`, `frontend/app/view/agents/boxrecallmodel.ts`, `frontend/app/view/agents/boxrecallmodel.test.ts`, `frontend/app/view/agents/agentqueuestore.ts`, `frontend/app/view/agents/agentqueuestore.test.ts`, `scripts/cdp/scenarios-agent-queued.mjs`

**What to build:** the Queued board's third artboard, and decisions 5, 10 and 11 in the box. ↑ in the empty
Rendered box: while the mod holds something, `AgentTakeBackCommand` and the returned texts fill the box, one per
line, in order (the bubbles go, the turn runs on, Enter queues the text again); a failed take-back keeps the box
empty and toasts the error, and the messages stay queued. With nothing held, ↑ / ↓ step through history (decision
10), ↓ past the newest empties the box. The `/` and `@` panels' keys keep priority. The store keeps and toasts lost
items and the box applies them (decision 11). The pure rules (which key does what, the history list and step, the
lost bookkeeping) live in `boxrecallmodel.ts` and the store.

**Acceptance:**
- Model: ↑ with held items asks for take-back; ↑ with none and history `[a, /x, b]` (oldest first) gives `b`, then
  `/x`, then `a`, then stays; ↓ from `a` gives `/x`, `b`, then empty; an Arc-classified entry and a shell run are not
  in history; an edited recall leaves recall.
- Model (store): a lost item received while no box is mounted is toasted once and kept; a later report without it
  keeps it; a box mount applies it once; the same event delivered again neither toasts nor applies it twice.
- `agent-queued` steps, the scenario holding the fixture block's `AgentControlCommand` stream from the page and
  answering each `{"takeback":id}` with a `SetAgentQueueCommand` report naming it: with two messages queued, ↑ in the
  empty box fills it with both lines in order, both bubbles and the Queued line go, the working line stays; Enter
  queues the text again as one bubble; a take-back left unanswered shows the error toast and the bubbles stay; with
  nothing queued, ↑ recalls the newest typed prompt and ↓ empties the box; a report that drops a held message without
  a `left` shows the warning toast and puts its text back in the box.

### Task 9: The file-peek check fails only when the peek is broken
**Depends on:** Task 7
**Chunk:** Flake: agent-rendered 'rendered: file peek' failed once in run af7381fb (drawn: false, Monaco drew no view lines though the peek opened and closed); passed on rerun of the same tree. Step predates the run; repro under CPU stress.
**Files:** `scripts/cdp/scenarios-agent-rendered.mjs`, `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/code/codepeekcard.tsx`

**What to build:** reproduce the `rendered: file peek` failure (`drawn: false`) by running the `agent-rendered`
scenario's steps back to back in one isolated app under CPU stress, in this task's own tree: copy
`scripts/cdp/final-verify.mjs` to a temp file whose verify step runs a loop script that attaches, runs the scenario
N times and prints failed steps, and start `worker_threads` busy-spinners only after attach (stress during boot
overruns the build cap). Then fix the cause where it lies: the step's wait, or the peek (the dock's comment in
`renderedview.tsx` notes the editor measures its box once, on mount). A fix in the wait must still fail when the
editor really draws nothing. It runs after Task 7 only because both edit `renderedview.tsx`.

**Acceptance:**
- The completion report gives the failure rate under stress before and after the fix, with the run counts.
- After the fix the step passes every run of at least 10 under the same stress, and still fails when the peek's
  editor is made to draw nothing (checked once by breaking it, then reverted).
- If 20 stressed runs never reproduce it, the report says so with the counts and this task changes no file.
- `agent-rendered`'s `rendered: file peek` step shows the peek drawing the file.
