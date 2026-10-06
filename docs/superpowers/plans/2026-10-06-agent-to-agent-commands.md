# Agent-to-agent commands implementation plan

**Effort:** effort:9a24ac55-5ea9-4b18-a171-5dc481160d0f
**Spec:** `docs/superpowers/specs/2026-10-06-agent-to-agent-commands-design.md` Read it first: it is the design, and every task's requirements include it.
**Verify:** `node scripts/verify.mjs ./pkg/agentmsg ./pkg/agentsessions ./pkg/orchestrate ./pkg/wshrpc/... ./cmd/wsh/... ./skills`
**Check:** `go vet ./pkg/agentsessions/ ./pkg/orchestrate/ ./pkg/wshrpc/... ./cmd/wsh/... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`

## Goal and shape

`wsh agents list | send | read` let one agent find a live agent tab, hand it a prompt, and read its last
answer, so follow-up work goes to the session that already holds the context instead of a new run.

Delivery reuses the one existing server-side path, `orchestrate.SendToSession` (the Claude mod's control
stream when the session holds one, bracketed-paste typing otherwise). Nothing in this plan builds a second
delivery path, a UI, or a persisted message log. Only claude and pi sessions are agents here.

## Global constraints

- Go is the source of truth for wshrpc types. After changing `pkg/wshrpc/wshrpctypes_agents.go` run
  `task generate`; never hand-edit a generated file (`frontend/app/store/wshclientapi.ts`,
  `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`).
- Reuse before writing: `orchestrate.SendToSession`, `orchestrate.latestAgentStatus`, `agentctl.Has`,
  `agentask.GlobalRegistry`, `runHasWorkerTab` (`wshserver_jarvis.go`), `agentsessions.TranscriptForSession`,
  the project resolution in `cmd/wsh/cmd/wshcmd-runs.go` (`runsProjectAt`, `runsPathWithin`).
- A harness seam is unit-tested with a fake. No test starts a live session, a PTY, or wavesrv.
- Errors are returned with context and never swallowed. Comments say why, in lower case, only when needed.
- No codex or opencode support. No new dependencies.
- No attribution trailer in any commit message.

## Review focus

Inputs the spec implies that are most likely to bite; each is pinned by a test in the task named.

- A tab prefix that matches two live tabs: `send` and `read` refuse and name the candidates (Task 2).
- A message whose text starts with `/`: it arrives inside the envelope and runs no command (Task 1).
- A long typed message claude recorded inside `<pasted_content>`: still recognized as an agent message
  and kept out of `HumanPrompts` (Task 1).
- `send --wait` against a target that ends up asking the user: the wait ends and says so (Task 3).
- `read` on a session that has not answered yet, or whose transcript path is unknown: an empty answer
  with the state, not an error (Task 2); `wsh` prints that it has not answered yet (Task 3).

### Task 1: Message envelope, send-back lock, and last-answer reading
**Depends on:** none

Files this task owns:
- Create `pkg/agentmsg/agentmsg.go`, `pkg/agentmsg/agentmsg_test.go`
- Modify `pkg/agentsessions/humanprompts.go`, `pkg/agentsessions/humanprompts_test.go`
- Create `pkg/agentsessions/lastanswer.go`, `pkg/agentsessions/lastanswer_test.go`

Decisions:
- `pkg/agentmsg` imports nothing from the engine (no wstore, orchestrate, wshrpc), so `agentsessions`
  can import it.
- The envelope is the spec's one header line, a newline, then the text. Its fixed prefix is one
  constant that `Envelope` writes and `IsAgentMessage` checks.
- The lock is a mutex-guarded in-memory map keyed by block id: `NoteSent(from, to)` records that `to`
  was last messaged by `from`; `SendBackLocked(from, to)` is true exactly when `to` messaged `from` and
  `from`'s turn has not ended; `TurnEnded(block)` clears what was recorded for `block`.
- `LastAnswer` returns the full text (not clipped) of the last assistant text and its transcript time
  in the unit `parseTs` returns. Claude: the last non-sidechain `assistant` record with non-blank text
  blocks, joined with newlines. Pi: the last entry on `ActiveBranch()` whose message role is assistant
  with text. Another runtime or an unreadable file gives `"", 0`.
- `HumanPrompts` drops a prompt for which `IsAgentMessage` is true, for claude (after the
  `<pasted_content>` wrapper is removed) and for pi.

Interfaces other tasks rely on:
```go
package agentmsg
func Envelope(senderName, senderTabId, text string) string
func IsAgentMessage(text string) bool
func NoteSent(fromBlock, toBlock string)
func SendBackLocked(fromBlock, toBlock string) bool
func TurnEnded(block string)

package agentsessions
func LastAnswer(path, runtime string) (text string, ts int64)
```

Acceptance, each proven by a focused test:
- `Envelope` output satisfies `IsAgentMessage`, names the sender's tab name and id, and ends with the
  text unchanged; a text starting with `/` yields an envelope that does not start with `/`; ordinary
  text is not an agent message.
