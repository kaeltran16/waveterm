# Subagents in the transcript: Final round 1 fix

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\9460c361\docs\superpowers\specs\2026-11-26-transcript-subagents-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/wshrpc/...`
**Final:** `node scripts/cdp/final-verify.mjs transcript-subagents-step transcript-subagents-view transcript-subagents-nowline agent-subagents agent-rendered`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\transcript-subagents

## Decisions beyond the spec

- **An Agent step linked to a subagent is headed by the subagent's type, not "Agent".** The PickStep and
  NowLineSubagents boards head each Agent step with the type ("Explore", "general-purpose") followed by its
  description; the build kept `stepTitle`'s generic "Agent", so two background general-purpose steps read alike only
  by description and the head disagrees with the boards. Why the type comes from the link (`useSubagentOf`) rather
  than from `stepTitle`: `SubagentVM.type` already resolves spawn `subagent_type`, then meta `agentType`, so the row
  needs no second copy of that order, and `stepTitle` stays the one naming used by the live line and the fold. A step
  with no linked subagent keeps "Agent".
- **Out of scope, recorded as open:** a fold phrase counts `Agent` spawns as "used N other tools" (`VERB_BY_TOOL` maps
  `Task` only). It passed Final, predates this goal and changes fold wording across every agent, so it is not folded
  into this fix.

### Task 1: Head a linked Agent step with its subagent's type
**Depends on:** none
**Files:** `frontend/app/view/agents/steprows.tsx`, `scripts/cdp/scenarios-transcript-subagents-step.mjs`

**What to build:** In `StepRow`, when `useSubagentOf(action.toolUseId)` returns a link, `StepTitle` draws
`link.sub.type` in place of the generic verb word "Agent", followed by the description (unchanged, still mono and
muted) and the background tag where the step has one. When the type is empty, or the step links to no subagent, the
head stays "Agent". The live line, the fold, the notice and every non-Agent step are unchanged. Expose the drawn word
as the row's `[data-step-title]` text so a scenario can read it.

**Acceptance:**
- Scenario `transcript-subagents-step` step 2 also asserts the type: the running foreground step's `[data-step-title]`
  reads "Explore" and the finished foreground step's reads "Explore" (add `title` to `rowFacts`).
- Scenario `transcript-subagents-step` step 3 asserts the acked background step's `[data-step-title]` reads
  "general-purpose", with the background tag still after its description.
- The step-2 and step-4 screenshots read "Explore List the plan format tests" and "general-purpose Research app store
  gaps" rather than "Agent ...".
- The other Final scenarios (`transcript-subagents-view`, `transcript-subagents-nowline`, `agent-subagents`,
  `agent-rendered`) still pass.
