# Brief design-parity self-seeding Fix Plan

**Goal:** Make the `brief-design-parity` CDP scenario pass in Final's isolated dev app by seeding the design's initiatives itself, instead of requiring a manual `node scripts/cdp/seed-brief.mjs` first.

**Architecture:** The seed data and the seeding loop move out of `seed-brief.mjs`'s top level into an exported function in the same file. The CLI keeps working, and the scenario's `arrange` calls the function and its `teardown` deletes only what it created.

**Tech Stack:** Node ESM CDP scripts (`scripts/cdp/`).

**Spec:** `docs/superpowers/specs/2026-11-05-brief-code-review-fixes-design.md` (this round fixes a Final failure, not a spec finding).

**Verify:** `node scripts/verify.mjs ./pkg/jarvisstate`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brief-act brief-surface brief-design-parity brief-inline-tracker brief-peek`

## Why this round

Final round 1 passed every step of brief-act, brief-surface, brief-peek and brief-inline-tracker. `brief-design-parity` failed in `arrange` (`scripts/cdp/scenarios-brief.mjs:3070-3073`) with `Cannot read properties of null (reading 'some')`. The cause has two parts:

- Final's isolated store has no initiatives, and `effortlist` then answers `{ efforts: null }` (a nil Go slice). The `{ efforts = [] }` destructuring default covers only `undefined`, so `efforts.some` throws.
- With that fixed, `arrange` would still throw its own "run node scripts/cdp/seed-brief.mjs first". The scenario needs the design's three initiatives (`Scenario gate clearance` and the others), and nothing in Final seeds them.

The failure is not from this run's Brief changes. It holds the land all the same.

## Global Constraints

- Don't attach to the dev app on CDP :9222 / Vite :5174, and don't stop or kill any `wave-tauri` / `wavesrv` process: another session drives it. Verify only through `node scripts/cdp/final-verify.mjs`, which starts its own isolated app.
- Keep prettier off `scripts/*.mjs` (hand-formatted, 4-space).
- Don't change the scenario's assertions (steps a-i). The fix is data and setup only. If a step still fails once seeded, fix its selector against the current markup, and say so under Differs from plan.

---

### Task 1: brief-design-parity seeds and removes its own initiatives
**Depends on:** none
**Files:** `scripts/cdp/seed-brief.mjs`, `scripts/cdp/scenarios-brief.mjs`

**Interfaces:**
- Produces: `export async function seedBriefDesign(h): Promise<string[]>` in `scripts/cdp/seed-brief.mjs`. It seeds each of the `INITIATIVES` whose title is not already present, with archived initiatives counted (`effortlist` with `includearchived: true`). It returns the effort oids it created, an empty list when every title already exists, and logs the same `seeded …` / `skip …` lines as today.

- [ ] **Step 1: Extract the seeding into `seedBriefDesign(h)`.** Move the body of today's `try` block (`seed-brief.mjs:65-100`), together with the `mutate` helper at line 62 (bound to the `h` passed in) into the function, unchanged apart from two things: it collects each created `effortoid`, and it reads the list null-safe (`(await h.rpc("effortlist", { includearchived: true }))?.efforts ?? []`). The CLI path (`attach`, call, `h.close()` in `finally`) runs only when the file is executed directly, compared via `import.meta.url` against `pathToFileURL(process.argv[1]).href`. Importing the module must not attach to any port. Update the header comment: the scenario seeds itself, and the CLI is for the side-by-side review.

- [ ] **Step 2: Seed in `briefDesignParity.arrange`.** Replace the `effortlist` check at `scenarios-brief.mjs:3070-3073` with `return { seeded: await seedBriefDesign(h) };`, and import `seedBriefDesign` from `./seed-brief.mjs`. Update the comment at line 3061: the scenario seeds the design's data and removes what it seeded.

- [ ] **Step 3: Delete what was seeded in `briefDesignParity.teardown`.** After the existing teardown lines, delete each oid in `ctx.seeded ?? []` with `h.rpc("effortdelete", { effortoid })`. Log a failed delete with `console.warn` and keep going, as `scenarios-brief.mjs:375` does. Initiatives a developer seeded by hand (already present, so not in `ctx.seeded`) are left alone.

- [ ] **Step 4: Run the scenario in an isolated app.**
  Run: `node scripts/cdp/final-verify.mjs brief-design-parity`
  Expected: `# brief-design-parity` lists steps a-i, each PASS, or SKIP for e only when the store has no run, and the summary line reports no failure. Then run `node scripts/cdp/final-verify.mjs brief-design-parity brief-inline-tracker` and expect no failure, which shows the teardown leaves the next scenario a clean store.

- [ ] **Step 5: Commit** `scripts/cdp/seed-brief.mjs` and `scripts/cdp/scenarios-brief.mjs` with a subject such as `test(brief): design-parity scenario seeds its own initiatives`.
