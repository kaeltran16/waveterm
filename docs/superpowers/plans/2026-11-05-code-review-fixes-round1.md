# Code surface review fixes, round 1: Final failures

> **For agentic workers:** each task below is one worker's job. Logic goes in pure `.ts` files with a vitest test
> beside them; `.tsx` stays a thin consumer. The parent plan is
> `docs/superpowers/plans/2026-11-05-code-review-fixes.md` and the spec
> `docs/superpowers/specs/2026-11-05-code-review-fixes-design.md`. Round 1's Final output (shots.json, screenshots,
> logs) is in `C:\Users\kael02\AppData\Local\dev.arc.app\data\final-shots\dc40b934-46a3-4251-a584-192387c36c2c\1`.

**Goal:** Make every step of the run's Final pass on the merged result: 13 steps failed and 1 skipped, in
`code-changed`, `code-peek`, `code-git-status`, `code-markdown` and `code-tree-on-arrival`.

**Architecture:** One real defect (a focus flag left set when the Code tree unmounts) and its likely relative on the
Agent surface, then three older Code scenarios that relied on a project already registered in the dev app. Final
runs on a fresh store with none.

**Tech Stack:** React 19, jotai, vitest, the CDP harness in `scripts/cdp/`.

**Spec:** `docs/superpowers/specs/2026-11-05-code-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/gitinfo`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs code-session code-jumps code-toolbar code-keys code-handoff code-changed code-blame-draft code-diff-states code-editor code-peek code-diff code-blame code-review code-markdown code-stale-bar code-plain-dir code-git-status code-tree-on-arrival`

## Global Constraints

- A snapshot dev app on :9222 / :5174 belongs to another review: never attach to it or stop it. Check scenarios
  with `ARC_FINAL_OUT=<tmp dir> node scripts/cdp/final-verify.mjs <scenario...>`, which starts its own app on a
  fresh store with its own ports. Pass the scenarios in the order Final runs them when a step depends on what an
  earlier scenario left behind.
- Scenario fixtures live in `os.tmpdir()` dirs the scenario removes; a project a scenario registers is deleted at
  teardown. Use the kit in `scripts/cdp/scenarios-code-kit.mjs` (`makeCodeRepo`, `removeCodeRepo`,
  `openFolderInCode`, `openFileInCode`) rather than a registered project.
- Never weaken a step's assertion to make it pass; a step changes only where it depended on ambient dev-app state.

---

### Task 1: The Code tree's focus flag outlives the tree
**Depends on:** none
**Files:** `frontend/app/view/code/codetreepane.tsx`, `frontend/app/view/code/codetree.ts`, `frontend/app/view/code/codetree.test.ts`, `scripts/cdp/scenarios-code-changed.mjs`

Failing: `code-changed: ArrowDown moves focus to the second row and the tab stop follows`
(`{"focused":"a.txt","tabIndexes":"0,-1,-1","syntheticKeydown":true}`) and `code-changed: Enter opens the focused
row in the editor` (`{"path":"a.txt"}`; it follows from the first).

Cause, as read from the code (confirm it before fixing): the tree (`codetreepane.tsx:245-249`) sets
`codeTreeFocusedAtom` on focus and clears it on blur. Opening a folder focuses the tree; clicking the Changed tab
unmounts the tree while it holds focus, and React fires no blur on unmount, so the flag stays true. The bindings
`code:tree-next-arrow` / `code:tree-prev-arrow` (`bindings.ts`, gate `inTree` near line 1577) then claim ArrowDown
on window capture, ahead of the Changed list's `onKeyDown`, for the real key and the scenario's synthetic one alike.

Fix: the tree pane clears `codeTreeFocusedAtom` when it unmounts (an effect cleanup), so no binding acts on a tree
that is gone. Do not edit `bindings.ts`. Its gate is right once the flag is.

Also, from Task 2's "Found not fixed": the inline name input's duplicate check (`existing={paths}`,
`codetreepane.tsx:101`) does not count the session folders (`codeSessionDirsAtom`). A new folder named like an
empty session folder passes validation, and the mkdir error then shows as a mutate banner. Pass the session folders
into `existing` too; if that list is built by logic beyond a concatenation, put it in `codetree.ts` with a test.

Acceptance: `code-changed` passes all three steps with real CDP keys, without the synthetic fallback (its detail
says `"syntheticKeydown":false`). Run it after `code-session`, so it starts from a tree that held focus. Add a step
to `code-changed`, with a shot: the Changed tab is opened from a focused tree, and a real ArrowDown then
moves the Changed list's focus.

### Task 2: Esc in the agent terminal is taken after the Code scenarios ran
**Depends on:** Task 1
**Files:** `frontend/app/view/code/codetreepane.tsx`, `frontend/app/view/code/codepeekstore.ts`, `frontend/app/view/code/codepeekstore.test.ts`, `scripts/cdp/scenarios-codepeek.mjs`

Depends on Task 1 for a reason beyond the shared file: its fix may be this one's.

Failing: `Esc in the focused card closes it and focuses the terminal; Esc in the terminal reaches the agent and
leaves the card open` with `"termEscSeen":[]`: a window-capture probe never saw the terminal's Escape, so a
keybinding took it. The same step passed in an earlier Final where `code-peek` ran on its own
(`final-shots\53576183-…\1\shots.json`). Here it ran after `code-tree-on-arrival code-git-status code-plain-dir
code-diff code-blame code-review code-markdown`. So state one of those leaves behind is the likely trigger,
the way Task 1's flag outlives the tree.

Find the binding that claims Escape there (the `keys: "Escape"` bindings in `bindings.ts` and the atoms their
`when` reads) and the state that enables it; fix it where the state is set, not in the scenario. If the cause turns
out to be outside this task's files, edit the file that holds it and name it in your report. If the earlier
scenarios leave nothing behind and the key simply never arrives, say so with the evidence, and make the step
robust the way `code-tree-on-arrival` is (`Emulation.setFocusEmulationEnabled`). Do not drop the
`termSeen.includes("Escape")` check.

Acceptance: `code-peek` passes when run after `code-git-status code-plain-dir code-diff code-blame code-review
code-markdown` (the Final order), and passes on its own.

### Task 3: Older Code scenarios open their own repository
**Depends on:** none
**Files:** `scripts/cdp/scenarios-code.mjs`, `scripts/cdp/scenarios-code-editor.mjs`

Failing, all on a fresh store with no registered project:
- `code-tree-on-arrival`: skipped, "no tree: pick a project on Code first".
- `code-git-status`: `select a project` (`picked=false`): the picker had no rows. The steps after it fail with it.
- `code-markdown`: no `select a project` step ran (the previous scenario left a Code project loaded, a deleted
  temp repo), so Ctrl+P found no `README.md`, and every step after it failed.

Each of the three makes its own temp repo with `makeCodeRepo` and opens it with `openFolderInCode`, removing it at
teardown, instead of picking whatever project the dev app holds:
- `code-git-status`: a committed file with an uncommitted edit that adds and removes lines, so the Changed row
  carries `+N` and `-N` and the tree paints a status letter.
- `code-markdown`: a `README.md` with a heading and a paragraph, long enough that the reopen step measures a real
  render.
- `code-tree-on-arrival`: open the repo, then do the Agent → Code arrival it checks. If a fresh store has no agent
  terminal for `focusAgentXterm`, arrive from another surface with focus outside the tree, and say which in the
  step's detail.

Keep every existing assertion; only the setup changes. Also, from Task 11's review: in `scenarios-code-editor.mjs`
the nbsp normalization reads `.replace(/00a0/g, " ")` (lines 61, 115, 128, 129), with the escape lost, so it
replaces nothing. Make it match U+00A0. Inside the template literal that builds the page code it must be written
`/\\u00a0/g`.

Acceptance: `code-tree-on-arrival code-git-status code-markdown code-editor` all pass, run in that order on a fresh
store, and `code-tree-on-arrival` reports a pass, not a skip.
