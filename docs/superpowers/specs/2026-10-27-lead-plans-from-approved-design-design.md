# The lead plans from an approved design

## Intent and why

An orchestrator run's lead does three jobs today: it designs the goal with the human (`superpowers:brainstorming`,
a `Spec review`, often `arc:design` boards), writes the plan, then supervises the DAG for hours. The design
conversation is the wrong context for the other two, and the goal-run path is the only place it can happen inside a
run, so goals were written to force it ("start with the arc:design skill"), including for work that needed only a
mockup or only a brainstorm.

The split: design happens with the human in a design session (the brainstorm pane, or a canvas); the run's lead
never holds a design conversation. It plans from an approved design, then supervises. Planning and supervision stay
in one agent because both need the same knowledge: the spec, the code, and the plan.

## What runs today

- The asking lead prompt opens with "Work this goal with the superpowers:brainstorming skill" and ends the
  architectural path with a `Spec review` approval, also when the goal names a mockup that settles the design
  (`writeAskingPaths`, `pkg/jarvis/leadprompt.go`).
- An approved brainstorm prefills the launcher with the goal "Build X as specified in <spec>" and the first board as
  the prototype (`runPrefill`, `frontend/app/view/agents/brainstormmodel.ts`); a canvas's Build this… prefills
  `buildGoal` and `prototype` (`openBuildRun`, `canvaspane.tsx`). The prototype is a field (`Run.Prototype`); the
  spec exists only as prose in the goal, which the launcher lets the human edit away.
  `BuildOrchestratePrompt(goal, principles, runtime, autonomous)` receives neither field, so the lead infers from
  prose whether it was handed an approved design.
- Plan review, prod store, 115 DAGs: 21 passed in round 1, 49 in round 2, 45 failed both and proceeded on the
  human's accept (26 of 52 in October). The five latest accepted findings are code grounding: wrong struct and
  function names, a file missing from a Files line, two tasks disagreeing on an interface.
- The handoff `/compact` (`HandoffCompact`, `pkg/orchestrate/wake.go`) is typed when the plan review passes or is
  accepted (`handOffLead`, `planreview.go`), or at a no-review submit (`postLeadHandoff`, `wshserver_dag.go`). It does
  not hold the workers: across 114 runs the first worker spawned a median 5s after the pass (p90 37s). Across 32 lead
  transcripts it cut a median 214k context (max 483k) to 66k, which then grew a median 51k over ~70 turns.

## Roles

| Role | Who | Starts from | Ends with |
|---|---|---|---|
| Designer | an interactive agent: the brainstorm pane (`superpowers:brainstorming` + `arc:brainstorm`), or `arc:design` for a canvas | the human's idea | an approved spec, a mockup, or both |
| Lead | the run's lead | an approved design, or a goal that needs none | the plan, then the wakes until land |
| Engine | `pkg/orchestrate` | the plan | unchanged |

## Entry points

| The work needs | Where | Becomes a run by | The lead gets |
|---|---|---|---|
| a brainstorm only | brainstorm pane, no boards | Approve | `Run.Spec` |
| a design only | `arc:design` canvas | Build this… | `Run.Prototype` |
| both | brainstorm pane with boards | Approve | `Run.Spec` + `Run.Prototype` |
| nothing, or unclear | + Run → Orchestrator → A goal | Start | the goal |

A design session is normal (the human started it in chat) or linked (a run started it and waits on it). Approve and
Build this… behave by which one it is.

## Decisions

1. **`Run.Spec` is a field, mirroring `Run.Prototype`.** `CommandCreateRunData.Spec` and `Run.Spec` carry the
   approved spec's absolute path; orchestrator runs only, refused on quick. At `dag submit`, `run.Spec` wins over the
   lead's `--spec`, as `run.Prototype` already wins over the plan's line (`wshserver_dag.go`). `wsh runs start` gets
   `--spec`, beside `--prototype`. Why: whether a design exists becomes a fact the engine holds, so the lead's path
   is chosen in code, not inferred from prose.

2. **The lead's prompt branches on the fields.** `BuildOrchestratePrompt` takes the run.
   - `Spec` or `Prototype` set: the plan-from-design prompt. The design is approved; no brainstorming, no
     classification, no `Spec review`. Read the design and the code it touches, write the decisions made beyond it
     into the plan's header, then the existing `writePlanAndSubmit` (with `--spec` when a spec is set). The same
     prompt with `AutonomousRules` when the run is autonomous.
   - Neither set: the goal prompt. Its first line no longer names `superpowers:brainstorming`: the human is at the
     terminal and every question goes through the ask tool. Spike and bounded are unchanged. A feature goal (the
     architectural path) asks once, header `Needs a design`, with three options: `Brainstorm it`, `Mock it up`, `Plan
     from the goal`. The first two hand the run to a linked design session (decision 4). `Plan from the goal`: the
     lead makes the design calls itself, records each with why in the plan's header, and submits without `--spec`.
   - Autonomous goal runs keep today's autonomous paths: with nobody to talk to, the lead's design work is code
     reading, which supervision needs anyway.

