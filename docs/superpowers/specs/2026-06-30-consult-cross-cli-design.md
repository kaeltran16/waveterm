# One-shot consult: a blocking cross-CLI reply in Channels

Date: 2026-06-30
Scope: feature (one new streaming wshrpc command + a detect-installed command + a Channels composer gesture and
two message types). Spec only — hands off to writing-plans.
Related: `docs/orchestrator-roadmap.md` (step 2 — the documented fast-follow on Channels; also the future
Delegator's "review the combined diff" tool), the Channels tab (`2026-06-30-channels-tab-design.md`, the substrate
this layers onto — `consult-reply` is message type #5, deferred there), and the inspiration
`~/.codex/skills/1devtool-orchestrator/SKILL.md` (a reference contract, **not** a runtime dependency).

## Problem

Channels v1 gives you one verb with two targets: `@<runtime>` dispatches a **brand-new persistent worker**, `@<name>`
**steers** a live one. Both spawn or talk to a long-lived PTY agent. There is no way to get a **quick second opinion** —
"does this have a race condition?", "review this approach" — without spinning up a full persistent worker you then have
to babysit and tear down.

A **consult** fills that gap: a one-shot, headless invocation of a CLI agent (`claude -p`, `codex exec`, `agy -p`) that
runs to completion, streams its reply into the channel, and leaves no persistent process behind. It is the opposite
lifecycle from dispatch — fire-once, capture, done.

It is also a **future-manager tool**: the roadmap's Delegator fires a one-shot consult to a reviewer model as its
"review the combined diff" step. Building it as a backend command now means the human (via the composer) and the
headless manager (later) call the identical verb.

## Decisions (locked via brainstorming, 2026-06-30)

Settled interactively; recorded so the plan doesn't relitigate them.

- **Server-side Go exec.** The consult runs as a backend wshrpc command via `exec.CommandContext`, not in a frontend
  cmd-block. Decisive reason: exec-location determines *who can call it*. Server-side = both the composer and a future
  headless manager call the identical command with no UI. A frontend cmd-block consult structurally can't be a manager
  tool and would be rebuilt at the orchestrator phase. It also matches the consult's lifecycle (fire-once, capture,
  return) instead of bending the PTY/cmd-block machinery (built for long-lived interactive terminals) around a one-shot.
- **Our own native provider, not the 1devtool shim.** The roadmap rejects hard-coupling to the external
  `1devtool-agent.cmd` (a user-specific path, auto-managed by another app, "may be absent in headless/cron runs"). We
  mirror its proven *contract* (stdin prompt, timeout, cwd, detect-installed) natively for the runtimes we support.
- **`ask @runtime …` is the consult gesture.** Leading `@runtime` stays dispatch (Channels v1). A reserved leading
  `ask` keyword routes to consult. Chosen over a `@@runtime` sigil (less discoverable, easy to typo) and a composer
  mode-toggle (modal state a headless manager can't express — the gesture must round-trip through the pure
  `planMessage` router *and* be emittable as text by the manager). Reversible later; low stakes.
- **Streaming, not blocking.** The reply types in live (token-streaming over the wshrpc stream path), and is persisted
  as a `consult-reply` message on completion. The stream serves the human (live typing); the persisted reply serves
  durability (survives reload) and the headless manager (which may never drain the stream).
- **Context injection, always-on and capped.** The backend prepends a capped transcript of the channel's recent
  messages (v1: last ~20 messages or ~4 000 chars, whichever is smaller) to the prompt, server-side, so the consulted
  model "sees the room." The **question row displays only what you typed** — the injected context is invisible
  plumbing. (An opt-out — e.g. `ask! @runtime` — is a future refinement.)
- **Detect-installed.** A `ListConsultRuntimesCommand` probes which runtimes are actually installed (composer
  autocomplete offers only those; missing → an upfront hint instead of a silent failure).
- **Runtimes: claude, codex, antigravity.** All three have confirmed one-shot/print modes (verified 2026-06-30):
  - `claude` → `claude -p`
  - `codex` → `codex exec`
  - `antigravity` → **`agy -p`** (binary is `agy`, v1.0.12; `--print`/`--prompt` aliases; ships its own
    `--print-timeout`, default 5m). The binary is `agy`, *not* `antigravity` — the consult command map uses `agy`.
    (The FE's interactive `RUNTIME_CMD` was also wrong here — `antigravity` does not resolve on PATH; fixed to `agy`
    in `launch.ts` alongside this work.)
  gemini / opencode / amp / qwen / aider stay deferred (each needs its headless flag verified before inclusion).
- **Fan-out.** `ask @gemini @codex …` fires one consult per mentioned runtime in parallel — one question row, N reply
  rows. Nearly free at the composer level (`parseMentions` already returns `mentions[]`); the backend command stays
  single-runtime.

## Architecture / data flow

