# opencode support — full parity design

**Date:** 2026-08-07
**Status:** design approved, no plan written yet
**Design source:** none — the cockpit's existing Claude Code / Codex integration is the template. opencode support mirrors it surface for surface.
**Supersedes:** nothing.

## Why

The cockpit drives a fleet of external coding agents — Claude Code (`claude`), Codex (`codex`), and Antigravity (`agy`) — across five surfaces: Launch/dispatch, the Channels `ask @runtime` consult, the Sessions (recent/resumable) list, the live agent roster, and the usage readouts. opencode (`opencode`, the CLI this document is being written from) is installed on this machine (v1.18.14) and produces no fewer than half the coding sessions in `~/.local/share/opencode`, yet none of it reaches the cockpit. The Ask surface silently lacks an `@opencode` runtime, no opencode session is resumable from the cockpit, and a running opencode agent reports nothing to the roster.

This design adds opencode to every surface, reusing the existing per-agent plumbing rather than inventing new machinery.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| Per-runtime launch catalog | `frontend/app/view/agents/launch.ts` — `Runtime` union, `RUNTIME_CMD`, `RUNTIME_FLAGS`, `composeStartupCommand`, `buildLaunchMeta`, `resumeArgsForClaude` | Shipped. One more runtime is one more entry in each map. |
| Channel runtime parsing | `channelmessages.ts` `RUNTIMES`, `composercommand.ts` `KNOWN_RUNTIMES` | Shipped. Arrays; adding `"opencode"` to both makes `@opencode` dispatch and `ask @opencode` consult live. |
| Consult backend | `pkg/consult` — `runtimeSpecs` map keyed by runtime, `Run`/`RunPty`, `ProbeInstalled`, `SupportedRuntimes` | Shipped. opencode gets one `RuntimeSpec` + one parse func. |
| Sessions scanner | `pkg/agentsessions` — `provider` struct, `scanProvider`, `claudeProvider`/`codexProvider`, `ExtractSession`, `ScanSessions` | Shipped. opencode gets a provider (same `provider` shape), its own storage root, and a `switch` arm. |
| Transcript projection | `frontend/app/view/agents/transcriptregistry.ts` — `PROJECTORS` map + `agentFromPath` + `projectorFor`; pure `transcriptprojection.ts` / `codextranscriptprojection.ts` | Shipped. The registry doc comment already names opencode as the intended next entry. |
| Live transcript streaming | `livetranscript.ts` + `StreamAgentTranscriptCommand` — streams a JSONL file, projects each chunk | Shipped and format-agnostic: the opencode projector consumes the same `string[]` line contract. |
| Live status reporter | `cmd/wsh/cmd/wshcmd-agenthook.go` — reads a Claude hook payload on stdin, publishes `agent:status` (`AgentStatusData{State, Detail, Agent, TranscriptPath, Model, Title, Ts}`) | Shipped. Needs an `--agent` flag so it can stamp `"opencode"` instead of the hardcoded `"claude"`. |
| Hook install | `cmd/wsh/cmd/wshcmd-installhooks.go` — writes the Claude hooks into `~/.claude` on every launch | Shipped. Gets a sibling step that writes the opencode plugin. |
| Resume-on-reopen | `frontend/app/view/agents/session-models/agentresumestore.ts` — bakes `--resume <id>` into a live agent's persisted `cmd:args` | Shipped and Claude-only; opencode gets the same shape via `-s <id>`. |
| Runtime chrome | `runtimemeta.ts` (`RuntimeMeta`), `cockpitrailmodel.ts` (`providerDot`/`providerLabel`), `agentsviewmodel.ts` (`PROVIDER_RANK`) | Shipped; each is a `Record`/rank that takes one more key. |
| Usage readout | `usagesurface.tsx` `PROVIDER_LABEL` | Shipped; opencode participates at best-effort level (see §5). |

opencode's on-disk data (verified on this machine, v1.18.14 / storage `v1.1.50` under `~/.local/share/opencode`):

