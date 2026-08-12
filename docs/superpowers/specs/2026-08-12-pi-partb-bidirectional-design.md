# Pi Part B — Bidirectional Integration (Wave Tools + Control Channel + Notification Bridge)

> Design spec for meta Part B of the pi-in-arc effort. Part B makes the integration
> bidirectional: pi can drive arc (B1 wave tools), arc can steer live pi sessions (B2 control
> channel), and meaningful pi events surface as arc notifications (B3). Reads on top of
> [`2026-08-11-pi-main-harness-meta-design.md`](./2026-08-11-pi-main-harness-meta-design.md)
> (Part B sections), the core spec
> [`2026-08-11-pi-harness-opencode-branding-design.md`](./2026-08-11-pi-harness-opencode-branding-design.md)
> (launch/consult/transcript/usage/live-status, landed), and
> [`docs/pi-package-integration-meta-spec.md`](../../pi-package-integration-meta-spec.md).

## Summary

Three workstreams, one extension file, one new wshrpc domain:

- **B1 — Wave tools:** pi registers five `wave_*` model-callable tools that drive arc through
  existing wsh endpoints. Four ship in v1; `wave_create_widget` is deferred to v2
  (recorded in `docs/deferred.md`).
- **B3 — Notification bridge:** a new `wsh notify` endpoint plus a minimal frontend toast
  surface; the extension maps only explicit, user-meaningful pi transitions to notifications.
- **B2 — Control channel:** a per-session command pipe — wavesrv writes
  `<sessionId>.json` command files into a Wave-managed directory, the pi extension watches
  and executes them against pi APIs, so the cockpit can steer live pi sessions.

All three build on the extension pattern already proven by `waveterm-status.ts`
(`pi.exec(wshPath, [...])` → wsh RPC → wavesrv). Everything outside a Wave block is inert,
same as today.

## Dependencies and coordination

- Targets pi **0.84.1** (same as the core spec and meta). All extension APIs used —
  `registerTool`, `sendUserMessage`, `setSessionName`, `ctx.compact`, `ctx.abort`,
  `ctx.newSession`, `ctx.switchSession` — exist in that version (verified against the
  installed `docs/extensions.md`).
- **Part B's extension code queues on meta Part D's layout** (in flight): the pi package at
  repo root, `wsh install-agent-hooks` provisioning, and the `pi/` → `cmd/wsh/cmd/` sync
  step. Part B adds a **new** extension file (`pi/extensions/waveterm-tools.ts`) rather than
  growing `waveterm-status.ts`, so it does not collide with the in-flight Part C+D work; it
  is provisioned by the same idempotent mechanism.
- Part A (prominence) and Part C+D (package/theme/provisioning) file maps do not overlap
  Part B's (new wshrpc domain, new extension file, frontend toast + steer UI).

## B1 — Wave tools (pi drives arc)

### Extension file

`pi/extensions/waveterm-tools.ts` — a new file, separate from `waveterm-status.ts`
(status/usage reporting). pi auto-loads every file in the extensions directory, so a second
file needs no registration plumbing. It holds the tool registrations (B1) and the control
channel watcher (B2).

### Tool contract

All tools:

- registered via `pi.registerTool({...})` with lowercase `wave_` names, Typebox
  `parameters`, a `promptSnippet`, and `promptGuidelines` entries that **name the tool
  explicitly** ("Use wave_run_command when ...") per the extension docs' rule.
- execute by `pi.exec(wshPath, [...])` — the same mechanism as the status extension.
- return `{ content: [{ type: "text", text }], details: {} }`; on non-zero wsh exit they
  return the wsh error text as tool error content, never swallow.
- run under the same security boundary as pi's bash tool: the user authorized
  model-callable code execution by running pi. No new permission layer. Users can disable
  tools via pi's own `pi.setActiveTools()` / settings.

### The five tools

