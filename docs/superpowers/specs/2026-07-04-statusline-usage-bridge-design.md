# StatusLine usage bridge — app-managed, no manual file editing

## Problem

Live agent usage (per-agent context bar, session cost, and the account-global
5-hour / weekly plan gauges) is dark in the cockpit. Claude Code delivers those
numbers to exactly one place — the `statusLine` command's stdin JSON — so the
bridge has to live there. Today it doesn't: the user's `statusLine.command`
(`~/.claude/settings.json`) points at a personal script that prints the numbers
to the terminal but never forwards them to Wave. `wsh agentstatus --usage`
(the publisher) shipped and works, but nothing calls it.

The prior remedy (`docs/agents/usage-reporting.md`) asked the user to hand-edit
their statusline script and paste in a `jq` + `wsh` snippet. That is exactly the
friction we want to remove: **provisioning must happen inside the app**, the same
way lifecycle hooks already auto-install.

## Goal

The app auto-provisions the usage bridge on launch, with **zero manual editing**,
while leaving the user's existing terminal statusline display byte-for-byte
unchanged. All live usage readouts (context bar, cost, plan gauges) light up on
their own for a Claude.ai Pro/Max session; API-key sessions light up context +
cost (rate limits are subscriber-only, by design).

## Non-goals

- Replacing the flag-based `wsh agentstatus --usage` path — it stays for
  backward-compat and manual setups.
- Providing an Arc default statusline for users who have none configured — the
  wrapper just publishes usage and prints nothing (passthrough).
- Historical usage (the backend transcript scan) — already works, untouched.

## Constraint that shapes the design

Claude Code supports exactly **one** `statusLine.command`. The user already has a
custom one. So "incorporating" the bridge means the app must **own** that single
slot and **delegate** to the user's original command for display.

## Architecture

Extend the existing auto-installer. On every launch the Tauri shell already fires
`wsh install-agent-hooks` (`src-tauri/src/main.rs:166`), which idempotently merges
Arc-owned entries into `~/.claude/settings.json` while preserving everything else
(`cmd/wsh/cmd/wshcmd-installhooks.go`). The same install pass now also wraps
`statusLine.command`:

```
statusLine.command  →  "<wshpath>" statusline --inner <base64(original command)>
```

At render time Claude Code invokes `wsh statusline`, which:

1. reads the statusLine JSON from stdin (once),
2. concurrently: (a) runs the **original** command with that same stdin, capturing
   its stdout, and (b) publishes the usage delta to Wave,
3. waits for the original, writes its stdout through unchanged, best-effort
   finishes the publish, exits 0.

```
Claude Code statusLine JSON (stdin: context_window, rate_limits, cost)
        │
        ▼  "<wsh>" statusline --inner <b64>        (Arc-owned wrapper slot)
   ┌─────────────┴─────────────┐
   ▼ (concurrent)              ▼ (concurrent)
 run inner command          parse JSON → publishUsageDelta()
 (user's original)            → agent:status WaveEvent {usage}  (Persist:0)
   ▼                            │
 stdout passed through          ▼  agentstatusstore → getAgentUsageAtom(oref)
 (terminal line unchanged)      ▼  liveagents → focusview context bar + PlanGauge
```

### Why route through `wsh` (not a shell snippet)

- No `jq`/bash dependency; JSON parsing happens in Go, cross-platform.
- Matches how everything else in this system already works — lifecycle hooks are
  all `wsh` subcommands provisioned by the same installer.
- The installer can detect-and-refresh it idempotently, exactly like
  `isManagedCommand` does for hooks today.

### Why carry the original command in argv (base64)

The user's original command is embedded, base64-encoded, in the wrapper's own
argv (`--inner <b64>`). This makes the wrapper **self-describing** — no side files,
single source of truth. Re-wrapping on the next launch decodes `--inner` to
recover the true original, so wrapping never nests, and the `wsh` path is
re-resolved each install so app updates self-heal.

## Components

### 1. Installer: manage the statusLine slot (`wshcmd-installhooks.go`)

Mirror the existing managed-hooks logic for the single statusLine slot:

- `isManagedStatusLine(cmd) bool` — first token's basename starts with `wsh` and
  the remainder starts with `statusline`. Path/version-independent.
