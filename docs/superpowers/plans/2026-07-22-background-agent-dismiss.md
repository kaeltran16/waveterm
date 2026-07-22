# Background-agent dismiss action

## Context

The cockpit Background strip (`backgroundagentsstrip.tsx`) mirrors `claude agents --json`. When
the Claude bg daemon force-exits on idle without finalizing a job's `state.json`, the record is
left frozen at its last `blocked` checkpoint and re-appears forever as a phantom "needs input"
agent (see memory `stale-background-jobs-gotcha`). Today Wave's only per-row action is **Attach**;
there is no way to clear a stale/finished background agent short of manually deleting
`~/.claude/jobs/<id>/`.

This adds a durable **Dismiss** action: a per-row control wired to a new wshrpc command that
removes the on-disk job record at the source (transcripts under `~/.claude/projects/**` are
untouched, so `claude --resume <id>` / a fresh Attach still work).

## Design decisions

- **Remove the job record, don't filter in the UI.** Filtering by age/state in the frontend is a
  band-aid — the stale record still shows in `claude agents`, Codex, etc. Removing the source dir
  is the single-source-of-truth fix.
- **Match by sessionId via directory scan, not by assuming the dir name.** `Remove` enumerates
  `~/.claude/jobs/*/state.json` and deletes the dir whose `sessionId` matches. This avoids guessing
  the short-id dir-naming convention, inherently confines deletion to real job dirs (no path
  traversal from the caller's input), and only ever removes a directory we enumerated ourselves.
- **Idempotent.** Not-found → nil (the goal state — record gone — is already true). Prevents a
  benign double-click / already-cleaned race from surfacing an error.
- **No liveness guard.** A background agent shown in Wave is parked (idle/blocked); dismiss is a
  deliberate per-row user action and transcripts are preserved, so the worst case (dismissing a
  job with a live daemon worker) is a minor daemon inconsistency until restart, not data loss.
  A state/roster guard would be fragile against the undocumented, versioned job format — YAGNI.
- **`~/.claude` resolution matches existing code** (`os.UserHomeDir()` + `.claude/jobs`); no
  `CLAUDE_CONFIG_DIR` support since `agentsessions`/`usagestats` don't use it either.

## Tasks

1. **`pkg/bgagents/bgagents.go` — `Remove(sessionId string) error`** + `bgagents_test.go`.
   Scans the jobs dir, matches `state.json.sessionId`, `os.RemoveAll` the dir; nil if not found.
   Tests: removes the matching dir; leaves siblings; no-op on unknown id; rejects empty id.

2. **`pkg/wshrpc/wshrpctypes_agents.go`** — add to `AgentCommands`:
   `RemoveBackgroundAgentCommand(ctx, data CommandRemoveBackgroundAgentData) error` +
   `type CommandRemoveBackgroundAgentData struct { SessionId string \`json:"sessionid"\` }`.

3. **`pkg/wshrpc/wshserver/wshserver_agents.go`** — implement: validate `SessionId != ""`, call
   `bgagents.Remove`, wrap error.

4. **`task generate`** — regenerates `wshclient.go`, `wshclientapi.ts`, `gotypes.d.ts`.

5. **Frontend**:
   - `backgroundagentsstore.ts` — `dismissBackgroundAgent(sessionId)`: call
     `RpcApi.RemoveBackgroundAgentCommand`, optimistically drop it from `backgroundAgentsAtom`,
     then `loadBackgroundAgents()` to reconcile.
   - `backgroundagentsstrip.tsx` — add a subtle "×" dismiss button per row (before Attach),
     `title="Dismiss (remove this background session)"`.

## Verification

- `go test ./pkg/bgagents/` (new tests pass).
- `go build ./...` (backend compiles with new command).
- `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (FE typechecks; generated
  client/types present).
- Confirm generated files changed: `wshclientapi.ts` gains `RemoveBackgroundAgentCommand`,
  `gotypes.d.ts` gains `CommandRemoveBackgroundAgentData`.
- Visual (deferred): requires a background agent present; strip currently empty after the
  2026-07-22 stale-job cleanup.
