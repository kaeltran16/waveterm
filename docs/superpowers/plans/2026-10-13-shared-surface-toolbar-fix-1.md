# Shared Surface Toolbar: fix round 1

**Goal:** make the `surface-headers` "zero facts" step pass. The product is right and the step's check is wrong.

The Final run on the merged result failed only that step, with this output: `{"sessions":{"text":"Sessions All Live Needs you 3 Done","titleThenSpacer":true,"factShown":true}, ...}`. Sessions renders no fact: `titleThenSpacer` is true, so the h1 is followed directly by the spacer. But the step's regex for the Sessions fact is `/\blive\b/i`, and that matches the "Live" status-filter chip in the same toolbar. So `factShown` comes out true and the step fails.

### Task 1: Match the Sessions fact text in "zero facts", not the Live chip

**Depends on:** none

**Files:** `scripts/cdp/scenarios.mjs`

The change goes in the `surface-headers` scenario's "zero facts" step, near `for (const [surface, word] of [["sessions", /\blive\b/i], ["usage", /\breporting\b/i]])`.

- [ ] **Step 1:** In that loop, replace the Sessions pattern `/\blive\b/i` with `/\d+ agents? live\b/i`. The fact reads "1 agent live" / "N agents live" (see the "sessions" step's `/(^|\D)1 agent live\b/i`), and the status-filter chip "Live" no longer matches. Leave the Usage pattern and everything else in the step unchanged. Don't reformat the file: `scripts/*.mjs` are hand-formatted and must never go through prettier.
- [ ] **Step 2:** Run `node scripts/cdp/final-verify.mjs surface-headers` and confirm all of its steps pass, including "zero facts" with `sessions.factShown=false` and `titleThenSpacer=true` for both surfaces.
- [ ] **Step 3:** Commit only `scripts/cdp/scenarios.mjs` with `test(cockpit): match the Sessions fact, not the Live chip, in surface-headers zero facts`.

**Acceptance:** `surface-headers` passes every step under `final-verify.mjs`. The "sessions" step still requires "1 agent live" when the roster has a live agent.
