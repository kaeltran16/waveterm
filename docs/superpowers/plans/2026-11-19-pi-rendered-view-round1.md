# Pi in the transcript renderer: round 1

**Spec:** `docs/superpowers/specs/2026-11-19-pi-rendered-view-design.md`
**Verify:** `node scripts/verify.mjs ./cmd/wsh/cmd ./pkg/claudecmds`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs rendered-pi transcript-census-projection agent-rendered agent-queued`

The spec says Stop on a pi agent with queued steers sends them at once. The run built that for the Rendered box only
(`stopAgent` in `renderedview.tsx`). The header's "Interrupt turn" (`agentheader.tsx`) and the palette's
`agent:interrupt` (`frontend/app/cockpit/actions/agent.ts`) still call `interruptAgent`, a bare Esc. On a pi agent
with a queued foot, pi then moves the steers back into its editor unsent, and the foot leaves at the next prompt
boundary, so the Rendered view shows nothing waiting while the steers sit unsent. Claude's Esc sends its own queue
from any of these paths, so pi differs only here.

### Task 1: every Stop of a pi agent sends its queued steers
**Depends on:** none
**Files:** `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/stopsend.ts`, `frontend/app/view/agents/stopsend.test.ts`, `frontend/app/view/agents/queuedprompts.ts`, `frontend/app/view/agents/queuedprompts.test.ts`, `frontend/app/view/agents/agentactions.ts`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/cockpit/actions/agent.ts`, `frontend/app/cockpit/actions/agent.test.ts`, `scripts/cdp/scenarios-rendered-pi.mjs`

**What to build:** one Stop for an agent, used by the Rendered box (button and Esc), the header's "Interrupt turn"
and the palette's `agent:interrupt`. For pi with a non-empty queued foot it is the run's Esc, then Enter once on the
next idle report, or a warning toast after `PI_STOP_SETTLE_MS`. Otherwise it is the bare Esc, so Claude and every
other harness behave as now. The pending-stop guard (a second Stop cancels the first's wait, so Enter is never typed
twice) covers all three paths.

The header and the palette have no queued foot in hand, so the stop reads the pi foot from the global atoms the
view already uses: the agent's live entries, the box's sends and the block's prompt boundary. Keep one source for
the pi foot: the view's `useQueuedFoot` and the stop compute it through the same function, never two copies of the
rule. Where the shared stop lives is the worker's call. It must not import from a `.tsx` file, and it must not
create an import cycle with `agentactions.ts`.

**Acceptance:**
- the palette's `agent:interrupt` on a pi agent with a queued foot types Esc, then Enter once after an idle report;
  with an empty foot, or on a Claude agent, it types Esc alone (testable through the action's `run` with the
  driving and status seams faked)
- a second Stop while the first still waits never leads to two Enters, whichever paths the two came from
- the Rendered box's Stop keeps its current behavior, and the pi foot it draws is unchanged
- scenario `rendered-pi` gains a step after its existing Stop step: with a queued foot drawn again, the header's
  "Interrupt turn" types Esc, an idle report then brings exactly one Enter (read off the key probe), and the foot
  clears
