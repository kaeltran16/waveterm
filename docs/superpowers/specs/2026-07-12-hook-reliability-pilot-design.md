# Hook reliability pilot — design

**Date:** 2026-07-12
**Status:** pilot spec (go/no-go instrument, not the feature)

## Purpose

The Agents cockpit derives an agent's **state** (working / idle / asking) and its
**transcript-path discovery** from Claude Code lifecycle hooks (`wsh agent-hook`,
`cmd/wsh/cmd/wshcmd-agenthook.go`). The hook channel is reported unreliable across
four symptoms: stale/wrong state, agents that never appear, fragile provisioning
(cross-install `settings.json` clobbering, restart-to-load, block-gated), and ask
failures.

A candidate fix ("Approach 3") makes **file + process observation** the authoritative
source of state/discovery and demotes hooks to enrichment. Before building that
subsystem, this pilot measures — over real usage — whether the problem is real and
whether observation would close it. **The pilot never drives the roster.** It is
log-only, zero blast radius.

This spec exists to freeze the decision rule *before* the data arrives, so the
outcome cannot be argued after the fact.

## The non-circular anchor

Every `claude.exe` runs as a descendant of its Wave block's shell (blockcontroller
owns the PTY). The pilot attributes each live process to a block by walking the
**parent-pid chain** — independent of both the hook and the transcript. The OS
process table is the ground truth: it cannot lie about which block an agent belongs
to, nor when it was alive.

## Instrument: three-way timeline

For each claude session, record four time-aligned tracks:

| Track | Source | Role |
|---|---|---|
| **Process (truth)** | poll `claude.exe`, read `WAVETERM_BLOCKID` from env; alive interval | ground truth |
| **Hook** (diagnostic) | `WAVETERM_HOOK_DEBUG` log | did the hook *channel* fire — isolates hook reliability |
| **Roster** (decision-grade) | retained `agent:status` via `EventReadHistoryCommand` | what the cockpit *actually* shows = hook **+** backend backstops |
| **Observer (shadow)** | the real discovery heuristic + state deriver, log-only | what Approach 3 *would* have shown |

**Why the roster track is decisive (added after live data, 2026-07-12).** The first live
sweep found two agents with **zero** hook firings whose roster state was nonetheless
`working` — the backend backstops (`spawn=working` / `exit=idle`, independent of the hook)
already covered them. So a hook-only pilot would report a false 100% coverage gap and
credit the observer with closing it, when the cockpit was never actually broken. The
build decision therefore hinges on the **roster** gap (sessions the cockpit truly never
showed), not the raw hook gap. Reading the roster needs RPC, so the shadow must run inside
a Wave block; without RPC the verdict is INCONCLUSIVE, not a pass.

### Discovery heuristic (observer track)

1. Slugify the block cwd the way Claude does (`C:\Users\cktra\Projects\waveterm` →
   `C--Users-cktra-Projects-waveterm`) → `~/.claude/projects/<slug>/`.
2. Filter `*.jsonl` to those whose in-record `cwd` equals the block's canonical cwd
   (guards slug collisions). cwd is read from the transcript, not queried from the
   process (avoids `NtQueryInformationProcess`).
3. Disambiguate by **create-time proximity**: pick the cwd-matching transcript whose
   session-start (first-record timestamp) is closest to the agent process's create time.
   Newest-mtime is only the fallback when no session start can be read.

