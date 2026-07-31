# Decision record — Orca → Arc port: port nothing

> **Decided** 2026-07-30. **Outcome: no ports.** Every candidate is already solved in Arc, does not apply
> to Arc's runtimes, or is speculative breadth for demand that does not exist.
>
> Source: a full source comparison of Arc against **Orca** (`stablyai/orca`, MIT), read at the local clone
> `IdeaProjects/orca` @ `561e2d3`, version `1.4.162-rc.0`. Orca was read, not run.
>
> This started as a triage brief with a P1–P4 build ladder. The ladder did not survive verification against
> Arc's actual code. It is rewritten as a decision record so the comparison is not re-run from scratch, and
> so the declined items are declined *with reasons* rather than left looking like a backlog.

## The decision

Orca is a directly adjacent product — "The AI Orchestrator for 100x builders", Electron, MIT, shipping
daily, and far larger than Arc. Almost none of it is worth taking, and the parts that looked worth taking
turned out not to be.

Orca's own orchestration checklist declares *"No product dashboard, Run UI, badges, or coordinator chat UI"*
as an explicit non-goal. That non-goal is Arc's entire product (Jarvis, Radar, the Concierge → Gatekeeper →
Delegator ladder). **Arc's ground is the supervisory layer, not the workbench** — and the supervisory layer
is the one thing Orca has committed to not building.

The comparison's value is the negative result plus the reasoning below.

## Why nothing ported — what Arc already has

This table is what produces the verdict. Each row is a candidate that turned out to be already solved.

| Thing | Arc's existing implementation |
|---|---|
| **App-managed agent hooks** | `cmd/wsh/cmd/wshcmd-installhooks.go` — `wsh install-agent-hooks` merges Arc's managed block into `~/.claude/settings.json`, preserving non-managed groups. Fired detached every launch from `src-tauri/src/main.rs:221`. `configIsHealthy()` (`:230`) skips the rewrite when the set is intact and the `wsh` exe exists; `isManagedCommand()` (`:53`) matches basename-`wsh` + a subcommand allowlist, so it is path/version-independent and self-heals across updates. |
| **Statusline usage bridge** | Same command wraps the user's statusline as `wsh statusline --inner=<base64>`. **Better than Orca's** — it carries the user's original command losslessly and `recoverInner()` un-nests on re-wrap. Orca generates and installs its own script; do not port that direction. |
| **Hook routing correctness** | `wsh` derives its RpcContext *and socket name* from `WAVETERM_JWT` in its environment (`cmd/wsh/cmd/wshcmd-root.go:154-161`). Combined with `"cmd:jwt": true` forcing the right JWT into every agent's env (`frontend/app/view/agents/launch.ts:154`, fix `eb415927`), which wavesrv a hook reaches is decided by the agent's env, not by which `wsh` binary the hook line names. This is what kills Orca's install-lock port — see below. |
| **Terminal scrollback across restart** | `frontend/app/view/term/termwrap.ts` serializes via `@xterm/addon-serialize` to `cache:term:full` through `BlockService.SaveTerminalState`. |
| **Headless one-shot invocation** | `pkg/consult` — per-runtime `RuntimeSpec` (bin, base args, prompt-via-stdin vs positional, pty workaround, JSONL parsers) for `claude -p` / `codex exec --json` / `agy -p`, plus `ProbeInstalled` for install/version probing. |
| **Worktree-per-agent** | `pkg/gitinfo` `CreateWorktree` / `WorktreePath`, wired into the New Agent launcher. |
| **Interactive launch table** | `frontend/app/view/agents/launch.ts` already *is* a small catalog: `RUNTIME_CMD` (binary aliasing — `antigravity: "agy"`) is Orca's `launchCmd`; the antigravity `-i` case at `:136` is Orca's `promptInjectionMode`; `RUNTIME_FLAGS` is a per-runtime flag catalog with descriptions that drives the picker's flag menu, with no Orca equivalent found. |
| **Typed cross-process contract** | `pkg/wshrpc` + `task generate`. Orca maintains its equivalents by hand. An Arc advantage to preserve. |

## Declined items, with reasons

Recorded so each is declined on evidence rather than re-proposed.

### Interactive agent launch catalog — declined

Orca's `src/shared/tui-agent-config.ts` (328 lines) makes 35 agent CLIs launchable at ~5–10 declarative
lines each, with a genuinely useful taxonomy: six `promptInjectionMode` variants, `detectCmd` +
aliases + required-commands, `launchCmdByPlatform`, and a set of hard-won traps.

It does not port because **every trap column is empty for Arc's three runtimes**:

- `launchCmd` binary aliasing — Arc already has it (`RUNTIME_CMD`).
- `promptInjectionMode` — Arc has exactly one non-default case (antigravity `-i`) and it is one `if`.
- `argvPromptSeparator` — applies to **`trae` and `grok` only** (see corrections). Not claude/codex/antigravity.
- `draftPromptFlag` / `draftPromptEnvVar` — seeds a composer without submitting, for a review-then-send
  flow. Arc's `@quick`/`@run` want immediate execution, so positional argv is already correct.
