# Orchestrator redesign — observed flaws tracker

> Living tracker captured 2026-08-16 during the first live DAG run of the "check Evidence snapshot in
> channel run, how do we improve it" goal (lead run `e6ed1a8d`, DAG `dd172828`, engine parallelism 2).
> Every flaw below was observed first-hand in that run, with evidence. The redesign
> (`docs/orchestrator-roadmap.md` + this tracker) closes these rows; resolved rows keep only their
> summary line.
> A second capture (2026-09-04, a 13-task plan executed end to end) adds F11-F17 below; the
> capture-1 sections keep their original scope.

## Capture 1 — first live DAG run (2026-08-16)

### The failure story in one paragraph

The engine spawns headless children that run the full superpowers workflow, including human gates
(brainstorming design-approval, `ask_user_question`). The ask bridge projects the question onto the
child's own session card in the cockpit, where the user never looks, and the lead receives no event, no
notification, and has no command to list or answer it. Meanwhile nothing watches the children: a
provider hang sits "running" for 40+ minutes, the 30-minute ask timeout expires into a frozen child,
and `dag status` reports both as healthy. The lead's only unblock was a hand-written raw socket RPC
client. Current DAG state at capture time: both children frozen, tasks still `running`.

### Flaw table

| #  | Flaw                                                         | Evidence (this session)                                                        | Impact                                   | Status |
| -- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------- | ------ |
| F1 | Child asks invisible to lead, unreachable for user           | t-ev-3 (`b63e97ef`) raised `ask_user_question` 14:20:52; parked 40+ min; card projects only on the child session; user could not find it; lead got no event/CLI/notification | silent whole-DAG deadlock                | ✅ Resolved 2026-08-16 |
| F2 | Lead has no channel into children                            | `wsh jarvis` has no ask list/answer/steer; `AnswerAgentCommand` exists only as an RPC (`pkg/wshrpc/wshclient/wshclient.go:38`); had to write a raw socket client to answer | lead cannot resolve the deadlock         | ✅ Resolved 2026-08-16 |
| F3 | No watchdog for stalled children                             | t-ev-1 (`03e4a16f`) last session write 14:22:17 (model call to deepseek-v4-flash never returned); `dag status` still `running` at 15:01; no alert in 40 min | DAG sits dead indefinitely, progress lies | ✅ Resolved 2026-08-16 |
| F4 | Silent 30-min ask expiry with no recovery                    | `askWaitTimeout` 30m (`cmd/wsh/cmd/wshcmd-ask.go`); t-ev-3's ask expired ~14:50:52; child stayed frozen (session file unchanged 15:01) | the safety valve does not resume work     | ✅ Resolved 2026-08-16 |
| F5 | `dag status` lacks per-task health                           | status JSON has only `state` + `runid`; no age / last-activity / ask indicator; stalled and working tasks look identical | lead cannot triage without forbidden transcript reads | ✅ Resolved 2026-08-16 |
| F6 | Plan pins never reach children                               | `ImportPitasks` (`pkg/orchestrate/import.go:12`) maps only Subject→label, drops Description; t-ev-3 asked a question the plan had already answered in the description | children re-litigate decided questions    | ✅ Resolved 2026-08-16 |
| F7 | Children run a human-gated workflow headless                 | t-ev-1 followed the brainstorming skill ("present a short design and get approval", 14:22:17) — a gate with no human on the other end | deadlock-by-design for any judgment call | ✅ Resolved 2026-08-16 |
| F8 | Lead run context not injected                                | `wsh jarvis dag status -b <block>` → `run "" not found`; `--channel/--runid` had to be dug out of `waveterm.db` by hand (sqlite) | ~2 min DB archaeology per lead session    | ✅ Resolved 2026-08-16 |
| F9 | Plan tooling fights the lead                                 | pi-tasks extension quality gate rejected `task_plan` 5× (multi-action steps, multi-output expectedOutputs, allowedActions > 3); the engine file store `.pi/tasks/tasks.json` has no gate and imported clean on the first write | minutes of churn; wrong tool for the destination | ✅ Resolved 2026-08-16 |
| F10 | No template/init for the DAG store                           | `.pi/tasks` schema rediscovered from `pkg/pitasks` source (`pitasks.go` Read/Parse); no example or scaffold command | every lead re-learns the schema; wiring errors possible | ✅ Resolved 2026-08-16 |

