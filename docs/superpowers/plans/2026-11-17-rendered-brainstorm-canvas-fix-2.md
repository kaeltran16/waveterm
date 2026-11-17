# Fix round 2: Brainstorm and canvas inline in the Rendered transcript

The run's plan is `docs/superpowers/plans/2026-11-17-rendered-brainstorm-canvas.md`; its Verify, Check, Final and
Prototype hold. Round 1's fix (viewed times kept across an in-flight poll) passed: `rendered-bs-mockup` is green.

Final failed one step of 197, `rendered-bs-composer` "Working: the agent writing; no brainstorm card under the
timeline, ...": `gone` was true, but `readHost` right after read the design card's whole text in the host, so
`host.text === ""` failed. The step's screenshot, taken a moment later, shows no card. The host's
`data-rendered-bs-card` turns "none" at once while the leaving card is still in the DOM through its
AnimatePresence exit fade, which Final's load stretches. The UI is right; the kit's wait ends too early.

### Task 1: Waiting for no card waits for the leaving card to go
**Depends on:** none
**Files:** `scripts/cdp/scenarios-rendered-brainstorm.mjs`

**What to build:** the kit's `waitCard(h, "none")` resolves only once the host's kind is "none" and the leaving
card has left the DOM (the host draws no card text), so every step that waits for no card reads the settled host.
Fix it in the shared helper, not in the one step; other kinds wait as today. Leave the card's exit fade as it is.

**Acceptance:**
- The `rendered-bs-composer` step "Working: the agent writing; no brainstorm card under the timeline, the steer box
  with Stop, the turn's steps and working line drawn" passes, its `host.text === ""` check unchanged.
- A `waitCard(h, "none")` that times out still returns false (a card that never leaves fails the step).
