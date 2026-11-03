# Remote control on the Arc phone app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hand chosen claude and pi agents to the phone page, where the owner reads their transcript, sends the next prompt, stops a turn and approves or denies a Claude Code permission prompt, all through Arc's own phone listener, tunnel and locks.

**Architecture:** `pkg/remotemode` keeps the hand-overs in memory and owns the one eligibility rule. It reads agents and transcripts through two hooks (`AgentsHook`, `TranscriptHook`) that `pkg/wshrpc/wshserver` implements from its roster and transcript tailer, set in `main-server.go` like `orchestrate.SealRunEvidenceHook`. That is needed because `wshserver` imports `remotemode`, so the reverse import would be a cycle. The phone listener gets an SSE route and four action routes, and it types into the agent's block in-process with `blockcontroller.SendInput`, the function `ControllerInputCommand` wraps. The page draws the transcript with the cockpit's own projectors, which esbuild bundles into one committed ES module. The cockpit gets a Hand to phone button and key, and `wsh` gets `remote hand` and `remote take-back`.

**Tech Stack:** Go (`net/http` SSE), plain ES modules on the phone page, esbuild (already in `node_modules` through vite), React 19 + jotai, vitest, CDP scenarios.

**Spec:** `C:\Users\kael02\IdeaProjects\waveterm\docs\superpowers\specs\2026-11-03-arc-pwa-more-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/remotemode/... ./pkg/wshrpc/... ./pkg/baseds/... ./cmd/wsh/... ./cmd/remotepreview/...`
**Check:** `task check:ts && go vet ./pkg/remotemode/... ./pkg/wshrpc/... ./cmd/wsh/... ./cmd/remotepreview/ ./cmd/server/`
**Final:** `node scripts/cdp/final-verify.mjs remote-phone remote-hand`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\arc-pwa-rc\project\Cockpit.dc.html

## Decisions beyond the design (and why)

1. **Hooks, not a package move.** `remotemode` declares `AgentsHook` and `TranscriptHook` (types in Task 1). `wshserver` implements them from `loadAgentRosterFacts`/`buildAgentRoster`/`agentTranscriptPath`/`streamTranscript`, and `main-server.go` assigns them before `remotemode.Restore()`. Why: moving the roster and tailer out of `wshserver` would rewrite two large files and their tests for no behavior change. The repo already wires engine hooks this way, and the interface stays owned by its consumer.
2. **The eligibility rule** is `remotemode.Eligible(a Agent) error`, used by `Hand`, by every phone request and by `Status`'s prune. An agent is eligible when it is in the roster (a running shell whose status reports claude or pi), has a `BlockId`, its session is live (below), and it is not a run worker. **Live session.** The roster keeps a tab whose claude or pi exited back to its shell, with its last status (the ponytail note on `buildAgentRoster`), and a Send there would type into a bare shell. So `Eligible` also requires:
   - **claude:** `Agent.HasStream`, the arc mod's control stream (`agentctl.Has(blockId)`). The mod's `wsh agentctl` process lives exactly as long as the claude session, and every claude Arc launches loads the mod. A claude session without the mod (none expected) is refused, which is safe.
   - **pi:** `!Status.Ended`. pi's status extension already reports on `session_shutdown`. That report now passes a new `wsh agentstatus --ended`, which sets `AgentStatusData.Ended` (`json:"ended,omitempty"`). The next `session_start` report clears it, since only the latest status counts.

   Why not a SessionEnd hook for claude: Arc no longer manages SessionEnd (`managedHooks`), and the mod's stream already marks the claude process's lifetime exactly. Run workers: `Agent.RunWorker` is true when the tab's owner run (`ownerRun`) has a `TaskId`, `Review`, a `StageRole` or a `ParentLeadORef`. Those are the engine's task workers, task reviewers and stage sessions, and the children a lead starts with `wsh jarvis run`. An orchestrator lead's own run has none of the four, so it is eligible, and so is a Quick run's agent. The cockpit mirrors the rule in the pure `canHandToPhone` (Task 8), shown for a plain agent or a lead role only. It cannot call Go per render. A `wsh jarvis run` child with no dag reads as a plain agent there, so the button can show and the backend refuses with a toast. That mismatch is accepted.
3. **Hand-overs are in memory only and do not survive an Arc restart**, even when remote mode itself is restored at start. Turning off clears them and the ended reasons. Why: the spec says each time the owner leaves starts clean, and a restarted wavesrv has restarted the blocks too.
4. **Ending.** `TakeBack` records reason `taken`. An agent that stops being eligible is dropped with reason `exited` the next time anything reads the hand-overs: `Status`, the list call, every phone request, and the stream's 2 s state poll. Turning off (`remoteTurnOff`, the one path for the desk, `wsh` and the phone's button) clears every hand-over and gives each the reason `off`. A listener stop, whether off or a re-setup's restart (`remoteRestartIfOn`), closes open streams without an `ended` event. After a restart the page's `EventSource` reconnects and the hand-overs are still there. After an off, the page goes unreachable. Hand-overs are cleared in `remoteTurnOff`, not in `remoteStopLocked`, so a re-setup does not end them. Reasons are kept per tab until remote mode turns off, so a stream or a reload opened after the fact still says why. Handing a tab over again clears its reason. `Status` prunes silently. A prune from a phone request publishes `remote:status` when it dropped something. Why: no agent-exit event reaches `remotemode`, and Status runs inside `publishStatus`, so publishing from it would recurse.
5. **`RemoteStatusData.Handed []string`** (sorted tab ids) is the handed-over set on the existing `remote:status` event. The agent header and the phone both read it. `Hand` turns remote mode on (the existing `On` path) only after the agent passes `Eligible`, so a refused hand-over starts nothing. If turning on fails, nothing is handed.
6. **The phone states**, derived in Go from the hook's raw status:
   - `asking` when an ask is open or the status is asking.
   - `permission` when the status is `waiting`, `Hook == "Notification"` and `NotificationType == "permission_prompt"`.
   - `input` for any other `waiting`.
   - `working` and `idle` as reported.

   The roster's `agentsState` folds waiting into idle, so `Agent` carries the raw `Status`. `Since` is when the listener first saw the agent in its current phone state: seeded from `Status.Ts` at the first look, and set to now on each change. Why: `Status.Ts` moves on every tool call, and "working 1m" must count the turn.
