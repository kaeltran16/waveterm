# New Agent / New Project launcher polish — design

Date: 2026-06-26
Status: approved, ready to implement
Scope: frontend-only. No Go, no `task generate`.

## Problem

Three issues in the cockpit launcher modals:

1. **Worktree field is confusing.** The New Agent modal's "Worktree branch" field is a
   pre-filled free-text input (`feat/new-agent`) that silently forces a git worktree onto
   every Claude/Codex/Antigravity launch. One field conflates "create a new branch" and
   "attach to an existing branch," with no indication of which will happen and no opt-out.
2. **New Project: folder-picker name not auto-populated.** Picking a folder via `Browse…`
   does not fill the Name field as intended.
3. **New Project: modal dismissed on outside click "for some reasons."** Clicking outside
   closes the modal unexpectedly; combined with #2 this wipes in-progress input.

## Decisions (locked with the user)

- **D1.** No worktree by default — the agent runs in the project dir; a worktree is an
  explicit opt-in.
- **D2.** When the worktree opt-in is on, the branch field defaults to the project's
  **current branch**, with derive-on-collision (a branch already checked out can't be reused
  by git, so we branch a fresh name off it). The outcome is shown, never silent.
- **D3.** Outside-click dismissal is removed from both launcher modals; Escape is wired.

## Design

### A. Worktree opt-in (New Agent modal)

**Toggle.** Replace the always-visible "Worktree branch" `Section` with a toggle row —
**"Run in an isolated git worktree"**, default **off**. Styled with existing `@theme`
tokens. Rendered only when `runtimeSupportsWorktree(runtime)` is true (i.e. not Terminal);
this also fixes the current latent case where the field shows for Terminal even though
`launchAgent` ignores a branch there.

- **Off (default):** no branch field; `launch()` passes no branch → `launchAgent` skips the
  worktree (existing guard at `cockpit-actions.ts:22`). Agent runs in the project dir.
- **On:** reveal the existing branch input + recent-branch dropdown (unchanged markup),
  defaulting the value to the project's current branch, plus an outcome-hint line below it.

**Current branch source.** Fetch via the existing `GitChangesCommand` (returns `Branch`,
`wshrpctypes.go:614`) keyed on the selected project path. The existing `ListBranchesCommand`
fetch stays (powers the dropdown and the collision check).

**Outcome hint** (pure `worktreeOutcome`, see below) renders one line under the field:

| Chosen value | Hint |
|---|---|
| empty | "Enter a branch name" |
| equals current branch | "Creates new branch `<derived>` off `<current>`" |
| existing branch, not current | "Checks out existing branch `<name>` in a worktree" |
| new name | "Creates new branch `<name>` off current HEAD" |

**Launch wiring.** In `launch()`:
- worktree off → `branch: undefined`.
- worktree on, chosen `=== currentBranch` → `branch: deriveBranch(currentBranch, branchNames)`.
- worktree on, otherwise → `branch: chosen.trim()`.
- Validation: worktree on but empty branch → set the error line ("Enter a branch name or
  turn off the worktree option") and abort.

No backend change: a derived, non-colliding name passed to the existing `CreateWorktree`
hits its new-branch path (`git worktree add <wt> -b <name>`), which branches off the repo's
current HEAD — i.e. off the current branch's tip, satisfying "based on the current branch."

**Derivation rule** is frontend-side so the hint and the actual launch use the same name
(single source of truth; avoids prediction/action drift between FE and Go).

### B. Pure helpers (in `launch.ts`, unit-tested)

```ts
// runtime !== "terminal"; sibling of runtimeShowsTask
export function runtimeSupportsWorktree(runtime: Runtime): boolean

// "<base>-agent", bumping "-agent-2", "-3"… until it is not in existing.
export function deriveBranch(base: string, existing: string[]): string

// Decides the outcome-hint copy. Pure; computes the derived name internally
// via deriveBranch when the chosen value equals the current branch.
export function worktreeOutcome(args: {
    branch: string;
    currentBranch: string;
    branchNames: string[];
}): string
```

`deriveBranch` only needs to resolve the common collision (chosen === current branch, which
is guaranteed checked out in the main worktree). The `-agent` suffix is a chosen convention,
trivially changeable.

### C. Modal fixes (New Project AND New Agent)

- Remove the backdrop `onClick={close}` (`newprojectmodal.tsx:60`, `newagentmodal.tsx:146`).
  The inner `stopPropagation` becomes unnecessary but is harmless; leave or drop it.
- Wire Escape via the established pattern (`confirmmodal.tsx:33-41`): a `useEffect` placed
  with the other hooks (before the `if (!open) return null` early return), guarded by `open`,
  that adds a `window.addEventListener("keydown", …)` calling `close()` on `e.key === "Escape"`.
- Keep Cancel.

This fixes #3 directly and #2 as a consequence: with no outside-click dismissal, the async
`browse()` callback (`newprojectmodal.tsx:40-57`) can no longer write `setPath`/`setName`
into a modal that a stray backdrop click already closed and reset.

## Edge cases

- A branch checked out in *another* worktree (not the main repo) also can't be reused; the
  FE only derives for the current-branch case. This rarer case still surfaces `CreateWorktree`'s
  existing error in the modal's error line — acceptable, no silent failure.
- Deeper collisions on the derived name (`<base>-agent` already exists) are handled by the
  suffix bump in `deriveBranch`, checked against the loaded branch list.
- Switching runtime to Terminal while worktree is on: the section just hides; `launchAgent`
  already ignores a branch for Terminal, so no state reset needed.

## Testing

- **Pure helpers** (`launch.test.ts`): `deriveBranch` (no collision, single collision,
  multi-collision suffix bump), `worktreeOutcome` (each of the four rows above),
  `runtimeSupportsWorktree`. Matches the codebase's pattern of testing extracted pure
  functions; no DOM needed.
- **Components**: per the cockpit's no-jsdom constraint, verify the toggle reveal, the
  current-branch default, the outcome hint, Escape-to-close, and that outside-click no longer
  dismisses — in the live dev app via CDP (`scripts/cdp-shot.mjs`), plus a manual `Browse…`
  run to confirm the name now auto-fills.
- Full `npx vitest run` stays green.

## Out of scope

- Any backend / Go change, new RPC, or `task generate`.
- The two-field base+new-branch UI (rejected for simplicity).
- Backend detection of branches checked out in other worktrees.

## Implementation (ordered)

1. **`launch.ts`** — add `runtimeSupportsWorktree`, `deriveBranch`, `worktreeOutcome`.
2. **`launch.test.ts`** — tests for the three helpers; run vitest, confirm green.
3. **`newagentmodal.tsx`** —
   a. add `useWorktree` (default false) and `currentBranch` state;
   b. fetch current branch via `GitChangesCommand` in the existing path-keyed effect;
   c. replace the "Worktree branch" `Section` with the toggle + conditional field (gated by
      `runtimeSupportsWorktree`), defaulting the field to `currentBranch`, with the outcome hint;
   d. update `launch()` branch wiring + validation per §A;
   e. remove backdrop `onClick={close}`; add the Escape `useEffect`.
4. **`newprojectmodal.tsx`** — remove backdrop `onClick={close}`; add the Escape `useEffect`.
5. **Verify** — `npx vitest run` green; `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
   shows only the 3 pre-existing `api.test.ts` errors; then live dev-app CDP check.

## Commit

Per repo convention, this spec folds into the feature commit — no separate docs-only commit.
Commit only after explicit approval.
