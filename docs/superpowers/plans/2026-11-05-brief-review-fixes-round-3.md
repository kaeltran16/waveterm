# Brief review fixes, round 3 Fix Plan

**Goal:** Fix the open issues the run left in the Brief: the F12 error toast drawn under the record peek's scrim, Retry on a failed plan load showing no loading state, the pure model importing the store, and two scenario leftovers.

**Architecture:** Each fix stays in the file that owns it. A layering change goes in `brieftoast.tsx`, a store change in `effortstore.ts` with a test beside it, and a key helper moves into the pure model. Each visual fix gets an assertion in the `brief-act` step that already shows that state.

**Tech Stack:** React 19, jotai, Tailwind 4, vitest, CDP scenarios (`scripts/cdp/`).

**Spec:** `docs/superpowers/specs/2026-11-05-brief-code-review-fixes-design.md` (F12, F13; the run's reviewers and Final verifier raised these)

**Verify:** `node scripts/verify.mjs ./pkg/jarvisstate`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs brief-act brief-surface brief-design-parity brief-inline-tracker brief-peek`

## Global Constraints

- All paths are under `frontend/app/view/jarvis/` unless given in full. Every line number below is pre-edit (at `ca4e52849`).
- Don't attach to the dev app on CDP :9222 / Vite :5174, and don't stop or kill any `wave-tauri` / `wavesrv` process. Verify the scenario only through `node scripts/cdp/final-verify.mjs` (with `ARC_FINAL_OUT` set to a temp dir), which starts its own isolated app.
- No new design tokens and no raw colors. A z-index above `ModalShell`'s `z-[70]` uses the codebase's existing `z-[80]` layer (`agents/harnesspicker.tsx:161`, `agents/routepicker.tsx:209`).
- Keep prettier off `scripts/*.mjs`. Lint and format only the files you touch.

---

### Task 1: The Brief toast draws above the record peek; scenario leftovers
**Depends on:** none
**Files:** `frontend/app/view/jarvis/brieftoast.tsx`, `frontend/app/view/jarvis/briefsurface.tsx`, `scripts/cdp/scenarios-brief.mjs`

The record peek is a `ModalShell` dialog (`fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm`, `modals/modalshell.tsx:23`), mounted as a sibling of the surface (`briefsurface.tsx:1304`). The toast is `absolute … z-50` (`brieftoast.tsx:32`). So a refused status change from the peek (F12) reports through a toast that the scrim darkens and blurs. The Final verifier saw this in step 34's shot.

- [ ] **Step 1: Raise the toast above the dialog layer.** In `brieftoast.tsx:32`, change `z-50` to `z-[80]`, with a lower-case why-comment that a toast reports what an open dialog just did. If an ancestor of `<BriefToastView />` (`briefsurface.tsx:1300`) creates a stacking context that keeps the toast under the dialog, move `<BriefToastView />` to sit beside `<BriefPeek>` rather than adding another layer. Keep the toast's bottom-centre placement over the Brief.

- [ ] **Step 2: Assert it in step 34 (F12).** While the peek is still open and the error toast is showing, add `onTop` to the step's detail: `document.elementFromPoint` at the toast's centre falls inside `[data-jarvis-brief-toast]`. Also require `onTop === true` for the step to pass. The step's text gains "drawn above the peek".

- [ ] **Step 3: Fix step 27's text.** At `scenarios-brief.mjs:5155`, "and the run row still reads running" becomes "and the run row is unchanged", which is what the step asserts.

- [ ] **Step 4: Clear the lint warning.** At `scenarios-brief.mjs:2561`, `async teardown(h) {}` becomes `async teardown() {}`. Confirm with `npx eslint scripts/cdp/scenarios-brief.mjs`: no warning at that line.

- [ ] **Step 5: Run the scenario.** Run `node scripts/cdp/final-verify.mjs brief-act` with `ARC_FINAL_OUT` set to a temp dir. Expected: every step passes, step 34's detail shows `"onTop":true`, and its shot shows the toast undimmed over the peek.

- [ ] **Step 6: Commit** the three files, with a subject such as `fix(brief): draw the toast above the record peek`.

### Task 2: Retry shows the plan loading; the pure model stops importing the store
**Depends on:** Task 1 (both edit `scripts/cdp/scenarios-brief.mjs`)
**Files:** `frontend/app/view/jarvis/effortstore.ts`, `frontend/app/view/jarvis/effortstore.test.ts`, `frontend/app/view/jarvis/briefingmodel.ts`, `frontend/app/view/jarvis/briefundo.ts`, `scripts/cdp/scenarios-brief.mjs`

**Interfaces:**
- Produces: `chunkKey(oref: string, label: string): string` exported from `briefingmodel.ts`, with the same body as `briefundo.ts:129`. `briefundo.ts` imports it from `./briefingmodel` and re-exports it, so the current importers (`briefmutations.ts`, `briefqueueactions.ts` and their tests) don't change.

- [ ] **Step 1: Write the failing test** in `effortstore.test.ts`, beside the existing load-error tests (around line 105): `"clears a recorded load error when a reload starts"`. Seed `effortLoadErrorAtom` with `effort:x → "timeout"`, and mock `EffortGetCommand` with a promise that never settles. Call `loadEffortDetail("effort:x")` without awaiting it, then expect `globalStore.get(effortLoadErrorAtom).has("effort:x")` to be `false`.

- [ ] **Step 2: Run** `npx vitest run frontend/app/view/jarvis/effortstore.test.ts`. Expected: the new test fails, and the others pass.

- [ ] **Step 3: Clear the error when the RPC starts.** In `loadEffortDetail` (`effortstore.ts:108`), call `setLoadError(oref, null)` after the freshness return and before the RPC. The error line shows only while no detail is cached (`briefsurface.tsx:537`), so during a Retry the region draws its loading line again until the load settles. Update the function's comment to match.

- [ ] **Step 4: Run** the same command. Expected: every test passes.

- [ ] **Step 5: Move `chunkKey` into the pure model.** Define and export it in `briefingmodel.ts` and drop that file's `import { chunkKey } from "./briefundo"` (line 9). In `briefundo.ts`, replace the definition with an import from `./briefingmodel` plus an `export { chunkKey }`. Then check that `briefingmodel.ts` imports nothing from `@/app/store/jotaiStore`, directly or through `./briefundo`: `grep -n "briefundo\|jotaiStore" frontend/app/view/jarvis/briefingmodel.ts` prints nothing. Run `npx vitest run frontend/app/view/jarvis/` and expect every test to pass.

- [ ] **Step 6: Assert the Retry loading line in step 30 (F13).** In step 30 (around `scenarios-brief.mjs:5269`), after `releaseRpc(h, "EffortGetCommand")` lifts the failure, run `holdRpc(h, "EffortGetCommand")` so the retried read stays pending. Click `[data-jarvis-plan-retry]` and record `retrying`: `[data-jarvis-initiative-detail="loading"]` is present and `[data-jarvis-initiative-detail="error"]` is gone. Then `releaseRpc` it and keep the existing `f13b` checks (plan drawn, no error). The step passes only if `retrying` holds too, and its text gains ", showing the plan loading while it retries".

- [ ] **Step 7: Run the scenario.** Run `node scripts/cdp/final-verify.mjs brief-act` with `ARC_FINAL_OUT` set to a temp dir. Expected: every step passes, and step 30's detail shows the retrying state with no error and the loading line drawn.

- [ ] **Step 8: Commit** the five files, with a subject such as `fix(brief): show the plan loading on Retry; keep chunkKey pure`.