- `preflightTrust` — three values in all of Orca (`cursor`, `copilot`, `codex`), one occurrence each. Arc
  has been launching codex into fresh worktrees by design without prompts vanishing, so the one value that
  could apply evidently does not bite. *(Inferred from the absence of reports, not measured.)*
- `windowsShiftEnterEncoding` — moot; Arc injects via `ControllerInput`, not keystroke encoding.

What remained was a refactor of working code into a three-row declarative table with no populated trap
columns, in anticipation of agents nobody requested. By the standard that declined Gatekeeper v1.1 (see
`gatekeeper-v11-declined`), populating a 34-agent catalog on spec is speculative.

The 34-agent figure is also not the value it appears to be: Arc's New Agent modal already has a free-text
startup-command field, so launching an arbitrary CLI is possible today. The catalog's real value would be
the traps — and the traps do not apply.

### Hook install ownership lock — declined

Orca has `src/main/agent-hooks/managed-hook-install-lock.ts` (142 lines) and
`managed-hook-owner-identity.ts` (209 lines): an install takes a lock and records which host owns the
managed block, so a second instance defers instead of racing.

The hazard this would fix is described in `docs/agents/runs-pipeline-known-issues.md` — whichever `wsh` ran
`install-agent-hooks` last wins the path via `os.Executable()`, and both the dev app and a packaged install
run it every launch. **That hazard is no longer live.** Hook routing follows the JWT in the agent's env
(`wshcmd-root.go:154-161` + `cmd:jwt:true`), not the stamped `wsh` path, so a hook line naming dev's `wsh`
still reaches the launching app's wavesrv. The known-issues doc reads as current because it records the
roster fix (`initialWorkerStatusEvent`) and not the routing fix.

Residual, and too narrow to act on: the install path (`wshcmd-installhooks.go:300-333`) is an unlocked
read → `configIsHealthy` → write, so two concurrent launches can both write. Both produce a valid config
and `tmp`+`rename` prevents a torn file, so the loser only loses its own path — harmless given the above.
Separately, binary version skew is possible if the stamped `wsh` is an older build than the hook contract
it serves; `exeExists` catches absence but not staleness. Neither justifies a lock plus an owner-identity
subsystem.

### Trust preflight — declined

~30 lines, and a real silent-failure class in principle: the first-run "trust this folder?" menu consumes
the injected prompt, the agent looks healthy, the worker sits idle. It would bite hardest exactly where Arc
operates — fresh worktrees. But it is only observable once the agent set widens past the already-trusted
three, and the catalog that would widen it is declined. Codex is the one `preflightTrust` value Arc could
use, and it does not appear to bite today.

### Per-agent hook services — declined as a program

Orca has 14 hook services behind a registry of install/remove/status triples
(`src/main/agent-hooks/managed-agent-hook-registry.ts`). *(Count from the original pass; not re-verified.)*
Arc manages one provider.

This is a breadth gap, not an ownership gap, and it is not uniform work — Codex is not a settings.json merge
at all but `config.toml` sections plus trust-grant reconciliation, and Orca spends dozens of files on Codex
config alone. **Standing rule, worth keeping even though the item is declined:** add a hook service per
provider only when that provider's cockpit integration is actually wanted, and take Orca's
`AgentHookInstallStatus` idea — install state as a visible per-agent readout — so a missing hook is a
diagnosable state rather than a silently empty cockpit card.

### Picker install-detection — declined

Wiring `detectCmd` through the existing `pkg/consult.ProbeInstalled` so the picker marks uninstalled agents.
Declined: three runtimes, one user who knows what is on their machine, and the failure it prevents already
announces itself as "command not found" in the terminal it opens. Revisit only if the runtime list grows.

### Tier 2 — take the idea, not the code

- **Mailbox semantics for Delegator fanout.** Gated on fanout still being wanted (`docs/orchestrator-roadmap.md`
  lists it as the one open extension; Gatekeeper v1.1 was declined on evidence grounds, which casts doubt).
  If it is designed, read `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md` (1787 lines) first — it is a free
  postmortem. Directly reusable: bounded actionable batches (50 max), one outstanding delivery per Run
  replayed verbatim until whole-batch ack, atomic `ack → check → register-waiter`, consumer-generation
  fencing so a stale coordinator cannot ack or reply. Plus three invariants that cost nothing: **silence
  never proves worker death**, results are labeled `worker_report` not verified truth, and every mutation
  returns `ready | failed | outcome_unknown` with residual resources enumerated. This is reading, not an item.
- **Diff comments.** Annotate a diff line, ship comments back to the agent. Arc has `aifilediff` +
  `reviewstore`, so it extends an existing surface. A product feature needing its own brainstorm, not a port.