7. **The notification type travels on `baseds.AgentStatusData.NotificationType`** (`json:"notificationtype,omitempty"`). `planEmission` fills it for the waiting Notification cases only. No other reporter sets it.
7b. **Task 1 stays one task (types, hooks and hand-over logic together)** rather than a contract task followed by the logic. The phone routes (Task 4) need the hand-over logic for their own tests: exited pruning, the `off` reason and since tracking. So a split would move only Tasks 2, 3 and 8 earlier, none of which is on the longest chain (1 → 4 → 7), while adding a task, a review and a merge to that chain.
8. **Keystrokes.** Each is typed with `blockcontroller.SendInput` (via a package var, so tests record it), as the owner's own input. Never `AgentsSendCommand`, never the mod's control stream.
   - **Send:** a bracketed paste of the text (`ESC[200~ … ESC[201~`), a pause of `agentask.KeystrokeDelay`, then `\r`, as `orchestrate.typeWake` does, so a multi-line message stays one message.
   - **Stop:** `\x1b`.
   - **Approve:** `1`. It picks Claude Code's first option ("Yes") without depending on where the menu's cursor sits. Enter would pick whatever is focused, and that could be "Yes, and don't ask again".
   - **Deny:** `\x1b`, the menu's "No, and tell Claude what to do differently". With text, it is followed after `agentask.KeystrokeDelay` by the text typed as Send types it.

   Every action re-reads the state at request time and refuses with 409 when it does not fit:
   - send only while `idle` or `working`;
   - stop only while `working`;
   - approve and deny only while `permission`.