- Merge step inside the same `install-agent-hooks` run:
  - Resolve current `statusLine.command`.
  - If it's already managed, decode its `--inner` to recover the true original;
    otherwise the current command *is* the original (may be empty/absent).
  - Rebuild `statusLine.command` = `quotePath(wshExe) + " statusline --inner " + b64(original)`.
  - Preserve `statusLine.type` (default `"command"`), `padding`, and every other
    settings key — reuse the existing deep-copy round-trip.
- Empty/absent statusLine → `--inner` of an empty string; wrapper publishes usage
  and prints nothing.

### 2. `wsh statusline` runtime (new `cmd/wsh/cmd/wshcmd-statusline.go`)

Contract identical to `agent-hook`: **never errors, never blocks the visible
line, always exits 0.**

- Read all of stdin into `raw`.
- Decode `--inner`; if non-empty, run it via the platform shell
  (`cmd /c <inner>` on Windows, `sh -c <inner>` elsewhere) with `raw` on its
  stdin, capturing stdout. Run this in a goroutine.
- Concurrently, if `WAVETERM_BLOCKID` and the JWT env are set and
  `context_window.used_percentage` is present: parse the usage fields from `raw`
  and publish via the shared usage-publish helper.
- Wait for the inner command; write its captured stdout to our stdout. Best-effort
  complete the publish. Exit 0 regardless of any error in either path.

Fields parsed from the statusLine JSON (per `docs/agents/usage-reporting.md`):

| statusLine field | AgentUsage field | notes |
| --- | --- | --- |
| `.context_window.used_percentage` | `contextpct` | gates the publish |
| `.context_window.context_window_size` | `contextmax` | 200000 or 1000000 |
| `.cost.total_cost_usd` | `costusd` | hidden when 0 |
| `.rate_limits.five_hour.used_percentage` | `fivehourpct` | subscriber-only → nil if absent |
| `.rate_limits.five_hour.resets_at` | `fivehourreset` | epoch seconds |
| `.rate_limits.seven_day.used_percentage` | `weekpct` | key is `seven_day` |
| `.rate_limits.seven_day.resets_at` | `weekreset` | epoch seconds |

Rate-limit fields stay **nil when absent** so an API-key session reports "unknown"
rather than a misleading 0% — the existing `publishUsageDelta` already does this
gating; refactor its usage-struct construction into a shared helper both the
flag path and the JSON path call.

### 3. Docs (`docs/agents/usage-reporting.md`)

Replace the manual-edit "Setup" section with the auto-wrap mechanism; keep the
data-flow and field-mapping sections. Note the flag-based path remains for manual
use.

## Performance (measured, 2026-07-04, live dev backend)

The wrapper adds, per render, over the user's existing line:

| Component | Cost |
| --- | --- |
| User's existing script (unchanged) | ~530 ms (git + `jq` spawns; dominates) |
| Extra shell layer `sh -c "bash …"` | ~0 ms (measured identical to direct) |
| `wsh` process launch | ~34 ms |
| RPC setup + publish | ~10 ms — runs concurrently with inner, so hidden |

Net added wall-clock ≈ **~30 ms on a ~530 ms line (~6%)**, effectively just the
outer `wsh` launch; the publish overlaps the inner run. StatusLine is debounced at
300 ms, so renders don't stack. A one-shot `wsh agentstatus --usage` publish to the
live backend measured ~44 ms end-to-end and round-tripped cleanly, confirming the
pipeline is intact and only the bridge was missing.

## Error handling

- Wrapper is best-effort and silent: any failure (bad JSON, no block env, RPC
  down, inner command error) still yields exit 0 and the inner command's stdout.
  A dropped publish self-heals on the next render (the line re-fires often).
- Installer failure is already ignored by the Tauri caller (detached, output
  discarded) — unchanged.

## Testing

- Go unit tests for the installer statusLine merge (mirror
  `wshcmd-installhooks_test.go`): `isManagedStatusLine`; wrap-when-unmanaged saves
  the original as `--inner` b64; re-wrap-when-managed recovers the original and
  refreshes the `wsh` path; empty/absent statusLine case; other settings keys and
  the managed hooks block preserved.
- Go test for statusLine-JSON → `AgentUsage` field extraction, including the
  subscriber-only nil gating (rate-limit fields absent → nil, present → set).

## Open questions

None outstanding — the "wrap" mechanism and the per-render overhead are both
settled (see Performance).