| Tool | Purpose | Backing | New surface |
|---|---|---|---|
| `wave_run_command` | Run a command visibly in a tab | `wsh run --cwd <cwd> -- <cmd...>` (or `-c <string>`) | none |
| `wave_open_file` | Open a file (optionally at a line) in a tab | `wsh editor <abs-path>` | none (line meta key verified at implementation) |
| `wave_query_sessions` | List open blocks for the model to reference | `wsh blocks list --json` | none |
| `wave_notify` | Send a Wave notification | `wsh notify` (B3) | endpoint + frontend surface |
| `wave_create_widget` | Create/update a live vdom widget | `wsh widget` CLI wrapping `VDomCreateContextCommand`/`VDomRenderCommand` | **deferred to v2** |

### Behavioral decisions

- `wave_run_command` returns blockid + cwd + command. **Output streams in the visible
  block, not back to the model** (the meta's context-flood rule). An optional `capture`
  boolean fetches a truncated tail via `wsh termscrollback <blockid>` using the existing
  truncation utilities, capped so it never floods model context.
- `wave_open_file` requires an existing file (wsh editor stat-checks and errors with "file
  does not exist"). Optional `line` parameter; the exact meta key the edit view uses for a
  line number is confirmed at implementation time.
- `wave_query_sessions` filters to useful defaults (term + edit blocks) and caps result
  length.
- `wave_create_widget` is **deferred to v2** — vdom async-initiation / render-stream
  semantics need their own care and there is no concrete consumer yet. Recorded in
  `docs/deferred.md` with plug-in points and resume instructions.

## B3 — Notification bridge

### Endpoint

New `wsh notify <title> [--message <text>] [--level info|warn|error]` command → new
`NotifyCommand` on wshserver. No notify endpoint exists today (verified: `wsh badge` sets a
block badge, a different thing). This is the only new server surface in the pi→arc half.

### Extension mapping

The extension maps only explicit, user-meaningful transitions, per the meta's rule (no
per-turn spam). v1 mappings:

- session ends in error (`agent_settled` after a failed run) → error notification;
- a B2 control-channel command fails → error notification.

Exact event predicates are tuned during implementation against the settled/error semantics
pi exposes.

### Frontend surface

The cockpit has no toast/notification surface today (verified: the attention list is the
server-computed "needs you" list for asks and run gates — polled, and semantically distinct
from transient notifications). B3 adds a **minimal toast overlay**:

- `frontend/app/cockpit/notificationstore.ts` — jotai atom + add/dismiss helpers;
- a small toast stack component mounted in `CockpitRoot`, styled from `@theme` tokens,
  auto-dismiss after a few seconds. No router, no persistence.

### Error handling

`wsh notify` is best-effort from the extension's side (try/catch, like the status
reporter); a failed notify never breaks the session.

## B2 — Control channel (arc steers pi)

### Transport

Per-session command pipe as the meta prescribes: wavesrv writes JSON command files into a
Wave-managed directory named `<sessionId>.json` (the session ID the status extension
already reports via `agentstatus --session-id`); the extension watches, executes, deletes.

### Directory and discovery

- Directory: `<dataHome>/pi-control/`, created by wavesrv on demand.
- Discovery: the frontend sets `WAVETERM_PI_CONTROL_DIR` in the pi launch env via the same
  `cmd:*` meta mechanism that already carries `cmd:jwt` into the agent env (verified in
  `frontend/app/view/agents/launch.ts`).
- Bare pi outside arc: env var absent → watcher inert, consistent with the existing "bare
  pi is inert" extension pattern.

### Writer (wavesrv)

New `PiSendControlCommand{SessionId, Command, Args}` on wshserver. Validates the session is
a known pi agent session — the status extension already reports session IDs into the agents
table via `agentstatus --session-id` — then writes `<dir>/<sessionId>.json` **atomically**
(temp file + rename). The frontend calls it from the steer UI.

### Reader (extension)

On `session_start`, resolve the control dir from env and start watching `<sessionId>.json`
via `fs.watch` with a polling fallback. On arrival: parse, validate, execute, delete.
Delete happens even on failure (idempotent), so a wedged command cannot replay.

