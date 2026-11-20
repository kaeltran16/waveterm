# Brainstorm cards restyle: open-issue round

**Verify:** `node scripts/verify.mjs ./pkg/waveobj`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs rendered-bs-question rendered-bs-boards workspace-brainstorm-cards rendered-bs-check rendered-bs-design rendered-bs-review rendered-bs-run rendered-bs-mockup workspace-pane-canvas rendered-bs-rows`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\brainstorm-cards\project

Final passed. This round takes the two open issues that are round work. One is a stale comment the final verifier found in `renderedbsrun.tsx`. The other is the settled design card at narrow width, which t-4 reported nothing checks.

### Task 1: The gone card's comment says where Open brainstorm is
**Depends on:** none
**Files:** `frontend/app/view/agents/renderedbsrun.tsx`

**What to build:** the comment above GoneCard's `frame` says "the header's Open brainstorm is the only way on". The full gone card passes `link={null}`, so its header has no Open brainstorm. Only the folded row CardFrame draws while the Brainstorm tab shows has it. Reword the comment to match: no status and no link on the full card, because the file is gone, and the folded row keeps Open brainstorm. Comment only; no behaviour change.

**Acceptance:**
- The diff touches only that comment, and `rendered-bs-run` still passes every step.

### Task 2: The settled design card checked at narrow width
**Depends on:** none
**Files:** `scripts/cdp/scenarios-rendered-bs-design.mjs`, `frontend/app/view/agents/renderedbsdesign.tsx`

**What to build:** add a step to `rendered-bs-design` that draws the settled design card (the state the "settled" steps use) in the narrow column. Use the kit's `narrow`/`widen`, as the existing "the narrow column stacks each row's buttons under its line" step does. Assert that:
- the card is compact;
- the header still reads Brainstorm, the topic, the "Ready for the builder check" chip and Open brainstorm;
- the settled row (`[data-rendered-bs-design-settled]`) wraps inside the card, with Check with a builder fully inside the card's right edge;
- the card stays inside the column.

Widen back at the end, and leave the file state as the next step expects. If the card does not fit, fix the layout in `renderedbsdesign.tsx`.

**Acceptance:**
- `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs rendered-bs-design` passes every step, including the new narrow settled step with its screenshot.
