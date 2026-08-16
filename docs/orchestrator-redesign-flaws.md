# Orchestrator redesign — observed flaws tracker

> Living tracker captured 2026-08-16 during the first live DAG run of the "check Evidence snapshot in
> channel run, how do we improve it" goal (lead run `e6ed1a8d`, DAG `dd172828`, engine parallelism 2).
> Every flaw below was observed first-hand in that run, with evidence. The redesign
> (`docs/orchestrator-roadmap.md` + this tracker) closes these rows; resolved rows keep only their
> summary line.

## The failure story in one paragraph

The engine spawns headless children that run the full superpowers workflow, including human gates
(brainstorming design-approval, `ask_user_question`). The ask bridge projects the question onto the
child's own session card in the cockpit, where the user never looks, and the lead receives no event, no
notification, and has no command to list or answer it. Meanwhile nothing watches the children: a
provider hang sits "running" for 40+ minutes, the 30-minute ask timeout expires into a frozen child,
and `dag status` reports both as healthy. The lead's only unblock was a hand-written raw socket RPC
client. Current DAG state at capture time: both children frozen, tasks still `running`.

## Flaw table

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

## Derived redesign requirements

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

## Constraints carried into the redesign

- KISS/YAGNI: no new subsystems, no per-task timeout policies, no message bus. Only the failure modes
  observed above.
- The lead is the child's human: children stay headless; every question routes to lead or cockpit.
- Everything is verifiable with a live DAG run (the evidence goal re-run is the validation case).
