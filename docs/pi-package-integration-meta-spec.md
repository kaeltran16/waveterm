# Pi Package Integration — Meta Spec (Task Feed & Ask Bridge)

> Captured 2026-08-11. Umbrella tracking doc for the two workstreams that surface **pi
> package state** in the Arc cockpit: the tasks feed (pi-tasks → cockpit) and the ask
> bridge (pi ask tool → cockpit attention list). This is the package-data axis of the
> pi-in-arc effort; it reads on top of
> [`docs/superpowers/specs/2026-08-11-pi-main-harness-meta-design.md`](./superpowers/specs/2026-08-11-pi-main-harness-meta-design.md)
> (harness prominence, wave tools, control channel, provisioning — Parts A–D), the core
> spec
> [`2026-08-11-pi-harness-opencode-branding-design.md`](./superpowers/specs/2026-08-11-pi-harness-opencode-branding-design.md)
> (launch/consult/worker/transcript/usage/resume/live status, in flight), and
> [`docs/agents/organic-ask-setup.md`](./agents/organic-ask-setup.md) (the ask protocol).
> This doc defines the **workstream split** and tracks status; each workstream gets its own
> spec under `docs/superpowers/specs/` and plan under `docs/superpowers/plans/`.

## 1. Vision

Pi is a first-class agent in the cockpit. Today pi runs standalone; its task list lives
in `.pi/tasks/*.json` files and its questions render in the pi TUI. These workstreams
close the two gaps where pi's *package-level* state should surface in Arc, mirroring what
already exists for Claude Code (task files via the scanner pattern, `AskUserQuestion` via
the organic-ask hooks):

- **Tasks feed** — pi-tasks' file-resident task lists become a read-only cockpit surface.
- **Ask bridge** — pi's ask tool routes through the cockpit attention list instead of a
  terminal questionnaire.

This axis is orthogonal to the main harness meta design (Parts A–D): that doc sequences
*how pi becomes the default harness and how arc steers pi sessions*; this doc tracks *what
pi package state Arc consumes*. The two share plumbing (the `pi/` package from Part D, the
wsh channel) but no workstream overlaps.

## 2. Locked decisions (pi side)

Package selection for the pi agent, decided 2026-08-11, all installed into
`~/.pi/agent/settings.json`:

| Package | Role | In Arc scope |
|---|---|---|
| `@tintinweb/pi-tasks` | Claude Code-style task tracking; file-resident JSON (`.pi/tasks/tasks-<sessionId>.json` session scope, `tasks.json` project scope), lock-protected | **Yes — tasks feed** |
| `pi-subagents` (nicopreme) | Standalone delegation (scout/worker/reviewer/oracle) | No — standalone capability; TaskExecute intentionally unused (Arc brings orchestration) |
| `pi-web-access` | Web research for the model | No |
| `pi-lens` | LSP/lint/type-check feedback | No |
| `@juicesharp/rpiv-ask-user-question` | Questionnaire tool | **Yes — ask bridge replaces its terminal rendering in-arc** |

Why pi-tasks over rpiv-todo (the popular alternative): rpiv-todo's state is rebuilt from
the conversation branch with no disk writes — structurally unintegrable; pi-tasks'
file-resident, project/session-scoped JSON fits Arc's established read-only scanner
pattern (`pkg/bgagents`, `pkg/agentsessions`).

## 3. Workstream E — Tasks feed (pi-tasks → cockpit)

**Status: design (next).**

- **Data source:** `<cwd>/.pi/tasks/tasks-<sessionId>.json` (per-session, survives resume)
  and `<cwd>/.pi/tasks/tasks.json` (project-shared). JSON task records: status
  (`pending | in_progress | completed | deleted`), subject/description, bidirectional
  `blocks`/`blockedBy` edges, owner, metadata. Exact schema to be confirmed from the
  installed package source (`~/.pi/agent/npm/@tintinweb/pi-tasks`) in the E spec.
- **Pattern:** read-only scanner like `pkg/bgagents` / `pkg/agentsessions` →
  `pkg/pitasks` (Parse tolerant, never fails on malformed elements) → new wshrpc domain
  (`wshrpctypes_tasks.go` + `wshserver_tasks.go` + `wshclient`) → frontend surface.
- **Open questions for the E spec:**
  - surface placement: dedicated Tasks surface vs fold into an existing surface
    (Sessions/Jarvis);
  - session-scope vs project-scope aggregation, and lifecycle (auto-clear of completed
    tasks mirrors pi-tasks' own `autoClearCompleted`);
  - read-only vs write-back (marking tasks done from the cockpit — write-back touches
    pi-tasks' lock-protected files, defer unless a concrete need appears).

## 4. Workstream F — Ask bridge (pi ask → cockpit attention)

**Status: backlog.**

Findings (grounded in source, 2026-08-11):

- `wsh ask` (`cmd/wsh/cmd/wshcmd-ask.go`) is **fire-and-forget**: it registers a pending
  ask keyed by the block ORef (`pkg/agentask` registry) and returns an AskId. The Short
  text says non-blocking; the organic-ask doc describes the older hook-script flow.
- Answers arrive via `AnswerAgentCommand` → `DeliverAnswer` (`pkg/agentask/deliver.go`),
  which **injects answers as PTY keystrokes** into the block — built for Claude Code's
  terminal picker. That path does not return an answer to a pi tool call.
- pi 0.84.1 has no built-in `ask_question` tool (built-ins are `read`, `bash`, `edit`,
  `write`, `grep`, `find`, `ls`); extensions register their own ask tools — the
  rpiv-ask-user-question tool is the template.

**Shape:** an Arc-side blocking answer return (e.g., `wsh ask --wait`: register, block
until answered, emit answers as JSON on stdout) plus a pi extension tool that calls it via
`pi.exec()`. The extension lives in the repo's `pi/` package (Part D) and is provisioned
by `wsh install-agent-hooks`.

**Open questions for the F spec:**
- wait-mode delivery: parallel resolve path for waiters vs extending `DeliverAnswer`
  (must preserve the existing claim/idempotence semantics);
- payload parity with the Claude Code hook envelope `wsh ask` already unwraps;
- multi-question batching, multi-select, timeout, cancel, and `--clear` behavior;
- coordination with the core spec's waiting-state rule (pi is "waiting" only during an
  explicit ask flow) and the attention list age display (`pkg/agentask` `PendingAsk.Ts`).

## 5. Tracking

| Workstream | Status | Spec | Plan | Depends on |
|---|---|---|---|---|
| E — tasks feed | design | — | — | pi-tasks package (installed) |
| F — ask bridge | backlog | — | — | Part D `pi/` package (scheduled); organic-ask machinery (exists) |

## 6. Sequencing

1. **E spec** → E plan → E implementation (self-contained, Arc-side only).
2. **F spec** after E is underway — it needs the Part D `pi/` package shape and the
   organic-ask machinery, both of which exist or are scheduled; no hard dependency on E.

## 7. Out of scope

- TaskExecute / subagent execution in Arc — Arc brings orchestration (Runs, dispatch);
  the cockpit surfaces tasks, it does not execute pi's DAG.
- pi-subagents fleet visibility in Arc — standalone capability; revisit after E.
- pi as a dispatchable runtime in `launch.ts` (`RUNTIME_CMD`) — future workstream if
  desired; not part of this meta spec.
- Control channel, wave tools, theme/keybindings, provisioning — owned by the main
  harness meta design (Parts A–D).
