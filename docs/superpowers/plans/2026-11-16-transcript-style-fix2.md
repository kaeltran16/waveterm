# Transcript style: fix round 2 (open issues)

**Effort:** effort:f283ad11-bcef-4053-b3f8-cda2e04998a2
**Verify:** `node scripts/verify.mjs ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered narration-feed motion-agent rendered-shell transcript-base transcript-initiative transcript-dag transcript-dagactions transcript-runs transcript-agents transcript-notes transcript-arc transcript-boards`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\rendered-view-style\project

Final passed on round 2. This round takes the open issues that are round work: defects and gaps in the
feature the run built, plus checks for behaviour that no scenario step exercises yet. It is the last round, so
every change stays small, and every added scenario step must be deterministic: seeded data, no wall-clock
values, no navigation away from the page.

Decisions:
1. **One shared card-facts control.** Seven modules draw the same duration plus "Show the command" control:
   `CallFacts` in agents, dag, dagactions, initiative and notes; `CardFacts` in runs; and inline in
   `wshchangerow.tsx`. dag draws `SquareTerminal` where the others draw `ArrowUpRight`. The single source is
   `CallFacts` exported from `wshchangerow.tsx`, drawing `ArrowUpRight`, and `WshChangeRow` uses it too. The
   agents copy has no compact size; it takes the shared component's compact sizes.
2. `wshcards-initiative.tsx`'s `statusTone` duplicates `chunkTone` (`frontend/app/view/jarvis/effortmodel.ts`).
   Use `chunkTone`.
3. **Step summaries come from the call's own output only.** A collapsed step row may carry a short summary
   between its command and its time. The Runs board draws "nothing waiting" there for an empty
   `wsh runs attention --json`. A summary is a pure function of the call and its own output. A collapsed row
   never fetches: a call without `--json` output has no summary.
4. **Mark anchoring uses `ts`.** `anchorMarks` (`permissionmodel.ts`) times an action by `startedTs`, which is
   set only while the call is pending. A finished action has no time, so a permission mark answered mid-stretch
   anchors to the next prose or user entry rather than after the call it allowed. Actions now carry `ts` (Task 2
   of the run), so a mark is placed against `ts ?? startedTs`.

### Task 1: One shared card-facts control
**Depends on:** none
**Files:** `frontend/app/view/agents/wshchangerow.tsx`, `frontend/app/view/agents/wshcards-agents.tsx`, `frontend/app/view/agents/wshcards-dag.tsx`, `frontend/app/view/agents/wshcards-dagactions.tsx`, `frontend/app/view/agents/wshcards-initiative.tsx`, `frontend/app/view/agents/wshcards-notes.tsx`, `frontend/app/view/agents/wshcards-runs.tsx`, `scripts/cdp/scenarios-transcript-initiative.mjs`

- `wshchangerow.tsx` exports `CallFacts({ action, compact }: { action: AgentActionEntry; compact: boolean })`
  (decision 1). Every family module and `WshChangeRow` use it, and no local copy remains. Grep for
  `function CallFacts`, `function CardFacts` and the `"Show the command"` label afterwards: the only definition
  is the shared one.
- `wshcards-initiative.tsx` uses `chunkTone` in place of `statusTone` (decision 2), and `statusTone` is deleted.
- A `wshcards-dag.tsx` import of `wshchangerow.tsx` must not re-create the cycle t-7 avoided
  (`wshrenderers` → `wshcards-dag` → `wshrenderers`). `wshchangerow.tsx` imports nothing from
  `wshrenderers.tsx`; keep it that way.
- Two new steps in `scenarios-transcript-initiative.mjs`:
  - **Show the command:** a click on a card's "Show the command" opens the tool detail modal holding the call's
    command, and Escape closes it.
  - **effort show from its own `--json` output:** a `wsh effort show <id> --json` step whose output carries an
    effort that is not seeded. Opening it draws the view from that output, with no "as of now" marker.

