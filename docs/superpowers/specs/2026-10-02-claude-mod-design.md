# Arc Claude mod: usage and ask through Claude Code function hooks

Date: 2026-10-02. Status: approved direction, not started.

## Why

Arc talks to Claude Code through settings `command` hooks and a `statusLine` wrapper, each one a
fresh `wsh` process fed a JSON envelope. pi gets in-process extensions (`pi/extensions/*`) instead.
Claude Code 2.1.287 ships function-hook plugins ("mods"): a TypeScript module loaded into the
session, with typed events and an engine interface `$` (`$.process`, `$.fs`, `$.env`, `$.tool`, ...).

Two things Arc does for Claude are workarounds that a mod removes:

1. **Usage rides the statusLine.** `docs/agents/usage-reporting.md`: Claude delivers context,
   rate-limit and cost numbers only to the `statusLine` command, so `install-agent-hooks` wraps the
   user's status line in `wsh statusline --inner=<b64>`. The mod's `session.measure` event carries
   the same numbers, so the wrapper can go and the status line is the user's again.
2. **Claude asks are answered by typing into the terminal.** A cockpit answer to a Claude
   `AskUserQuestion` is delivered by `pkg/agentask/deliver.go` as arrow/enter keystrokes into the
   native picker, one PTY write per key with `KeystrokeDelay`, then `awaitClear` to confirm it landed.
   The mod can answer the tool call itself: block on `wsh ask --wait`, the waiter path pi already
   uses, and return the answers as the tool's result. No keystrokes.

## Probe evidence (2026-10-02)

A throwaway mod (`.superpowers/probes/claude-mods/arcprobe`, gitignored) under Claude Code 2.1.287:

| Capability | Result |
|---|---|
| `claude -p --plugin-dir <dir>` loads it, no enable prompt | yes |
| interactive `claude --plugin-dir <dir>` loads it | yes (log shows session.start and hooks firing) |
| `tool.call` on `AskUserQuestion` returns `{ result: { questions, answers } }` | yes: the model received the hook's answer, interactive session |
| `session.measure` | fires at start and on change: `context { tokens, window, percent }`, `rateLimits [{ kind: five_hour\|seven_day, percentUsed, resetsAt (ISO) }]`, `cost { usd }` |
| `$.process.run([wsh, 'version'])` | works; ~40 ms per call (a bash spawn of the same: ~60 ms) |
| `$.env.get` | reads the process environment |
| `$.tool.register`, `prompt.compose` | work (not used in this design; see Out of scope) |

`AskUserQuestion` is not offered under `claude -p`, so headless runs cannot exercise the ask path.

## Design

### Source, build, install

- **Source:** `claude/arc-mod/` (beside `pi/`): `.claude-plugin/plugin.json`, `hooks/hooks.json`,
  `hooks/register.ts`, and a pure `hooks/arc-core.ts` holding the mapping logic, tested by vitest
  (`arc-core.test.ts`), the same split as `pi/extensions/*-core.ts`.
- **Embed:** a `sync:claudemod` task, run wherever `sync:piartifacts` runs, copies the files into
  `cmd/wsh/cmd/claude-mod-*` for `go:embed`. Edit `claude/`, never the copies.
- **Install:** `wsh install-agent-hooks` writes the mod to `~/.arc/claude-mod/` (fixed, beside
  `~/.arc/bin/`), substituting `__WSH_PATH__` with the stable wsh path as the pi installers do.
- **Load:** the same command merges `~/.arc/claude-mod` into `env.CLAUDE_CODE_PLUGIN_DIRS` in
  `~/.claude/settings.json`. That variable is read from the user settings' `env` block and loads each
  folder exactly as `--plugin-dir`, so every Claude launch is covered (cockpit agents, run workers,
  consults, a terminal the user opened) with no change at any launch site. The merge keeps the
  user's own entries (platform path-list separator) and is idempotent. Mod files are rewritten only
  when their bytes differ: interactive sessions watch plugin folders and reload on a write.
- **Inert outside Arc:** `session.start` reads `WAVETERM_BLOCKID` and `WAVETERM_JWT`; without both,
  every hook passes straight to `next(e)`. The mod registers no tool and adds no prompt text.

### Usage (`session.measure`)

The hook maps the measurement to `wsh agentstatus --usage` flags and runs it with `$.process.run`,
awaited, then returns `next(e)`:

- `--context-pct` from `context.percent` (the same value as the statusLine's `used_percentage`),
  `--context-max` from `window`, `--cost-usd` from `cost.usd` (0 when absent, as the statusLine sent).
- `--five-hour-pct/--five-hour-reset` and `--week-pct/--week-reset` from `rateLimits` by `kind`,
  `resetsAt` converted to epoch seconds. Absent kinds send no flag (API-key sessions have none).
- No `context.percent` yet: report nothing, as `parseStatusLineUsage` does without
  `used_percentage`.
- A failed `wsh` call is logged with `$.ui.log(..., { to: "debug" })` and dropped; the next
  measurement self-heals, as a dropped statusLine publish does today.

### Retiring the statusLine wrapper

Once the mod reports usage, `mergeStatusLine` stops wrapping and unwraps an existing wrapper with
`recoverInner`, restoring the user's original command (or removing `statusLine` if Arc added it with
no inner). This is gated on the installed Claude Code supporting mods: `install-agent-hooks` reads
`claude --version` and unwraps only at or above `2.1.287`, the tested build; below it the wrapper
stays. `wsh statusline` stays for that fallback. `configIsHealthy` expects the managed statusLine
today, so it takes the same gate (and checks the plugin-dirs entry), or every launch would rewrite
the settings file.

