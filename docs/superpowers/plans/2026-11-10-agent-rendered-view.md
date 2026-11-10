# Agent surface: Rendered mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-11-09-agent-rendered-view-design.md` (follow it where this plan is silent)
**Verify:** `node scripts/verify.mjs ./pkg/agentask/... ./pkg/wshrpc/... ./pkg/tsgen/... ./cmd/wsh/... ./pkg/agentsync/...`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\agent-rendered-view\project\Main.dc.html

**Goal:** A second view of a Claude Code agent in the Agent surface center, "Rendered", beside the live terminal: the
transcript as a readable timeline with renderers (chart blocks, `git diff`, test output, images), a composer, a docked
permission band, and native model / permission-mode controls in the header.

**Architecture:** One claude process in the pty, two views of it. The rendered view reads the focused agent's live
transcript entries (`useAtomValue(entriesAtomFor(agent.id))`, already streamed for the focused agent by
`AgentStreams`), renders them with `NarrationTimeline` plus one renderer registry, and drives the agent through the
paths that exist today (`sendAgentText`, `ControllerInputCommand`, the ask `AnswerBar`). Permission prompts are
projected by a new non-blocking `PermissionRequest` hook into a server registry in `pkg/agentask`, and answered by
typing keys into Claude's own prompt, as asks are. Two small interface tasks land first (the permission wire, the
renderer skeleton) so the long implementations run beside the UI tasks that consume them.

**Tech Stack:** Go (wsh, wavesrv, wshrpc), React 19 + jotai + Tailwind 4, visx (`@visx/scale`, `@visx/axis`), motion.

## Decisions this plan makes beyond the spec, and why

1. **Permission hook event and wire.** Claude Code's `PermissionRequest` hook carries `tool_name`, `tool_input` and
   `permission_suggestions` when the dialog shows. A new hidden `wsh permission` subcommand is the managed hook
   `{Event: "PermissionRequest", Args: "permission", Timeout: 10}` (sync, prints nothing, never exits 2, so Claude
   always shows its own dialog). It calls one new wshrpc command, `AgentPermissionCommand`, modelled on `wsh ask`.
   The band answers through `AnswerAgentPermissionCommand`. Both sit in the existing `AskCommands` interface
   (`pkg/wshrpc/wshrpctypes_ask.go`): the same "project a Claude picker, answer it by keys" family. Their handlers
   live in a new `pkg/wshrpc/wshserver/wshserver_permission.go`.
2. **Registry lives in `pkg/agentask`** (`permission.go`), not a new package: it reuses `sendInput` (and its test
   seam), `KeystrokeDelay` and `singleSelectKeys`, so one package owns typing into Claude's pickers.
3. **A FIFO queue per block, and the band answers only a queue of one.** The band shows the head when one request
   waits; with more than one it shows "N permission prompts waiting: answer them in the terminal" and an
   `Open terminal` button. Delivery refuses unless the queue holds exactly the named request. Why: parallel subagents
   can raise prompts at once, and keys typed for a request the TUI is not showing would approve the wrong tool.
4. **Retiring a request answered elsewhere.** `AgentStatusData` gains `ToolKey` (set by `agent-hook` on
   `PostToolUse`) and `PermissionMode` (every hook payload carries `permission_mode`). `toolKey` = first 16 hex chars
   of sha256(tool name + NUL + canonical JSON of tool_input, keys sorted), computed only in `wsh`. The server retires
   a pending request when a status for the same oref arrives with (a) `Hook == PostToolUse`, matching `ToolKey`, and
   status `Ts >=` request Ts, or (b) `Hook` in {`UserPromptSubmit`, `Stop`, `SessionStart`} and status `Ts >=` the
   request's Ts (all such requests). `retirePermissions` runs in `publishEvent` **before** the
   `staleAgentStatus`/`outOfTurnStatus` drop: a late async `PostToolUse` that the drop discards still proves its tool
   ran. Each retirement publishes a cleared `agent:permission` event. A denial typed in the terminal fires no
   `PostToolUse`, so its request stays until the next prompt or Stop; that window has no live dialog, and a second
   request then reads as "2 waiting", so the band never types into a different prompt.
5. **Choice labels are computed server-side** (`agentask.PermissionChoices`), so the labels the band shows and the
   index the server encodes come from one place. Exact lists:
   - Edit, Write, MultiEdit, NotebookEdit: `Yes` / `Yes, allow edits this session` / `No, tell Claude what to do`
   - Bash: `Yes` / `Yes, don't ask again for this command` / `No, tell Claude what to do`
   - ExitPlanMode (plan approval uses the dock, spec "left to the builder"): `Yes, auto-accept edits` /
     `Yes, manually approve edits` / `No, keep planning` (always three)
   - any other tool: `Yes` / `Yes, don't ask again this session` / `No, tell Claude what to do`
   - the middle option is present only when the request carried a non-empty `permission_suggestions` (ExitPlanMode
     excepted). Encoding: Down x index then Enter (`singleSelectKeys`), one key per write with `KeystrokeDelay`.
6. **Picker close signal.** Sending a picker command from the composer sets a per-agent flip timestamp; the view is
   Terminal while it is set. It returns to Rendered on the agent's next status whose `hook` is `UserPromptSubmit`,
   `Stop` or `SessionStart` with `ts` after the flip, or when the user flips back (`v` or the toggle). Other hooks
   (`Notification` idle_prompt, a background `PostToolUse`) do not unflip, since they fire while a picker is still
   open. Cost, accepted: a picker that closes with no prompt (`/config`) leaves the view on the terminal until the next
   prompt or a manual flip. Picker commands: `/config /settings /resume /rewind /permissions /agents /mcp /hooks
   /memory /login /logout /status /doctor /theme /plugin /plugins /ide /export /add-dir /output-style /statusline
   /terminal-setup /usage /cost /context`, and `/model` with no argument.