### Derived redesign requirements

The redesign must provide (one per flaw cluster):

- **R1 (F1/F2):** child asks → `child_ask` control event to the lead + card rendered on the parent run
  surface + `wsh jarvis ask list` / `wsh jarvis ask answer <task> <option|text>` (wrapping the existing
  `answeragent` RPC).
- **R2 (F3):** per-task last-activity tracking; after 15 min of silence the engine emits
  `child_stalled` to the lead and flags the task `stalled` in status.
- **R3 (F4):** ask expiry must resume the child (decline semantics, "proceed with best judgment"), not
  leave it frozen.
- **R4 (F5):** `dag status` per-task: `state ∈ pending/running/stalled/ask/done` + age + ask summary.
- **R5 (F6):** `ImportPitasks` passes the task description into the child goal/prompt so plan-pinned
  decisions reach the child.
- **R6 (F7):** child contract: the plan is the authority for what it pinned; children do not re-plan or
  pause for design approval (that is the lead's job). Genuinely unpinned, consequential decisions are
  ASKED — the ask forwards to the orchestrator lead, who decides or escalates to the human; the child
  waits on the answer rather than guessing.
- **R7 (F8):** engine injects run context (`WAVE_RUN_ID` / `WAVE_CHANNEL_ID`, or `wsh jarvis ctx`).
- **R8 (F9/F10):** document the `.pi/tasks/tasks.json` format + ship a scaffold (`wsh jarvis dag init`
  or `docs/orchestrator/tasks.example.json`); lead writes the store directly, skipping the extension
  quality gate.

## Capture 2 — executing a 13-task plan (2026-09-04)

> Second live capture, evidence in `docs/jarvis-orchestrator-plan-e2e.md`: lead run
> `e4a54512`, DAG `f2347178`, `mode=orchestrator runtime=pi model=openai-codex/gpt-5.6-sol`,
> project `.claude/worktrees/git-compare-viewer-parity`, engine parallelism 2. Plan under execution:
> `docs/superpowers/plans/2026-09-04-git-compare-viewer-parity.md` (13 numbered tasks).

The engine itself worked: it validated the DAG, spawned children into managed worktrees, drained them
against the parallelism cap, derived state from child runs, and stopped correctly at the merge gate.
Everything that went wrong sat around it. The route picker's first offer was a route the account
cannot run, and the lead died on its first API call in a way indistinguishable from thinking for 15
minutes. Re-launched, the lead spent ~10 minutes planning and produced 13 task records, which
`import-tasks` rejected outright at 8. Asked how to proceed, the lead recommended splitting into two
DAG phases — a shape this build cannot execute, because a run links exactly one `TaskGroup` for its
lifetime, a constraint stated nowhere. It compressed 13 → 8 instead and the DAG ran. State at capture
and still true at review time: 4 of 8 tasks done, four child branches unmerged, project HEAD still at
the base commit, digest `health: "healthy"`, nothing advancing.

### Flaw table

| #  | Flaw                                                    | Evidence (2026-09-04 run)                                                      | Impact                                   | Status |
| -- | ------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- | ------ |
| F11 | `MaxTasks = 8` has no path for a larger plan           | 13-task plan; `wsh jarvis dag import-tasks` → `Error: no more than 8 tasks are allowed` (`pkg/orchestrate/dag.go:137`) after the lead had already spent ~10 min producing 13 pi-tasks records. `MaxTasks` (`dag.go:39`) is referenced from that one call site and asserted by no test | plan rejected *after* the planning cost; only workaround is lossy compression | open |
| F12 | One run holds exactly one DAG, stated nowhere           | `wstore.CreateDagForRun` (`pkg/wstore/wstore_dag.go:88`) returns the *existing* dag whenever `run.DagORef != ""`; `DagSubmitCommand` fails a differing proposal with `dag conflict: run %s already linked to a different dag` (`wshserver_dag.go:91`). The lead's own recommended escalation answer — "two DAG phases, import 9–13 after the first integrates" — would have hard-failed at the second import, stranding tasks 9–13. Nothing in the prompt, CLI help, or error text says so | lead confidently recommends a dead-end shape; a human taking it discovers it eight tasks later | open |
| F13 | No first-token deadline: a dead lead looks like a thinking one | First launch pinned `openai-codex/gpt-5.3-codex-spark`; lead died on its first API call (`the 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account`) with a 4-line transcript, while the run read `executing / orchestrate:running`. Liveness is transcript-mtime only (`pkg/orchestrate/liveness.go:25`, `StallThreshold` 15 min), so dying *before* writing is indistinguishable from thinking | 15 min to notice a launch that failed in seconds | open |
| F14 | Route picker offers routes the account cannot run       | `openai-codex/gpt-5.3-codex-spark` listed, selectable, rejected by the provider; the `pi` **tier** routes resolve to a bare `deepseek-v4-pro`, which pi rejects as "ambiguous across providers". `ListHarnessesCommand` reports capability, not entitlement | the picker's first option is a guaranteed dead run | open |
| F15 | `import-tasks` hardcodes `parallelism: 2`               | `cmd/wsh/cmd/wshcmd-jarvisdag.go:82` sends `Parallelism: 2` with no flag; `DagSubmitCommand` accepts up to `MaxParallelism = 8` (`dag.go:40`). This DAG had 4 independent backend tasks (t-1..t-4) draining two at a time — digest `next.kind = parallelism-wait` while t-1/t-4 were ready | ~2× wall clock on wide DAGs; only the CLI path pins it | open |
| F16 | Merge gate has no liveness and no age                   | 4 done / 4 worktrees on `wave/e4a54512-…-t-1..t-4`; digest `health: "healthy"`, 0 stalled, 0 attention, `next.kind = merge-ready`, `actions: ["resolve-merge"]`. `StallThreshold` covers only *running* children, so nothing ages the gate. Confirmed still parked at review time: project worktree still at `fcfca8da`, four child branches unmerged | a lead that died or drifted strands finished work indefinitely while health reads clean | open |
| F17 | `runtime` silently selects between two different orchestrators | `BuildOrchestratePrompt` (`pkg/jarvis/run.go:353`) forks: `pi` → create pi-tasks + `dag import-tasks`, engine schedules (the only path producing a `TaskGroup`); `claude`/`codex` → "execute it adaptively by dispatching your own subagents" — no TaskGroup, no managed worktrees, `pkg/orchestrate` never runs. Nothing in the composer says which one a route buys | same UI, two execution models; every DAG affordance silently absent on one of them | open |

*Also observed, outside the seven:* `.waveterm/worktrees/34571345-…-t-3` and `-t-4` sit in the main
checkout on disk but are absent from `git worktree list` — orphans leaked by an earlier DAG. Worktree
cleanup debt is already real, not just a risk at the merge gate.

### Derived requirements

- **R9 (F11/F12):** a plan larger than one DAG needs *a* path. Either raise `MaxTasks` (one call site,
  no test pins it) or make the import failure state the real constraint — "one run holds one DAG for
  its lifetime; compress, or split into a second run" — so the lead cannot recommend a shape the
  engine refuses. Whichever, the one-DAG-per-run rule belongs in the lead's prompt and the CLI help.
- **R10 (F13/F16):** these are one root cause — *nothing watches the lead itself*. `StallThreshold`
  only covers running children, so both a lead that dies before its first token and one that dies at
  the merge gate read as healthy. Needs a spawn/first-token deadline at launch and an age on the merge
  gate. Note the fix is **not** health precedence: `next.kind = merge-ready` already reports the state
  correctly, there is just no signal that nobody is acting on it.
- **R11 (F14):** the route list must reflect entitlement, not just capability — either probe at
  `CreateRunCommand` (which already resolves the route before persisting,
  `wshserver_runs.go:282`) or mark unusable routes in the picker.
- **R12 (F15):** `import-tasks --parallelism`, defaulting to the DAG's ready-width capped at
  `MaxParallelism`, instead of a literal 2.
- **R13 (F17):** the composer must say which orchestrator a runtime buys (engine-managed DAG vs.
  adaptive self-dispatch), or the shape choice must stop depending on the route.

## Constraints carried into the redesign

- KISS/YAGNI: no new subsystems, no per-task timeout policies, no message bus. Only the failure modes
  observed above.
- The lead is the child's human: children stay headless; every question routes to lead or cockpit.
- Everything is verifiable with a live DAG run (the evidence goal re-run is the validation case).