**Watcher lifecycle (session replacement):** on every `session_start`, tear down any
existing watch and rebind to `<current sessionId>.json`. The replacement session's new
extension instance fires `session_start`, so the rebind is automatic. On `session_shutdown`,
stop watching. Between switch-arrival and the new `session_start`, commands keep flowing to
the old session ID — correct, because the old session is still live until the switch
completes.

### Command set

| Command | API |
|---|---|
| `steer` | `pi.sendUserMessage(content, {deliverAs: "steer"})` |
| `follow_up` | `pi.sendUserMessage(content, {deliverAs: "followUp"})` |
| `set_session_name` | `pi.setSessionName(name)` |
| `compact` | `ctx.compact({customInstructions})` |
| `abort` | `ctx.abort()` |
| `new_session` | `ctx.newSession({withSession})` |
| `switch_session` | `ctx.switchSession(path, {withSession})` |

All seven are in v1. `new_session` / `switch_session` were reviewed against the documented
session-replacement footguns and deliberately kept (recorded in `docs/deferred.md` so they
are not re-deferred later).

**Ack semantics for `new_session` / `switch_session`:** capture only plain data (the command
file path + sessionId — safe across replacement), invoke the API with `withSession`, and
delete the command file when the replacement session confirms. Delete is idempotent, so a
try-finally covers the mid-switch failure case; the failure surfaces via
`agentstatus --detail` and an error notification.

**Documented residual risk:** pi tears down the old runtime before `withSession` runs; a
mid-switch failure can leave the prior session gone. Inherent to pi's API — the extension
cannot paper over it, only surface it.

### JSON protocol

```json
{ "cmd": "steer", "content": "...", "deliverAs": "steer" }
```

Unknown `cmd` values are ignored and reported (agentstatus detail), never fatal.

### Frontend affordance

The agent detail rail already shows live pi status (working/idle + detail via agentstatus).
B2 adds a small **steer input** there: type a message, hit enter, cockpit calls
`PiSendControlCommand` (steer). This is the visible "arc steers pi" surface.

The core spec's waiting-state rule is preserved: pi is represented as waiting only during an
explicit ask flow; steering never marks it waiting.

## Server surface (complete list)

- `wshrpc` types + `wshserver` handlers for `NotifyCommand` (B3) and
  `PiSendControlCommand` (B2); `wsh notify` CLI command.
- Frontend: `notificationstore.ts` + toast stack in `CockpitRoot` (B3); steer input in the
  agent detail rail (B2); generated `wshclientapi` bindings via `task generate`.

No other backend changes.

## Testing

- **Extension logic:** tool modules and the command-file parser extract pure functions
  (tool params → wsh argv; command-file parse/validate) with Vitest beside them — the
  repo's "testable logic extracted, not rendered" convention.
- **Go:** wshserver handlers — notify payload validation; control-file write is atomic and
  session-validated.
- **Round-trip:** write a control file, observe the pi action, confirm deletion and error
  surfacing; a live `switch_session` test (session A → B, assert A's `session_shutdown`, B's
  `session_start`, file deleted).
- **CDP scenario:** extend `surface-smoke` — steer input visible on a pi session card; a
  `wsh notify` toast appears.

## Sequencing

Phased implementation plan, each phase a reviewable checkpoint:

1. **Phase 1 — B1 tools:** `pi/extensions/waveterm-tools.ts` tool registrations + pure
   helpers + Vitest.
2. **Phase 2 — B3 notify:** `NotifyCommand` + `wsh notify` + toast surface + Go tests.
3. **Phase 3 — B2 control channel:** `PiSendControlCommand` writer, extension watcher,
   steer UI, live round-trip tests.

Part B's extension provisioning lands after the in-flight Part D layout; the plan sequences
the sync/provisioning step accordingly.

## Out of scope / deferred

- `wave_create_widget` + `wsh widget` CLI — v2, recorded in `docs/deferred.md` (2026-08-12).
- TaskExecute / pi-subagents fleet visibility in arc — meta out-of-scope, unchanged.
- Pi as a dispatchable runtime in `launch.ts` `RUNTIME_CMD` — meta out-of-scope, unchanged.
- No speculative ask tool: the waiting-state rule is preserved.