7. **`/model` natively:** the header's model menu sends `/model <alias>` through `sendAgentText`, which the arc mod's
   control channel already runs as a command (`control-core.ts` `deliver`), typed otherwise. Aliases: `default`,
   `opus`, `sonnet`, `haiku`. No arc mod change is needed.
8. **Permission mode natively:** Claude Code has no command that sets the mode, so the control types Shift+Tab
   (`"\x1b[Z"`), one per write 60ms apart, `(target - current + 3) % 3` times over the cycle
   `default -> acceptEdits -> plan`, each write an awaited `RpcApi.ControllerInputCommand` (not `driveAgent`, which
   swallows errors), so a failed write reverts the optimistic mode. The current mode is the last non-empty
   `permissionmode` the agent's statuses reported, overridden optimistically after a change until the next status.
   `bypassPermissions` or any unknown mode shows read-only (no menu). Labels: `default permissions`, `accept edits`,
   `plan mode`, otherwise the raw mode.
9. **Renderer registry** is one module, `frontend/app/view/agents/renderregistry.ts`: `BLOCK_RENDERERS` keyed by a
   fenced block's language (consulted by `MarkdownMessage`'s `pre` handler, so a `chart` block draws everywhere
   markdown renders) and `toolRendererKey(action)` keyed by tool (consulted by `NarrationTimeline` only when its new
   `renderers` prop is set, which only the rendered view sets: always-open cards would bloat the cockpit's narrow
   cards). Tool output cards sit always open under their tool row; the row's own expand still works.
10. **Images** ride on the action entry as `images?: ToolImage[]`, filled by the Claude projection from `tool_result`
    content items of `type: "image"` with a base64 source. Rendered as `data:` URLs.
11. **Charts need no new dependency.** Line and area paths are straight segments built by hand
    (`M x,y L ...`); `@visx/shape` is present only transitively, and declaring it would change `package.json` in a run
    whose worktrees junction the main checkout's `node_modules`. Bar charts are horizontal (category labels on the
    left, as the prototype draws them). The spec's "needs a shape helper" line is updated to say so.
12. **Chart spec schema** (taught by a new arc skill `skills/charts/SKILL.md`, listed as `arc:charts`), JSON in a
    `chart` fenced block:
    `{"type": "bar|line|area|scatter", "title": "...", "x": {"label": "..."}, "y": {"label": "...", "unit": "s"}, "series": [{"name": "...", "points": [{"x": "pkg/jarvis", "y": 41}]}]}`.
    `x`/`y` objects optional; at most 8 series and 500 points per series; `scatter` needs numeric x; `y` finite
    numbers. A spec that fails renders the raw block (`CodeBlock`) plus a one-line reason.
13. **Mockup captions are not built:** the prototype's "tool output renderer" and "[sample data]" texts are
    annotations, not UI. **`Inline.dc.html`** in the design folder is the rejected inline placement of the band
    (spec answer 9 chose docked; `canvas.json` lists only `Main.dc.html`): not built, no step.
14. **Mode state is per agent, not persisted** (spec: no Settings default; every agent opens in the terminal). The
    toggle shows only for `agent.agent === "claude"` with a live `blockId`, not a terminal, not an ended worker or a
    final-stage row. **Precedence in the center** (`agentsurface.tsx`): ended worker, final stage, brainstorm pane,
    canvas pane and the subagent interior keep winning as today; Rendered draws only when none of them shows
    (`!paneMode && !showSub`, not ended, not stage). In fullscreen (`terminalFullscreenAtom`) Rendered fills the
    fullscreen center the same way the terminal does.
15. **The "allowed" timeline row** (spec answer 9) is session-local: after the band delivers a choice, the rendered
    view records `{afterEntry: entries.length, text}` for the agent and `NarrationTimeline` draws it after that entry.
    It is not in the transcript, so a reload loses it.
16. **Not persisted across reload:** pending permissions live in the FE from events only; after a reload a request
    already open shows in the terminal only. Accepted: a reload is rare and the terminal stays the source of truth.
17. **Interface first.** Task 1 lands the permission wire with stub handlers (`errors.New("not implemented")`) and
    `task generate`; Task 4 lands the renderer registry's types, the `renderers` prop and the markdown hook with stub
    lookups. The implementations (Tasks 2, 5, 6) then run beside the UI tasks (7-9).

## Global Constraints

- Colors only from the `@theme` tokens in `frontend/tailwindsetup.css`; no raw hex, no new tokens (DESIGN.md).
- The rendered body is `NarrationTimeline` at max width 920px, centered; the composer row is centered at 920px too.
- Every renderer falls back to the raw text when its parse fails; the chart card shows its raw spec on a `spec` toggle,
  the tool cards on a `raw` toggle.
- No pi, Codex or opencode support; no Settings default; the terminal block stays mounted in both modes.
- `tsconfig.json` is `strict: false`: narrow an ok-union with `"reason" in result`, never `result.ok ? ... : ...reason`.
- Generated files change only through `task generate`.
- `wsh permission` must never print to stdout and never exit 2 (exit 2 from a `PermissionRequest` hook denies).
- The `data-*` attributes named in each task's Interfaces are the scenario's contract: keep them exactly.

## Review Focus

