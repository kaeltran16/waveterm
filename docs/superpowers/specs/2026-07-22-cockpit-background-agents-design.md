# Cockpit surfaces background Claude Code agents

- Date: 2026-07-22
- Status: Design — approved for planning
- Scope: single implementation plan

## Problem

The cockpit's live agent roster is *inferred* from Claude Code lifecycle hooks. `~/.claude`
hooks shell out to `wsh agent-hook`, which maps hook event names to a Wave-invented state
(`working`/`waiting`/`asking`/`idle`) and publishes an ephemeral `agent:status` wps event
**keyed by the Wave terminal block** it runs in. `wsh agent-hook` no-ops unless
`WAVETERM_BLOCKID` is set (`cmd/wsh/cmd/wshcmd-agenthook.go`).

Claude Code (v2.1.198+) made background/headless agents the default: `claude --bg`,
`/background`, `/fork`-to-background. A background agent has **no Wave terminal block**, so
the hook pipeline is structurally blind to it. As the background-agent workflow gets adopted,
the cockpit stops seeing exactly those agents.

## Goal

Surface active background Claude Code agents for the current project in the cockpit roster,
as an **additive** source alongside the existing hook pipeline. The hook/wps pipeline is not
modified.

## Non-goals (v1)

- No PR link (the `claude agents --json` listing carries no PR field).
- No token/model for background agents (not in the listing).
- No system-wide / cross-project view — current project only.
- No completed-agent history — active sessions only (no `--all`).
- No change to the hook pipeline, the `agent:ask` flow, or ask-in-place.

## Empirical grounding: `claude agents --json`

Captured on the dev machine, Claude Code v2.1.217. Two record shapes in the array:

```jsonc
// kind: "background"
{ "id": "7802f291", "sessionId": "7802f291-33c2-4c24-94d7-b7a029a3a526",
  "cwd": "C:\\Users\\kael02\\IdeaProjects\\waveterm", "kind": "background",
  "startedAt": 1782441963164, "name": "Determine next tab implementation",
  "state": "blocked" }

// kind: "interactive"
{ "pid": 28732, "sessionId": "c32f3bda-8ea6-47e1-a2fc-3f38ce03f18a",
  "cwd": "C:\\Users\\kael02\\IdeaProjects\\waveterm", "kind": "interactive",
  "startedAt": 1784691487376, "name": "waveterm-49", "status": "busy" }
```

Facts the design depends on:

- Identity is `sessionId` (UUID). Background carries a short `id` and a `state` field;
  interactive carries a `pid` and a `status` field — **different field names for the same
  concept**.
- Observed values: background `state` = `blocked`; interactive `status` = `busy`/`idle`.
  The full set is undocumented → the parser must default unknown/missing values.
- No PR, model, or token fields.
- The listing is **system-wide** (includes sessions in other projects and worktrees).
  `--cwd <path>` scopes by directory prefix; `--all` adds completed sessions (unused in v1).
- No event stream — the CLI is poll-only.

## Design

### 1. Backend command

New wshrpc command `GetBackgroundAgentsCommand` in
`pkg/wshrpc/wshserver/wshserver_agents.go` (sibling to `GetUsageStatsCommand`).

- Resolves the `claude` binary via PATH. If unresolved, return a typed error (do not panic);
  the frontend degrades to an empty lane. This is the same failure class as the historical
  "wsh not on PATH → empty cockpit cards" bug — a non-interactive backend env may lack PATH,
  so resolution and its failure must be explicit. A configurable binary path is **deferred**
  (YAGNI) until PATH resolution proves insufficient.
- Runs `claude agents --json --cwd <projectPath>` with a short timeout (default 5s; if it
  overruns, return last error, empty list).
- Parses stdout with a **pure, guarded parser** (see below) and returns
  `[]BackgroundAgentData`.

Request payload: `{ projectPath string }`. Response: `[]BackgroundAgentData`.
Command + payload types go in `pkg/wshrpc/wshrpctypes_agents.go`; `task generate` regenerates
`wshclientapi.ts` and the TS types afterward.

### 2. Data type

New Go type in `pkg/baseds/baseds.go` (mirrored to TS by codegen), normalized across both
record shapes:

```go
type BackgroundAgentData struct {
    SessionId string `json:"sessionid"`
    ShortId   string `json:"shortid,omitempty"` // background only
    Pid       int    `json:"pid,omitempty"`      // interactive only
    Cwd       string `json:"cwd"`
    Kind      string `json:"kind"`               // "background" | "interactive"
    Name      string `json:"name"`
    State     string `json:"state"`              // normalized from state|status
    StartedTs int64  `json:"startedts"`
}
```

### 3. Guarded parser (the risky glue — unit-tested in isolation)

A pure function `parseClaudeAgents([]byte) ([]BackgroundAgentData, error)`:

- Unmarshal into `[]map[string]json.RawMessage` (tolerate the two shapes without a rigid
  struct).
- For each element: read `sessionId`, `cwd`, `kind`, `name`, `startedAt`. Read state from
  `state` if present, else `status`. Default missing fields to zero values; never fail the
  whole batch on one bad element — skip the element and continue.
- Non-JSON or top-level-not-array input → return `(nil, error)`.
- Empty array → `([], nil)`.

### 4. Frontend store

New `frontend/app/view/agents/backgroundagentsstore.ts`, mirroring `usagestore.ts`:

- `backgroundAgentsAtom: BackgroundAgentData[]`.
- `loadBackgroundAgents(projectPath)` calls `RpcApi.GetBackgroundAgentsCommand`, guarded by a
  monotonic `loadSeq` (drop out-of-order responses), keeps last-good on failure, sets an
  error flag (`backgroundAgentsErrorAtom`).