- **Additional usage providers.** `src/main/rate-limits/` reportedly has working fetchers for Gemini, Grok,
  Kimi, MiniMax, OpenCode *(unverified this pass)*. Worthless without per-provider hooks to show usage for.
- **`max-lines` ratchet in lint.** Declined: this repo has no lint task wrapper at all (`npx eslint .` is run
  directly), so a blocking gate is backwards until lint is wired up.

## Corrections to the original triage

Verified against both repos. Recorded because the original pass asserted each of these wrongly.

| Original claim | Verified |
|---|---|
| The hook-ownership race is live, citing `runs-pipeline-known-issues.md` | Defanged by `cmd:jwt:true` + JWT-derived routing. The cited doc predates the routing fix. |
| `src/shared/agent-trust-presets.ts` | It is `src/main/agent-trust-presets.ts` (plus `remote-agent-trust-presets.ts`). |
| "36 agent CLIs" / "~36 launchable agents" | `TuiAgent` has **35** members; `claude-agent-teams` wraps Orca's own CLI and is excluded → **34** portable. |
| Drift is "at least three places" — `composercommand.ts`, `newagentmodal.tsx`, `pkg/consult` | **Four**, and the omitted one is central: `frontend/app/view/agents/launch.ts` holds `RUNTIME_CMD`, `RUNTIME_FLAGS`, and the antigravity injection case. |
| `argvPromptSeparator` framed as a general argv trap | Set on **`trae`** (`:109`) and **`grok`** (`:299`) only, each with a comment pinning it to that CLI's parser. Absent from claude, codex, antigravity. |
| Recommended a Go `pkg/agentcatalog` mirroring `pkg/consult` | No Go consumer exists for interactive launch specs — `launchAgent` assembles the launch entirely on the frontend. Symmetry, not reuse. Moot now the catalog is declined. |

Minor: `tui-agent-config.ts` is 328 lines (not 320); the orchestration checklist is 1787 (not 1788). Orca's
~1.03M-line and Arc's ~139k-line figures are from the original pass and were not re-verified.

**Two method notes, since both caused a wrong call above:**

1. A field appearing in a source file does not mean it is applied. The false `argvPromptSeparator` finding
   came from a grep that hit the **type declaration** in the same file as the entries. Grep for the
   *assignment*, and count which entries carry it.
2. A comparison whose honest output is "port nothing" should not be shaped as a P1–P4 ladder with effort
   estimates. The original framing read as a backlog and was treated as one for several rounds before the
   items were checked against Arc's code.

## Unmeasured

- What `claude` actually does with a prompt starting with `-`, or one whose first word collides with a
  subcommand. Orca's evidence points at "no separator needed," so this is a measure-before-filing question.
- Whether codex's trust menu has ever eaten an injected prompt in Arc. Inferred safe from absence of
  reports.

## Explicit non-ports

Each is a large subsystem that would pull Arc into the workbench race:

Electron main/daemon/relay architecture · SSH relay + WSL hosts · connected-server federation ·
plugin host + marketplace · i18n (5 locales + coverage gates) · embedded Chromium + Design Mode + CDP ·
Android/iOS emulator panes · computer use · `orca-profiles` cloud auth / org membership ·
mobile and web clients · dictation · forge integrations (GitHub/GitLab/Gitea/Bitbucket/Azure DevOps/Jira/Linear).

## Licensing — if this is ever revisited

Orca is **MIT**; Arc is **Apache-2.0**. Copying is permitted, but MIT requires retaining the copyright and
permission notice. Keep any directly-derived code in identifiable files with provenance in a header comment
(`derived from stablyai/orca @ 561e2d3, MIT`) rather than pasting fragments into existing Apache-2.0 files.

## What would re-open this

- **The launch catalog:** a specific agent someone actually wants to run, that does not launch correctly
  via the existing free-text startup command. Then add one row's worth of handling — not 34.
- **Trust preflight:** one observed instance of a launched agent sitting idle with a vanished prompt.
- **A hook service:** a specific provider whose cockpit integration (status, ask-interception, usage) is
  wanted, per the standing rule above.
- **The install lock:** evidence that version skew between a stamped `wsh` and the hook contract actually
  broke a hook, or a routing failure that survives `cmd:jwt:true`.

## The one genuinely open question

Out of scope here and worth its own brief: should Arc's Delegator **drive Orca's CLI** rather than grow its
own worker control plane? Orca's CLI is agent-drivable and MIT, its orchestration primitives are more
rigorous than Arc would plausibly build, and it would inherit 34 agents, SSH, and cross-machine placement in
one move.

The cost is a hard external dependency at the center of Arc's highest-value surface — and Orca's declared
non-goal means the interface Arc would need (dashboard, Run UI, badges, coordinator chat) is precisely the
one Orca has committed to not stabilizing. Current read: no. But it is the only question in this comparison
that verification did not settle.
