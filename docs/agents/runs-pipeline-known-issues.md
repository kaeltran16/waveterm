# Channels Runs — pipeline worker known issues

Two bugs in the pipeline-mode run workers, found on 2026-07-05 by driving a
real pipeline run in the dev app and inspecting the spawned worker end-to-end over
CDP (roster atoms), the object DB (`waveterm.db`), the worker's Windows process
command line, its Claude transcript, and its terminal blockfile (`filestore.db`).

Both were about what happens *after* the worker launches (it launches correctly and
receives its full goal). **Both are now fixed** — see "Resolved" below. The mechanical
spawn bugs fixed earlier in the same session are in "Already fixed" for context.

Companion: `docs/agents/channels-flows.md`, `docs/agents/organic-ask-setup.md`.
Engine/spawn code: `pkg/jarvis/runexec.go`, `pkg/wshrpc/wshserver/wshserver.go`
(`spawnRunWorkers`). Frontend roster: `frontend/app/view/agents/liveagents.ts`,
`session-models/agentstatusstore.ts`, `runmodel.ts` / `runssurface.tsx`.

---

## Already fixed this session (context, not open)

Recorded here so the two open bugs below aren't confused with them.

1. **Worker blocked on the folder-trust / permission prompt.** Headless workers had
   no human to approve prompts, so `claude` sat alive-but-idle forever. Fixed by
   launching with `--dangerously-skip-permissions` in `SpawnClaudeWorker`
   (`pkg/jarvis/runexec.go`). Verified: worker terminal shows `bypass permissions on`.
2. **Prompt truncated at apostrophes.** Worker args are shell-quoted and run via
   `<shell> -c <cmdStr>`. `ShellQuote` emits POSIX quoting, but the local shell here
   is PowerShell, which re-split the arg at any `'` — so `the phase's deliverable`
   (and any user goal with an apostrophe, in **both** modes) lost everything after
   the quote. Orchestrator only escaped it because its prompt has no apostrophe.
   Fixed with shell-aware quoting: pass the resolved shell type into
   `createCmdStrAndOpts` and quote with `HardQuotePowerShell` under pwsh; also fixed a
   newline-doubling bug in `HardQuotePowerShell` (`pkg/blockcontroller/shellcontroller.go`,
   `pkg/util/shellutil/shellquote.go`). Verified end-to-end: the live worker's process
   command line carried the full goal (`the worker's uptime`) intact; pwsh round-trip
   test confirmed an apostrophe+newline+quote arg survives to child argv.

---

## Resolved

The chosen shape: a headless worker works **autonomously for low-stakes calls** but
**escalates genuinely hard questions to the human in the cockpit** — which needs the
worker to be reliably visible there. So both fixes landed together.

### A. Headless run workers never appear in the cockpit — **fixed**

**Was:** a running pipeline worker (process alive, actively reasoning) did **not** show
up as a session tab; `liveAgentsAtom` / `liveAgentBaseAtom` were empty mid-turn. This
was the user's "there is no tab for it in agent" report. Orchestrator workers showed up
*sometimes*, so reporting was inconsistent, not wholly absent.

**Root cause (confirmed by code trace):** the roster (`liveagents.ts`
`liveAgentBaseAtom`) includes a session only once its block has emitted an `agent:status`
with a `state`. That state comes solely from the external reporter hook (`wsh agent-hook`,
wired on `UserPromptSubmit`/`PreToolUse`/`Stop`/…). The in-repo pieces are all correct —
the FE subscription is global and set up at boot; the headless worker's env is force-
injected with `WAVETERM_BLOCKID`+JWT (`shellexec.go` `StartLocalShellProc`); the hooks are
registered for every event including `UserPromptSubmit`. The failure is **hook ownership
between coexisting installs**: `~/.claude/settings.json` hooks are stamped with whichever
`wsh` ran `install-agent-hooks` last (`os.Executable()`), and both the dev app and a
packaged Arc install re-run it every launch (`src-tauri/src/main.rs`). When the hook binary
belongs to a different install than the worker's wavesrv, the status never reaches the
cockpit the user is watching — inherently racy, matching "sometimes".

**Fix:** the roster no longer depends on the external reporter to *see* a run worker.
`SpawnClaudeWorker` (`pkg/jarvis/runexec.go`) publishes a retained (`Persist:1`)
`agent:status = working` for the worker's block right after starting the controller
(`initialWorkerStatusEvent`), so the worker enters the roster deterministically at spawn.
A real hook event (if it arrives) still refines it (detail/model, idle-on-stop).

**Residual — now fixed (2026-07-08, run-worker status hardening).** The retained `working`
was never overwritten with `idle` on exit, so if the reporter hook never fired a finished
worker lingered as "working". The backend now owns the coarse lifecycle: when an
**agent-session** block's process exits, the cmd wait-loop publishes a retained
`agent:status = idle` scoped to that block (`emitAgentIdleOnExit` /`idleOnExitEvent` in
`pkg/blockcontroller/shellcontroller.go`), gated on the tab's `session:agent` meta so plain
terminals emit nothing. Spawn (`working`) and exit (`idle`) now share one constructor
(`blockcontroller.AgentStatusEvent`), so their shape cannot drift. Independent of the hook.

