# Pi Tasks Feed — Design Spec (Workstream E)

> 2026-08-11. Implements Workstream E of the
> [pi-package-integration meta-spec](../../pi-package-integration-meta-spec.md): pi-tasks'
> file-resident task lists as a read-only cockpit surface. Placement decision (2026-08-11):
> render in the **Agent surface detail rail** (`agentdetailsrail.tsx`), compacting existing
> rail info to make room — no dedicated surface, no Sessions/Jarvis fold-in.
> F (ask bridge) is deferred to its own spec.

## 1. Goal

A pi-tasks section in the agent detail rail: for the selected agent, show the tasks pi
persisted for that agent's project (`.pi/tasks/*.json`), read-only. Mirror of what pi-tasks
writes; never opens those files for write (they are lock-protected by pi-tasks itself).

## 2. Data source (verified against installed package source, 2026-08-11)

Package: `@tintinweb/pi-tasks` at `~/.pi/agent/npm/node_modules/@tintinweb/pi-tasks`
(note: the meta-spec's `~/.pi/agent/npm/@tintinweb/pi-tasks` path is missing
`node_modules/`). Files:

| Scope       | Path                                     | Notes                                                          |
| ----------- | ---------------------------------------- | -------------------------------------------------------------- |
| session     | `<cwd>/.pi/tasks/tasks-<sessionId>.json` | survives resume; `src/index.ts:141`                            |
| project     | `<cwd>/.pi/tasks/tasks.json`             | `src/index.ts:148`                                             |
| shared list | `~/.pi/tasks/<listId>.json`              | `PI_TASK_LIST_ID` env; **out of scope**                        |
| none        | —                                        | `PI_TASKS=off`, `taskScope: "memory"` produce no project files |

File shape (each store file): `{ "nextId": number, "tasks": Task[] }` where

```
Task { id, subject, description, status, activeForm?, owner?, metadata,
       blocks: string[], blockedBy: string[], createdAt, updatedAt }
```

**Status semantics (correcting the meta-spec):** the persisted `status` values are
`pending | in_progress | completed` only (`src/types.ts` `TaskStatus`). `deleted` is a
tool-input status that **removes the record from the array** (`src/index.ts:1200`
`store.update(taskId, { status: "deleted" })`); no file ever persists a `deleted` record.
The scanner therefore treats "absent from JSON" as deleted and never needs a tombstone.

**Config:** `autoClearCompleted` values are `never | on_list_complete | on_task_complete`
(default `on_list_complete`, `src/tasks-config.ts:11`) — pi-tasks prunes completed tasks
itself; the cockpit mirrors whatever remains. No config parsing needed by the scanner.

## 3. Backend — `pkg/pitasks` (new package)

Read-only scanner following the `pkg/bgagents` / `pkg/agentsessions` conventions: tolerant,
never fails a scan, a missing dir is a silent empty result.

- `Parse(data []byte) ([]Task, error)` — parse one store file; skip (never fail on) malformed
  records; a malformed whole file yields `(nil, err)` so the caller can skip it.
- `Read(cwd string) ([]Task, error)` — walk `<cwd>/.pi/tasks/*.json`, parse each file
  tolerantly, aggregate. Missing dir → `(nil, nil)` (mirrors `bgagents.List` on a missing
  `claude` binary). Empty cwd → `(nil, nil)`.
- Aggregation rules (deterministic): dedupe by `id` keeping the record with the highest
  `updatedAt` (each store file has its own `nextId` sequence, so ids can collide across
  session/project files); sort by status order (`in_progress`, `pending`, `completed`) then
  `updatedAt` descending. Grouping for display is the frontend's job; the backend returns one
  flat sorted list.
- `Task` struct: `ID, Subject, Description, Status, Owner, Blocks, BlockedBy []string,
CreatedAt, UpdatedAt int64` — the persisted subset; unknown fields ignored.

## 4. wshrpc domain

New domain files following the existing split (`wshrpctypes_ask.go` etc.):

- `pkg/wshrpc/wshrpctypes_tasks.go`:
  - `TasksCommands` interface: `GetTasksCommand(ctx, CommandGetTasksData) (*CommandGetTasksRtnData, error)`
  - `CommandGetTasksData{ Cwd string }`
  - `CommandGetTasksRtnData{ Tasks []PiTask }`
  - `PiTask` — wshrpc mirror of `pkg/pitasks.Task` (no json tags, matching `wshrpc.SessionInfo`)
