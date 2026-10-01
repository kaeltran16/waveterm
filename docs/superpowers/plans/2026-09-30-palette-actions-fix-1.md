# Ctrl+P actions — final-stage fix round 1

**Spec:** `docs/superpowers/specs/2026-09-30-palette-actions-design.md`

The final stage failed one step: `palette-goal` step 4, "Set up the run… opens the New run window with the goal
and project filled, and starts nothing". Every condition held except `palette === false`. The recorded detail was
`{"windowOpen":true,"palette":true,"goal":"zqvx80120 tidy the palette fixture","project":"verify-palette-goalAppData\\Local\\Temp","runsBefore":0,"runsAfter":0}`.

The product is right. The `setup` launch dep in `frontend/app/cockpit/command-palette.tsx` calls `close()` before it
opens the window. The screenshot taken just after the check (`cdp-shots/palette-goal-window.png`) shows the New run
window with no palette. `ModalShell` (`frontend/app/modals/modalshell.tsx`) unmounts its panel only after the
`AnimatePresence` exit animation finishes. Until then `input[data-palette-input]` is still in the DOM. The scenario
reads `!!${PALETTE_INPUT}` as soon as the goal textarea is filled, which can happen inside that exit window. The
check races the animation.

### Task 1: palette-goal waits for the palette to leave before asserting it closed

**Depends on:** none

**Files:**
- Modify: `scripts/cdp/scenarios.mjs` (the `paletteGoal` scenario's `assert`, the block after `await h.ev(paletteKey("Enter"));`)

Do not change product code. Do not touch the `palette-actions` scenario.

- [ ] **Step 1: Wait for the palette input to unmount**

In `paletteGoal.assert`, after the existing `polishWaitFor` that waits for the Goal textarea's value, and before the
`const filled = await h.ev(...)` read, add a wait for the palette to go. `openPalette` already uses the same idiom:

```js
        // the palette closes before the window opens, but its exit animation keeps the input mounted briefly
        const paletteGone = await polishWaitFor(h, `!${PALETTE_INPUT}`, 2000);
```

Replace `filled.palette === false` in step 4's condition with `paletteGone && filled.palette === false`. Add
`paletteGone` to the step's JSON detail next to `windowOpen`, so a real failure still shows which condition broke.

- [ ] **Step 2: Syntax-check the scenario file**

Run: `node --check scripts/cdp/scenarios.mjs`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp/scenarios.mjs
git commit -m "test(cdp): palette-goal waits out the palette's exit before asserting it closed"
```
