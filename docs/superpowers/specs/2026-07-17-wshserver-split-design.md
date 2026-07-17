# wshserver.go collision investigation + domain split

Date: 2026-07-17

## Problem

Edits to `pkg/wshrpc/wshserver/wshserver.go` and `pkg/wshrpc/wshrpctypes.go` fail
(merge/rebase conflicts) far more often than other files. These two files are the
single choke point for adding any RPC command, and every feature stream flows through
them.

## Investigation — root cause

Churn is extreme and shared across unrelated features:

- `wshserver.go`: 186 commits, 2374 lines, 151 handler methods on one `WshServer` struct.
- `wshrpctypes.go`: 182 commits, 1499 lines (interface at L36–251, ~1250 lines of `CommandXxxData` structs).
- The two co-change in nearly every recent commit, from streams that have nothing to do
  with each other: agents, runs, channels, radar, memory, jarvis, jobs.

Adding one RPC command requires hand-editing, in these two files:
1. a signature line in the `WshRpcInterface` block (`wshrpctypes.go`),
2. a `CommandXxxData` struct (`wshrpctypes.go`),
3. a `func (ws *WshServer) XxxCommand(...)` handler (`wshserver.go`),

then regenerating `wshclient.go` + `wshclientapi.ts` via `task generate`.

There are **three independent collision surfaces**, all concentrated in these two files:

1. **Import block (`wshserver.go` L8–60).** Each feature adds a package import
   (`agentask`, `jarvis`, `memvault`, `reporadar`, `consult`, `tasksharpen`…).
   Two branches both touching the import block conflict at the top of the file.
   (Commit `e568a2b3` rewrote imports at L8/27/50/64 in a single change.)
2. **Interface + struct blocks (`wshrpctypes.go`).** No section markers exist; features
   append signatures and structs wherever, so hunks from different streams interleave.
3. **Generated files.** Every command change forces `task generate`, which rewrites
   `wshclient.go`/`wshclientapi.ts`. Concurrent branches both regenerate → the generated
   files conflict even when the hand-edited hunks do not.

The hunk history confirms the concentration: Runs edits cluster at L1831–2340, Channels
at L1513–1656, Agents at L1327 — all packed into one 2374-line file with no structural
separation between streams.

**Not a file-specific bug — structural hot-file contention.** The fix is to stop
unrelated streams from sharing the same text regions.

## Feasibility — why a split is safe

Both command-discovery paths are **pure reflection over method sets**, never source parsing:

- `wshrpc.GenerateWshCommandDeclMap()` (`wshrpcmeta.go`): `reflect.TypeOf((*WshRpcInterface)(nil)).Elem()`
  then iterates `NumMethod()`. Consumed by codegen (`cmd/generatego`, `cmd/generatets`) and
  by `pkg/tsgen`.
- `wshrpc.MakeMethodMapForImpl(impl, declMap)` (`wshrpcmeta.go`): reflects `reflect.TypeOf(impl)`
  (`WshServer`) and its `NumMethod()`. This is the runtime dispatch binding.

Go reflection (a) includes a type's methods regardless of which **file** in the package
defines them, and (b) returns interface method sets — including embedded interfaces —
flattened and sorted by name. Therefore moving handler methods into sibling files in the
same package changes nothing on the wire and produces **byte-identical generated output**.

Precedent already exists in the package: `resolvers.go`, `sessiongroup.go`, `transcript.go`,
`keyedmutex.go`, `wshserverutil.go` are domain-split files with methods/helpers peeled out
of the main file.

## Scope (decided)

**Impl-only.** Split `wshserver.go` handler methods into per-domain files. Leave
`wshrpctypes.go` intact for now (its interface/struct split via embedded sub-interfaces is
also reflection-safe but is a separate, larger change — deferred, not needed to relieve the
biggest surface). This kills collision surface #1 (imports) entirely and #2's impl half,
which is the bulk of the pain, at near-zero risk.

## Design — file map

Move-only. Each method plus its domain-private helpers/vars/consts moves verbatim to a new
`wshserver_<domain>.go` file in package `wshserver`. `goimports` redistributes the import
block per file (this dissolves the import-block collision surface). No signature, body, or
logic change.