- After `NoteSent(a, b)`: `SendBackLocked(b, a)` is true, `SendBackLocked(a, b)` and
  `SendBackLocked(b, c)` are false; after `TurnEnded(b)` it is false. Safe under `go test -race`.
- `LastAnswer` on a claude fixture returns the last main-chain assistant text and its time, ignoring a
  later sidechain assistant record and tool-only assistant records; on a pi fixture returns the active
  branch's last assistant text; on a transcript with no assistant text, and for runtime `codex`,
  returns `"", 0`.
- `HumanPrompts` omits an enveloped prompt typed into claude, the same prompt wrapped in
  `<pasted_content id="..">`, and an enveloped pi user message, while keeping the human's prompts
  around it.

Run: `go test ./pkg/agentmsg -race -run 'TestEnvelope|TestSendBack'` and
`go test ./pkg/agentsessions -run 'TestLastAnswer|TestHumanPromptsSkipAgentMessages'`

### Task 2: The agents RPCs and their server handlers
**Depends on:** Task 1

Files this task owns:
- Modify `pkg/wshrpc/wshrpctypes_agents.go`, then `task generate` (owns every generated file it rewrites)
- Create `pkg/wshrpc/wshserver/wshserver_agentmsg.go`, `pkg/wshrpc/wshserver/wshserver_agentmsg_test.go`
- Modify `pkg/orchestrate/wake.go` (export the status read only), `pkg/wshrpc/wshserver/wshserver.go`
  (the `EventPublishCommand` hook only)

Decisions:
- Three commands on `AgentCommands`, json field names lower case without separators as the file's
  other types have them:
```go
AgentsListCommand(ctx context.Context) (*CommandAgentsListRtnData, error)
AgentsSendCommand(ctx context.Context, data CommandAgentsSendData) (*CommandAgentsSendRtnData, error)
AgentsReadCommand(ctx context.Context, data CommandAgentsReadData) (*CommandAgentsReadRtnData, error)

type AgentInfo struct { TabId, Name, ProjectPath, Project, RunId, Harness, State string }
type CommandAgentsListRtnData struct { Agents []AgentInfo }
type CommandAgentsSendData struct { Tab, Text, FromORef string } // FromORef: the sender's block oref
type CommandAgentsSendRtnData struct { TabId string; SentTs int64; MidTurn bool } // SentTs: server unix ms
type CommandAgentsReadData struct { Tab string }
type CommandAgentsReadRtnData struct { TabId, State, Answer string; AnswerTs int64 }
```
- `State` is one of three exported constants, `idle`, `working`, `asking`: `asking` when the latest
  status says so or `agentask.GlobalRegistry` holds an open ask for the block; `idle` for idle or
  waiting; `working` otherwise.
- `orchestrate.latestAgentStatus` becomes exported `LatestAgentStatus(blockId, tabId string)
  baseds.AgentStatusData`; its existing callers are updated; no behavior change.
- The roster is one function used by all three handlers, split so its pure part is tested without a
  store: a loader gathers, per tab, the tab, its first block id, whether that block's shell is running,
  its latest status, whether it has an open ask and a control stream, and the runs; a pure function
  turns those into `AgentInfo` rows per the spec's "Server" section (claude and pi only; run from
  `runHasWorkerTab`; project path from the run, else the status cwd; project name from the channel
  holding that path, else the path's last element). The loader is a package variable so tests script it.
- Tab resolution: an exact tab id, else a unique prefix among roster rows. No match: an error saying
  the tab is not a live agent session and pointing at `wsh agents list`. Several matches: an error
  listing the candidates' ids and names.
- `AgentsSendCommand` checks in this order, each with its own message: target resolves; sender
  resolves from `FromORef` (a block oref whose tab exists) ; target is not the sender's tab;
  `agentmsg.SendBackLocked(senderBlock, targetBlock)` is false (the message says the sender reads the
  reply with `wsh agents read`, so answer in the turn); trimmed text is not empty; target is not
  `asking` while it holds no control stream. Then `agentmsg.NoteSent`, `agentmsg.Envelope` with the
  sender tab's name and id, and the delivery seam: a package variable defaulting to
  `orchestrate.SendToSession`. `MidTurn` in the reply is true when the target was not `idle`.
- `AgentsReadCommand` resolves the tab and returns its state with `agentsessions.LastAnswer`; the
  transcript path is the status's `TranscriptPath`, else the block's `agent:transcriptpath` meta, else
  `agentsessions.TranscriptForSession(agentsessions.SessionRoot(runtime), runtime, cwd, sessionId)`.
  No path or no answer is an empty `Answer`, not an error.
- `EventPublishCommand` calls `agentmsg.TurnEnded(blockId)` for an agent-status event whose state is
  idle or waiting and whose scope is a block oref.
- Keep the spec's `ponytail:` comment on the roster about a tab whose agent exited to its shell.