```
                          ┌────────────────────────── Channels surface ───────────────────────────────┐
  ask @codex "races?" ───▶│  composer → planMessage → { kind:"consult", runtimes:["codex"], text }      │
                          │       │                                                                     │
                          │       ├─ post ONE consult question row  (author "you", RefORef consult:<id>)│
                          │       │                                                                     │
                          │       └─ for each runtime: ConsultCommand{channelId, runtime, prompt, id} ──┼──▶ stream
                          │                                                                             │     │
                          │   ephemeral live row (keyed consult:<id>+runtime) ◀── ConsultChunk stream ──┼─────┘
                          │                                          │                                  │
                          │   persisted consult-reply row  ◀─────────┴── (posted on completion, same id)│
                          └──────────────────────────────────────────────────────────────────────────-┘
                                                  ▲ supersedes the ephemeral row (same consult:<id>)

  backend ConsultCommand:  resolve cwd from channel.projectPath
                           → build capped recent-history context + prompt
                           → exec.CommandContext(<runtime headless argv>, cwd, prompt via stdin, timeout)
                           → stream stdout chunks  ──▶ (FE live row)
                           → on exit: PostChannelMessage(consult-reply, author=runtime, RefORef=consult:<id>)
                           → close stream
```

The consult is a backend primitive the composer calls today and the future manager calls later — same command, no
new substrate. See `docs/orchestrator-roadmap.md`.

## Backend — verbs as commands (manager-ready seam)

Two new wshrpc commands.

- **`ConsultCommand(ctx, CommandConsultData) → chan RespOrErrorUnion[ConsultChunk]`** (streaming).
  `CommandConsultData{ChannelId, Runtime, Prompt, ConsultId}`. Resolves cwd from the channel's `ProjectPath`, builds the
  capped-context prompt (recent channel messages + the user's prompt), builds the runtime's headless argv from a
  hardcoded per-runtime map, runs it via `exec.CommandContext` with a timeout (default 120s; at or below `agy`'s 5m
  print-timeout), piping the prompt over **stdin** (mirrors the shim — never argv; avoids shell-quoting/leak issues;
  per-runtime fallback to positional if a CLI does not read stdin in print mode). Streams stdout as `ConsultChunk`s for
  live display; on completion posts a persisted `consult-reply` `ChannelMessage` (author = runtime, `RefORef =
  consult:<ConsultId>`, text = full captured output) via the existing `PostChannelMessage` + `wcore.SendWaveObjUpdate`
  path, then closes the stream. This *is* the Delegator's review tool.
  - `ConsultChunk{Text string}` (the streamed delta). Errors flow through `RespOrErrorUnion`'s error arm.

- **`ListConsultRuntimesCommand(ctx) → CommandListConsultRuntimesRtnData{ Runtimes []ConsultRuntimeInfo }`**.
  `ConsultRuntimeInfo{Runtime, Installed, Version}`. Probes each known runtime (claude/codex/antigravity) with
  `exec.LookPath` (+ best-effort `<cmd> --version`). Drives composer autocomplete and the "not installed" hint.

**Per-runtime headless map** (Go, mirrors the FE `RUNTIME_CMD` pattern; hardcoded, not config-driven — YAGNI until a
fourth runtime needs it):

| Runtime | Binary | Headless argv | Prompt delivery |
|---|---|---|---|
| `claude` | `claude` | `-p` | stdin (verify; else positional) |
| `codex` | `codex` | `exec` | stdin (verify; else positional) |
| `antigravity` | `agy` | `-p` | stdin (verify; else positional) |

**No `ChannelMessage` struct change.** The consult reuses the Channels-v1 `ChannelMessage` as-is: two new `Kind`
values (`consult`, `consult-reply`) and a `RefORef` convention (`consult:<ConsultId>`) tie the question, the live
stream, and the persisted reply together. This keeps the consult off the in-flight Channels work's toes (see
Dependencies).

## Frontend

1. **`channelmessages.ts`** — extend the pure `planMessage`: a leading reserved `ask` keyword routes to
   `{ kind:"consult", runtimes: string[], text }` (runtimes = the `@mention`s after `ask`, filtered to known runtimes).
   Leading `@runtime` → dispatch, `@name` → steer, else → post (unchanged). Pure, unit-tested.
2. **`channelactions.ts`** — a `consult` branch in `sendChannelMessage`: generate a `consultId` (uuid), post one
   `consult` question row (author "you", `RefORef = consult:<id>`, text = the typed prompt), then fire one streaming
   `ConsultCommand` per runtime in parallel. Accumulate each stream's chunks into ephemeral live state keyed by
   `consultId + runtime`.
3. **`channelsstore.ts`** — ephemeral consult-stream state (a map `consultId+runtime → accumulated text + status`),
   cleared when the persisted `consult-reply` with the matching `consultId` arrives via the WOS update path.