**Live verification (CDP, 2026-07-08).** Drove a real agent-session cmd block (tab tagged
`session:agent`, a short non-`claude` command so *no* Claude hook runs — the only thing that
can move the status is the backend). Read the block's persisted `agent:status` via the
`eventreadhistory` RPC:
- **Natural exit:** `working → idle` after the command exited (~4s), idle emitted by the
  backend with no hook involvement.
- **Kill (`controllerdestroy`):** `working → idle` immediately.
Both confirm the backstop fires on graceful exit and kill alike. (A real run worker runs
`claude` *interactively*, so its process lingers past turn-end and only exits on
finish/cancel/crash; `CancelRun` now stops each live worker's process (`stopRunWorkers`:
`cmd:runonstart=false` + `DestroyBlockController`) and **keeps** the worker tab so its
transcript stays inspectable; the idle-on-exit backstop flips the roster row `working → idle`
— either way no stale "working" survives.)

**Touchpoints:** `pkg/jarvis/runexec.go` (`SpawnClaudeWorker`, `initialWorkerStatusEvent` →
`AgentStatusEvent`); `pkg/blockcontroller/{blockcontroller.go,shellcontroller.go}`
(`AgentStatusEvent`, `idleOnExitEvent`, `emitAgentIdleOnExit`); `agentstatusstore.ts`;
`liveagents.ts`.

### C. Cross-install hook routing — confirmed working, not a defect (2026-07-08)

The earlier hypothesis (residual A's "routing failure") was that when `~/.claude/settings.json`
hooks are stamped with a *different* install's `wsh`, status never reaches the cockpit. A code
trace argued the opposite (the hook routes by the JWT's **absolute** socket path, not by which
`wsh` runs it); this was confirmed live.

**Evidence.** On this machine two installs coexist: a **packaged** Arc (data home
`dev.arc.app`, socket `…\dev.arc.app\data\wave.sock`) and this **dev** build (`dev.arc.app-dev`,
served from `dist/bin`). The verifying Claude Code session itself ran as a packaged-Arc agent
block (`WAVETERM_BLOCKID`=`df9292f9…`, JWT socket = `dev.arc.app\data\wave.sock`). Running the
**dev-build** `wsh agent-hook` (a *different* install's binary) under that session env, with the
new `WAVETERM_HOOK_DEBUG=1` log (`~/.claude/arc-hook-debug.log`), produced:

```
published event=UserPromptSubmit state=working oref=block:df9292f9-…
```

i.e. a foreign `wsh` binary published to the packaged-Arc wavesrv named in the JWT. Had it
resolved the wrong/absent socket it would have logged `skip: setupRpcClient failed`; it logged
`published`. **Outcome (a): cross-install routing is sound.** The earlier "sometimes working"
inconsistency was the missing `idle` (fixed above), not a routing break — so no speculative
routing fix was added.

**Diagnostics (2a) & churn (2c).** `wsh agent-hook` now logs its branch per invocation when
`WAVETERM_HOOK_DEBUG` is set (silent no-op otherwise; never writes to stdout/stderr).
`install-agent-hooks` now skips rewriting an already-healthy config
(`configIsHealthy` in `wshcmd-installhooks.go`), so two coexisting installs stop clobbering
each other's hook paths every launch. (Caveat: the churn stops only once *both* installs carry
this guard — the packaged Arc here predates it and still re-stamps its path on its next launch.)

### B. Pipeline brainstorm phase is interactive — headless worker stalls — **fixed**

**Was:** with the full goal delivered, the worker ran, loaded
`superpowers:brainstorming`, reasoned correctly, then stopped at a clarifying-question TUI
menu ("What should the haiku be about …", `Enter to select · Tab/Arrow keys to navigate`)
and waited. No human is attached to a headless worker, so it hung indefinitely and kept
consuming API quota while parked.

**Root cause:** the pipeline playbook's first phase drives an **interactive** skill, and
`BuildPhasePrompt` said only *"Use the skill … then stop when the deliverable is written"*
with no autonomy guidance. Orchestrator mode avoided this — its prompt is autonomous.

**Fix:** `BuildPhasePrompt` (`pkg/jarvis/run.go`) now tells the worker it is headless with
no human at its terminal: make reasonable assumptions for low-stakes / reversible choices
and proceed, and reserve `AskUserQuestion` for decisions a wrong assumption would derail.
`AskUserQuestion` is intercepted by the existing organic-ask hook and surfaced in the
cockpit (`docs/agents/organic-ask-setup.md`) — which is why A had to be fixed too, so a
human can actually answer. The plan-phase gate remains the primary human checkpoint.

**Touchpoints:** `pkg/jarvis/run.go` (`BuildPhasePrompt`); `docs/agents/organic-ask-setup.md`.

---

**Verification status:** A and B were unit-level at first; the run-worker status hardening
(2026-07-08) added unit coverage — `AgentStatusEvent`/`idleOnExitEvent`
(`pkg/blockcontroller`), `hookDebugLine` and `configIsHealthy` (`cmd/wsh/cmd`), alongside the
existing `TestInitialWorkerStatusEvent` and `TestBuildPhasePromptTellsWorkerToSelfServeAndEscalate` —
**and drove the backend idle-on-exit backstop and cross-install hook routing end-to-end in the
live dev app over CDP** (results in residual A and section C above). Not yet exercised live: the
organic-ask round-trip (B).
