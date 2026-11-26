# Subagents in the transcript: open-issue round

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\9460c361\docs\superpowers\specs\2026-11-26-transcript-subagents-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs transcript-subagents-step transcript-subagents-view transcript-subagents-nowline agent-subagents agent-rendered`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\transcript-subagents

## Decisions beyond the spec

- **The `Agent` tool is a spawn, like `Task`.** Claude Code renamed `Task` to `Agent`; the projection's
  `VERB_BY_TOOL` maps only `Task` to `"spawned"`, so every `Agent` call falls through to `readableVerb` ("agent") and
  a folded turn counts subagent spawns as "used N other tools" instead of "spawned N agents" (seen in the round-1 step
  screenshots). Mapping `Agent: "spawned"` in the one table fixes the fold and every other consumer of the verb at
  once, rather than special-casing "agent" in the fold phrase. Why now: it was left out of round 1 as outside the
  failing step; this round exists for such open issues, and it misreads exactly the steps this goal adds.
- **Consequence for the step head.** An `Agent` step now gets `stepTitle`'s "spawned" shape ("Spawned" + the
  description as subject) like a `Task` step. The round-1 type head (`AGENT_VERB` in `steprows.tsx`) keys on
  `"spawned"` instead of `"agent"`, so a linked step of either tool reads `<type> <description>` with the description
  mono and muted as today; an unlinked spawn of either tool reads "Spawned <description>", as a `Task` step already
  does. One rule for both tools, no second naming path.

### Task 1: Count Agent calls as spawns
**Depends on:** none
**Files:** `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/steprows.tsx`, `scripts/cdp/scenarios-transcript-subagents-step.mjs`

**What to build:** `VERB_BY_TOOL` maps `Agent` to `"spawned"`. A folded turn's phrase counts Agent calls with Task
calls as "spawned N agents". In `StepTitle`, the linked-subagent type head applies to steps whose verb is
`"spawned"`: the type replaces the title word, and the description (now the title's subject) still follows it, drawn
mono and muted as the round-1 head draws it, with the background tag after it. An unlinked spawn reads "Spawned
<description>". The live line, the notice and every non-spawn step are unchanged.

**Acceptance:**
- The projection's verb table test gains an `Agent` case projecting to verb `"spawned"` with the call's description as
  target (joining the existing table for the verb mapping).
- Scenario `transcript-subagents-step` step 4 also asserts the fold line reads "spawned N agents" for the fixture
  turn's N Agent calls and has no "other tool".
- Scenario `transcript-subagents-step` steps 2 and 3 still pass unchanged: "Explore" on both foreground heads,
  "general-purpose" on the background head with the description after it and the tag after that.
- The other Final scenarios (`transcript-subagents-view`, `transcript-subagents-nowline`, `agent-subagents`,
  `agent-rendered`) still pass.