Acceptance, each proven by a focused test in `wshserver_agentmsg_test.go` using the scripted loader
and a fake delivery seam:
- Rows: a claude tab with a run, a pi tab with no run (project from cwd), a codex tab and a tab whose
  shell is not running (both absent); the three states, including `asking` from an open ask alone.
- Resolution: exact id, unique prefix, unknown tab, ambiguous prefix naming both candidates.
- Each `send` refusal above returns its own error and calls the seam zero times.
- A good send calls the seam once with the target's block id and a text for which
  `agentmsg.IsAgentMessage` is true and that contains the sender tab's name and the original text;
  afterwards a send from the target back to the sender is refused, and is accepted again after an
  idle agent-status event for the target's block passes through `EventPublishCommand`.
- An asking target with a control stream is accepted; `MidTurn` is true for a working target and
  false for an idle one.
- `read` returns the fixture transcript's last answer and time with the state, and an empty answer
  when the session has no transcript path.

Run: `go test ./pkg/wshrpc/wshserver -run 'TestAgentsRoster|TestAgentsResolve|TestAgentsSend|TestAgentsRead'`
and `go test ./pkg/orchestrate -run 'TestWake'` for the rename.

### Task 3: The `wsh agents` commands
**Depends on:** Task 2
**Chunk:** wsh agents list: live agent tabs with tab id, project, run, status (idle, working, asking)
**Chunk:** wsh agents send <tab> <text|--file>: deliver a prompt to an existing agent session, queued if it is mid-turn
**Chunk:** wsh agents read <tab>: the target's last answer, so the sender can follow up without a new run

Files this task owns:
- Create `cmd/wsh/cmd/wshcmd-agents.go`, `cmd/wsh/cmd/wshcmd-agents_test.go`

Decisions:
- A visible `agents` cobra group with `list`, `send`, `read`, built like `wshcmd-runs.go` (pure
  line-building and argument functions, thin `RunE`s over `wshclient.Agents*Command`).
- `list [--all] [--json]`: columns are the tab id's first 8 characters, name, project, the run id's
  first 8 characters or `-`, harness, state. Without `--all` it keeps rows whose `ProjectPath` is
  inside the caller's project, resolved with the helpers `wsh runs` uses; a caller in no project sees
  every row. No rows prints one line saying there are no live agents (and how to see all projects when
  filtered). `--json` prints the kept rows as a JSON array.
- `send <tab> [text] [--file path] [--wait] [--timeout 10m]`: exactly one of the text argument and
  `--file`; blank text is refused before any RPC; `FromORef` is the caller's block from
  `resolveBlockArg`. Prints the target's short id and whether the message started a turn or joined a
  running one, and the `wsh agents read <tab>` line to get the answer.
- `--wait` polls `AgentsReadCommand` every 2 seconds (a named constant) until the state is not
  `working` and `AnswerTs` is later than the send's `SentTs`, then prints the answer. A state of
  `asking` ends the wait with a line saying the target is waiting on the user. On timeout it returns
  an error saying the target is still working and to run `wsh agents read <tab>` later. The loop is a
  function taking the read call, a sleep and a clock as parameters, so the test scripts them.
- `read <tab> [--json]`: prints the answer; with none, one line saying the session has not answered
  yet and its state. `--json` prints the reply data.
- RPC errors are returned as they come.

Acceptance, each proven by a focused test:
- List lines for a mixed roster, the project filter (inside, outside, caller in no project), the
  empty-roster line, and `--json` shape.
- Text resolution: argument only, file only, both (error), neither (error), blank file (error).
- The wait loop: returns the answer once the state leaves `working` with a newer answer; keeps
  waiting while the answer is older than the send; ends on `asking`; errors on timeout.
- `read` output with an answer and without one.

Run: `go test ./cmd/wsh/cmd -run 'TestAgentsList|TestAgentsSendText|TestAgentsWait|TestAgentsRead'`

### Task 4: Teach the cockpit-runs skill
**Depends on:** none
**Chunk:** Teach it: cockpit-runs skill says to message a finished run's live agent before starting a new run

Files this task owns:
- Modify `skills/cockpit-runs/SKILL.md` (never the vault or `~/.claude/skills` copies)

Decisions:
- The frontmatter description also names messaging a live agent via `wsh agents`, so the skill is
  found for it.
- A short section after the `wsh runs` command list: `wsh agents list`, `wsh agents send <tab> "<text>"`
  (or `--file`, `--wait`), `wsh agents read <tab>`, one line each.
- One rule in Rules: for follow-up work on something a finished run did, look for that run's agent in
  `wsh agents list` first; when its tab is live, send it the follow-up and read the answer; start a new
  run only when no live agent holds that context. Say that the target answers in its own turn and the
  sender reads it, so a target does not send a message back.
- Keep the file's voice and length: no new headings beyond the one section.

Acceptance: the skill's existing embed test still passes and the file contains the three commands and
the rule.

Run: `go test ./skills`