### Ask (`tool.call` on `AskUserQuestion`)

Decision (2026-10-02): **the cockpit card is the answer surface for Claude agents.** The hook
answers the call itself, so Claude's own dialog does not open. The API cannot cancel a dialog once
`next(e)` opened it, so the two cannot race.

1. **Questions the card cannot show go native.** Any question with `kind` `text` or `number`, or with
   no options, means the whole call goes to `next(e)` (the current path, unchanged).
2. **Wait on the card.** `$.process.spawn({ argv: [wsh, 'ask', '--wait'], input: <questions json> })`
   (spawn, not `run`: `run` caps at ten minutes; stdin, not `--questions-json`: option previews can
   outrun a Windows command line). `$.ui.status` shows a line pointing at the Arc
   card while it waits, cleared when it ends. `next.signal` (an Esc interrupt) ends the spawn loop,
   which kills the child; the server's waiter cancel cleans the card up
   (`TestAskCommandWaitCancelCleansUp`).
3. **Map the reply.** `wsh` prints `{ answers: AgentAnswerItem[], cancelled }`. Answers are in
   question order: `selectedindexes` become the option labels, comma-joined for multi-select;
   `text` (the "Other" answer) is used verbatim. The hook returns
   `{ result: { questions: e.questions, answers: { [question]: answer } } }`.
4. **Cancelled** (dismissed in the cockpit): `{ deny: "The user dismissed the question." }`.
5. **Failure** (wsh cannot start, RPC error, or its 30-minute `askWaitTimeout`): clear the card
   with `wsh ask --clear`, then `next(e)`, so the question still reaches the user through the native
   dialog. This is error handling, not a second answer surface. An interrupt is not a failure: it
   clears the card and returns a deny, never opening the dialog.

The settings hooks for `AskUserQuestion` (`ask`, `ask --clear`) stay: they run beneath plugin
`tool.call` hooks, so they never fire when the mod answers, and they keep the keystroke path working
wherever the mod is not loaded. `pkg/agentask` keystroke injection stays for that fallback and for
pi.

### To verify in implementation (not assumed)

- Settings `PreToolUse` hooks do not fire for a call the mod answers. The probe shows the answer
  lands; it did not check the settings side. If `agent-hook`'s `Asking` state then never reaches the
  cockpit, check whether the pending-ask publish from `AskCommand` already covers it before adding
  anything.
- A dag child's ask still routes to its lead, and `wsh jarvis dag answer` resolves the waiter
  (`DeliverAnswer` resolves a waiter first, so it should).
- `CLAUDE_CODE_PLUGIN_DIRS` from the settings `env` block loads without the enable-hot-reloading
  prompt in an interactive session (the probe used `--plugin-dir`).
- `$.process.spawn` has no hard timeout for the caller (its type declares none).

## Out of scope

Each is a decision on the effort tracker, revived only on evidence:

- **`wave_*` tools for Claude** (`$.tool.register`, pi parity). Claude reaches the same actions through
  Bash, `wsh` and the cockpit skills; there is no recorded failure that native tools would fix.
- **Orchestration rules through `prompt.compose`** in place of the `SessionStart compact` →
  `wsh jarvis dag rules --inject` hook. The hook works; the move changes where the rules live (system
  prompt, not a user message).
- **Moving `agent-hook` status reporting into the mod.** It works, and the mod still spawns `wsh` per
  event (~40 ms vs ~60 ms), so speed is not a reason.
- **Panes, bands or other UI inside Claude.** The cockpit is the UI.

## Risks

- **Early-access API** ("may change between releases without notice"). Mitigations: the settings
  hooks stay as the fallback for ask; the statusLine unwrap is version-gated; `claude plugin validate`
  runs in CI-equivalent checks (see Testing).
- **A broken mod module** is skipped by the engine with a debug-log line, so Claude still works; the
  symptom is missing usage or a native dialog where a card was expected.

## Testing

- vitest on `arc-core.ts`: measurement to argv (float percent, ISO to epoch, missing kinds, no
  context), answer mapping (single, multi, Other text, cancelled), and the native-path predicate.
- `claude plugin validate claude/arc-mod` as part of the plan's Check line.
- Go: `install-agent-hooks` tests for the `CLAUDE_CODE_PLUGIN_DIRS` merge (user entries kept,
  idempotent, stale entry dropped) and the version-gated statusLine unwrap.
- Live, in the dev app: a Claude agent's usage strip updates with the status line unwrapped; an
  `AskUserQuestion` answered from the card reaches Claude with no keystrokes; Esc during the wait
  clears the card.

## Docs

`docs/agents/usage-reporting.md` (the data flow), `AGENTS.md` (`claude/` is a source dir like `pi/`),
`docs/open-issues.md` if anything above stays open.