**Revised after live data (2026-07-12).** The original plan ("newest-active wins on
ties") mis-attributes: on this machine the waveterm project dir holds **141** transcripts
sharing the cwd, and two concurrent agents both resolved to the newest file. Create-time
proximity fixed it (each agent → its own transcript). Consequences recorded here:
- **Discovery correctness rests on the tiebreaker**, not on cwd — the pilot records
  `MatchCount` per resolution so the ambiguity rate is measured, not assumed.
- **`claude --resume` is a known blind spot**: a resumed session reuses an old transcript
  whose start time is far from the process's create time, so proximity can pick the wrong
  file. The pilot will surface this as observer/hook disagreements on resumed sessions.
- A production observer (inside wavesrv) has a stronger signal the pilot lacks: the block's
  own launch time and, for Wave-spawned workers, the session id — either removes the
  ambiguity the tiebreaker only mitigates.

### State deriver (observer track)

- file grew in the last few seconds / last record is an in-progress assistant turn
  → **working**
- `AskUserQuestion` `tool_use` with no matching `tool_result` → **asking**
- file quiescent past the hysteresis window (default **20s**) **and** last record is
  a completed assistant turn → **idle**
- process exited (from the anchor) → **idle**, terminal

`waiting` (permission prompt) is out of scope: workers run with
`--dangerously-skip-permissions`, so it effectively does not occur.

## Where it runs

A hidden `wsh agent-observe-shadow` subcommand runs the observer as a standalone
process: watches `~/.claude/projects/**`, polls the process table, writes the
three-way comparison to a log file. Rationale:

- **Zero blast radius** — wavesrv and the roster are never touched; the observer only
  writes to a log.
- **Reusable core** — the correlator + deriver live in a real Go package
  (`pkg/agentobserve`). That package is exactly the code wired into wavesrv if the
  pilot passes; on failure it is one self-contained package to delete.

## Metrics and decision rule

| Metric | Answers | Gate |
|---|---|---|
| **Roster coverage gap** — % of anchor-confirmed live processes the *cockpit* never showed | is there a real, user-facing problem | kill gate: if ~0, stop — backstops already suffice |
| **Roster-gap closure** — of those, % the observer correlated and showed | does observation help beyond backstops | **build only if > 80%** |
| **Hook coverage gap** (diagnostic) — % the hook *channel* never reported | how unreliable the hook itself is | context, not a gate |
| **Stale-working duration** — process-exit → idle, roster vs observer | the "stuck on working" symptom | **build only if observer median < 20s** |
| **Discovery ambiguity** — `MatchCount` per resolution; tiebreaker-reliance rate | how safe cwd correlation is | qualitative; high ambiguity is a risk flag |
| **Disagreement adjudication** — where roster/hook ≠ observer, which matched the anchor | which source to trust | qualitative |
| **Ask detection (measure-only)** — pending `AskUserQuestion` the observer would surface | ask coverage | qualitative; no injection in pilot |

Build the full Approach 3 only if **roster-gap closure > 80% AND observer median
stale-working < 20s**. If the roster gap is ~0 the backstops already do the job and the
observer is not worth building; if the roster track was not measured (no RPC) the run is
INCONCLUSIVE, not a pass.

### Known limits of the pilot (do not over-read a green)

- **Fine-state correctness is only spot-checkable.** The process anchor validates
  alive/dead, not working-vs-asking-vs-idle. "Observer covered it" means it produced *a*
  state, not necessarily the *right* one — and in roster-gap sessions there is no second
  source to check against. Confirm fine state by hand on a sample.
- **Observer idle-on-exit is true by construction** (the liveness floor), so its
  stale-working number is a design guarantee, not a discovery; the meaningful comparison
  is the roster's stale-working.
- **Standalone poll timing under-credits the observer** — production (fsnotify in
  wavesrv) is faster than the pilot's N-second poll.
- **Validity depends on a representative window** — intermittent cross-install races may
  not occur during a quiet run, under-measuring the problem.

## Scope

Out of scope for the pilot: the reconciler, any frontend change, ask *injection*, and
any path where the observer drives the roster. Windows-only (matches build reality).

## Caveats recorded in results

- The observer runs as a separate process, so its timing is representative but not
  identical to an in-wavesrv deployment. Noted in results, not hidden.
- All three logs are same-machine wall-clock; second-granularity alignment suffices.

## If the pilot passes

The full Approach 3 build (reconciler precedence rules, FE wiring, the ask split:
SDK `canUseTool` for Wave-spawned workers, native prompt fallback for interactive
agents) is a non-trivial change and gets its own implementation plan at that point.