- Embed `TasksCommands` in `WshRpcInterface` (`pkg/wshrpc/wshrpctypes.go:35` composition).
- `pkg/wshrpc/wshserver/wshserver_tasks.go`: `func (ws *WshServer) GetTasksCommand(ctx, data)`
  calls `pitasks.Read(data.Cwd)` and maps to `[]wshrpc.PiTask` (mirrors
  `wshserver_agents.go:67` `GetRecentSessionsCommand`). Empty cwd → empty result, no error.
- Run `task generate` — regenerates the Go `wshclient` function (`GetTasksCommand`, route id
  `"gettasks"`, `pkg/wshrpc/wshclient/wshclient.go`) and the TS binding
  (`RpcApi.GetTasksCommand` + types in `frontend/app/store/wshclientapi.ts`). Dispatch is
  reflection-based (`pkg/wshutil/wshrpc.go` `MakeWshRpc`), so no route table edit.

Read-only: no write-back commands (write-back is deferred per the meta-spec; it would touch
pi-tasks' lock-protected files).

## 5. Frontend — agent detail rail

`AgentDetailsRail` (`frontend/app/view/agents/agentdetailsrail.tsx`) builds a
`RailSection[]` for `CollapsibleRail`. Add one more section:

- **New section "Tasks"** (after "Files touched"), icon from lucide added to `RAIL_ICON`
  (`frontend/app/view/agents/railicons.tsx`, e.g. `ListTodo`).
- **Visibility:** render the section only when tasks exist (mirrors how Subagents/Tools
  sections are conditional on content). Empty scan → section absent, never a dead "No tasks"
  strip.
- **Loading:** `pitasksstore.ts` mirrors `recentsessionsstore.ts` — a jotai atom plus
  `loadTasksForAgent(id, transcriptPath, blockId)` that resolves cwd via `resolveCwd`
  (`agentcwdresolve.ts`, same as `railstore.ts` `loadRailForAgent`) and guards against stale
  focus with the `current.id` pattern. Called from the rail's existing `useEffect` (agent
  focus) plus a 15s silent refresh interval, mirroring `loadSessionUsage`.
- **Derive helpers in pure TS** (`pitasks.ts` + `pitasks.test.ts`, repo convention):
  group by status, cap displayed rows (`RailFilesCap`-style `+N more`).
- **Row rendering:** status dot (accent/ok/warn palette like the Subagents section), subject
  truncated, age; `blocks`/`blockedBy` edges as small chips only when present (keep minimal).
- **Rail compaction (per decision):** tighten the Details section — `DetailRow` padding
  `py-[8px]` → `py-[5px]`, and merge the "Running" row into the "Runtime" row as an age badge
  (one row saved). No other existing sections change; nothing is removed.

## 6. States

| Condition                             | Behavior                                              |
| ------------------------------------- | ----------------------------------------------------- |
| cwd not resolved for agent            | section hidden                                        |
| `.pi/tasks/` missing or no task files | section hidden                                        |
| one file malformed                    | file skipped, other files still shown                 |
| RPC error / scan error                | section hidden (catch → empty, never breaks the rail) |
| `PI_TASKS=off` / `taskScope: memory`  | no files → hidden                                     |

## 7. Out of scope

- Write-back (marking tasks done from the cockpit) — deferred unless a concrete need appears.
- `PI_TASK_LIST_ID` shared-list mode and `~/.pi/tasks/` home-dir lists.
- Session-scope selection UI or resolving the pi session id from transcripts — the section
  shows whatever the project's task dir contains, aggregated.
- Any other surface (dedicated Tasks surface, Sessions, Jarvis).
- Workstream F (ask bridge) — separate spec, deferred.

## 8. Testing

- **Go:** `pkg/pitasks` unit tests — tolerant parse (malformed record/file), dedupe with
  `updatedAt` tiebreak, status sort, missing dir → nil, empty cwd → nil.
- **FE:** `pitasks.ts` vitest — grouping, caps, empty input.
- **Wiring:** after `task generate`, `RpcApi.GetTasksCommand` present in
  `frontend/app/store/wshclientapi.ts`; typecheck via
  `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc`
  stack-overflows on this repo); `go test ./pkg/wshrpc/... ./pkg/pitasks/...`.
- **UI:** manual CDP verification against the live dev app (WebView2 `:9222`,
  `scripts/cdp-shot.mjs`), with a fixture `.pi/tasks/` dir created in a scratch project; the
  `surface-smoke` scenario must still pass.
