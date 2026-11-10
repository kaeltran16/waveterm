# Surface review follow-ups, round 4: fix plan

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix findings F1-F8 of `C:/Users/kael02/IdeaProjects/waveterm/cdp-shots/review/followups-4/report.md`
(gitignored; read it by that absolute path). Each was checked on HEAD 92cbb8591 before planning and still happens;
the UI ones (F3, F5) are re-confirmed live by their worker before the fix.

**Architecture:** Seven independent fixes across the wshserver prompt path, the run object, the agent tree model,
the orchestrator scheduler, the CDP harness, the Taskfile and the `wsh jarvis dag status` CLI. The decisions are
D1-D8 of the spec; each task names the ones it implements.

**Tech Stack:** Go (wshserver, orchestrate, wstore, wsh), React 19 + jotai, vitest, CDP scenarios, Taskfile.

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\79227e05\docs\superpowers\specs\2026-11-10-surface-review-followups-4-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/orchestrate ./pkg/wstore ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/...`
**Check:** `go build ./... && go vet ./pkg/orchestrate ./pkg/wstore ./pkg/waveobj ./pkg/wshrpc/... ./cmd/wsh/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs brief-composer-steer-only agent-tree-rail canvas-mark brainstorm-mode brainstorm-answer-boards brainstorm-builder-check`

## Global Constraints

- Logic is extracted, not rendered: pure `foo.ts` + `foo.test.ts`, thin `.tsx`.
- Colors and spacing from the `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens.
- Lint/format only the files you touched; keep prettier off `scripts/*.mjs`.
- Never attach to CDP :9222 (another session may drive that dev app). Verify UI against your own second dev app
  (docs/reference/cdp-verification.md, "a second dev app beside the main one"). Never stop `wave-tauri.exe` /
  `wavesrv.x64.exe` by image name; stop only a dev app you started, by PID.
- After changing a waveobj type, run `task generate` and commit the generated files with the change.
- Before fixing, confirm the finding still happens on your tree; if it does not, say so in your report and change
  nothing for it.

## Review Focus

- F1: no frontend caller of `AgentPromptCommand` swallows the refusal; no CDP fixture now fails because its made-up
  block is refused.
- F4: the new rule never lets a task start on a base missing one of its dependencies' commits. Early start becomes
  single-dependency only (spec D4): a fork still starts early on its predecessor's tip
  (`TestStartBaseForkStartsOnDonePredecessor` stays green); a join waits until every lane it depends on merged.

---

### Task 1: The server refuses a prompt to a block no terminal can take (F1)
**Depends on:** none
**Chunk:** A cockpit prompt to a block that no longer exists is accepted and dropped silently: AgentPromptCommand (wshserver_agentmsg.go) returns nil for any block id outside a snapshot store, the typing fails later in a goroutine that only logs, and the Brief composer posts a directive though nothing reached a terminal. Reject an unknown block on the server (6 frontend callers; check the CDP fixtures that send to bogus blockIds).
**Files:** `pkg/wshrpc/wshserver/wshserver_agentmsg.go`, `pkg/wshrpc/wshserver/wshserver_agentmsg_test.go`, `pkg/wshrpc/wshserver/snapshotguard_test.go`, `frontend/app/view/agents/headercontrols.tsx`, `frontend/app/view/agents/agentcomposer.tsx`, `frontend/app/view/agents/agentsend.ts`, `frontend/app/view/agents/agentsend.test.ts`, `frontend/app/view/agents/brainstormsend.ts`, `frontend/app/view/agents/brainstormsend.test.ts`, `frontend/app/view/agents/canvassend.ts`, `frontend/app/view/agents/canvassend.test.ts`, `frontend/app/view/agents/commentsend.ts`, `frontend/app/view/agents/commentsend.test.ts`, `frontend/app/view/code/codepathbar.tsx`, `frontend/app/view/code/codereviewstore.ts`, `frontend/app/view/code/codereviewstore.test.ts`
**Files:** `scripts/cdp/scenarios-brief.mjs`, `scripts/cdp/scenarios-agent.mjs`, `scripts/cdp/scenarios-shared.mjs`, `scripts/cdp/scenarios-brainstorm.mjs`, `scripts/cdp/scenarios-brainstorm-builder.mjs`, `scripts/cdp/scenarios-brainstorm-judge.mjs`, `scripts/cdp/scenarios-brainstorm-review.mjs`, `scripts/cdp/scenarios-files.mjs`, `scripts/cdp/scenarios-files-states.mjs`, `scripts/cdp/scenarios-runs.mjs`