- Poll every ~10s while the cockpit is visible; pause when hidden. (Background state changes,
  especially `blocked`/needs-input, want faster feedback than the 60s usage refresh, but a
  process spawn per poll caps the practical floor.)
- `projectPath` is the cockpit workspace's anchor project path (the primary repo root the
  workspace is centered on). `claude agents --cwd <path>` matches sessions started *under*
  that path (help: "Show only background sessions started under <path>"), so same-project
  worktrees are included automatically — no client-side prefix matching needed. The precise
  source atom for that path is a planning detail.

### 5. Roster merge

In `frontend/app/view/agents/liveagents.ts` (`liveAgentBaseAtom`):

- Fold `backgroundAgentsAtom` entries into `AgentVM[]` with `kind: "background"`.
- **Dedup by `sessionId`.** The frontend already carries `AgentVM.transcriptPath`
  (`agentsviewmodel.ts`); Claude transcripts are named `<sessionId>.jsonl`, so derive a
  hook-tracked agent's `sessionId` from the basename of its `transcriptPath` and drop any
  background entry whose `sessionId` matches an existing hook-tracked agent. No backend change
  is needed for dedup — it is a pure frontend derivation.
- Interactive entries from `claude agents --json` that are **not** already hook-tracked are
  **not** added in v1 (they are foreign terminals; the hook pipeline owns Wave terminal
  agents). Only `kind:"background"` entries enter the roster.

### 6. State mapping

Map Claude's states onto the roster's display state:

| Claude `state`/`status` | Roster display |
|---|---|
| `blocked`               | `needs-input` (new) |
| `busy`, `working`       | `working` |
| `idle`                  | `idle` |
| anything else / missing | `working` (conservative default) |

`needs-input` is a **new** frontend `AgentState` member (`agentsviewmodel.ts:6`), used only
for background agents — it fills the gap where the current model has no needs-input state
(closest today is `asking`, which specifically means a pending `AskUserQuestion` native
picker). Every `switch`/mapping over `AgentState` (notably `agentVMFromInput`) gets a
`needs-input` case rendered as a distinct badge.

### 7. Attach action

A background agent card exposes an **Attach** action → launches a new Wave terminal block
running `claude --resume <sessionId>` via the existing `launchAgent` path (reload +
`PendingLaunch` + surface atom). `--resume <sessionId>` is the confirmed primitive
(`claude --help`: `-r, --resume [value]  Resume a conversation by session ID`); there is
**no** `claude attach` subcommand — an earlier web claim of one was wrong, verified against
v2.1.217. Once resumed in a Wave terminal block, the hook pipeline begins reporting the
session and the `sessionId` dedup collapses the background entry and the new hook-tracked
agent into one. This is the actionable path for a `needs-input` background agent, since
ask-in-place cannot reach an agent with no PTY block.

**Validation required in implementation:** the behavior of `--resume` against a *still-running*
background worker (cleanly attach to the live worker vs. fork a replayed session) was not
exercised, to avoid disturbing real background sessions. If `--resume` cannot attach to a
running worker, v1 restricts Attach to parked/idle sessions; visibility — the core
deliverable — is unaffected either way.

## Data flow

```
claude agents --json --cwd <project>   (poll ~10s, backend shell-out)
      -> parseClaudeAgents (guarded)
      -> GetBackgroundAgentsCommand (wshrpc)
      -> backgroundagentsstore (loadSeq, keep-last-good)
      -> liveAgentBaseAtom merge + sessionId dedup
      -> roster render (kind:background, needs-input badge, Attach action)
```

Independent of the hook/wps pipeline; the two meet only at the dedup step.

## Error handling

- `claude` unresolved → typed error, empty lane, cockpit otherwise unaffected.
- Non-JSON / timeout / non-zero exit → error returned; store keeps last-good roster and sets
  the error flag. No crash.
- Windows path separators: `cwd` values use backslashes; `--cwd` matching and any project-path
  comparison must normalize separators before comparing (prior art: the radar channel
  path-separator gotcha).

## Testing

- **Go unit test** on `parseClaudeAgents`: both record shapes, missing `sessionId`, missing
  state field, `state` vs `status`, a malformed element among good ones, non-JSON, empty
  array. This is the risky glue, extracted pure per the "extract risky wiring, unit-test the
  pure part" convention.
- **Frontend unit test** on the merge/dedup in `liveagents` (pure function over the hook
  roster + background list): dedup by `sessionId` derived from `transcriptPath`, `kind`
  tagging, state mapping including `needs-input` and the unknown-state default.
- **CDP surface-smoke** that the agent surface renders with a background agent present (per
  the no-jsdom-render-tests convention).

## File-level change list

- `pkg/baseds/baseds.go` — add `BackgroundAgentData`.
- `pkg/wshrpc/wshrpctypes_agents.go` — add `GetBackgroundAgentsCommand` + payload types.
- `pkg/wshrpc/wshserver/wshserver_agents.go` — implement the command; add `parseClaudeAgents`
  and its test.
- `frontend/app/store/wshclientapi.ts` + generated TS types — via `task generate` (do not
  hand-edit).
- `frontend/app/view/agents/backgroundagentsstore.ts` — new poll store.
- `frontend/app/view/agents/liveagents.ts` — merge + dedup.
- `frontend/app/view/agents/agentsviewmodel.ts` — `needs-input` `AgentState` member +
  mapping.
- Agent card component — `needs-input` badge + Attach action.

## Future (not this plan)

- Draft-PR link on completed background agents (needs a second source; `gh` or session
  result).
- Token/model enrichment for background agents.
- System-wide / cross-project toggle and a completed-agents history section (`--all`).