3. **Launcher start "Approved design".** Beside Goal and Plan, shown only when a prefill brings a design: the spec
   and/or prototype read-only, the goal editable (it names the run), project, width, routes and approvals as today.
   It sends `Spec` and `Prototype` as fields, never as goal prose. A normal session's Approve and Build this… open
   the launcher on it.

4. **A run can wait on a linked design session.**
   - `Run.Design` records the wait: `{kind: brainstorm|canvas, blockid}`, where `blockid` is the linked session's
     terminal. A run with `Design` set is in status `planning` with no lead and no dag; the cockpit shows it as
     Designing, with a link to the session. No new run status.
   - Two ways in. At launch: a "Design first" choice (Brainstorm | Mock up) on the Goal start creates the run with
     `Design` and starts the session instead of the lead. From the lead: `Brainstorm it` / `Mock it up` runs
     `wsh jarvis design --kind brainstorm|canvas`, which starts the session, sets `Design`, and closes the lead's tab;
     the lead does not wait. One server function serves both.
   - The session is an interactive agent in the project, started without `ARC_RUN_AGENT` so the pane and its hook
     context apply, prompted with the goal: brainstorm it (`superpowers:brainstorming`), or mock it up with
     `arc:design`.
   - Approve in that session's pane, or Build this… on its canvas, checks the store for a run whose `Design.blockid`
     is the session's block. Found: it calls one RPC that sets `Spec`/`Prototype`, clears `Design`, records a run
     event, and starts a fresh lead with the plan-from-design prompt; no launcher. Then `brainstorm: run <id>` as
     today. Not found: the normal session's launcher (decision 3). The lookup is code; the agent never judges whether
     it is linked.
   - Refused: Design first on an autonomous run (nobody to design with), `wsh jarvis design` on an autonomous run,
     and the attach RPC on a run that is not waiting on a design. Cancelling a designing run cancels it like any
     planning run; the session's tab stays, as a normal session.

5. **The handoff compaction stays, rewritten for a lead that planned.** `handoffInstructions` becomes: keep the
   interfaces and files each task relies on, why the plan is split as it is, and the human's answers to the lead's
   own asks; drop tool output, plan drafts and code bodies. The mechanism (`PostHandoff`, its call sites) is
   unchanged. Why: the compaction does not block workers, and it saves its context on each of ~70 wakes. With the
   design conversation upstream its remaining cut is the planning reads, whose size is unmeasured. Removing it is a
   follow-up, decided on numbers (Follow-up).

6. **Docs and skills follow.** `docs/orchestrator-guide.md`: the rows and sections that say the lead brainstorms
   (the "A goal that still needs design decisions" row, the Lead model row, "The lead brainstorms with you", the path
   classification, the handoff paragraph) describe the new flow. `skills/brainstorm/SKILL.md`: on a linked session,
   Approve attaches the design to the waiting run instead of opening the launcher. `skills/design/SKILL.md`: the same
   for Build this… on a linked canvas.

## Out of scope

- Removing the handoff compaction (Follow-up).
- Quick runs, plan-file runs (`--plan`), and the engine after submit.
- The brainstorm pane's and canvas's own UI beyond Approve / Build this… routing and the Designing link.
- `AgentControlMsg.Compact` and the mods' compaction support.

## Testing

- `pkg/jarvis`: the plan-from-design prompt for `Spec`, `Prototype` and both, asking and autonomous: no
  `brainstorming`, no `Spec review`, the paths named, `--spec` only with a spec. The goal prompt: no
  `superpowers:brainstorming`, the `Needs a design` ask and its three options; autonomous unchanged.
- `pkg/wshrpc/wshserver`: CreateRun stores `Spec`, refuses it on quick, refuses Design first on autonomous, starts
  no lead for Design first; `run.Spec` wins at `dag submit`; the attach RPC starts exactly one lead and refuses a run
  not waiting; `wsh jarvis design` sets `Design` and closes the lead tab.
- `pkg/orchestrate`: the handoff instructions' new text.
- Frontend, pure models: `launchOptsFromConfig` for the Approved design start; the Approve / Build this… router
  (linked run found → attach, else launcher).
- CDP scenarios: the launcher's Approved design start with a spec and a prototype; a designing run on the run sheet
  with its session link.

## Follow-up

Record each run's lead context at submit and its supervision quality (answers the human overruled) for the first
runs after this lands. If plan-only leads submit under ~100k, remove the handoff compaction (`HandoffCompact`,
`PostHandoff` and its three call sites); otherwise it stays.