- `storage/session/<projectID>/<sessionID>.json` — session info: `id`, `slug`, `projectID`, `directory`, `title`, `time.{created,updated}`, `summary.{additions,deletions,files}`.
- `storage/message/<sessionID>/<messageID>.json` — message meta: `id`, `sessionID`, `role`, `time.created`, `summary.title`, `agent`, `model.{providerID,modelID}`, `variant`.
- `storage/part/<messageID>/<partID>.json` — message parts, `type` ∈ `text` | `tool` | `reasoning`; assistant text parts carry `cost` and `tokens.{input,output,reasoning,cache}`.

CLI facts (verified): `opencode run [message..]` is headless one-shot; `-s/--session <id>` and `-c/--continue` resume; `--auto`, `--pure`, `--model provider/model` exist; `opencode stats` aggregates cost/tokens. **`opencode run --format json` output shape is unverified** — it is the one implementation checkpoint in §2.

## Resolved decisions

**1. The agent identity is the string `"opencode"`; the binary is `opencode`.** Same convention as `"claude"`/`"codex"`: the identity appears in `AgentStatusData.Agent`, `AgentVM.agent`, the `Runtime` union, projector registry keys, and provider label maps; the binary name is what `RUNTIME_CMD`/`runtimeSpecs.Bin` resolve. opencode is the only name that ever appears — no legacy alias to reconcile (contrast `antigravity`/`agy`).

**2. A launched opencode worker is a TUI session, exactly like claude/codex.** `buildLaunchMeta` passes the task as a single positional arg (`opencode "task"`), spawns a plain `cmd` block with `cmd:jwt:true`. opencode's TUI accepts a positional message, so no `-i`-style quirk (contrast `agy`, whose positional is ignored and needs `-i`).

**3. Resume-on-reopen extends to opencode via `-s <id>`.** The existing Claude machinery bakes `--resume <id>` into persisted `cmd:args` when "Remember flags" is on. opencode's equivalent resume flag is `-s/--session <id>` (`-c` resumes only the *last* session, which is wrong once the roster holds several). The session id is the shadow transcript's filename stem (decision 5), so the same `sessionIdFromTranscript` derivation works. The gate `shouldPersistClaudeResume` is renamed/generalized to include opencode; the block's `cmd` check accepts `"opencode"`. codex/antigravity remain restart-fresh.

**4. The live roster rides the opencode plugin system; the plugin never ships state it cannot stand behind.** opencode has no lifecycle-hook contract like Claude Code's `hook_event_name` JSON — its extension point is **plugins** (`~/.config/opencode/plugin/`). The plugin is the exact analog of the `~/.claude` hooks: an external artifact the app auto-installs, driven by opencode events, that no-ops unless it is inside a Wave block (`WAVETERM_BLOCKID` + JWT present). It must not throw when run by a bare `opencode` outside Wave — the same "a hook must never break the agent's turn" discipline `agentHookRun` already follows.

**5. The plugin writes a normalized JSONL shadow transcript; the cockpit streams that, not opencode's parts directory.** opencode's storage is a tree of small JSON files that are written per-part, so the existing `StreamAgentTranscriptCommand` (file-tail streaming) has nothing to tail. The plugin solves this by writing one JSON line per interesting event to a shadow file the FE streams unchanged. Location: `~/.local/share/opencode/waveterm/<sessionID>.jsonl` — inside opencode's own data root (which both plugin and backend can resolve from `$HOME`) but under a namespace opencode does not touch. The shadow filename *is* the session id (stem), so resume (decision 3) and gone-worker outcome derivation work from the path alone, matching how Claude's transcript path doubles as its resume key.

Shadow line schema (one JSON object per line):

```json
{"type":"session","id":"ses_...","ts":1750000000000}
{"type":"state","state":"working|idle|waiting","ts":1750000000000}
{"type":"user","text":"...","ts":1750000000000}
{"type":"assistant","text":"...","ts":1750000000000}
{"type":"tool","name":"bash","input":"...","ts":1750000000000}
```