| File | Domain |
|---|---|
| `wshserver.go` (core, stays) | struct/impl var; `Test*`, `Message`, `StreamTest`; `Get/SetMeta`, `Get/SetRTInfo`, `ResolveIds`, `WaitForRoute`, `UpdateWorkspaceTabIds`; `Event*`; config (`SetConfig`, `SetConnectionsConfig`, `GetFullConfig`, `GetWaveAIModeConfig`); `GetJwtPublicKey`; `WaveInfo`, `MacOSVersion`; telemetry (`RecordTEvent`, `WshActivity`); vars (`Get/GetAll/SetVar`, `PathCommand`); suggestions/badges (`FetchSuggestions`, `DisposeSuggestions`, `GetAllBadges`); `WaveAIGetToolDiff` |
| `wshserver_blocks.go` | `Create/Delete Block/SubBlock`, `Controller*`, `BlockInfo`, `DebugTerm`, `BlocksList`, `WorkspaceList` |
| `wshserver_files.go` | `File*`, `WriteTempFile`, `WaveFileReadStream`, `waveFileToWaveFileInfo` |
| `wshserver_conn.go` | `Conn*`, `Wsl*`, `FindGitBash`, `InvalidWslDistroNames` |
| `wshserver_projects.go` | `CreateProject`, `DeleteProject`, `CreateWorktree`, `ListBranches`, `Git*` |
| `wshserver_agents.go` | `GetSessionGroup`, `GetAgentTranscript`, `GetSubagents`, `GetRecentSessions`, `GetSessionsActivity`, `GetTranscript*`, `StreamAgentTranscript`, `GetUsageStats`, `GetCacheStatus`, `GetWindowTokens`, `SharpenTask` |
| `wshserver_memory.go` | `Memory*` |
| `wshserver_channels.go` | `*Channel*` incl. `SetChannelProfile` |
| `wshserver_runs.go` | `*Run*` + run helpers (`runSpawnLocks`, `spawnRunWorkers`, `stopWorkerORef`, `stopRunWorkers`, `resolveRunPlan`, `steerRunLead`, `applyRunAction`) |
| `wshserver_radar.go` | `*Radar*` |
| `wshserver_jarvis.go` | `Jarvis*`, `Consult*`, profile (`GetJarvisProfile`, `Get/SetGlobalProfile`) + helpers (`postConsultReply`, `postJarvisReply`, `consultTimeout`), `ListConsultRuntimes` |
| `wshserver_jobs.go` | `JobController*`, `JobCmdExited`, `BlockJobStatus` |
| `wshserver_secrets.go` | `GetSecrets*`, `SetSecrets` |
| `wshserver_ask.go` | `Ask`, `AnswerAgent`, `AgentAskClear`, `publishAgentAsk` |

Domain-private helper functions, package vars, and consts move to the file of the domain
that uses them (e.g. run helpers → `wshserver_runs.go`). Any helper used across domains
stays in `wshserver.go` (or an existing shared file such as `wshserverutil.go`).

## Verification (evidence before "done")

1. Move-only proof: `git diff` shows methods relocated, bodies unchanged.
2. **Generated output identical**: `task generate` then `git diff` on `wshclient.go` and
   `frontend/app/store/wshclientapi.ts` must be **empty**.
3. `task build:backend` compiles.
4. `go test ./pkg/wshrpc/...` passes (package tests: `wshserver_run_test.go`,
   `projects_test.go`, `sessiongroup_test.go`, `transcript_test.go`, etc.).

## Coordination

One atomic move-only commit in this isolated worktree, merged fast, to minimize the window
where the reorg collides with a parallel session editing `wshserver.go`.

## Follow-up: wshrpctypes.go split (DONE)

`wshrpctypes.go` was split the same reflection-safe way in a follow-up. The monolithic
`WshRpcInterface` (~170 inline methods) now embeds 14 per-domain sub-interfaces
(`CoreCommands`, `BlockCommands`, `RunCommands`, …) defined in `wshrpctypes_<domain>.go`,
alongside the 2 pre-existing embeds (`WshRpcFileInterface`, `WshRpcRemoteFileInterface`).
The `CommandXxxData` structs moved to the domain file of the command that references them.
The embedded-sub-interface pattern was already proven in this file (`wshrpctypes_file.go`),
so codegen was unaffected: `task generate` produced byte-identical output, 201/201
non-interface decls verified byte-identical, wshrpctypes.go dropped 1499→618 lines.

## Deferred (still not in scope)

- Generated-file merge strategy (surface #3) — e.g. `.gitattributes merge=union` or a
  regenerate-on-merge hook. Independent of the impl/interface splits; revisit if
  generated-file conflicts remain painful.