1. **Claude Code's real prompt has a different option list** (no middle option on a Bash prompt without
   suggestions, a version that adds one): the wrong index is typed. Pinned by `TestPermissionChoices` (Task 2) on
   the suggestions flag, and by the queue-of-one delivery rule.
2. **A request answered in the terminal leaves a stale band** whose keys land in the next prompt. Pinned by
   `TestRetirePermissionByToolKey`, `TestRetirePermissionIgnoresEarlierStatus` and
   `TestPublishEventRetiresBeforeStaleDrop` (Task 2) and `TestToolKeyStableAcrossKeyOrder` (Task 3).
3. **Huge tool output** (`git diff` p90 ~15k chars, `go test -v` with thousands of lines, ANSI color codes): parsers
   must not choke and cards must not render unbounded. Pinned by the ANSI and size tests in Task 5.
4. **A malformed `chart` block** (bad JSON, unknown type, NaN, 10k points) must render raw with a reason, never
   throw. Pinned by `chartspec.test.ts` (Task 6).
5. **Non-Claude agents, plain terminals and ended workers** must not get the toggle, and `v` must pass through for
   them. Pinned by `canRender` tests (Task 7).

## Scenario `agent-rendered` (built in Task 10; every UI task names its steps)

Fixtures, as `scenarios-agent-header.mjs` does (`setRoster`, `makeTab`, `focusAgent`, `closeTabs`, `restoreRoster`),
transcripts written by `writeTranscript` with `userText`, `assistantText`, `toolUse`, `toolResult`:
- **A**: a claude agent whose block is a tab with no controller (keys sent to it fail), with the main transcript:
  a prompt, prose, a `go test -json` Bash run with 1 fail and skips, a `git diff` Bash run, a `Read` whose result is
  an image item (a 1x1 PNG), and assistant text with four `chart` blocks (bar with 5 bars, line, area, scatter) plus
  one malformed `chart` block.
- **P**: a claude agent whose block runs a key probe, `scripts/cdp/fixtures/keyprobe.mjs <outfile>` (a node script
  in raw stdin mode appending the hex of every chunk it receives, one chunk per line, to `<outfile>`), started by the
  block's `cmd` controller; its transcript is a short prompt + reply. Keys typed into P are asserted by reading
  `<outfile>` from the scenario.
- **E**: a claude agent with an existing empty transcript file (skeleton state) and **N**: one with no
  `transcriptPath` (no-transcript state).
- Statuses are published with `h.rpc` `eventpublish` (`agent:status`, scoped to the block oref); permission requests
  with `h.rpc` `agentpermission`; an ask with `h.rpc` `ask`. Teardown publishes a `Stop` status for every fixture oref
  (retires requests), clears the ask, closes the tabs and restores the roster.

Steps (each shots the Agent surface center):
- `rendered: toggle` — on A, clicking Rendered in `[data-view-toggle]` shows `[data-rendered-view]`; the A terminal
  div is hidden but still in the DOM.
- `rendered: timeline` — the You bubble and markdown prose inside a column no wider than 920px.
- `rendered: empty states` — E shows `[data-rendered-empty="skeleton"]`, N shows
  `[data-rendered-empty="no-transcript"]` with "No transcript for this session yet.".
- `rendered: test card` — `[data-tool-card="test"]` shows `[data-test-counts]` reading pass / fail / skip and one
  `[data-test-failure]` with package, test, message, file:line; its `[data-raw-toggle]` shows the raw output.
- `rendered: diff card` — `[data-tool-card="git-diff"]` shows file headers with +/- counts and diff lines.
- `rendered: image` — `[data-tool-card="image"] img` has `naturalWidth > 0`.
- `rendered: chart` — the bar `[data-chart-card][data-chart-type="bar"]` has 5 `[data-chart-mark]` and its title;
  `[data-chart-spec-toggle]` shows the raw block.
- `rendered: chart types` — the line, area and scatter cards each draw `[data-chart-mark]` elements and their axes;
  the malformed block shows `[data-chart-fallback]` with its reason.
- `rendered: ask dock` — an ask raised on A docks the `AnswerBar` above the composer in `[data-rendered-view]`.
- `rendered: permission band` — an Edit request on A docks `[data-permission-band]` above `[data-rendered-composer]`
  with the title, the diff preview and three `[data-permission-choice]` buttons numbered 1-3.