`wsh agent-hook --agent opencode --shadow <path>` reads this tail for `Model`/`Title` derivation (reusing the existing `tailLines` reader on a record shape the new projector also consumes).

**6. Consult runs `opencode run --format json` and the parser matches whatever shape that actually is.** Checkpoint: capture the real output shape first (single JSON array vs JSONL event stream). A JSONL stream gets a `ParseLine` (real incremental streaming like claude/codex); a single JSON array is buffered and post-processed to the assistant text parts (same non-streaming behavior as claude/codex plain modes, still a clean persisted reply). If `--format json` proves unstable, fall back to default format (raw stdout, no streaming) — a valid consult either way. opencode takes no tier/model selection: tiers are a claude-only `--model` contract, and `--model provider/model` resolution is exactly the sort of per-provider opinion this design declines to add (same as codex).

**7. The Sessions surface reads opencode's native storage; it does not depend on the shadow.** A shadow exists only while a worker runs. The scanner walks `storage/session/<projectID>/ses_*.json`, derives the task from the first user text part and the model from message meta, sums tokens/cost from assistant parts (decision 8), and builds the same `SessionInfo` the claude/codex providers build. `resumeCmd` is `opencode -s <id>` (interactive resume, matching `claude --resume <id>`).

**8. Usage is best-effort and storage-derived: per-session tokens + cost.** opencode has no `statusLine` contract, so the live context-% bar and the Claude-plan gauges are unreproducible and out of scope. What opencode does record is `cost` and `tokens` on assistant parts, so `SessionInfo` gains a `CostUsd` field (it already has `TokensTotal`), both summed from parts by the opencode provider, and the sessions surface renders them for opencode rows. The account-wide Usage surface keeps its claude/codex daily aggregates; wiring opencode into `dailychart.ts` is deferred (see §11).

**9. The opencode projector is a new pure file + one registry entry; every other FE consumer is unchanged.** `projectorFor` already routes by explicit agent. `agentFromPath`'s fallback gains an `opencode` segment match — the shadow path is `~/.local/share/opencode/waveterm/…`, which contains `opencode` but **not** `.opencode` (the claude/codex checks match `~/.claude`/`~/.codex` by their dot-prefixed names; opencode needs the segment without the dot). It is checked after `.codex`, so a `.claude`/`.codex` path inside an opencode-adjacent string still wins on its own terms — the current ordering already handles this class. `projectorFor` returns the opencode projector only when the identity/path says opencode; unknown inputs still fall back to claude.

## 1. Launch / dispatch

`frontend/app/view/agents/launch.ts`:

- `Runtime` union → `"claude" | "codex" | "antigravity" | "opencode" | "terminal"`.
- `RUNTIME_CMD`: `opencode: "opencode"`.
- `RUNTIME_FLAGS.opencode` (boolean flags only, matching the catalog's shape):
  - `{ id: "auto", flag: "--auto", desc: "Auto-approve non-denied permissions (dangerous)" }`
  - `{ id: "pure", flag: "--pure", desc: "Run without external plugins" }`
  - `{ id: "continue", flag: "-c", desc: "Resume the last session" }`
- `buildLaunchMeta`: opencode takes the task positionally (decision 2); no special casing.
- New `resumeArgsForOpencode(sessionId, baseArgs): string[]` → `["-s", sessionId, ...kept]`, stripping a prior `-s`/`--session`/`-c` pair from `baseArgs` exactly as `resumeArgsForClaude` strips `--resume`/`--continue`.

`channelmessages.ts`: `RUNTIMES` → add `"opencode"`. `composercommand.ts`: `KNOWN_RUNTIMES` → add `"opencode"`. Both are pure and already tested; the tests gain the opencode cases.

`runtimemeta.ts`: a `RuntimeMeta` entry — `id: "opencode"`, `label: "opencode"`, `glyph: "◈"`, and `text/softBg/line` utilities `text-rt-opencode`, `bg-rt-opencode-soft`, `border-rt-opencode-line`. The `RuntimeMeta.id` union widens to include `"opencode"`. Tailwind tokens added to `frontend/tailwindsetup.css` beside the existing `--color-rt-claude`/`--color-rt-codex` block (a hue distinct from both; value settled in plan).

`agentresumestore.ts`: generalize `shouldPersistClaudeResume` to `shouldPersistResume(provider, rememberFlags)` accepting `"claude" | "opencode"`; `persistClaudeResume` picks `resumeArgsForClaude` vs `resumeArgsForOpencode` by provider, and the block `cmd` check accepts `"opencode"`. codex/antigravity still restart fresh.

## 2. Consult

`pkg/consult/consult.go`:

```go
"opencode": {Bin: "opencode", BaseArgs: []string{"run", "--format", "json"}, PromptViaStdin: false, ParseLine: opencodeParseLine},
```

- `PromptViaStdin: false` — `opencode run` takes the message as a positional (`[message..]`), appended by `startCmd` like claude/codex already do.
- `opencodeParseLine(line []byte) (string, bool)` — extracts assistant text from the verified event shape (decision 6). For a JSONL event stream: assistant text arrives as `message.part.updated` events whose `part.type == "text"` and whose `part.messageID` maps to an assistant message; for a single JSON array, a buffered post-process returns the concatenated assistant text parts. Implement after the shape is captured; the spec does not guess.
- `SupportedRuntimes()` → `[]string{"claude", "codex", "antigravity", "opencode"}`.
- `ProbeInstalled` picks up `opencode` automatically (it reads `runtimeSpecs[runtime].Bin`).
- Tiers: no `--model` (decision 6); `SpecForTier` already returns non-claude specs untouched.

## 3. Sessions surface

`pkg/agentsessions/agentsessions.go`:

- New `opencodeProvider(root)` with:
  - `root` = `filepath.Join(wavebase.GetHomeDir(), ".local", "share", "opencode", "storage", "session")` — opencode uses this path on Windows too (verified).
  - `matches`: any `ses_*.json` one directory below root (projectID subdirs).
  - `extract`: read the session info file for `directory` (→ `ProjectPath`/`ProjectName`), `title`, `time.{created,updated}`; walk `storage/message/<sessionID>/` for the first user `role` message (its first text part → `Task`) and the last assistant message's `model` (→ `Model`); walk `storage/part/<messageID>/` to build `TokensTotal` + `CostUsd` from assistant text parts (`cost`, `tokens`) and to seed events.
  - `resumeCmd`: `opencode -s <id>`.
  - `events`: a port of the FE opencode projector's lifecycle extraction, in Go, mirroring `extractClaudeEvents`/`extractCodexEvents`: first user text part → started; last assistant text part → finished; a tool part whose `tool.state` is error and whose tool is `bash` → errored; a `git commit` command → committed.
  - Skip `extract` when no user task exists (subagent-only / tool-only sessions), matching the claude/codex providers' `hasTask` gate.
- `ExtractSession` `switch` gains `case "opencode":`.
- `ScanSessions` providers list gains `opencodeProvider(...)`.
- `SessionInfo` gains `CostUsd float64`.
- The headless-self-exclusion in `scanProvider` (`headlessSlug`) is claude-specific; opencode's own consult runs (decision 6) are `opencode run` sessions recorded in the same storage, so they will appear. Accepted: a headless consult is a real session a user may want to resume, and excluding it would require opencode-specific detection the claude slug mechanism does not generalize to.

## 4. Live roster

Three pieces: the plugin, the `wsh` command, and the FE projector.

### The plugin — `plugins/opencode/wave-status.{ts,mjs}` (in-repo, installed to `~/.config/opencode/plugin/`)

Registered as an opencode plugin. On each relevant event it:

1. Derives state: assistant text part arriving → `working`; a `session.idle`/`session.error` event → `idle`; (waiting/permission states mapped as the plugin API exposes them — verified in plan).
2. Appends a shadow line to `~/.local/share/opencode/waveterm/<sessionID>.jsonl` per the decision-5 schema.
3. Spawns `wsh agent-hook --agent opencode --shadow <path>` detached (never awaiting it, never letting a failure reach the agent), with the ambient `WAVETERM_BLOCKID`/JWT.

It no-ops when `WAVETERM_BLOCKID` or the JWT is absent (decision 4). Installation: `wshcmd-installhooks.go` writes the plugin file (and any plugin config opencode's version needs to load it) beside the existing Claude hook install, idempotently. The plugin API shape (exact `setup(app)`/event names for this opencode version) is verified during implementation and recorded here.

### `wsh agent-hook` — `cmd/wsh/cmd/wshcmd-agenthook.go`

Two optional flags, defaults preserving today's behavior:

- `--agent <name>` — defaults to `"claude"`; stamps `AgentStatusData.Agent`.
- `--shadow <path>` — for opencode, the shadow path replaces the Claude `transcript_path` source for the `agent:transcript-path` meta stamp and for `Model`/`Title` derivation. When absent, behavior is unchanged.

`readLastModel`/`readLastTitle` already scan arbitrary JSONL records for `message.model`/`ai-title`; the shadow schema carries no `message` wrapper, so the plan adds a tiny shadow-aware variant (read `session`/`assistant`/`state` records) rather than forcing the shadow to mimic Claude's record shape.

The plugin calls this path instead of emitting `agent:status` directly because the wsh command already owns oref resolution, JWT handling, and the `agent:transcript-path` meta stamp — duplicating those in the plugin would split one concern across two languages.

### FE projector — `frontend/app/view/agents/opencodetranscriptprojection.ts` (new, pure, tested)

- `project(lines: string[]): AgentEntry[]` — maps shadow lines to entries: `assistant` → said, `tool` → did (bash command summarized like claude's Bash detail), `user` → asked/head, `state` → status transitions.
- `extractTitle(lines)` — the `session` record's `title` if the plugin carried it, else the first user text.
- `extractTasks(lines)` — optional; opencode has no `TodoWrite`-equivalent part type in the verified storage, so omit rather than fabricate (the `TranscriptProjector.extractTasks` is already optional).
- `transcriptregistry.ts`: `PROJECTORS.opencode = {...}`; `agentFromPath` gains the `opencode` segment match (decision 9).

Provider surfacing (one-line map/rank additions): `agentsviewmodel.ts` `PROVIDER_RANK` (`opencode: 2`); `cockpitrailmodel.ts` `PROVIDER_LABEL`/`PROVIDER_DOT`; `usagesurface.tsx` `PROVIDER_LABEL` (decision 8 keeps this cosmetic).

## 5. Usage (best-effort)

- `SessionInfo.CostUsd` (decision 8) populated by the opencode provider.
- Sessions surface renders tokens/cost for opencode rows where it already renders `TokensTotal`.
- No live context-% bar, no plan gauges, no `dailychart.ts` wiring (see §11).

## 6. Wiring — files not named in sections 1–5

| File | Change |
|---|---|
| `frontend/tailwindsetup.css` | `--color-rt-opencode{,-soft,-line}` tokens. |
| `frontend/app/view/agents/session-models/agentresumestore.ts` | Provider-generalized resume gate + opencode arg builder. |
| `cmd/wsh/cmd/wshcmd-installhooks.go` | Idempotent opencode plugin install alongside the Claude hooks. |
| `docs/agents/channels-reference.md` | `SupportedRuntimes` list, consult transport notes, and the opencode gotchas (positional prompt, shadow path, plugin install). |

No `task generate`: no wshrpc/waveobj/wconfig type changes anywhere in this design.

## 7. Failure modes

| Situation | What the user sees |
|---|---|
| `opencode` binary absent | Launch still opens a block (bash `opencode` error inside it); consult probe returns not-installed and `@opencode` stays unoffered; sessions list simply has no opencode rows; plugin no-ops. Same degradation as a machine without `codex`. |
| opencode version's storage format drifts | The scanner/projector parse tolerantly (like `bgagents.Parse`); a session that fails to extract is skipped, never fatal. |
| `opencode run --format json` shape differs from the parser | Consult returns raw JSON as the reply (visible, debuggable) rather than failing the channel. The plan's checkpoint captures the real shape first. |
| Plugin runs outside Wave | Immediate no-op, agent turn unaffected (decision 4). |
| Plugin's `wsh` spawn fails (JWT expired, wavesrv gone) | Only the roster row lags; the agent is unaffected. Hook-debug-log path (decision 4) records it. |
| Agent exits; shadow exists | Gone-worker outcome derivation reads the shadow like it reads Claude transcripts; `SessionInfo` also recovers from native storage via the scanner. |
| Plugin disabled / `--pure` launch | No live row; sessions scanner still finds the finished session from native storage. |

## 8. Testing

**Vitest, beside each pure module (repo convention — no jsdom render tests).**

- `launch.test.ts` — opencode `RUNTIME_CMD`/flags catalog; task passes positionally through `buildLaunchMeta`; `resumeArgsForOpencode` strips a prior `-s`/`-c` and never stacks resume directives.
- `channelmessages.test.ts` + `composercommand.test.ts` — `@opencode` dispatch, `ask @opencode` consult, unknown-word body fallthrough.
- `opencodetranscriptprojection.test.ts` — assistant/user/tool/state lines → entries; no task list; title from session/user records; empty input.
- `transcriptregistry.test.ts` — explicit `agent: "opencode"` routes to the opencode projector; a shadow path with an `opencode` segment falls back correctly; a `.codex` path still wins over an opencode-adjacent path string.
- `runtimemeta.test.ts` / `cockpitrailmodel.test.ts` — opencode label/dot/id.

**Go.**

- `pkg/consult/consult_test.go` — `SpecFor("opencode")` bin/baseargs; `SupportedRuntimes` includes opencode; `opencodeParseLine` on fixture events of the verified shape.
- `pkg/agentsessions/agentsessions_test.go` — the opencode provider on a fixture tree: session info → title/project; first user part → task; assistant parts → tokens + cost; resume command; tool-error → failed; no-user-task → skipped; `ExtractSession("opencode", path)`.

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/consult/... ./pkg/agentsessions/...
```

**Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (bare `npx tsc` stack-overflows; `task check:ts` is unusable). Baseline is clean, so any error belongs to this work.

**Manual verification** against the live dev app over CDP (`task verify:ui` / `scripts/cdp-shot.mjs`): a launched opencode worker reports to the roster with a live narration; `ask @opencode` streams a consult reply; the Sessions surface lists an opencode session and resumes it.

## 9. Suggested phasing

Each stage independently verifiable; earlier stages do not depend on later ones:

1. **Launch + chrome** (sections 1, 6-partial): `Runtime`, catalogs, `runtimemeta`, tailwind tokens, channel parsing, resume-generalization. Verified by Vitest + launching an opencode worker in the dev app.
2. **Consult** (section 2): capture `--format json` shape, add the spec + parser. Verified by Go tests + a real `ask @opencode`.
3. **Sessions** (section 3): Go provider + `CostUsd`, FE projector for native storage rendering. Verified by Go tests + the sessions surface against this machine's real opencode data.
4. **Live roster** (sections 4): plugin, `wsh agent-hook --agent/--shadow`, shadow projector, install step. Verified by launching a worker and watching the roster + live narration, and by the CDP `surface-smoke` scenario (unchanged).

## 10. Explicitly out of scope

The account-wide Usage surface (`dailychart.ts`, `windowtokenstore` aggregates) — opencode stays out until a cost signal beyond per-session sums exists. Live context-% / plan gauges (no `statusLine` contract). `bgagents` background-lane parity (opencode has no `agents --json`; running agents surface via the plugin instead). Permissions-mode round-trips (`--auto` in the flag catalog is a launch choice, not a runtime control). Sending a controller directive into an opencode worker via `ControllerInputCommand` — opencode's TUI is a full-screen app and the steering contract is claude-specific; documented, not built. Anything touching opencode's ACP server (`opencode acp`, `opencode serve`).
