# Agent usage reporting — context %, cost, plan limits

The Agents tab shows two usage readouts:

- **Per-agent context bar** (focus view): `ctx [▓▓▓░] 84k / 200k · 42% · $1.23` — each
  agent's own context-window fill, token estimate, and session cost.
- **Account-wide "Plan usage" strip** (list header): the Claude.ai Pro/Max 5-hour
  ("Session") and 7-day ("This week") rate-limit gauges. These are account-global —
  every agent reports the same numbers, so the view shows the freshest one.

Both are driven by a single `AgentUsage` snapshot per block. If neither readout
appears, **no usage data is reaching Wave** — see the data flow below.

## Why usage rides the statusLine, not the hook reporter

Agent **state** (working / waiting / idle) and the **subagent tree** are driven by
`wsh agent-hook` (in-repo, `cmd/wsh/cmd/wshcmd-agenthook.go`), wired into Claude Code
lifecycle hooks (`PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SubagentStop`,
`UserPromptSubmit`) and auto-installed by the Arc app. Those hook payloads **do not
carry usage numbers**.

Claude Code delivers context/rate-limit/cost numbers to exactly one place: the
**`statusLine` command's** stdin JSON. So the usage bridge has to live there — there
is no hook that sees this data. This is the gap that originally left the display dark:
the Wave half (the `wsh agentstatus --usage` command and the FE rendering) shipped in
`fa195bf1`, but nothing ever *called* `--usage`. The statusLine script computed the
numbers only to print them to the terminal.

## Data flow

```
Claude Code statusLine JSON  (stdin: context_window, rate_limits, cost)
        │
        ▼  ~/.claude/statusline-command.sh   (the bridge — see Setup)
   wsh agentstatus --usage --context-pct … --five-hour-pct … --week-pct …
        │
        ▼  cmd/wsh/cmd/wshcmd-agentstatus.go : publishUsageDelta()
   publishes an `agent:status` WaveEvent  { usage: AgentUsage }   (Persist:0, ephemeral)
        │
        ▼  frontend/app/tab/sessionsidebar/agentstatusstore.ts : setupAgentStatusSubscription()
   data.usage != null  →  globalStore.set(getAgentUsageAtom(oref), data.usage)
        │
        ▼  frontend/app/view/agents/liveagents.ts : liveAgentBaseAtom
   vm.usage = get(getAgentUsageAtom(row.termBlockOref))
        │
        ├─▶ focusview.tsx       — renders the context bar iff usage.contextpct != null
        └─▶ agents.tsx PlanGauge — renders the plan strip iff usage.fivehourpct/weekpct != null
```

`Persist:0` (ephemeral) matters: the usage event is **not retained or replayed** to a
late subscriber (the retained `Persist:1` state event for the same scope must stay the
one replayed). The usage atom is populated only by events that arrive *after* the
sidebar subscription is live — which it always is — and the value sticks in the atom
for the rest of the app's lifetime. The statusLine re-fires constantly while an agent
is active, so a fresh value lands within seconds; a dropped publish self-heals on the
next render.

## statusLine JSON → wsh flag mapping

