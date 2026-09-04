# A Claude Code lead on the DAG engine, end to end

**Captured live on 2026-09-04** against the `task dev` app over CDP (`:9222`), at 1600×950. Every
value below comes from a real `wshrpc` call, a real block-meta read, the lead's real terminal
scrollback, or the scratch repo's real git history — nothing is mocked or reconstructed.

This is the proof for `docs/superpowers/plans/2026-09-04-claude-lead-dag-engine.md`. Before that
change the DAG engine could only be driven by a **pi** lead, because `BuildOrchestratePrompt` forked
on runtime alone. The question here is whether a **Claude Code** lead, told to use the engine,
actually publishes a `TaskGroup`, parks on the wake loop, and drives children to merge.

**It does.** It also surfaced one real defect in the wake protocol, recorded in full in
[§6](#6-what-did-not-work-the-wake-reason-at-the-merge-gate).

- **Channel:** `#claude-lead-e2e` (`4053139d-c0ca-459e-8e30-a604617c2366`)
- **Project:** `C:\Users\kael02\IdeaProjects\dag-e2e-scratch` — a throwaway repo created for this
  capture, so no real work was at risk
- **Base commit:** `704ed1d21f6b4ce81b3ef871838f9b9730be3d57`
- **Run:** `cf139597-67a0-487c-9234-a6b612111bec` · `mode=orchestrator` ·
  **`orchestration=engine`** · `runtime=claude` · `tier=capable` · workers `Same as lead`
- **Lead model** (from its own status line): `Opus 5 (1M context)`
- **DAG:** `e09befb0-0e21-485e-9dd0-4c13da1ce758` · 4 tasks · `parallelism=4` · `mergeRequired=true`
- **Outcome:** run `done`; all 4 children merged; 18/18 tests pass on the scratch repo's `main`

> Screenshots live in `cdp-shots/`, which is **gitignored** — the image links below resolve only on
> the machine that captured them. This matches the `docs/jarvis-orchestrator-plan-e2e.md` convention.

---

## The goal

> Add four independent string helpers, each in its OWN new file under `src/` with a matching test file
> beside it: `src/slugify.js` (slugify), `src/truncate.js` (truncate with ellipsis),
> `src/camelcase.js` (camelCase), `src/countwords.js` (countWords). Each file exports exactly one
> function and has a sibling `.test.js` using vitest. Follow the style of the existing
> `src/strings.js` and `src/strings.test.js`. Do not edit `src/strings.js`.

Deliberately shaped so **no two tasks touch the same file**, keeping the capture about the engine
rather than about merge-conflict handling. That shape turned out to matter — see §6.

## Setup, as driven

The channel was created over RPC and the lead route pinned as a **channel-scoped** override, so the
operator's global harness preference was never touched:

```js
createchannel      { name: "claude-lead-e2e", projectpath: "C:\\Users\\kael02\\IdeaProjects\\dag-e2e-scratch" }
setchannelprofile  { channelid: "4053139d-…", override: { route: { runtime: "claude", tier: "capable" } } }
```

Everything after that was driven through the real composer.

> **Note:** a channel created over RPC does not appear in the Subjects column until the page reloads.
> Channels created through the UI do. Not investigated — it is a capture-harness inconvenience, not
> something this change touches.

---

## 1. The composer sent `orchestration=engine`

Shape `Orchestrator` reveals the new `Engine | Adaptive` toggle. `Engine` keeps the `Lead → Workers`
row (a worker route is only read when the engine spawns children) and the footer reads
`→ engine DAG · lead capable · workers same as lead`.

![Composer before Run](../cdp-shots/e2e-before-run.png)

The field survives to the persisted `Run`:

```json
{ "id": "cf139597-67a0-487c-9234-a6b612111bec", "status": "executing", "mode": "orchestrator",
  "runtime": "claude", "tier": "capable", "orchestration": "engine",
  "basecommit": "704ed1d21f6b4ce81b3ef871838f9b9730be3d57" }
```

## 2. The lead got the engine prompt, not the adaptive one

Read back from the lead block's `cmd:args` — `claude --dangerously-skip-permissions <prompt>`, with
`cmd:cwd` the scratch repo and `cmd:keeponexit: true` so the tab outlives the lead process. The
engine-fork lines, verbatim:

> Two hard limits shape the plan … **a DAG holds at most 16 tasks**, and one orchestrator run holds
> exactly one DAG for its whole lifetime …
>
> Write the DAG as JSON to a file and submit it with `wsh jarvis dag submit --file <path>`. The JSON
> is an object with `title`, `parallelism` (1-8), and `tasks`, each task
> `{"id": "t-1", "label": "...", "description": "...", "deps": ["t-0"]}`.
>
> Then loop: run `wsh jarvis dag wait`, do exactly what it reports, and wait again. Stop when it
> reports a line beginning `woke: terminal:`. …
>
> … when the digest reports `merge`, run `wsh jarvis dag merge <task-id>` with the reported id …

The 16 comes from `jarvis.MaxDagTasks`, which `orchestrate.MaxTasks` now aliases, so the prompt
states the ceiling the engine actually enforces rather than a second hard-coded copy.

## 3. The lead planned, wrote a file, and submitted it

Every `wsh jarvis dag` invocation the lead made, in order, from its terminal:

```
wsh jarvis dag submit --help ; wsh jarvis ctx      (orienting)
wsh jarvis dag submit --file "…/scratchpad/dag.json"
wsh jarvis dag wait
wsh jarvis dag status
wsh jarvis dag merge --help ; git worktree list
wsh jarvis dag wait
```

The file it wrote is 16,891 bytes and matches the prompt's schema exactly:

```
top-level keys: title, parallelism, tasks
title:          "Four independent string helpers"
parallelism:    4
task keys:      id, label, description, deps
  t-slugify     "slugify"     deps=[]  description 3,696 chars
  t-truncate    "truncate"    deps=[]  description 4,249 chars
  t-camelcase   "camelCase"   deps=[]  description 4,143 chars
  t-countwords  "countWords"  deps=[]  description 3,821 chars
```

Those descriptions take the prompt's "the child never has to rediscover the broad goal" instruction
seriously — each carries the broad goal, `src/strings.js` reproduced verbatim as style evidence, hard
constraints, pinned decisions (including *why* diacritic folding is deliberately omitted), a
reference implementation, and the exact verification command.

The engine accepted it and created one managed worktree and branch per task:

```
.waveterm/worktrees/cf139597-…-t-slugify      wave/cf139597-…-t-slugify
.waveterm/worktrees/cf139597-…-t-truncate     wave/cf139597-…-t-truncate
.waveterm/worktrees/cf139597-…-t-camelcase    wave/cf139597-…-t-camelcase
.waveterm/worktrees/cf139597-…-t-countwords   wave/cf139597-…-t-countwords
```

## 4. `wait` stayed blocked through four child spawns

This is the design point the feature turns on, and it held. With all four children spawned and
running, the live digest read:

```json
{ "health": "healthy",
  "counts": { "total": 4, "done": 0, "running": 4, "mergeready": 0 },
  "next": { "kind": "parallelism-wait",
            "blockingtaskids": ["t-slugify","t-truncate","t-camelcase","t-countwords"] } }
```

`next.actions` is absent, so `waitDecision` returns `false` and the lead stayed parked — even though
each spawn published a `dag:task-spawned` event that woke the subscriber loop. **The event wakes the
loop; the digest makes the decision.** No spurious return, no polling.

## 5. The outcome

All four children merged and the run reached `done`:

```
979b767 docs: plan for the four string helpers
04416c3 run cf139597-…-t-countwords: countWords
5c595f7 run cf139597-…-t-camelcase: camelCase
9f5b9f5 run cf139597-…-t-truncate: truncate
aa08f18 run cf139597-…-t-slugify: slugify
704ed1d chore: scratch project for DAG engine e2e
```

`src/` holds all eight expected files, `strings.js` untouched, and every managed worktree was cleaned
up (`git worktree list` shows only `main`). The produced code works:

```
✓ src/truncate.test.js (4)   ✓ src/strings.test.js (2)   ✓ src/camelcase.test.js (4)
✓ src/countwords.test.js (4) ✓ src/slugify.test.js (4)
Test Files  5 passed (5)     Tests  18 passed (18)
```

---

## 6. What did not work: the wake reason at the merge gate

**The plan expected `dag wait` to return `woke: action:merge-ready` when the gate opened. It returned
`woke: terminal:healthy` instead — a stop signal — with four children still unmerged.**

The two real wake lines from the lead's terminal, in order:

```
woke: terminal:healthy
dag e09befb0-… status=running tasks=4/4 …

woke: terminal:done
dag e09befb0-… status=done tasks=4/4 …
```

The first one is wrong twice over: the DAG was `status=running`, not terminal, and `healthy` is a
*health*, not a terminal status. Per its own prompt — *"Stop when it reports a line beginning
`woke: terminal:`"* — the lead should have stopped there, leaving four unmerged worktrees.

### Root cause

Two layers combine, and only the second is new code.

**`buildNext` has no condition for "all tasks done, merges pending, nothing blocked"**
(`pkg/orchestrate/digest.go:292`). Its merge-ready branch is gated on `mergeReadyBlocking(g)`, which
returns *pending tasks whose dependency chain reaches a merge-ready task*. This DAG is flat — every
task has `deps: []` — so there are no pending tasks at all, the branch never fires, and `buildNext`
falls through its dispatch / parallelism-wait / dependency-wait cases to the terminal default. Since
`g.Status` was still `running`, that default returns a **bare** `DagNextStep{Kind: "terminal"}` with
an empty `TerminalStatus`. Note `mergeReadyIDs(g)` would have returned all four ids — the information
was there; the condition guarding it was too narrow.

**`waitDecision` turns that bare marker into a confident stop**
(`cmd/wsh/cmd/wshcmd-jarvisdag.go`). It treats any `Kind == "terminal"` as terminal and, when
`TerminalStatus` is empty, substitutes `d.Health` — manufacturing the nonsense reason
`terminal:healthy`. This is new code from Task 4, and it is the part that actively misled the lead.

### Why the run still succeeded

The lead ignored the stop signal. It ran `wsh jarvis dag status`, saw four merge-ready tasks, read
`dag merge --help`, merged all four, and waited again — that second wait returned the legitimate
`woke: terminal:done`. **The model recovered by being sensible, not because the protocol worked.** A
lead that followed its instructions literally would have stopped and stranded the work.

### Suggested fix — applied 2026-09-04 (`d966c27e`)

> The fix below was taken as written: `buildNext` gained a second `merge-ready` branch that fires
> whenever `mergeReadyIDs(g)` is non-empty, ranked below dispatch and parallelism-wait so a DAG that
> can still spawn is never reported as needing the lead, and the old bare-`terminal` fall-through
> became a typed `cleanup-wait` step. `waitDecision` was left alone, exactly as the caveat below
> asks. The rest of this section is the original analysis, kept as the record.

The narrow fix belongs in the digest, not in `wait`: report `merge-ready` with `resolve-merge`
actions whenever `mergeReadyIDs(g)` is non-empty, regardless of whether a successor is blocked. Then
`waitDecision` returns `action:merge-ready` exactly as the plan intended.

Tightening `waitDecision` alone would be wrong — if it stopped treating a bare `terminal` as
terminal, this DAG would report no action and no terminal state, and the lead would block forever on
a wake that never comes. That is worse than the current behaviour, which is why this is left as a
decision rather than a patch.

`waitDecision`'s unit tests (`TestWaitDecision`) pass and remain correct: they assert the mapping for
digests that are well-formed. This case is a digest the tests never contemplated — `Kind: "terminal"`
with an empty `TerminalStatus` on a running DAG.

## 7. Also worth recording: the folder-trust gate

The lead's first run did nothing at all. Its terminal held:

```
Accessing workspace: C:\Users\kael02\IdeaProjects\dag-e2e-scratch
Quick safety check: Is this a project you created or one you trust?
❯ No, exit     Yes, I trust this folder
```

`SpawnRunWorker` passes `--dangerously-skip-permissions` precisely so a headless worker never blocks
here — its own comment names "the folder-trust dialog / per-tool prompts" as the reason the flag is
mandatory. But that flag covers **tool** permissions only; a directory Claude Code has never seen
still gets the trust gate, and the worker sat alive-but-idle with no signal that it was stuck.

> **Fixed 2026-09-04 (`50cdc2d8`).** `SpawnRunWorker` now calls `ensureClaudeDirTrusted` before
> launching a `claude` worker: it resolves Claude's own canonical-git-root project key (which maps a
> linked worktree back to its main repo, so one entry covers every worktree under it) and pre-registers
> the directory in `~/.claude.json` under Claude's `.lock` directory protocol, refusing to write if the
> file is malformed. The flag's comment was also corrected — it never covered directory trust.

Unblocked by sending `Down` then `Enter` to the block over `controllerinput`. This only bites on a
directory the operator has never opened in Claude Code — which is exactly what a fresh scratch repo
is, and would also be true of any newly created worktree-per-project setup. Not fixed here.