9. **Wire shapes (the phone page's contract).** `GET /api/waiting` gains `handed: HandedAgent[]`. The spec allows this instead of a separate list call, and it costs one fetch per refresh. The routes are below. Each one acts only on a tab handed over at that moment. A tab that is not answers 410 `{"error":"gone","reason":"taken"|"exited"|"off"}`. Path params use Go 1.22 mux patterns.
   - `GET /api/agents/{tab}/stream` is SSE with `Content-Type: text/event-stream`, `Cache-Control: no-store` and `X-Accel-Buffering: no`. It sends:
     - `event: agent` with a `HandedAgent` JSON, first and on every change;
     - `event: lines` with `{"lines":[...]}`: the transcript backlog (the tailer's default 200 lines), then each append;
     - `event: ended` with `{"reason":...}`, after which the stream closes;
     - a `: ping` comment every `remoteStreamHeartbeat` (25 s, a var), under cloudflared's 100 s idle cut.

     A tab not handed over gets 200 with a single `ended` event, so `EventSource` can read why, where it cannot read a 4xx body.
   - `POST /api/agents/{tab}/send` with `{"text"}` (non-empty after trim, at most `handlerMaxBody`).
   - `POST /api/agents/{tab}/stop`, `/approve` and `/deny`, the last with an optional `{"text"}`.
   - `POST /api/agents/{tab}/takeback`.

   Every POST goes through the existing `handlerPost` (Origin, JSON content type, body cap), and every route through `Verify`.
10. **The chat is addressed by `#agent/<tab>`** in the page URL, so a reload or a push tap keeps it, and the preview can open the exited case directly. The page redraws the transcript by re-projecting the lines it holds on every `lines` event, keeping at most 2000. The projectors replay whole transcripts, and they are fast at that size.
11. **The projector bundle** is `pkg/remotemode/web/static/projectors.js`, built from a new entry `frontend/app/view/agents/remoteprojectors.ts` that exports `projectFor(runtime, lines)`. It uses `projectTranscript` for claude and `projectPiTranscript` for pi, and gives `[]` for anything else. `scripts/sync-remote-web.mjs` builds it with esbuild's `buildSync` (ESM, `bundle: true`, unminified, so its diff stays reviewable), and it runs as part of `task sync:remoteweb`, which every backend and dev build already depends on. A vitest test rebuilds it in memory and fails when the committed file differs. esbuild is a transitive dependency (through vite) and is not added to `package.json`, so no task needs an install Setup.
12. **The permission card's tool and command come from the transcript.** The card shows the last projected `action` entry that has no `outcome`, which is the tool call waiting on the menu. Its verb maps to a title: "Ran" gives `Bash` / "Wants to run a command"; an edit verb gives `Edit` / "Wants to edit a file"; anything else gives the verb / "Wants to use a tool". The target is the command or path. Without such an entry, the card shows "Wants your approval" over the row's `line`. Why: the hook's `Detail` is truncated to 60 characters, and the owner must see the whole command they approve.
13. **A row's latest line** (`HandedAgent.Line`):
    - working: the status `Detail` with its first letter capitalized ("Running node …");
    - permission: `Wants to run: <cmd>` when `Detail` starts with `running `, else `Wants approval: <Detail>`;
    - idle and input: the first non-empty line of `agentsessions.LastAnswer(path, harness)`;
    - asking: `Asking you a question`.
14. **States the boards do not draw:**
    - **`input`:** "Needs input · answer it at the desk", with the box disabled and no Approve or Deny.
    - **`asking`:** "Asking you · answer it under Questions", with the box disabled and a link back to the list. Typing into Claude's question menu would answer it.
15. **Copy is the boards', verbatim**, including the off footer: "This page goes offline, every handed-over agent goes back to the desk, and the PC may sleep again." It is always shown, since it is true with or without hand-overs. The ChatEnded reasons are the board's two strings with the agent's name, and `off` has no page of its own: the page is unreachable then.
16. **The cockpit key is `p`** (`agent:hand-to-phone`, group Agent, `when: agentNav`). `p` is free in `buildAgentBindings`; the global `g p` is a leader chord, so it does not clash. Its `run` returns false (lets the key pass) when the focused agent is not eligible, as `agent:review` does. A failed hand or take-back shows a `pushToast` error with the RPC's message. The header has no error line of its own.
17. **`wsh remote hand [tab]` and `wsh remote take-back [tab]`** take a tab id or a unique prefix, resolved against the eligible roster. With no argument they act on the calling terminal's own tab (`FromORef`, the block `wsh` runs in), so an agent can hand itself over.

## Global Constraints

- Every string from the server or an agent goes into the page as text (`textContent`, the existing `h()` helper). Never `innerHTML`, never a markdown renderer. `icon()` markup stays constant-only.
- The first spec's locks stay: Cloudflare Access verified on every request, and Origin plus JSON content-type checks on every POST. The main wavesrv listener and its key are never exposed. The phone listener runs only while remote mode is on.
- A send reaches the session as the owner's own input via `blockcontroller.SendInput`, never `AgentsSendCommand`.
- The page follows `DESIGN.md`, `phone.css` and `tokens.css`: no text under 10.5 px, touch targets at least 44 px. Colors only from `tokens.css` custom properties on the page, and only from `@theme` tokens in the cockpit, with no new tokens. The boards' hexes map onto existing tokens (accent `#5e9cff`, warning `#e6b450`, success `#54c79a`, muted `#7f858b`).
- Board copy, verbatim:
  - Section and header: "Handed over", "N agents handed over" (singular "1 agent handed over"), "Take back".
  - Composer: "Message <agent>", "Send", "Add to this turn", "Stop this turn".
  - Permission card: "Approve", "Deny", "The agent is paused until you choose.", "Deny and say what to do instead", with the label "Deny and tell <agent> why".
  - Ended page: "Back at the desk", "Back to the list".
  - Cockpit button: "Hand to phone", "On phone · Take back", with the titles "Hand to phone: turns remote mode on (p)" and "Take back from the phone (p)".
- Never hand-edit generated files: `task generate` outputs, and `projectors.js`, `tokens.css`, fonts and icon from `sync:remoteweb`.
- No jsdom render tests. Pure logic lives in `model.js`/`chatmodel.js`/`handtophone.ts` with tests beside it, and rendering is proven by the `remote-phone` and `remote-hand` CDP scenarios.
- Windows-only, like the rest of the Tauri packaging. Lint and format only the files you touch, and never run prettier on `scripts/*.mjs`.

## Review Focus

1. **Agent text that looks like markup or a fence it never closes.** A reply holding `<img src=x onerror=…>`, or an unclosed fence, draws as literal text, and the rest of the reply stays readable. The test goes in Task 6 (`splitReply`).
2. **A stale button press.** Approve is pressed after the desk already answered the menu (state now `working`), or Send is pressed while a question just opened. Expected: 409, nothing typed, and the page redraws with the fresh state. The test goes in Task 4 (`TestActionRefusedOutsideState`).
3. **An agent that exits while its chat is open, including back to its still-running shell** (claude's mod stream closes, or pi reports `--ended`). The stream sends `ended` with reason `exited`, the page draws Back at the desk, and the EventSource does not reconnect forever. The tests go in Task 4 (`TestStreamEndsWhenAgentExits`) and Task 7 (preview exited fixture).
4. **Remote mode turned off from the desk while a stream is open.** The stream closes, `Off` returns within `remoteShutdownTimeout`, and no goroutine is left. A re-setup restart keeps the hand-overs, and the page reconnects. The test goes in Task 4 (`TestOffEndsStreams`).
5. **Handing over a run worker, a codex session or a closed tab.** It is refused with a message naming why, and remote mode is not turned on. The test goes in Task 1 (`TestHandRefusesIneligibleWithoutTurningOn`).

---

### Task 1: Hand-over core, its wire types and RPCs
**Depends on:** none
**Files:** `pkg/baseds/baseds.go`, `pkg/wshrpc/wshrpctypes_remote.go`, `pkg/wshrpc/wshserver/wshserver_remote.go`, `pkg/remotemode/handover.go`, `pkg/remotemode/handover_test.go`, `pkg/remotemode/remote.go`, `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, `pkg/wshrpc/wshclient/wshclient.go`

Decisions 2, 3, 4, 5, 6 (state and since), 7 (the field only). Add two fields to `baseds.AgentStatusData`:
- `NotificationType string json:"notificationtype,omitempty"`, with a comment that only Claude Code's Notification hook sets it.
- `Ended bool json:"ended,omitempty"`, with a comment that pi's shutdown report sets it. Add the remote types and the two commands, implement them in `wshserver_remote.go` by calling `remotemode.Hand`/`TakeBack`, and run `task generate`. In `remote.go`, `Status()` fills `Handed` from the pruned set, and `remoteTurnOff` clears hand-overs (each gets reason `off`) per decision 4. `remoteStopLocked` leaves them alone, so `remoteRestartIfOn` keeps them. An empty `Tab` resolves to the roster agent whose `BlockId` is `FromORef`'s block.

**Interfaces — Produces:**
```go
// pkg/wshrpc
type CommandRemoteHandData struct {
    Tab      string `json:"tab,omitempty"`      // tab id or unique prefix; "" = the tab FromORef's block is in
    FromORef string `json:"fromoref,omitempty"` // block:<id> wsh runs in
}
RemoteHandCommand(ctx, CommandRemoteHandData) (*RemoteStatusData, error)
RemoteTakeBackCommand(ctx, CommandRemoteHandData) (*RemoteStatusData, error)
// RemoteStatusData gains:
Handed []string `json:"handed,omitempty"`

// pkg/remotemode
type Agent struct {
    TabId, BlockId, Name, Project, Harness, TranscriptPath string
    Status    baseds.AgentStatusData
    OpenAsk   bool
    HasStream bool // the arc mod's control stream is open (claude's liveness)
    RunWorker bool
}
var AgentsHook func(ctx context.Context) ([]Agent, error)   // nil: no agents, Hand refuses
var TranscriptHook func(ctx context.Context, path string, tailLines int, send func(lines []string) error) error
const (EndTaken = "taken"; EndExited = "exited"; EndOff = "off")
type GoneError struct{ Reason string }                        // Error(): "agent is not handed over (<reason>)"
const (PhoneWorking = "working"; PhoneIdle = "idle"; PhonePermission = "permission"; PhoneInput = "input"; PhoneAsking = "asking")
func Eligible(a Agent) error
func PhoneState(a Agent) string
func Hand(ctx context.Context, data wshrpc.CommandRemoteHandData) (*wshrpc.RemoteStatusData, error)
func TakeBack(ctx context.Context, data wshrpc.CommandRemoteHandData) (*wshrpc.RemoteStatusData, error)
// a handed-over, still-eligible agent and the phone state's since (decision 6), or a *GoneError; prunes and
// publishes when it drops something
func LookupHanded(ctx context.Context, tab string) (Agent, int64, error)
// every handed-over, still-eligible agent with its since, sorted by tab id; prunes like LookupHanded
func ListHanded(ctx context.Context) ([]Agent, []int64, error)
```

- [ ] In `handover_test.go`, set `AgentsHook` to a scripted roster and fake the start path the way `remote_test.go` fakes cloudflared, keep-awake and the tunnel. Write these tests:
  - `TestEligible`: a claude agent with a block and `HasStream` passes, and so does a pi agent that is not `Ended`. Each of these fails with a message naming the reason: a `RunWorker`, an empty `BlockId`, harness `codex`, claude without `HasStream` (exited to its shell), and pi with `Status.Ended`.
  - `TestExitedToShellIsPruned`: a handed claude agent loses `HasStream` while still in the roster, and `LookupHanded` says `exited`.
  - `TestPhoneState`: asking (an open ask wins over working); permission only for waiting + Notification + `permission_prompt`; input for waiting with `elicitation_dialog` and with an empty type; working; idle.
  - `TestHandTurnsOnAndPublishes`: remote off, then `Hand` leaves it on, with `Status().Handed == [tab]`.
  - `TestHandRefusesIneligibleWithoutTurningOn`: a run worker is refused, and the start path was never called.
  - `TestHandResolvesPrefixAndOwnTab`: a unique prefix resolves, an ambiguous one errors naming both, and an empty `Tab` with a `FromORef` block resolves to that block's tab.
  - `TestTakeBackRecordsTaken`: `LookupHanded` then returns `*GoneError{Reason: "taken"}`, and handing over again clears it.
  - `TestExitedIsPruned`: the agent leaves the roster, `ListHanded` drops it, and `LookupHanded` says `exited`.
  - `TestOffClearsHandovers`: after `Off`, `Status().Handed` is empty, and `LookupHanded` says `off`.
  - `TestRestartKeepsHandovers`: a `Setup` while on (restart) leaves `Status().Handed` unchanged.
  - `TestSinceTracksStateChanges`: the first look gives `Status.Ts`, the same state keeps it, and a changed state gives the injected now.
- [ ] Run `go test ./pkg/remotemode -run 'TestEligible|TestPhoneState|TestHand|TestTakeBack|TestExited|TestOffClearsHandovers|TestRestartKeepsHandovers|TestSinceTracksStateChanges'`. It fails. Implement, run `task generate`, and rerun. All pass. `git diff frontend/types/gotypes.d.ts` shows only `notificationtype`, `ended`, `handed` and `CommandRemoteHandData`.

### Task 2: The hook carries the notification type, pi reports its end, and `wsh remote hand` / `take-back`
**Depends on:** Task 1 (uses `AgentStatusData.NotificationType`/`Ended` and the generated `wshclient.RemoteHandCommand`/`RemoteTakeBackCommand`)
**Files:** `cmd/wsh/cmd/wshcmd-agenthook.go`, `cmd/wsh/cmd/wshcmd-agenthook_test.go`, `cmd/wsh/cmd/wshcmd-agentstatus.go`, `cmd/wsh/cmd/wshcmd-agentstatus_test.go`, `pi/extensions/waveterm-status.ts`, `pi/extensions/waveterm-status.test.ts`, `cmd/wsh/cmd/pi-status-extension.ts`, `cmd/wsh/cmd/pi-status-extension.test.ts`, `cmd/wsh/cmd/wshcmd-remote.go`, `cmd/wsh/cmd/wshcmd-remote_test.go`, `docs/remote-phone.md`

Decisions 2 (pi's live session), 7 and 17.

**pi's end.**
- `wsh agentstatus` gains `--ended` (bool), which sets `AgentStatusData.Ended`. `buildAgentStatusData` takes it, and its callers and test are updated.
- In `pi/extensions/waveterm-status.ts`, the `session_shutdown` handler's report passes `--ended`. No other report does.
- Run `task sync:piartifacts` so the embedded copy `cmd/wsh/cmd/pi-status-extension.ts` matches; never edit the copy by hand. Update `cmd/wsh/cmd/pi-status-extension.test.ts` only if it breaks.

**The notification type.** `agentEmission` gains `NotificationType`. `planEmission` sets it for the `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input` and `""` cases, and the run copies it onto `AgentStatusData`. Add the `hand [tab]` and `take-back [tab]` subcommands, which send `FromORef` from the calling block (`resolveBlockArg`, as other commands do) and print the agent and remote status the way `remote on` prints its status. Add a "Hand an agent to the phone" section to `docs/remote-phone.md`: the button, `p`, both commands, what ends a hand-over, and that a restart ends them.

- [ ] Add tests:
  - `TestPlanEmissionNotificationType` (table): `permission_prompt` gives waiting with type `permission_prompt`, `elicitation_dialog` gives waiting with its type, `idle_prompt` gives idle with no type, and `PreToolUse` Bash has no type.
  - A `wshcmd-remote_test.go` case for each new subcommand's argument handling, following that file's existing style.
  - In `wshcmd-agentstatus_test.go`, `buildAgentStatusData` with ended true sets `Ended`, and without it leaves it false.
  - In `waveterm-status.test.ts`, the `session_shutdown` report's args include `--ended`, and the `session_start` and `agent_settled` reports' args do not.
- [ ] Run `go test ./cmd/wsh/cmd -run 'TestPlanEmission|TestRemote|TestBuildAgentStatus'` and `npx vitest run pi/extensions/waveterm-status.test.ts`. Both fail. Implement, run `task sync:piartifacts`, and both pass. Match the Go test name to the existing agentstatus test's prefix if it differs.

### Task 3: wshserver implements the agent hooks
**Depends on:** Task 1 (uses `remotemode.Agent` and the `AgentsHook`/`TranscriptHook` types it adds)
**Files:** `pkg/wshrpc/wshserver/wshserver_remoteagents.go`, `pkg/wshrpc/wshserver/wshserver_remoteagents_test.go`, `pkg/wshrpc/wshserver/wshserver_agentmsg.go`, `cmd/server/main-server.go`

Decisions 1 and 2. `RemoteAgents(ctx) ([]remotemode.Agent, error)` builds one `Agent` per `buildAgentRoster` row:
- `Status` is the row's raw `status`, and `OpenAsk` is carried from `agentTabFacts` (add an `openAsk` field to `agentRow`). `HasStream` is the row's `hasStream`.
- `TranscriptPath` comes from `agentTranscriptPath`. An error there is logged, and the row is kept with an empty path.
- `RunWorker` is computed from `ownerRun(facts.Runs, tab)` per decision 2.

`RemoteTranscript(ctx, path, tail, send)` drains `streamTranscript`'s channel into `send`, returns the first error from `send` or from the stream, and returns nil on ctx done. In `main-server.go`, assign both hooks next to the other hook assignments, before `remotemode.Restore()`.

- [ ] Write `TestRemoteAgentsMarksRunWorkers` with scripted `loadAgentRosterFacts`, following `wshserver_agentmsg_test.go`. It covers:
  - a plain agent and an orchestrator lead give `RunWorker` false;
  - a dag task child (`TaskId`), a reviewer (`Review`), a stage (`StageRole`) and a `ParentLeadORef` child give true;
  - an agent with an open ask has `OpenAsk`;
  - `HasStream` follows the facts' `HasStream`, so a claude tab whose shell outlived claude reads false;
  - a waiting status survives raw, not folded to idle.
- [ ] Write `TestRemoteTranscriptSendsBacklogAndAppends` with a temp JSONL: the backlog arrives, then an appended line, and a `send` error ends it with that error.
- [ ] Run `go test ./pkg/wshrpc/wshserver -run 'TestRemoteAgents|TestRemoteTranscript'`. It fails. Implement, and it passes.

### Task 4: Phone listener routes for hand-overs
**Depends on:** Task 1 (uses `LookupHanded`, `ListHanded`, `PhoneState`, `GoneError`, `TranscriptHook`; shares `remote.go`)
**Files:** `pkg/remotemode/handler.go`, `pkg/remotemode/handler_test.go`, `pkg/remotemode/agents.go`, `pkg/remotemode/agents_test.go`, `pkg/remotemode/waiting.go`, `pkg/remotemode/remote.go`

Decisions 4 (stream polling, `off`), 8, 9, 13. The handler's half is route shapes, SSE framing, the heartbeat and status codes, and it works against `Deps` only. The real half is in `agents.go`:
- building `HandedAgent`s;
- the stream, which runs `TranscriptHook` beside a 2 s state poll that sends `Agent` on change;
- the keystrokes through `var remoteSendInput = blockcontroller.SendInput`;
- turning `TranscriptPath == ""` into a stream that sends `agent` and waits, rather than an error.

`remoteRun` gains a context that `remoteStopRun` cancels first. An open stream then returns nil, and the handler closes it without an `ended` event (decision 4) before `Shutdown` waits on it. `remoteDeps` wires the new fields.

**Interfaces — Produces** (`cmd/remotepreview` and the page rely on these):
```go
type HandedAgent struct {
    Tab     string `json:"tab"`
    Name    string `json:"name"`
    Project string `json:"project"`
    Runtime string `json:"runtime"` // claude | pi
    State   string `json:"state"`   // Phone* constants
    Since   int64  `json:"since"`   // unix ms
    Line    string `json:"line"`
}
// WaitingList gains: Handed []HandedAgent `json:"handed"` (never null)
type AgentAction struct {
    Kind string // ActionSend | ActionStop | ActionApprove | ActionDeny
    Text string
}
const (ActionSend = "send"; ActionStop = "stop"; ActionApprove = "approve"; ActionDeny = "deny")
var ErrWrongState = errors.New("the agent is not in a state that takes this") // wrapped with the state; 409
type StreamSink interface { Agent(HandedAgent) error; Lines([]string) error }
// Deps gains:
Handed   func(ctx context.Context) ([]HandedAgent, error)
Stream   func(ctx context.Context, tab string, sink StreamSink) error // returns *GoneError when it ends for a reason
Act      func(ctx context.Context, tab string, act AgentAction) error // *GoneError -> 410, ErrWrongState -> 409
TakeBack func(ctx context.Context, tab string) error
var remoteStreamHeartbeat = 25 * time.Second
```

- [ ] Write `handler_test.go` cases with fake `Deps`, using an `httptest` server for SSE:
  - `TestWaitingIncludesHanded`: `handed` is `[]` when there are none.
  - `TestStreamFramesAgentLinesAndEnded`: the events `agent`, `lines`, `ended` arrive in order with JSON data, and the headers match decision 9.
  - `TestStreamHeartbeat`: with `remoteStreamHeartbeat` at 50 ms and a quiet `Stream`, a `: ping` arrives.
  - `TestStreamGoneIsOneEndedEvent`.
  - `TestAgentPostsNeedOriginAndJSON`: each of the five POSTs is refused without Origin (403) and with a form content type (415).
  - `TestActStatusCodes`: gone gives 410 with its reason, wrong state gives 409, an empty send text gives 400, and ok gives 200.
- [ ] Write `agents_test.go` cases with a recording `remoteSendInput`, a scripted `AgentsHook` and `TranscriptHook`, and a fake clock:
  - `TestActionKeystrokes`: the exact byte sequences of decision 8 (send multi-line text, stop, approve, deny, deny with text).
  - `TestActionRefusedOutsideState`: approve while working, send while permission, input or asking, and stop while idle each give `ErrWrongState`, and nothing is typed.
  - `TestHandedLine`: each case of decision 13.
  - `TestStreamEndsWhenAgentExits`: the roster drops the agent mid-stream, and the stream returns `exited` within one poll.
  - `TestOffEndsStreams`: turning off ends the open stream, the handler writes no `ended` event, `Off` returns within `remoteShutdownTimeout`, and the stream's goroutines have exited.
- [ ] Run `go test ./pkg/remotemode -run 'TestWaitingIncludesHanded|TestStream|TestAgentPosts|TestAct|TestAction|TestHandedLine|TestOffEndsStreams'`. It fails. Implement, and it passes.

### Task 5: Bundle the cockpit projectors for the phone page
**Depends on:** none
**Files:** `frontend/app/view/agents/remoteprojectors.ts`, `scripts/sync-remote-web.mjs`, `Taskfile.yml`, `pkg/remotemode/web/static/projectors.js`, `pkg/remotemode/web/projectors.test.js`

Decision 11. `remoteprojectors.ts` imports only `projectTranscript` and `projectPiTranscript`, so the bundle carries neither codex nor opencode, nor anything from `@/`. `sync-remote-web.mjs` gains `writeProjectors()`, with the bundle's first line `/* generated by scripts/sync-remote-web.mjs from frontend/app/view/agents/remoteprojectors.ts; never hand-edit */` as a banner, and reports it in its `ok:` line. Export the build options from a small function so the test reuses them, and keep the script's top-level run guarded so importing it does not write files. `Taskfile.yml`'s `sync:remoteweb` adds the entry, `transcriptprojection.ts`, `pitranscriptprojection.ts`, `tooldetail.ts` and `agentsviewmodel.ts` to `sources`, and the bundle to `generates`.

**Interfaces — Produces:** `projectors.js` exports `projectFor(runtime: string, lines: string[]): AgentEntry[]`, giving `[]` for an unknown runtime.

- [ ] Write `projectors.test.js`:
  - "the committed bundle is current": rebuild in memory with `write: false`, and the text equals the committed file.
  - "projects claude and pi lines": import the committed module, and a two-line claude transcript (a user prompt and an assistant text) gives a `user` and a `message` entry; the pi equivalent gives the same.
  - "an unknown runtime gives no entries".
- [ ] Run `npx vitest run pkg/remotemode/web/projectors.test.js`. It fails. Implement, run `task sync:remoteweb`, and it passes.

### Task 6: The phone page: Handed over list and the chat
**Depends on:** none
**Files:** `pkg/remotemode/web/static/phone.js`, `pkg/remotemode/web/static/model.js`, `pkg/remotemode/web/static/chat.js`, `pkg/remotemode/web/static/chatmodel.js`, `pkg/remotemode/web/static/phone.css`, `pkg/remotemode/web/static/sw.js`, `pkg/remotemode/web/model.test.js`, `pkg/remotemode/web/chatmodel.test.js`

Boards `Main`, `Chat`, `ChatWorking`, `ChatPermission` and `ChatEnded`. Decisions 9, 10, 12, 14 and 15, against the wire contract in Task 4's Interfaces. The page imports `projectFor` from `./projectors.js` (Task 5).

- **List.**
  - A "Handed over" section between Questions and the held/shown section: one row per agent with the runtime dot, agent, project, a state chip (working green, idle grey, needs approval amber, needs input amber, asking amber), the latest line, and a chevron. The row is a 44 px+ button that opens `#agent/<tab>`.
  - `viewState` counts handed agents, so a list with only hand-overs is `main`.
  - `countsLine` orders questions · handed · held · other.
  - The header keeps its "Remote on" chip. The off footer's line becomes the Main board's "This page goes offline, every handed-over agent goes back to the desk, and the PC may sleep again." (decision 15).
- **Chat.** In `chat.js`, opened from the hash router in `phone.js`:
  - A back header with the agent, project, state line and Take back.
  - An `EventSource` on `/api/agents/<tab>/stream`, closed on `ended` and on leaving the chat. Entries are drawn per `chatItems`: a user bubble, a compact mono action line, or reply text through `splitReply`.
  - The composer per `composerFor`. Stop shows while working; the permission card shows while `permission`.
  - Send, Stop, Approve, Deny and Take back POST and show an inline error line on failure. On 410 the page draws ChatEnded with the reason; on 409 it shows "The agent moved on; showing it as it is now." and redraws from the next `agent` event.
  - The message box clears only on 200.
- **Ended.** "Back at the desk", the reason line, and "Back to the list".
- `sw.js` adds `/chat.js`, `/chatmodel.js` and `/projectors.js` to `SHELL`. `phone.js` imports `chat.js` statically, so the offline page needs all three cached.

**Interfaces — Produces** (`chatmodel.js`, pure):
```js
export function splitReply(text) // -> [{kind:"text", text} | {kind:"code", lang, text}]; an unclosed fence runs to the end as code
export function chatItems(entries) // AgentEntry[] -> [{kind:"user", text} | {kind:"action", mark:"ok"|"fail"|"pending", verb, target, summary, adds?, dels?} | {kind:"reply", parts}]
export function permissionCard(entries, agent) // -> {tool, ask, target} per decision 12
export function composerFor(agent) // -> {label, placeholder, disabled, note?, stop:boolean, permission:boolean}
export function rowStateLabel(agent, now) // "working 1m" | "idle 6m" | "needs approval" | "needs input" | "asking you"
export function headerStateLabel(agent, now) // "working 1m" | "idle · replied 2m ago" | "needs approval · 4m" | "needs input · 4m" | "asking you · 3m"
export function endedText(name, reason) // the ChatEnded board's two strings; unknown reasons read as taken
export function chatTab(hash) // "#agent/<tab>" -> tab, else null
```

- [ ] Write `chatmodel.test.js`:
  - `splitReply`: plain text keeps its line breaks; a fenced block with a language; two fences; an unclosed fence; a reply that is `<img src=x onerror=alert(1)>` comes back as one text part with the exact string.
  - `chatItems`: an edit action carries adds/dels from its `detail`; an action with no outcome is `pending`.
  - `permissionCard`: the Bash pending action, an edit, and the fallback with no pending action.
  - `composerFor`: each of the five states, with labels from Global Constraints and decision 14.
  - `rowStateLabel` and `headerStateLabel`: each state at a fixed now.
  - `endedText`: taken and exited.
  - `chatTab`.
- [ ] Extend `model.test.js`:
  - `countsLine({questions:[{}], handed:[{},{},{}], shown:[held]})` is `"1 question to answer · 3 agents handed over · 1 run held"`;
  - the singular "1 agent handed over";
  - `viewState` is `main` with only hand-overs.
- [ ] Run `npx vitest run pkg/remotemode/web/chatmodel.test.js pkg/remotemode/web/model.test.js`. The new cases fail. Implement, and all pass.

### Task 7: The preview and the remote-phone scenario cover hand-overs
**Depends on:** Task 4 (uses the new `Deps` fields and `HandedAgent`), Task 5 (uses the committed `projectors.js` the page imports), Task 6 (drives and reads the page's chat DOM)
**Files:** `cmd/remotepreview/main.go`, `cmd/remotepreview/main_test.go`, `cmd/remotepreview/testdata/siem-deploy.jsonl`, `cmd/remotepreview/testdata/phone-chat.jsonl`, `cmd/remotepreview/testdata/vault-sync.jsonl`, `cmd/remotepreview/testdata/docs-worker.jsonl`, `scripts/cdp/scenarios-settings.mjs`

Boards `Main`, `Chat`, `ChatWorking`, `ChatPermission`, `ChatEnded`.

**The preview:**
- The `main` fixture gains the boards' three hand-overs: `siem-deploy` (claude, permission, `siem`), `phone-chat` (claude, working, `waveterm`) and `vault-sync` (pi, idle, `arc_vault`). Their lines are the Main board's.
- Each has a recorded transcript under `testdata/` that projects to its board's content: the user message, the actions, and the reply, the reply including a fenced code block. `siem-deploy`'s ends in an unanswered Bash `tool_use`.
- The testdata files are embedded with `go:embed`.
- A new fixture `input` has one hand-over, `docs-worker` (claude, input).
- `Stream` sends the agent and the whole transcript, then waits. For the tab `fx-exited` it returns `*GoneError{EndExited}`.
- `Act` and `TakeBack` print `REMOTEPREVIEW input {"tab","action","text"}` and `REMOTEPREVIEW takeback {"tab"}`. A taken-back tab leaves `handed`, and its next stream or action is gone with `taken`.

**The scenario:** extend `remote-phone` with these steps, each with a shot:
- **1.** The Main step now also asserts:
  - the Handed over section's three rows and their state chips;
  - the counts line `3 questions to answer · 3 agents handed over · 2 runs held`;
  - the "Remote on" chip (already asserted);
  - the off footer's text, exactly the Main board's line.

  Shot `1-main` shows the section, and `1-main-held` the footer.
- **8. Chat** (vault-sync, idle): the user bubble, the action lines, the reply text and its mono code block, "Message vault-sync". Type and Send, and the preview recorded `send` with the text.
- **9. ChatWorking** (phone-chat): "working", "Add to this turn", "Stop this turn". Tap Stop, and `stop` is recorded.
- **10. ChatPermission** (siem-deploy): the amber card with `Bash`, the full `ssh deploy@siem-236 …` command and Approve/Deny, and the box reads "Deny and say what to do instead". Tap Approve, and `approve` is recorded. Then type a reason and Send, and `deny` with that text is recorded.
- **11. Needs input** (the `input` fixture): "Needs input · answer it at the desk", the box disabled, no Approve or Deny.
- **12. ChatEnded taken:** Take back on phone-chat is recorded, and the page reads "Back at the desk" with the taken string.
- **12b. ChatEnded exited:** load `#agent/fx-exited`, and the page shows the exited string.

Keep steps 2-7 passing. The restarts keep the port.

- [ ] Add `main_test.go` cases:
  - `TestFixtureHanded`: three hand-overs with the boards' states.
  - `TestPreviewStreamProjectsBoards`: each testdata file parses as JSONL.
  - `TestPreviewRecordsInputAndTakeBack`: the record lines, and gone after take-back.
- [ ] Run `go test ./cmd/remotepreview -run 'TestFixture|TestPreview'`. It fails. Implement, and it passes.
- [ ] **Acceptance, run by Final:** every `remote-phone` step (1-12b) passes, with shots matching the Main, Chat, ChatWorking, ChatPermission and ChatEnded boards. The worker runs `node --check scripts/cdp/scenarios-settings.mjs` and the Go tests above. It may also run `task verify:ui -- remote-phone` when a dev app is already up, but it does not start one.

### Task 8: Hand to phone on the Agent surface
**Depends on:** Task 1 (uses the generated `RemoteHandCommand`/`RemoteTakeBackCommand` and `RemoteStatusData.handed`)
**Files:** `frontend/app/view/agents/handtophone.ts`, `frontend/app/view/agents/handtophone.test.ts`, `frontend/app/view/agents/remotestore.ts`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-agent.mjs`, `scripts/cdp/scenarios.mjs`

Board `Cockpit`. Decisions 2 (the mirror), 5 and 16.

- **`handtophone.ts`**, pure:
  - `canHandToPhone(agent: Pick<AgentVM,"kind"|"blockId"|"agent">, role: RunRole | null | undefined): boolean` is true for kind `agent` or undefined with a `blockId`, agent `claude` or `pi`, and a role that is null or `lead`.
  - `isHandedOver(status: RemoteStatusData | null, tabId: string): boolean`.
- **`remotestore.ts`** gains `handToPhone(tabId)` and `takeBackFromPhone(tabId)`. Both use `REMOTE_SWITCH_TIMEOUT_MS`, set `remoteStatusAtom` from the reply, and throw the RPC error.
- **The header.**
  - Left of the fullscreen button, when `canHandToPhone` holds: "Hand to phone", in the `ICON_BTN` look with a lucide `Smartphone` icon at 13 px.
  - While handed over: "On phone · Take back" in the accent style the fullscreen-on state uses (`border-accent bg-accentbg text-accent`), with `aria-pressed`.
  - The titles are verbatim from Global Constraints. A failure shows `pushToast({level:"error"})` with the RPC's message.
  - The button carries `data-hand-to-phone`.
- **The key.** `agent:hand-to-phone` (`p`) toggles the same way. Add the row "`p` | Hand the agent to the phone, or take it back" to the Agent table in `docs/keyboard-shortcuts.md`.
- **The scenario** `remote-hand`, in `scenarios-agent.mjs`, listed in `SCENARIOS`:
  - Arrange a claude agent row with a terminal block on the Agent surface, reusing an existing Agent-surface arrange helper or fixture that already does so.
  - **Step 1:** the header shows "Hand to phone" left of the fullscreen button. Shot.
  - **Step 2:** set `remoteStatusAtom` to `{on:true, tunnel:"up", handed:[tabId]}` through the app's store module, as `remote-switch` does. The button reads "On phone · Take back" in the accent style, and the app bar shows `[data-remote-pill]`. Shot.
  - **Step 3:** reload the real status and click "Hand to phone". The dev store has no remote setup, so the real `RemoteHandCommand` refuses, whether for the setup or the agent's eligibility. An error toast appears, and the button still reads "Hand to phone". Shot.
  - Teardown reloads the real remote status.
- [ ] Write `handtophone.test.ts`:
  - `canHandToPhone`: plain claude, plain pi and a lead are eligible. A worker role, a stage role, a terminal, a background agent, no `blockId` and agent `codex` are not.
  - `isHandedOver`: a null status, a missing `handed`, and a match.
- [ ] Add a `bindings.test.ts` case: `buildAgentBindings` has `agent:hand-to-phone` on `p`, and no other Agent binding uses `p`.
- [ ] Run `npx vitest run frontend/app/view/agents/handtophone.test.ts frontend/app/store/keybindings/bindings.test.ts`. It fails. Implement, and it passes.
- [ ] **Acceptance, run by Final:** `remote-hand` steps 1-3 pass, showing the Cockpit board's two button states and the refusal toast. The worker runs `node --check scripts/cdp/scenarios-agent.mjs` and `node --check scripts/cdp/scenarios.mjs`, and does not start a dev app.