4. **`channelssurface.tsx`** — row renderers for `consult` (the question) and `consult-reply` (the answer, rendered as
   markdown). While streaming, render the ephemeral live row; when the persisted reply (same `consultId`) arrives it
   supersedes the ephemeral row seamlessly (the persisted text equals the final streamed text). Composer autocomplete
   uses `ListConsultRuntimesCommand` to offer only installed runtimes and show a "not installed" hint. @theme tokens,
   no SCSS, no hardcoded colors.

## Components (isolation)

1. Backend consult exec + per-runtime map + streaming (Go) — the manager's future review tool; one job, unit-testable
   (the argv builder and the context-capping formatter are pure).
2. Backend detect-installed probe (Go) — pure-ish (`LookPath` + version), independent of consult.
3. `planMessage` consult branch (TS) — pure routing, no React/RPC.
4. Consult send + ephemeral stream state (TS) — impure; calls the verb command, accumulates chunks.
5. Consult row renderers + autocomplete wiring (TSX) — view only.

## Error handling

- **CLI not installed** → the consult-reply row shows a clear "claude is not installed" error; autocomplete already
  hides uninstalled runtimes, so this is the belt-and-suspenders case (mirror, don't pre-validate — consistent with
  Channels/live-TUI posture).
- **Non-zero exit** → the reply row carries the captured stderr/exit info; the channel never breaks.
- **Timeout** → `context.WithTimeout` kills the process; the reply row notes the timeout (and any partial output
  streamed so far stays visible).
- **Unknown / unsupported runtime after `ask`** (e.g. `ask @terminal`, `ask @nobody`) → treated as a plain post with a
  hint; no consult fired.
- **Channel/cwd resolution failure** → error reply row, never an error screen.

## Deferred (noted, not built)

- **Opt-out of context injection** (`ask! @runtime` for prompt-only, no history). v1 is always-on capped.
- **More runtimes** — gemini / opencode / amp / qwen / aider. Each is one more map entry, but its headless flag must be
  verified first.
- **JSON envelope** — the shim's `--json` structured result (`status, output, exitCode, durationMs`). v1 returns
  streamed text + a persisted text reply; add when the manager needs the metadata.
- **Configurable timeout / history-cap** — hardcoded in v1 (120s / 20 msgs / 4 000 chars).
- **Consult against a live worker's session** (continue an existing conversation via `--continue`/`--conversation`) —
  v1 consults are stateless one-shots.

## Testing / verification

- Go: the per-runtime argv builder maps claude/codex/antigravity to the right binary + headless flag and rejects
  unsupported runtimes; the context-capping formatter truncates to the cap and preserves order; `ConsultCommand`
  resolves cwd from the channel and posts a `consult-reply` with `RefORef = consult:<id>` on completion;
  `ListConsultRuntimesCommand` reports installed/version (probe is mockable via `LookPath` indirection or a real
  smoke test against `agy --version`).
- vitest: `planMessage` routes `ask @codex …` → consult, `ask @c1 @c2 …` → consult with two runtimes, `ask @nobody …`
  → post-with-hint, and leaves dispatch/steer/post unchanged; the consult send fires one command per runtime and posts
  one question row; the ephemeral-row → persisted-row supersession keys correctly on `consultId`.
- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline has 3 pre-existing
  `api.test.ts` errors).
- CDP (live dev app): in a project-bound channel, `ask @claude does this repo have tests?` streams a reply live into a
  `consult-reply` row, which persists across a reload; `ask @codex @claude review X` shows one question and two reply
  rows filling in parallel; `ask @<uninstalled>` shows the not-installed hint; a forced timeout/non-zero exit renders
  an error reply row without breaking the channel.

## Dependencies / coordination

- **Builds on Channels v1** (in flight): requires the `Channel` waveobj, `ChannelMessage`, `PostChannelMessage` +
  `wcore.SendWaveObjUpdate`, `channelsstore.ts`, `channelactions.ts`, `channelmessages.ts`, and `channelssurface.tsx`.
  This spec adds to those files; it must land **after** Channels v1 merges. It introduces **no `ChannelMessage` struct
  change** (new `Kind` values + a `RefORef` convention only), so it does not conflict with the Channels schema.
- **Per the user's git workflow:** fold this spec into the consult feature commit series; get explicit approval before
  any push.

## Implementation outline (writing-plans will expand)

1. Per-runtime headless map + pure argv builder + pure context-capping formatter (Go) + unit tests.
2. `ConsultCommand` (streaming exec, cwd from channel, post persisted `consult-reply` on completion) +
   `ListConsultRuntimesCommand` (detect-installed); `task generate`.
3. `planMessage` consult branch (TS) + vitest.
4. Consult send + ephemeral stream state in `channelactions.ts` / `channelsstore.ts`.
5. `consult` / `consult-reply` row renderers + autocomplete gating in `channelssurface.tsx`.
6. Tests + CDP verify the `ask @runtime` → stream → persist → fan-out loop end-to-end.