**Acceptance:** tsc clean; the vitest files of the touched modules pass; every scenario on the Final line passes
with `ARC_FINAL_OUT=<tmp dir>`, since every card family changes.

### Task 2: "nothing waiting" on the collapsed Runs step row
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/wshrenderers.tsx`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/runscards.ts`, `frontend/app/view/agents/runscards.test.ts`, `frontend/app/view/agents/wshcards-runs.tsx`, `scripts/cdp/scenarios-transcript-runs.mjs`, `scripts/cdp/scenarios-transcript-boards.mjs`

- Interface: `export type WshStepSummary = (call: WshCall, output: string | undefined) => string | undefined`.
  `wshrenderers.tsx` exports `WSH_STEP_SUMMARIES: Partial<Record<WshViewKey, WshStepSummary>>`, merged from
  family maps the way `WSH_RENDERERS` is. The runs family adds `runs-attention`, whose summary comes from a pure
  function in `runscards.ts`.
- The step row draws a summary, when one exists, between the command and the time, in `text-muted`
  (decision 3). This is the Runs board's collapsed row.
- Unit tests in `runscards.test.ts`:
  - an empty `--json` array gives a summary;
  - a non-empty array gives none;
  - a call without `--json`, or with output that does not parse, gives none.
- `scenarios-transcript-runs.mjs` asserts the summary on the collapsed row for an empty attention call.
- The Runs step in `scenarios-transcript-boards.mjs` asserts it too, now that the board is matched.

**Acceptance:** tsc clean; `runscards.test.ts` passes; transcript-runs, transcript-boards, transcript-base and
narration-feed pass with `ARC_FINAL_OUT=<tmp dir>`.

### Task 3: Permission marks anchor to the call they follow
**Depends on:** none
**Files:** `frontend/app/view/agents/permissionmodel.ts`, `frontend/app/view/agents/permissionmodel.test.ts`

- `anchorMarks` times an action entry by `ts ?? startedTs` (decision 4). User and prose entries are unchanged.
- Unit tests:
  - a mark stamped after a finished action that has `ts`, and before the next prose entry, anchors right after
    that action;
  - a pending action with only `startedTs` still anchors as before;
  - a mark older than every stamped entry is still dropped.

**Acceptance:** `permissionmodel.test.ts` passes; agent-rendered passes with `ARC_FINAL_OUT=<tmp dir>` (its
permission-answer step leaves a mark).

### Task 4: Scenario checks for the agents roster error and the brainstorm path
**Depends on:** none
**Files:** `scripts/cdp/scenarios-transcript-agents.mjs`, `scripts/cdp/scenarios-transcript-notes.mjs`

- **Roster fetch error:** a step in `scenarios-transcript-agents.mjs` opens `wsh agents list` with no `--json`
  output, with the page's roster RPC (`AgentsListCommand`) forced to refuse. The view shows its inline load
  error. Restore the RPC afterwards. `scenarios-transcript-notes.mjs` already refuses `JiraShowCommand` this
  way; follow it.
  - The roster's wshdata key is the fixed `"agents"`, and seeded keys never fetch. So this step must run before
    anything in the page seeds that key, for example as the scenario's first step.
  - Final runs scenarios in one app, and transcript-boards (which seeds it) comes later in the Final line. If an
    earlier scenario has seeded the key anyway, the step reports that, and it is listed under Found not fixed.
    Do not add a test-only export to `wshdata.ts`.
- **Brainstorm path:** a step in `scenarios-transcript-notes.mjs` sets `ctx.brainstormFile`.
  - With the store's path matching, the judge card draws the brainstorm's state.
  - With a different path, it draws without it, as `wshcards-notes.tsx` line 386 decides.
  - Restore the store in teardown as the existing judge steps do.

**Acceptance:** transcript-agents, transcript-notes and transcript-boards pass with `ARC_FINAL_OUT=<tmp dir>`
(boards runs `transcriptNotes.teardown`).