Implements spec D1.

- [ ] `AgentPromptCommand` (wshserver_agentmsg.go ~line 285) refuses, before calling `deliverAgentMessage`, a block
  id that is not in the store, or that has neither a running block controller
  (`blockcontroller.GetBlockControllerRuntimeStatus(...).ShellProcStatus == Status_Running`) nor a mod stream
  (`agentctl.Has`). The error names the block and says nothing was sent. Read both facts through package vars
  (the file's existing `var tabAgentBlock = readTabAgentBlock` pattern) so the test scripts them. Keep the snapshot
  refusal as it is.
- [ ] Go tests in `wshserver_agentmsg_test.go`: a missing block is refused and `deliverAgentMessage` is never
  called; a stored block with no controller and no stream is refused; a stored block with a running controller is
  delivered; one with only a stream is delivered. Existing tests that prompt a stored block and expect delivery
  must script the new vars as live (controller running or stream present), not be weakened:
  `TestSnapshotRefusesAgentPromptOutsideScratch` and `TestNoSnapshotLeavesHandlersOpen` in `snapshotguard_test.go`,
  and the `agentsBlockB` case in `wshserver_agentmsg_test.go` (~line 222). Run
  `go test ./pkg/wshrpc/wshserver -run '<your test names>|SnapshotRefusesAgentPrompt|NoSnapshotLeavesHandlersOpen|<the agentsBlockB test>'`.
- [ ] Check every frontend caller of `AgentPromptCommand` and of `sendAgentText` (`agentsend.ts`,
  `brainstormsend.ts`, `canvassend.ts`, `commentsend.ts`, `codepathbar.tsx`, `codereviewstore.ts`, and the two the
  review found swallowing it: `headercontrols.tsx` ~line 61, which only logs in `.catch`, and `agentcomposer.tsx`
  ~line 31, which logs and keeps the text but shows nothing): a refusal must reach the user (a status/error the UI shows, or a
  rethrow to a caller that shows it) and must not be followed by any "sent" side effect. Fix any that swallows it,
  showing the error in the place that caller already shows status or errors (existing tokens and components only);
  add a vitest case per fix in its existing test file, or extract the decision to a pure helper with a test where the
  caller is a component with no test file.
- [ ] The Brief composer (`steerWorker` in channelactions.ts already sends before it posts) needs no code change.
  `brief-composer-steer-only` step 2: remove the `failRpc(h, "AgentPromptCommand", ...)` stub and its release so
  the real server refuses `fx-blk-steer-gone`; additionally assert no `directive` post reached the channel after
  the send (read the channel's posts before and after). Keep the existing status and draft conditions.
- [ ] CDP fixtures: grep `scripts/cdp` for every scenario whose page sends `agentprompt` (directly, or through
  the send helpers above) without stubbing it. For each, check the target block exists and has a running
  controller or stream in the isolated app. Where it does not, fix the fixture (create a real block, stub the
  RPC as the scenario's other stubs do, or expect the refusal), never the server rule. At minimum run
  `canvas-mark`, `brainstorm-mode`, `brainstorm-answer-boards` and `brainstorm-builder-check` against your own
  dev app with `task verify:ui -- <scenario>`, and report each scenario you changed.
- [ ] Acceptance: the Go tests pass; `brief-composer-steer-only` passes with the stub removed; the four scenarios
  above pass in Final.

### Task 2: A task with dependencies in more than one lane waits for a base that holds all of them (F4)
**Depends on:** none
**Chunk:** Orchestrator: a task with two dependencies, one of them a lane not yet landed, started from that lane's branch instead of the run branch with both in it (run 5195e068 t-3 lacked t-1's commit and had to merge the run head).
**Files:** `pkg/orchestrate/scheduler.go`, `pkg/orchestrate/scheduler_test.go`, `pkg/orchestrate/earlyready_test.go`, `pkg/orchestrate/lane_test.go`, `pkg/orchestrate/digestearly_test.go`, `pkg/orchestrate/earlyrestart_test.go`

Implements spec D4.

- [ ] The repro already exists and asserts the bug: `TestStartBaseJoinOneUnmergedPredecessor`
  (`earlyready_test.go` ~line 84: t-1 merged, t-2 `Reviewing` with a RunID and unmerged, t-3 depends on both;
  asserts base t-2, `true`). Rewrite it to the fixed behaviour (`nil, false`; rename it to say the join waits),
  run it on HEAD first and confirm it fails, then fix. This is the one intended behaviour change; say so in the
  test's comment.
- [ ] Fix `startBase`: an early start on an unmerged lane's tip is allowed only when every cross-lane dependency
  of the task lies in that one unmerged lane; any dependency satisfied by its lane having merged, or a second
  unmerged lane, means the task waits until every cross-lane lane has merged and then starts on the landing head
  (`nil, true`). Same-lane dependencies keep their current rule. Update the function's doc comment to state the
  rule and why (a lane tip's branch holds nothing merged after the lane started).
- [ ] Tests: the rewritten repro; `TestStartBaseForkStartsOnDonePredecessor` stays green unchanged (a fork still
  starts early); once t-2's lane merges, t-3 starts with `nil, true`; `ReadyTasks` excludes t-3 while it waits.
  Check the merged-plus-unmerged cases in `lane_test.go` (~lines 90 and 142), `digestearly_test.go` (~line 67)
  and `earlyrestart_test.go` (~line 109): any that asserts a join starting early is updated to the new rule with a
  comment; any that is a fork stays as it is. Run
  `go test ./pkg/orchestrate -run 'StartBase|ReadyTasks|Early|Lane'`.
- [ ] Acceptance: those tests pass; the only assertions changed are joins that started early under the old rule,
  each listed in your report.

### Task 3: CDP boot wait includes the RPC client; go mod tidy waits for the mod copy (F6, F7)
**Depends on:** none
**Chunk:** final-verify boot race: the first scenario after the isolated app boots can find window.TabRpcClient unset ('reading wshRpcCall'); 'nav rendered' can precede it (attach.mjs/final-verify.mjs)
**Chunk:** task dev boot race: go:mod:tidy can run while sync:claudemod recopies cmd/wsh/cmd/claude-skim-mod, failing once with 'no matching versions for query latest'
**Files:** `scripts/cdp/attach.mjs`, `scripts/cdp/attach.test.mjs`, `scripts/cdp/final-verify.mjs`, `Taskfile.yml`

Implements spec D5 and D6.

- [ ] F6: export one helper from `scripts/cdp/attach.mjs`, `waitBooted(ev, ms = NAV_WAIT_MS)`, that resolves true
  once the nav has rendered AND `window.TabRpcClient` is set, false past `ms` (built on the existing `waitFor`).
  `reload` and `goto` use it in place of their inline `NAV_RENDERED` waits (reload keeps its
  `!window.__cdpReloading` guard). `attach()` itself has no boot wait today: add a `waitBooted` call there before
  it returns, throwing an error that names what was missing (nav or TabRpcClient) on timeout, so a scenario whose
  arrange calls `h.rpc` before any `goto` never runs before the client exists. Touch `final-verify.mjs` only if its
  own boot wait needs the same condition. No retry.
- [ ] Test in `attach.test.mjs`: with a fake `ev`, `waitBooted` stays pending while the nav is rendered but
  `TabRpcClient` is unset, resolves true once both are, and resolves false past a short `ms`. Run
  `node --test scripts/cdp/attach.test.mjs` (match how the file is already run).
- [ ] F7: in `Taskfile.yml`, `go:mod:tidy` gains `deps: [sync:claudemod]` (a dependency, not a retry), so tidy can
  never run while the copy rewrites `cmd/wsh/cmd/claude-*`. Prove it with `task --dry dev` (or
  `task --dry build:backend:devhost`): `sync:claudemod` is listed before `go mod tidy`. Put the dry-run output's
  relevant lines in your report.
- [ ] Acceptance: the attach test passes; the Final stage (which boots an isolated app and runs scenarios that
  call `h.rpc` in arrange) passes its first scenario's arrange.

### Task 4: wsh jarvis dag status names why a held tip waits (F8)
**Depends on:** none
**Chunk:** wsh jarvis dag status prints a held tip as "merge held: waits on <holder>'s Verify" even when the holder is verify-failed or in a merge conflict; the cockpit's mergeGateLine names the reason (taskSignal does not see the holder's state)
**Files:** `cmd/wsh/cmd/wshcmd-jarvisdag.go`, `cmd/wsh/cmd/wshcmd-jarvisdag_test.go`

Implements spec D7.

- [ ] `taskSignal` (wshcmd-jarvisdag.go ~line 447) gets the holder's state (its caller at ~line 299 has the group's
  tasks; pass the holder's state, or a lookup, not the whole group if a string will do). A held tip reads
  `merge held: waits on <holder>'s <reason>` with reason `Verify` for `verifying`, `failed Verify` for
  `verify-failed`, `merge conflict` for `blocked-merge` (one Go map, the cockpit's `MERGE_HOLD_REASON` words), and
  `merge held` alone for any other or unknown holder state.
- [ ] Tests in `wshcmd-jarvisdag_test.go`: one case per reason (three), plus the unknown-state case; the existing
  cases keep passing. Run `go test ./cmd/wsh/cmd -run 'TaskSignal'` (match the existing test's name).
- [ ] Acceptance: those tests pass.

### Task 5: The run carries its plan title; the Brief composer names the lead by it before the dag loads (F2)
**Depends on:** Task 1
**Chunk:** Brief composer: a send made before the run's dag loads names the lead by its tab name, not its plan title (runInfoAtom not loaded yet).
**Files:** `pkg/waveobj/wtype.go`, `pkg/wstore/wstore_dag.go`, `pkg/wstore/wstore_dag_test.go`, `pkg/orchestrate/planreview.go`, `pkg/orchestrate/planreview_test.go`, `frontend/types/gotypes.d.ts`, `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`, `frontend/app/view/jarvis/briefcomposertarget.ts`, `frontend/app/view/jarvis/briefcomposertarget.test.ts`, `scripts/cdp/scenarios-brief.mjs`

Implements spec D2.

- [ ] `waveobj.Run` gains a `Title string` field with json tag `title,omitempty`: the plan's title, set where the owning run's
  `DagORef` is set at first submit (`pkg/wstore/wstore_dag.go` ~line 105, from the proposed dag's title) and again
  where a revised plan replaces the dag's title (`pkg/orchestrate/planreview.go` ~line 799,
  `g.Title = proposed.Title`: update the owning run's `Title` in the same mutation). Child runs do not need it. Run
  `task generate`; commit `frontend/types/gotypes.d.ts`. Go tests: in `wstore_dag_test.go`, after submit the owning
  run's `Title` equals the dag's; in `planreview_test.go`, after a revised plan with a new title is accepted, the
  owning run's `Title` is the new one.
- [ ] Frontend: `runTitle(run, dag)` prefers `dag.title`, then `run.title`, then the goal's first line (effort refs
  stripped as today). `runInfoOf` records on `RunInfo` (a new optional field) whether its title is a plan title
  (dag loaded, or the run has a `title`); `leadDisplayName` returns `run.title` when that is set (or the dag has
  loaded, as today) and the tab name otherwise. Keep `runTitle` and `leadDisplayName` callable exactly as today, so
  none of their other callers (agentheader.tsx, agenttree.tsx, leadcard.tsx, runsheet.tsx, runreport.ts,
  briefrows.ts, `cockpit/actions/run.ts` ~line 156, ...) has to change: because the knowledge is on `RunInfo`, they
  all get the fix, `cockpit/actions/run.ts` included. `resolveBriefComposerTarget` needs a change only if `info`
  can be undefined while the run is known; if so, derive the info from `input.run` there.
  Tests: `runlineage.test.ts` (title order; `runInfoOf` + `leadDisplayName` with a run `title` and no dag -> plan
  title; no title and no dag -> tab name) and `briefcomposertarget.test.ts` (info built from a run with `title` and
  no dag -> plan title; without -> tab name).
- [ ] `brief-composer-steer-only` step 2: drop the `until(dagLoaded, ...)` wait and send as soon as the composer
  mounts; the step still requires the status to read `${STEER_PLAN_TITLE} is no longer live — nothing was sent.`
  Keep Task 1's refusal assertions. Run it against your own dev app (`task verify:ui -- brief-composer-steer-only`).
- [ ] Acceptance: the unit tests pass and `brief-composer-steer-only` passes in Final.

### Task 6: A worker tab joining its run is placed from its first frame; the fixture tab is a real block (F3, F5)
**Depends on:** Task 1, Task 5
**Chunk:** Agent tree: a worker tab joining its run first renders as its own row below the run's agents, then about 250 ms later moves into the task's worker row and slides up (a visible jump; agent-tree-rail 9b measured it settling by 965 ms).
**Chunk:** agent-tree-rail fixture: the injected worker tab's header and rail read 'failed to start' / 'error getting block: not found' because the fixture tab's blockId does not exist (no assertion reads it; the shot shows it).
**Files:** `frontend/app/view/agents/agenttreemodel.ts`, `frontend/app/view/agents/agenttreemodel.test.ts`, `frontend/app/view/agents/runlineage.ts`, `frontend/app/view/agents/runlineage.test.ts`, `frontend/app/view/agents/runlineagestore.ts`, `scripts/cdp/scenarios-agent.mjs`, `scripts/cdp/scenarios-shared.mjs`

Implements spec D3 and D8.

- [ ] Confirm both live first: run `agent-tree-rail` against your own dev app and record, from the step 9b/9c
  samples and the `agent-tree-rail-p12-worker-header.png` shot, the intermediate row and the header error.
- [ ] F3: find what places the injected worker tab late (likely its role resolves only once its child run object
  loads: `runRoleOf` in runlineage.ts and how `agenttreemodel.ts` reads it). Fix it in the model so the tab is in
  its task's worker row from its first frame, using data the tree already has (the lead's dag lists each task's
  `runid`), or hidden until it can be placed; never a standalone row that later moves. Unit test the
  not-yet-loaded case in `agenttreemodel.test.ts` (and `runlineage.test.ts` if the fix is there).
- [ ] F3 scenario: tighten agent-tree-rail step 9c so it samples the tree from the moment of the inject (an
  in-page sampler started before `devMockAgentsAtom` is set, e.g. a requestAnimationFrame loop) and fails on any
  sampled frame in which the worker tab renders anywhere but t-1's worker row. Keep the overlap check.
- [ ] F5: the injected worker tab gets a real block created in the scenario (and deleted in teardown, also when the
  step fails) in place of `fx-blk-tree-worker-t1`, so the header reads as a running worker. Add a step asserting
  the worker header and rail show no error text (`failed to start`, `error getting block`). Per Task 1's refusal, a
  prompt to that tab must either reach the block or be refused; do not stub around it.
- [ ] Run `npx vitest run frontend/app/view/agents/agenttreemodel.test.ts frontend/app/view/agents/runlineage.test.ts`
  and `task verify:ui -- agent-tree-rail` against your own dev app.
- [ ] Acceptance: the unit tests pass; every `agent-tree-rail` step passes in Final, the tightened 9c and the new
  header step included.