- `rendered: permission error` — pressing `1` (focus outside the composer) on A's band shows
  `[data-permission-error]` and keeps the band (A's block has no controller).
- `rendered: permission queue` — a second request on A turns the band into `[data-permission-queue]` reading
  "2 permission prompts waiting"; its `Open terminal` button flips A to Terminal.
- `rendered: plan approval` — an ExitPlanMode request on P shows the plan markdown preview and the three plan choices.
- `rendered: permission answer` — on P, clicking choice 3 of an Edit request: the buttons lock while in flight, the
  band leaves, the probe file gains `1b5b42`, `1b5b42`, `0d`, a `[data-permission-mark]` row reads the choice label,
  and the composer has focus.
- `rendered: header controls` — `[data-header-model]` reads `opus 5.5` and its menu lists default, opus, sonnet,
  haiku; after a status with `permissionmode: "default"`, `[data-header-permission-mode]` reads
  `default permissions`.
- `rendered: permission mode change` — on P, choosing `plan mode` sets the label to `plan mode` at once and the probe
  file gains `1b5b5a` twice.
- `rendered: esc interrupt` — on P, Esc in the composer adds `1b` to the probe file.
- `rendered: picker flip` — on A, sending `/config` from the composer flips to Terminal; a published `Notification`
  status keeps it on Terminal; a published `UserPromptSubmit` status flips it back to Rendered.
- `rendered: v key` — on A, `v` with focus outside the terminal flips Rendered <-> Terminal.

---

### Task 1: Permission wire (types, event, stub handlers, generate)
**Depends on:** none
**Files:** `pkg/baseds/baseds.go`, `pkg/wshrpc/wshrpctypes_ask.go`, `pkg/wps/wpstypes.go`, `pkg/tsgen/tsgenevent.go`, `pkg/wshrpc/wshserver/wshserver_permission.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `frontend/types/waveevent.d.ts`

Decision 1, 17.

**Interfaces (produced):**
- `baseds.AgentPermissionData{ ORef "oref"; PermId "permid"; ToolName "toolname"; ToolInput string "toolinput"
  (raw JSON text); Choices []string "choices"; Ts int64 "ts"; Cleared bool "cleared,omitempty" }`.
- `baseds.AgentStatusData` gains `PermissionMode string "permissionmode,omitempty"` and
  `ToolKey string "toolkey,omitempty"`.
- `wps.Event_AgentPermission = "agent:permission"`, in `wps.AllEvents`; `tsgenevent.go` maps it to
  `baseds.AgentPermissionData`.
- `AskCommands` gains `AgentPermissionCommand(ctx, CommandAgentPermissionData) (string, error)` (returns the permid)
  and `AnswerAgentPermissionCommand(ctx, CommandAnswerAgentPermissionData) error`;
  `CommandAgentPermissionData{ ORef "oref"; ToolName "toolname"; ToolInput string "toolinput"; ToolKey "toolkey";
  HasSuggestions bool "hassuggestions,omitempty" }`, `CommandAnswerAgentPermissionData{ ORef "oref"; PermId "permid";
  Choice int "choice" }`. Wire names `agentpermission`, `answeragentpermission`. FE:
  `RpcApi.AnswerAgentPermissionCommand(TabRpcClient, { oref, permid, choice })`.
- `wshserver_permission.go`: both handlers as stubs returning `errors.New("not implemented")` (Task 2 fills them).

- [ ] Add the types, event and mapping and the stubs; run `task generate`.
- [ ] Run `go test ./pkg/tsgen` and `go build ./pkg/... ./cmd/...`: PASS.

### Task 2: Permission registry, delivery and retirement
**Depends on:** Task 1
**Files:** `pkg/agentask/permission.go`, `pkg/agentask/permission_test.go`, `pkg/wshrpc/wshserver/wshserver_permission.go`, `pkg/wshrpc/wshserver/wshserver.go`, `pkg/wshrpc/wshserver/wshserver_permission_test.go`

Decisions 2-5.

**Interfaces (produced):** `pkg/agentask`: `PermissionChoices(toolName string, hasSuggestions bool) []string`;
`type PendingPermission struct{ PermId, BlockId, ToolName, ToolInput, ToolKey string; Choices []string; Ts int64 }`;
`GlobalPermissions` with `Raise(oref string, p PendingPermission)`, `List(oref string) []PendingPermission`,
`RetireKey(oref, toolKey string, ts int64) []PendingPermission`, `RetireUpTo(oref string, ts int64) []PendingPermission`;
`DeliverPermission(oref, permid string, choice int) error` with `ErrNoPendingPermission` and `ErrPermissionQueued`.
`wshserver.go`: `retirePermissions(ev *wps.WaveEvent)` called in `publishEvent` before the stale/out-of-turn drop.

- [ ] Write `pkg/agentask/permission_test.go`: `TestPermissionChoices` (each list in decision 5, with and without
  suggestions; ExitPlanMode always three); `TestDeliverPermissionKeys` (choice 2 of 3 sends `ESC[B`, `ESC[B`, `\r` as
  three writes to the request's block via `SetSendInputForTest`, and the queue is then empty);
  `TestDeliverPermissionRefusesQueued` (two raised -> `ErrPermissionQueued`, nothing sent);
  `TestDeliverPermissionNoPending` (unknown or stale permid -> `ErrNoPendingPermission`); a choice out of range errors
  with nothing sent; `TestRetirePermissionByToolKey` (matching key with status ts >= request ts retires only that
  entry); `TestRetirePermissionIgnoresEarlierStatus` (status ts < request ts retires nothing).
- [ ] Run `go test ./pkg/agentask -run 'Permission'`: FAIL (undefined).
- [ ] Implement `pkg/agentask/permission.go`. A mid-inject `sendInput` failure drops the request (a partial prefix
  was typed; mirror `injectAnswer`'s rule).
- [ ] Replace the stubs: `AgentPermissionCommand` validates oref and tool name, raises with a uuid permid and
  `time.Now().UnixMilli()` and choices from `PermissionChoices`, publishes the raise; `AnswerAgentPermissionCommand`
  delivers and publishes the cleared event. Add `retirePermissions` per decision 4, publishing a cleared event per
  retired request.
- [ ] Write `wshserver_permission_test.go`: `TestAgentPermissionCommandPublishes` (raise event carries the choices),
  `TestPublishEventRetiresPermission` (a `Stop` status retires; a `PostToolUse` with a different ToolKey does not),
  `TestPublishEventRetiresBeforeStaleDrop` (a `PostToolUse` with the matching key that `outOfTurnStatus` drops still
  retires the request).
- [ ] Run `go test ./pkg/agentask -run 'Permission'` and `go test ./pkg/wshrpc/wshserver -run 'Permission'`: PASS.

### Task 3: `wsh permission` hook, managed hook entry, status fields
**Depends on:** Task 1 (uses `wshclient.AgentPermissionCommand` and the new `AgentStatusData` fields)
**Files:** `cmd/wsh/cmd/wshcmd-permission.go`, `cmd/wsh/cmd/wshcmd-permission_test.go`, `cmd/wsh/cmd/wshcmd-installhooks.go`, `cmd/wsh/cmd/wshcmd-installhooks_test.go`, `cmd/wsh/cmd/wshcmd-agenthook.go`, `cmd/wsh/cmd/wshcmd-agenthook_test.go`

- `toolKey(name string, input json.RawMessage) string` (package `cmd`, decision 4) and
  `parsePermissionRequest(raw []byte) (wshrpc.CommandAgentPermissionData, error)` (fills tool name, tool input text,
  tool key, `HasSuggestions` = non-empty `permission_suggestions`; ORef filled by the command from `resolveBlockArg`).
- The command runs hidden like `askCmd`, RPC timeout 5000ms, returns errors (exit 1, never 2, nothing on stdout).
- `managedHooks` gains `{Event: "PermissionRequest", Args: "permission", Timeout: 10}`; `isManagedCommand` accepts
  `"permission"`.
- `ccHookEvent` gains `PermissionMode string "permission_mode"`; the status carries it on every report; on
  `PostToolUse` it also carries `ToolKey`.

- [ ] Tests: `TestToolKeyStableAcrossKeyOrder` (`{"a":1,"b":2}` and `{"b":2,"a":1}` give one key; another tool name
  or input gives another; 16 hex chars), `TestParsePermissionRequest` (envelope with and without
  `permission_suggestions`; missing `tool_name` errors), the installhooks tests pass with the new entry and
  `isManagedCommand("wsh permission")` is true, an agent-hook test that a `PostToolUse` payload yields a status with
  `ToolKey == toolKey(...)` and `PermissionMode` copied.
- [ ] Run `go test ./cmd/wsh/cmd -run 'ToolKey|PermissionRequest|InstallHooks|ManagedCommand|AgentHook'`: FAIL, then
  implement, then PASS.

### Task 4: Renderer registry skeleton and timeline hooks
**Depends on:** none
**Files:** `frontend/app/view/agents/renderregistry.ts`, `frontend/app/view/agents/toolrenderers.tsx`, `frontend/app/view/agents/chartcard.tsx`, `frontend/app/view/agents/markdownmessage.tsx`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/renderregistry.test.ts`

Decisions 9, 17. Stubs here are replaced by Tasks 5 and 6.

**Interfaces (produced):**
- `renderregistry.ts`: `export type BlockRenderer = ComponentType<{ raw: string }>`;
  `export const BLOCK_RENDERERS: Record<string, BlockRenderer> = { chart: ChartCard }`;
  `blockRendererFor(lang?: string): BlockRenderer | undefined`; `export type ToolRendererKey = "image" | "git-diff" |
  "test"`; `toolRendererKey(action: AgentActionEntry): ToolRendererKey | null` (stub: always null).
- `toolrenderers.tsx`: `ToolOutputRenderer({ action }: { action: AgentActionEntry })` (stub: renders nothing).
- `chartcard.tsx`: `ChartCard({ raw }: { raw: string })` (stub: the raw block in `CodeBlock` with lang `json`).
- `markdownmessage.tsx`: the `pre` handler draws `blockRendererFor(lang)` when one exists, else `CodeBlock`.
- `narrationtimeline.tsx`: `NarrationTimeline` gains `renderers?: boolean`; with it, a tool row (in `ToolLine`, also
  inside expanded bursts) whose `toolRendererKey(action)` is non-null draws `<ToolOutputRenderer action>` always open
  under the row (`ml-[30px]`, as `DETAIL_PANEL`).

- [ ] `renderregistry.test.ts`: `blockRendererFor("chart")` is `ChartCard`; `blockRendererFor(undefined)` and
  `blockRendererFor("ts")` are undefined.
- [ ] Run `npx vitest run frontend/app/view/agents/renderregistry.test.ts`: FAIL, implement, PASS.

### Task 5: Tool output renderers and images in the projection
**Depends on:** Task 4
**Files:** `frontend/app/view/agents/renderregistry.ts`, `frontend/app/view/agents/renderregistry.test.ts`, `frontend/app/view/agents/toolrenderers.tsx`, `frontend/app/view/agents/testoutput.ts`, `frontend/app/view/agents/testoutput.test.ts`, `frontend/app/view/agents/unifieddiff.ts`, `frontend/app/view/agents/unifieddiff.test.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/tooldetail.ts`, `frontend/app/view/agents/tooldetail.test.ts`, `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`

Decisions 9, 10, 13.

**Interfaces (produced):**
- `agentsviewmodel.ts`: `export interface ToolImage { mediaType: string; data: string }`; the action variant of
  `AgentEntry` gains `images?: ToolImage[]`.
- `tooldetail.ts`: `toolResultImages(content: unknown): ToolImage[]`.
- `renderregistry.ts`: `toolRendererKey` implemented (images first; then Bash whose command matches
  `isGitDiffCommand` (`git ... diff|show`) and whose output parses; then `isTestCommand` (`go test`, `vitest`) and
  parses); `isGitDiffCommand(cmd: string): boolean`, `isTestCommand(cmd: string): boolean`.
- `testoutput.ts`: `parseTestOutput(output: string): TestSummary | null`,
  `TestSummary { runner: "go" | "vitest"; unit: "test" | "package"; pass: number; fail: number; skip: number;
  failures: TestFailure[] }`, `TestFailure { pkg?: string; test: string; message: string; loc?: string }`. Handles
  `go test -json`, `go test -v`, plain `go test` (unit `package`), vitest; strips ANSI first; null when nothing
  recognized.
- `unifieddiff.ts`: `parseUnifiedDiff(output: string): EditFile[] | null` (`diff --git` sections; `new file mode` ->
  badge `A`; skips `\ No newline`, the commit header of `git show`, binary files keep no lines); null without a
  `diff --git` header.
- Data hooks: `[data-tool-card="test" | "git-diff" | "image"]` on each card, `[data-raw-toggle]`,
  `[data-test-counts]`, `[data-test-failure]` per failure row.

Cards follow the prototype's go-test card: header row with the mono runner label (`go test`, `vitest`, `git diff`),
counts (`212 pass` success, `1 fail` error, `4 skip` muted), a `raw` toggle; body lists only failures (`FAIL`, pkg,
`test: message`, loc), "all passed" when none; the diff card reuses `ToolDetailBody` edit rendering; body max height
360px with scroll; the image card draws each image at max height 360px.

- [ ] Write the tests: `testoutput.test.ts` (one fixture each for go -json with 1 fail + skips, go -v with
  `plan_test.go:88:` message lines, plain go `ok`/`FAIL` package lines, vitest summary + failure block, ANSI-colored
  vitest, unrelated text -> null, a 20,000-line go -v output gives the right counts); `unifieddiff.test.ts` (two-file
  diff counts adds/dels, new file badge A, `git show` header skipped, no header -> null, a 20,000-line diff parses to
  the right counts); `renderregistry.test.ts` (`toolRendererKey` for each kind, a `git diff` with empty output ->
  null, a `go test` with unparseable output -> null); `tooldetail.test.ts` (`toolResultImages` reads base64 image
  items, ignores text and url sources); `transcriptprojection.test.ts` (a Read tool_result with an image item gives
  the action `images`).
- [ ] Run `npx vitest run frontend/app/view/agents/testoutput.test.ts frontend/app/view/agents/unifieddiff.test.ts frontend/app/view/agents/renderregistry.test.ts frontend/app/view/agents/tooldetail.test.ts frontend/app/view/agents/transcriptprojection.test.ts`: FAIL, implement, PASS.
- [ ] Acceptance in the running app: scenario steps `rendered: test card`, `rendered: diff card`, `rendered: image`
  (Task 10). The cockpit's cards are unchanged (no `renderers` prop there).

### Task 6: Chart renderer and the `arc:charts` skill
**Depends on:** Task 4
**Files:** `frontend/app/view/agents/chartspec.ts`, `frontend/app/view/agents/chartspec.test.ts`, `frontend/app/view/agents/chartcard.tsx`, `skills/charts/SKILL.md`, `skills/skills.go`, `cmd/wsh/cmd/claude-mod/skills/charts/SKILL.md`

Decisions 11, 12.

**Interfaces (produced):** `parseChartSpec(raw: string): { ok: true; spec: ChartSpec } | { ok: false; reason: string }`;
`ChartSpec { type: "bar" | "line" | "area" | "scatter"; title: string; x?: { label?: string }; y?: { label?: string;
unit?: string }; series: { name: string; points: { x: string | number; y: number }[] }[] }`; `ChartCard` keeps its
Task 4 signature. Data hooks: `[data-chart-card]` with `[data-chart-type]`, `[data-chart-mark]` on every bar, point
and line/area path, `[data-chart-spec-toggle]`, `[data-chart-fallback]` on the raw-with-reason fallback.

Card per the prototype: header with mono `chart` (accent-soft), the title, a `spec` toggle that shows the raw block in
`CodeBlock`; horizontal bars with labels in a 130px column, the value label right, an x tick row below; line, area and
scatter drawn with visx scales and axes as `dailychart.tsx` does (width from `@react-hook/resize-observer`), marks
animated with `motion`, a legend when more than one series, series colors from `@theme` tokens.

- [ ] `chartspec.test.ts`: a valid spec of each type parses; bad JSON, unknown type, missing title, empty series, a
  NaN or string y, more than 8 series, more than 500 points, and a scatter with string x each return `ok: false` with
  a reason naming the problem; parsing a 10,000-point spec never throws.
- [ ] Run `npx vitest run frontend/app/view/agents/chartspec.test.ts`: FAIL, implement, PASS.
- [ ] Write `skills/charts/SKILL.md` (frontmatter `name: charts`, a description that triggers when numbers would read
  better as a chart in Arc; the schema, limits, one example per type, "the block falls back to raw if invalid"), add
  `charts` to the `go:embed` line in `skills/skills.go`, run `task sync:claudemod` and keep only the
  `cmd/wsh/cmd/claude-mod/skills/charts/SKILL.md` copy it adds; grep `pkg/agentsync` tests for an enumerated shipped
  skill set and update any that list it.
- [ ] Run `go test ./pkg/agentsync -run 'Skill'`: PASS.
- [ ] Acceptance: scenario steps `rendered: chart`, `rendered: chart types` (Task 10).

### Task 7: Rendered mode: view, toggle, composer, picker flip
**Depends on:** Task 4 (uses `NarrationTimeline`'s `renderers` prop)
**Files:** `frontend/app/view/agents/renderedmode.ts`, `frontend/app/view/agents/renderedmode.test.ts`, `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/agentsurface.tsx`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/agentcomposer.tsx`, `frontend/app/view/agents/agentcomposer.test.ts`, `frontend/app/view/agents/session-models/agentstatusstore.ts`, `frontend/app/store/keybindings/bindings.ts`, `docs/keyboard-shortcuts.md`

Decisions 6, 14.

**Interfaces (produced):**
- `renderedmode.ts`: `viewModeAtom(agentId: string): PrimitiveAtom<"terminal" | "rendered">` (default terminal);
  `pickerFlipAtom(agentId: string): PrimitiveAtom<number | null>`;
  `effectiveViewMode(mode, flipTs: number | null): "terminal" | "rendered"`; `canRender(agent: AgentVM, opts:
  { ended: boolean; stage: boolean }): boolean`; `isPickerCommand(text: string): boolean`;
  `UNFLIP_HOOKS = ["UserPromptSubmit", "Stop", "SessionStart"]`;
  `shouldUnflip(flipTs: number | null, last: { hook: string; ts: number } | null): boolean`;
  `toggleViewMode(agentId: string): void` (clears the flip, flips the mode).
- `agentstatusstore.ts`: `getLastHookAtom(oref: string): PrimitiveAtom<{ hook: string; ts: number } | null>`, set by
  the `agent:status` handler for every event that carries a `hook` (usage-only events never reset it).
- `renderedview.tsx`: `RenderedView({ model, agent }: { model: AgentsViewModel; agent: AgentVM })`, reading
  `useAtomValue(entriesAtomFor(agent.id))`, with a dock slot above the composer holding the `AnswerBar` for a pending
  ask (wired to `model.toggleAnswer`, `model.setAnswerText`, `model.submitAnswer`, `model.answerTabAtom`,
  `model.sentIdsAtom` as `cockpitsurface.tsx` does), and a `composerRef: AgentComposerHandle`.
- `agentcomposer.tsx`: optional prop `onSubmitText?: (text: string) => void` called when a send starts; the handle
  gains `focus(): void`.
- Data hooks: `[data-view-toggle]` (the segmented group), `[data-rendered-view]` (root), `[data-rendered-composer]`,
  `[data-rendered-hint]`, `[data-rendered-empty="skeleton" | "no-transcript"]`.

Layout per the prototype: the header gains the `Terminal | Rendered` segmented control (`role="group"`,
`aria-label="View mode"`, `aria-pressed` on the active button) and a `v` kbd chip, shown only when `canRender`; the
center swaps the terminal div to `hidden` (still mounted) and draws `RenderedView`, with the precedence of decision 14;
the rail stays. `RenderedView`: scroll region with `NarrationTimeline entries renderers accentLatest active` centered
at max 920px with `useStickToBottom` and `JumpToLatestPill`; `TranscriptSkeleton` before entries arrive and "No
transcript for this session yet." without a transcript path; composer row (placeholder "Message the agent; / for
commands", Esc -> `interruptAgent(blockId)`), and the hint line `Esc interrupt · / commands · /model and permissions
in the header · other pickers open the terminal`. A picker command sets the flip before sending. Entering Rendered
focuses the composer; returning to Terminal focuses the xterm (as the pane-mode effect in `agentsurface.tsx` does).
Unflip: an effect on `getLastHookAtom(oref)` clears the flip when `shouldUnflip`. Key `v` (`agent:toggle-view`,
group Agent, label "Toggle Terminal / Rendered") when `nav(ctx)` and the focused agent `canRender`; a row in the Agent
table of `docs/keyboard-shortcuts.md`.

- [ ] `renderedmode.test.ts`: `canRender` true for a claude agent with a block; false for pi/codex/opencode, a
  terminal, no block, an ended worker, a stage row. `isPickerCommand`: `/config` and `/model` true, `/model opus`,
  `/compact`, `/review x` and plain text false, leading spaces tolerated. `effectiveViewMode("rendered", 5)` is
  terminal. `shouldUnflip(100, {hook:"Stop", ts:99})` false, `(100, {hook:"Stop", ts:101})` true,
  `(100, {hook:"Notification", ts:101})` false, `(100, {hook:"PostToolUse", ts:101})` false, `(null, x)` false.
  `agentcomposer.test.ts`: `onSubmitText` receives the text when a send starts.
- [ ] Run `npx vitest run frontend/app/view/agents/renderedmode.test.ts frontend/app/view/agents/agentcomposer.test.ts`:
  FAIL, implement, PASS.
- [ ] Acceptance: scenario steps `rendered: toggle`, `rendered: timeline`, `rendered: empty states`,
  `rendered: ask dock`, `rendered: esc interrupt`, `rendered: picker flip`, `rendered: v key` (Task 10).

### Task 8: Header model and permission-mode controls
**Depends on:** Task 1 (reads `AgentStatusData.permissionmode`), Task 7 (shares `agentheader.tsx`)
**Files:** `frontend/app/view/agents/headercontrols.tsx`, `frontend/app/view/agents/headercontrolsmodel.ts`, `frontend/app/view/agents/headercontrolsmodel.test.ts`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/session-models/agentstatusstore.ts`

Decisions 7, 8.

**Interfaces (produced):** `headercontrolsmodel.ts`: `MODEL_ALIASES = ["default", "opus", "sonnet", "haiku"]`;
`modelCommand(alias: string): string` (`/model <alias>`); `PERMISSION_CYCLE = ["default", "acceptEdits", "plan"]`;
`permissionModeKeys(current: string, target: string): string[] | null` (null when either is outside the cycle);
`permissionModeLabel(mode?: string): string`. `agentstatusstore.ts`: `getPermissionModeAtom(oref: string):
PrimitiveAtom<string | null>` holding the last non-empty `permissionmode`. Data hooks: `[data-header-model]`,
`[data-header-permission-mode]`.

Two buttons in the header title row per the prototype (mono 10.5px, raised surface, chevron): the model
(`prettyModel(agent.model)` lowercased, e.g. `opus 5.5`, aria-label `Model: <label>, change`) opening a context menu
of the aliases that sends `modelCommand` through `sendAgentText`; the permission mode (aria-label
`Permission mode: <label>, change`) opening a menu of the cycle that types `permissionModeKeys` with awaited
`RpcApi.ControllerInputCommand` writes 60ms apart and sets the optimistic mode, reverting it (and logging) when a
write fails. Shown when Task 7's `canRender` is true, in both views.

- [ ] `headercontrolsmodel.test.ts`: `permissionModeKeys("default","plan")` is two `"\x1b[Z"`, `("plan","default")`
  one, `("plan","plan")` empty, `("bypassPermissions","default")` null; labels for each mode and an unknown one;
  `modelCommand("opus") === "/model opus"`.
- [ ] Run `npx vitest run frontend/app/view/agents/headercontrolsmodel.test.ts`: FAIL, implement, PASS.
- [ ] Acceptance: scenario steps `rendered: header controls`, `rendered: permission mode change` (Task 10).

### Task 9: Permission band, its store, and the "allowed" timeline row
**Depends on:** Task 1 (uses `AgentPermissionData`, `agent:permission`, `AnswerAgentPermissionCommand`), Task 7 (docks into `renderedview.tsx`)
**Files:** `frontend/app/view/agents/permissionstore.ts`, `frontend/app/view/agents/permissionstore.test.ts`, `frontend/app/view/agents/permissionmodel.ts`, `frontend/app/view/agents/permissionmodel.test.ts`, `frontend/app/view/agents/permissionband.tsx`, `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/boot/boot-core.ts`, `frontend/app/store/keybindings/bindings.ts`, `docs/keyboard-shortcuts.md`

Decisions 3, 15, 16.

**Interfaces (produced):**
- `permissionstore.ts`: `getAgentPermissionsAtom(oref: string): PrimitiveAtom<AgentPermissionData[]>` (FIFO; a raise
  appends, a cleared event removes that permid only); `setupAgentPermissionSubscription()` called from
  `boot-core.ts` beside `setupAgentAskSubscription()`; `permissionLogAtom(agentId: string):
  PrimitiveAtom<{ afterEntry: number; text: string }[]>`.
- `permissionmodel.ts`: `permissionTitle(p): string` (Edit/Write/MultiEdit/NotebookEdit -> `Allow an edit to
  <file_path>?`; Bash -> `Allow this command?`; ExitPlanMode -> `Approve this plan?`; else `Allow <tool>?`);
  `permissionPreview(p): { kind: "diff"; files: EditFile[] } | { kind: "command"; text: string } | { kind: "markdown";
  text: string } | { kind: "json"; text: string }` (diff via `buildEditDiff`; a tool_input that is not JSON -> json
  kind with the raw text); `permissionLogText(p, choice: number): string` (`"<choice label>: <subject>"`).
- `narrationtimeline.tsx`: `NarrationTimeline` gains `marks?: { afterEntry: number; text: string }[]`, each drawn as
  a thin row (status square + text, mono faint, `[data-permission-mark]`) after the last item covering entry
  `afterEntry - 1`.
- Data hooks: `[data-permission-band]`, `[data-permission-choice]` (value = index), `[data-permission-queue]`,
  `[data-permission-error]`, `[data-permission-mark]`.

Band per the prototype (warning-tinted, `Needs you`, title, preview block, numbered buttons `1 Yes` primary, others
secondary), docked between the timeline and the composer, rendered mode only. A click, or digit 1-9 when focus is not
in an editable field (binding `agent:permission-choice`, documented in `docs/keyboard-shortcuts.md`), sends
`AnswerAgentPermissionCommand`; buttons lock while it is in flight; an error shows inline and keeps the band; on
success the log row is recorded, and after the last choice ("No"/"keep planning") the composer gets focus. Two or more
pending: the queue state with an `Open terminal` button that sets the picker flip.

- [ ] `permissionmodel.test.ts`: titles per tool; Edit preview gives one file with -/+ lines; Bash gives the command;
  ExitPlanMode gives the plan markdown; bad JSON input gives json kind; log text. `permissionstore.test.ts`: raise then
  raise keeps order; a cleared event for the second keeps the first; a cleared event for an unknown permid changes
  nothing.
- [ ] Run `npx vitest run frontend/app/view/agents/permissionmodel.test.ts frontend/app/view/agents/permissionstore.test.ts`:
  FAIL, implement, PASS.
- [ ] Acceptance: scenario steps `rendered: permission band`, `rendered: permission error`,
  `rendered: permission queue`, `rendered: plan approval`, `rendered: permission answer` (Task 10).

### Task 10: CDP scenario `agent-rendered`
**Depends on:** Task 2 (the answer steps need real delivery), Task 5 (draws the tool cards), Task 6 (draws the charts), Task 8 (draws the header controls), Task 9 (draws the band)
**Files:** `scripts/cdp/scenarios-agent-rendered.mjs`, `scripts/cdp/fixtures/keyprobe.mjs`, `scripts/cdp/scenarios.mjs`

Implements the fixtures and every step listed under "Scenario `agent-rendered`" above, asserting only on the `data-*`
hooks the tasks name (scope every query to the Agent surface container), and registers it in `SCENARIOS`. The key
probe exits when its tab closes; its output file lives in a temp dir removed at teardown.

- [ ] Run `node scripts/cdp/final-verify.mjs agent-rendered` against the dev app: every step passes or names why it
  could not verify.