Confirmed against the Claude Code statusLine schema
(<https://code.claude.com/docs/en/statusline.md>). Resets are **Unix epoch seconds**
(what the FE `formatReset` expects). Rate-limit fields are **subscriber-only** (absent
for API-key auth) — omit them rather than send `0`, or the gauge shows a misleading 0%.

| statusLine field                          | wsh flag            | AgentUsage field | notes                          |
| ----------------------------------------- | ------------------- | ---------------- | ------------------------------ |
| `.context_window.used_percentage`         | `--context-pct`     | `contextpct`     | input-only %; gates the bar    |
| `.context_window.context_window_size`     | `--context-max`     | `contextmax`     | 200000 or 1000000; FE falls back to 200000 |
| `.cost.total_cost_usd`                     | `--cost-usd`        | `costusd`        | client-side estimate; hidden when 0 |
| `.rate_limits.five_hour.used_percentage`  | `--five-hour-pct`   | `fivehourpct`    | subscriber-only → "Session" gauge |
| `.rate_limits.five_hour.resets_at`        | `--five-hour-reset` | `fivehourreset`  | epoch seconds                  |
| `.rate_limits.seven_day.used_percentage`  | `--week-pct`        | `weekpct`        | subscriber-only → "This week" gauge (key is `seven_day`, **not** `weekly`) |
| `.rate_limits.seven_day.resets_at`        | `--week-reset`      | `weekreset`      | epoch seconds                  |

## Setup

The bridge lives in your user-level `~/.claude/statusline-command.sh` (the
`statusLine.command` in `~/.claude/settings.json`). After parsing the fields above,
add — guarded so it never delays the printed status line and never publishes a
misleading 0%:

```bash
# Mirror usage into Wave's Agents tab. Detached + backgrounded so it never delays the
# status line; the line re-fires often, so a dropped publish self-heals next render.
# Gated on context data so a non-subscriber session reports nothing rather than 0%.
if [ -n "$WAVETERM_BLOCKID" ] && [ -n "$used_pct" ] && command -v wsh >/dev/null 2>&1; then
    usage_args=(--context-pct "$used_pct")
    [ -n "$ctx_max" ]  && usage_args+=(--context-max "$ctx_max")
    [ -n "$cost_usd" ] && usage_args+=(--cost-usd "$cost_usd")
    [ -n "$rate_5h" ]  && usage_args+=(--five-hour-pct "$rate_5h")
    [ -n "$reset_5h" ] && usage_args+=(--five-hour-reset "$reset_5h")
    [ -n "$rate_7d" ]  && usage_args+=(--week-pct "$rate_7d")
    [ -n "$reset_7d" ] && usage_args+=(--week-reset "$reset_7d")
    ( wsh agentstatus --usage "${usage_args[@]}" >/dev/null 2>&1 & )
fi
```

with the matching field parsing (`jq -r '… // empty'`):

```bash
ctx_max=$(echo "$input"  | jq -r '.context_window.context_window_size // empty')
cost_usd=$(echo "$input" | jq -r '.cost.total_cost_usd // empty')
reset_5h=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
rate_7d=$(echo "$input"  | jq -r '.rate_limits.seven_day.used_percentage // empty')
reset_7d=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')
```

`wsh agentstatus` takes no block argument — it resolves the current block from
`$WAVETERM_BLOCKID` (set by Wave in the terminal env, inherited by the statusLine
command), exactly like the reporter. `wsh agentstatus --usage` requires **wsh ≥
v0.14.5** (where the `--usage` flags landed); older binaries reject `--usage`.

## Verifying

- `bash -n ~/.claude/statusline-command.sh` — syntax.
- Feed a synthetic payload and confirm the argv (swap the `( wsh … & )` line for an
  `echo` to inspect it without publishing):
  ```bash
  echo '{"context_window":{"used_percentage":42.5,"context_window_size":1000000},
         "rate_limits":{"five_hour":{"used_percentage":63,"resets_at":1750700000},
         "seven_day":{"used_percentage":18,"resets_at":1751200000}},"cost":{"total_cost_usd":1.23}}' \
    | WAVETERM_BLOCKID=block:x bash ~/.claude/statusline-command.sh
  ```
- `wsh agentstatus --help | grep usage` — confirm the installed binary has the flags.
- Live: with an agent active in a Wave block, the focus-view context bar and the Plan
  usage strip populate within a few seconds (after the next statusLine render).

## Update cadence

Usage refreshes once per statusLine run. Claude Code invokes the statusLine
**event-driven, debounced at 300ms** — after each new assistant message, after
`/compact`, on a permission-mode change, and on a vim-mode toggle (per the
[statusLine docs](https://code.claude.com/docs/en/statusline.md)). So while an agent
is actively producing output, the gauges refresh up to ~3×/second; **when the session
goes idle the statusLine goes quiet**, so usage stops refreshing and holds its last
end-of-turn value. (Whether it fires on session start/resume is undocumented.)

To keep the gauges ticking during idle, add `refreshInterval` (seconds, min 1) to the
`statusLine` block in `~/.claude/settings.json` — it layers timer-based runs on top of
the event triggers. Marginal for per-agent context/cost (the numbers don't change while
idle); mainly keeps the account-global plan gauges current from other activity.

## Behavior notes

- **Context % is input-only** (Claude Code excludes output tokens from
  `used_percentage`); the token figure in the bar is derived from `pct × contextmax`.
- **Plan gauges are subscriber-only.** API-key sessions never emit `--five-hour-pct` /
  `--week-pct`, so the Plan usage strip stays hidden — by design, not a bug.
- **Idle agents** keep their last usage value (atoms don't clear); it just stops
  refreshing once the statusLine quiets. A full app restart clears the atoms until the
  next statusLine fire per block.
- The reporter (`wsh agent-hook`) is intentionally **not** involved here —
  state/subagents and usage are independent channels into the same `agent:status` event.
