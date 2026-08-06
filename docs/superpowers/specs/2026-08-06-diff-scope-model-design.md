# A stored scope for the Diff surface

**Date:** 2026-08-06
**Status:** design approved, no plan written yet
**Supersedes nothing.** Builds on the Diff surface rewrite (`a7c7c6cd`), branch comparison (`cea7ec8a`, spec `2026-07-31-git-branch-comparison-design.md`) and history filtering/paging (`3d1ed88f`, spec `2026-08-03-git-review-history-reads-design.md`).

## Why

The Diff surface's subject bar renders a three-way segmented control — Repository / Agent / Run — that looks like a switcher and does nothing. Its `onClick` (`filessurface.tsx:575-579`) has one branch, which fires only while branch comparison is active and only to leave it. In every ordinary state all three chips are inert. They are real `<button>` elements, so they take the pointer cursor, take keyboard focus, and are announced as buttons to a screen reader.

The chips are dead because the thing they name cannot be set. Scope is not stored anywhere; it is re-derived on every render from which of three variables happens to be non-null:

```ts
// filessurface.tsx:377
const scope = compareOn ? "repo" : runSource ? "run" : projectSel ? "repo" : "agent";
```

"Select a scope" is therefore not an operation the code can express. A click has nothing to write. The chips were left in place as a readout wearing a control's clothes, and three further problems fall out of the same root:

- **Branch comparison hides in a status line.** The only entry point is the chip labelled `Reading <expression>` (`filessurface.tsx:613-624`) — a button styled as a readout.
- **The range changes meaning silently.** The same text reads `session start a3f9c21 … worktree` for an agent, `<branch> · all refs` for a project, and `9f2c1de … HEAD` for a run. Same three panes, different question answered, nothing explaining the switch.
- **Reachable combinations are missing.** Asking for full history means selecting a *project*, which means clearing the agent. An agent working in a git worktree that was never registered as a project cannot be browsed at all.

Nothing in the backend causes any of this.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| One change-list RPC that already accepts any repo + any anchor | `GitChangesCommand(cwd, ref?, sessionstartts?)` | Shipped. All three current loaders call it and differ only in which optional argument they pass. **No backend change in this spec.** |
| History read, paging, filters | `GitHistoryCommand`, `githistorystore.ts` | Shipped `3d1ed88f`. Takes cwd, limit and filters only — the anchor is never sent to git. |
| Two-ref divergence + aggregate diff | `GitDivergenceCommand`, `GitCompareChangesCommand`, `GitCompareDiffCommand`, `comparestore.ts` | Shipped `cea7ec8a`. Reused unchanged; only how compare is *entered* moves. |
| Commit-scoped changes and diff | `GitCommitChangesCommand`, `GitCommitDiffCommand` | Shipped `a7c7c6cd`. Untouched. |
| Selection-settling and restore-notice behavior | `githistorystore.ts:204` (`settleSelection`), `:229` (`announceRestore`) | Shipped, fixed twice recently (`c328ee36`, `7dec28d2`). Untouched by this spec — see Risks. |
| Session-start resolution | `ensureSessionStart` (`agentsessionstore.ts`), backend echoes the resolved commit (`filesstore.ts:84`) | Shipped. Reused as-is. |
| Pure-derivation + unit-test convention | `historyrows.ts`, `historyquery.ts`, `comparerows.ts` and their tests | Shipped. The new module follows it. |

## Resolved decisions

**1. Scope becomes one stored value, not four variables and an inference.** A single `diffScopeAtom` holds `{ repo, range }`. It replaces the run source (`agents.tsx:98`), the picked project (`filesstore.ts:36`), the derived scope expression (`filessurface.tsx:377`), and branch comparison as an independent boolean (`comparestore.ts:34`). Every chip, menu item and deep link writes the same value.

**2. The stored repo holds an origin, and only an agent origin defers its directory.** Resolving an agent's working directory is asynchronous and can fail — `resolveCwd` reads the transcript, which may not have landed. Baking that into the stored scope would make *selecting* an agent a failable operation, so an agent origin carries nothing but its id and the loader resolves the rest; the resolved directory stays where it already lives, in `filesStateAtom.cwd`.

The other two origins are not in that position and pretending otherwise would cost a lookup that has no source. A registered project's path is synchronous registry data. A run's directory and base commit were captured when the run started and exist nowhere else — there is no registry to re-resolve them from, which is exactly why the run source atom carries them today. So a project origin carries its path and a run origin carries its directory and base commit. *(Refined 2026-08-06 while writing the implementation plan; the reasoning above is unchanged, only its over-broad phrasing.)*

*Consequence, stated because an earlier draft of this design said otherwise:* `FilesProject` (`filesstore.ts:27`) does not need widening and the projects registry is unchanged. An unregistered worktree becomes reachable as an **agent origin with a working-tree or compare range** — the combination that is unreachable today — not through a new repo type.

*Second consequence, found while writing the plan:* the scope atom cannot live on the view model in `agents.tsx`. `comparestore.ts` must read and write it, and a plain store importing a React view model would invert the dependency. It gets its own module, `diffscopeatom.ts`, with the view model re-exporting it so callers that reach it through the model are unaffected.

**3. Ranges are a closed union with explicit preconditions.** Four ranges: working tree, since session start, run base…HEAD, compare two refs. Working tree and compare need only a repository. Session needs an agent's transcript. Run needs a run's captured base commit, which this surface cannot obtain on its own — runs reach the frontend only per active channel (noted in `2026-07-31-git-branch-comparison-design.md`, decision 1). Availability is therefore computable from the scope, which is what lets an unavailable choice render as unavailable instead of dead.

**4. Structurally-unavailable ranges are absent; only temporarily-unavailable ones are disabled.** A greyed box with a hidden tooltip is still a control the reader must interrogate. The run range is not drawn unless a run is in context; the session range is not drawn for a project. Disabled-with-a-reason is reserved for the one case that resolves itself — an agent whose session-start commit has not resolved yet — where hiding the chip would misreport a temporary state as an impossible one. The strip changes width with context; that is preferred to a fixed frame with dead cells, which is the shape that caused this spec.

**5. Changing range must not reload history.** `GitHistoryCommand` (`githistorystore.ts:166-170`) takes cwd, limit and filters. The anchor feeds only the divider label and the synthetic row-zero label, both derived in `historyRowsAtom` (`:63-80`) from `historyOptsAtom`. The history guard token therefore keys on the resolved directory + filters and excludes range. Switching range costs one change-list call and zero history calls, with no list blanking and no scroll reset. Today this is impossible: changing range means changing source, which changes the token, which takes the `!sameSubject` branch (`:156`) and returns the reader to the top of the list.

**6. The compare range carries the range it interrupted.** `{ kind: "compare", base, head, from }`. Escape restores `from` rather than guessing. This deletes `compareAnchorAtom` (`comparestore.ts:51`) and the effect that invalidates it (`filessurface.tsx:481-487`), which exist only because the surface unmounts on nav switch and an effect keyed on directory would fire on every remount and tear down a comparison still in use. With the repo inside the same stored value, changing repo is an explicit write rather than something an effect must detect, so the hazard does not exist.

**7. Following the focused agent is preserved, expressed as one rule.** The surface currently follows `focusIdAtom` and its source picker writes it, deliberately (`filessurface.tsx:96-98`), so a diff can be inspected without bouncing to the Agent tab. The rule becomes: the tab follows focus only while the stored repo's origin is an agent. Pinning a project or arriving from a run stops focus changes from moving the surface. This is what the `run > project > agent` precedence does today, said once, as data.

**8. One branch, no feature flag.** A flag would require both the inferred-scope path and the stored-scope path to stay alive simultaneously, which is exactly the ambiguity being removed. Risk is managed by the rollout order in section 5 instead.

## 1. State model

New pure module `frontend/app/view/agents/diffscope.ts` — no React, no RPC, no atoms.

```ts
export type DiffOrigin =
    | { kind: "agent"; id: string }
    | { kind: "project"; name: string }
    | { kind: "run"; runId: string };

export type DiffRepo = { origin: DiffOrigin; label: string };

export type DiffRange =
    | { kind: "working" }                                    // uncommitted work vs HEAD
    | { kind: "session"; agentId: string }                   // since the agent's session began
    | { kind: "run"; runId: string; baseCommit: string }     // run base … HEAD
    | { kind: "compare"; base: string; head: string; from: DiffRange };

export type DiffScope = { repo: DiffRepo; range: DiffRange };
```

Exported functions, all pure:

| Function | Returns | Used by |
|---|---|---|
| `scopeKey(scope)` | stable string identifying the subject | stale-load guards, deep links |
| `historyKey(cwd, filters)` | stable string, range-free | history stale-load guard |
| `availableRanges(scope, { sessionStartResolved })` | the ranges to draw, each available, or unavailable with a reason | the range strip |
| `defaultRangeFor(origin)` | the range a newly-selected repo opens on | repo picker, deep links |
| `rangeOptsFor(range)` | the change-list RPC's optional arguments (minus the async session lookup) | `filesstore.ts` |
| `historyOptsFor(range, resolvedRef)` | `{ anchor, anchorLabel, rowLabel }` | `githistorystore.ts` |
| `rangeSummary(scope, state: FilesState)` | the readout sentence under the bar | the surface |

`defaultRangeFor`: agent → session; project → working; run → run.

`availableRanges` needs exactly one fact beyond the scope itself — whether the session-start commit has resolved, read from `filesStateAtom.ref`. Everything else follows from the origin: the run range is offered when and only when the origin is a run, since that is the only way this surface ever holds a run's captured base commit.

`historyKey` takes the resolved directory rather than the stored repo, because history is per-directory: two origins pointing at the same worktree should share a history read rather than reload each other's. `loadHistory` already receives the directory as its first argument, so this is today's token minus the anchor and nothing more.

**Switching repository replaces the whole scope** with `{ repo: <new>, range: defaultRangeFor(new.origin) }`. A compare range never crosses repositories — its `from` refers to the old repository's range and would be meaningless. This preserves today's behavior, where changing repository exits comparison through the anchor-invalidation effect.

The atom itself lives with the other cockpit atoms: `diffScopeAtom: DiffScope | null` on the view model in `agents.tsx`, replacing `filesRunAtom` (`agents.tsx:98`). `null` means nothing is selected — an explicit fact, distinct from a load in flight.

## 2. Loaders

### 2.1 One change-list loader

The three loaders in `filesstore.ts` (`loadFilesForAgent:122`, `loadFilesForProject:144`, `loadFilesForRun:152`) already funnel into `loadChangesForCwd` and differ only in the optional argument they compute. They collapse to:

```ts
export interface RepoTarget { cwd: string | null; transcriptPath?: string }

export async function loadFilesForScope(scope: DiffScope, target: RepoTarget): Promise<void> {
    const token = scopeKey(scope);
    beginLoad(token);
    const opts = await resolveRangeOpts(scope.range, target);
    if (current.token !== token) return;
    await loadChangesForCwd(token, target.cwd, opts);
}
```

`target` carries the two things only the surface can look up — the resolved directory and the agent's transcript path — matching how `loadFilesForAgent` already takes a transcript path as an argument, so `filesstore.ts` keeps no view-model dependency.

`resolveRangeOpts` is the single place a range becomes RPC arguments:

| Range | Change-list arguments |
|---|---|
| working | none — live working tree vs HEAD |
| session | `sessionstartts` from `ensureSessionStart(target.transcriptPath)`; null degrades to the live diff, as today |
| run | `ref` = the run's base commit |
| compare | none — panes 1 and 2 are driven by `comparestore.ts`; this load exists only to supply cwd, branch and is-this-a-repo |

`filesProjectSelAtom` (`filesstore.ts:36`) is deleted. The scope vocabulary helpers `agentScope` / `runScope` / `projectScope` (`:49-51`) are replaced by `scopeKey`.

### 2.2 History

`loadToken` (`githistorystore.ts:130`) drops the anchor and keys on `historyKey(cwd, filters)`. The anchor and its two labels move into `historyOptsAtom` through a setter that does **not** trigger a reload, so a range change relabels the divider and the synthetic top row without re-reading git. `historyRowsAtom` already derives both from `historyOptsAtom` (`:63-80`), so no row-building code changes.

The surface's history effect stops assembling `{anchor, anchorLabel, rowLabel}` inline with nested ternaries (`filessurface.tsx:461-474`) and calls `historyOptsFor(range, state.ref)`.

The reset condition simplifies. Today it must tell a still-loading change list apart from an absent repository (`filessurface.tsx:446-458`, the fix in `c328ee36`). With scope stored, "nothing selected" is `scope == null` — an explicit fact — so the heuristic disappears. `settleSelection` and `announceRestore` are untouched.

### 2.3 Compare

`compareOnAtom` (`comparestore.ts:34`) becomes derived: `range.kind === "compare"`. There is then no way for the surface to be in comparison and in another scope at once. `enterCompare(cwd, branch, anchor)` becomes a range write carrying `from`; `compareAnchorAtom` and its invalidation effect are deleted (decision 6). The two-ref loads themselves are unchanged.

### 2.4 Deep links

`requestFileLink(scope, path)` / `consumeFileLink(scope, available)` keep their one-shot semantics. The scope string becomes `scopeKey(scope)` — the same function the loader uses — instead of a string each caller hand-builds. The hazard the comment at `filesstore.ts:46-51` warns about ("a link built from a different string than the load's would silently never be claimed") stops being live.

Both callers collapse into one helper:

```ts
openDiff(model, scope, file?)   // writes diffScopeAtom, requests the link, switches surface
```

replacing the ad-hoc sequence in `openRunDiff` (`runcompletionsurface.tsx:41-47`) and the agent file rail's separate path (`agentdetailsrail.tsx:85`).

## 3. The subject bar

Two controls. Left: **which repository** — the existing source picker, unchanged in behavior, listing agents (with a state dot) and registered projects (with a folder glyph), plus the active run pinned at the top while one is in context. Right: **which range** — a strip of chips built from `availableRanges`.

| State | Chips drawn |
|---|---|
| agent origin | Working tree · Since session start `<sha>` · Compare |
| project origin | Working tree · Compare |
| run origin | Working tree · This run `<sha>` · Compare |
| agent whose session start has not resolved | Working tree · ~~Since session start~~ (disabled, "no session-start commit recorded yet") · Compare |

When the compare range is selected, the two ref fields (`RefPicker`) sit beside the strip as that range's parameters.

Beneath the bar, a non-interactive line states the read in words: `worktree against a3f9c21 · 12 files · +340 −82`. This is `rangeSummary`, and it is a `<span>`, not a button.

Deleted from the bar: the three-way Repository / Agent / Run segmented control, and the `Reading <expression>` button. Every remaining control in the bar is live.

The default-to-first-agent behavior on mount (`filessurface.tsx:404-408`) is preserved: no stored scope plus at least one agent writes `{ repo: agent, range: session }`.

Keyboard is unchanged in meaning. `c` writes the compare range instead of calling `enterCompare` (`bindings.ts:603`); Escape keeps its precedence — clear filters, then leave compare (restoring `from`), then go home (`bindings.ts:576-585`). The range chips are ordinary buttons, so they are tab-reachable; the disabled one carries the HTML `disabled` attribute and is skipped.

## 4. Testing

**Gate on the existing suites: no behavioral assertion may be deleted or weakened.** `githistorystore.test.ts` (10 cases on selection settling and deep links) keeps its assertions and changes only in how it spells the scope string. `filesstore.test.ts` (11 cases) has `describe` blocks named after functions this spec deletes, so those are renamed by necessity; all three load assertions transfer one-for-one — threading a run's base commit through as the diff ref, resolving the session-start timestamp and threading the echoed commit into the follow-up diff, and falling back to a live diff when the session start cannot be resolved. A test that needs its *expectation* changed is a signal the refactor broke behavior, not that the test was stale.

**New unit tests, `diffscope.test.ts`:**

1. `availableRanges` per origin — agent yields working/session/compare, project yields working/compare, run yields working/run/compare. This is where the "no dead controls" property lives.
2. `scopeKey` stability — the same stored scope yields the same key across calls. Load-bearing: it is what lets the `sameSubject` check (`githistorystore.ts:156`) recognise a remount and keep scroll position and selection.
3. `scopeKey` uniqueness — an agent, a project and a run all identified as `x` produce three different keys. `filesstore.test.ts:116` asserts this behavior today; the guarantee moves to the function that now owns it.
4. `historyOptsFor` per range — anchor plus both labels for session and run, no labels for working tree (where the count genuinely is working-tree-vs-HEAD).
5. **Range change does not change the history key.** The invariant behind decision 5; this test is what catches a future change that folds the anchor back into the history token.
6. Compare carries and restores `from`.

**Rendered bar: Chrome DevTools Protocol, not jsdom.** Per the standing decision against jsdom render tests for surfaces, the bar is verified by extending the `git-history` scenario (`scripts/cdp/scenarios.mjs:2525`), which already builds three real repositories — a healthy one with 61 commits, one with its git object store emptied so reads fail, and a plain directory — and registers them as projects. Three assertions to add:

- a project-origin repo draws exactly two range chips and both are enabled;
- clicking a range chip updates the readout line beneath the bar;
- switching range after scrolling deep into history preserves the scroll offset — the user-visible proof of decision 5.

**Commands**, accounting for this repo's known traps: `npx vitest run frontend/app/view/agents/`; `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` for typecheck, because bare `npx tsc` stack-overflows here and the baseline is otherwise clean; `task verify:ui -- git-history` with the dev app running.

## 5. Rollout order

1. Add `diffscope.ts` and `diffscope.test.ts`. Nothing wired, nothing changes.
2. Switch `filesstore.ts`, `githistorystore.ts` and `comparestore.ts` to consume it, **leaving the subject bar's markup alone** — same controls in the same places, including the dead chips, now reading and writing the stored scope instead of the three source variables. Behavior must be identical and the existing suites are the proof. This step carries the risk and is independently checkable.
3. Replace the bar: range strip in; the dead Repository / Agent / Run chips and the `Reading <expression>` button out.
4. Point the run evidence card (`runcompletionsurface.tsx`) and the agent file rail (`agentdetailsrail.tsx`) at `openDiff`.
5. Extend the `git-history` CDP scenario.

## Risks

**The history pane's "keep your place" behavior is delicate.** It was fixed twice recently — a still-loading change list read as an absent repository (`c328ee36`), and a deep link losing to a remembered row (`7dec28d2`). Step 2 of the rollout exists so a regression surfaces while the old bar is still in place and the cause is unambiguous.

**Escape's precedence on this surface is guarded by an assertion.** Moving compare from a standalone boolean to a range value touches the ordering — clear filters, then leave compare, then go home — and `bindings.ts` runs `assertNoConflicts` over mutually-exclusive guards. It will fail loudly if the guards stop being disjoint. That is the desired failure mode, but it should be expected rather than surprising.

**Range switching is newly cheap, which changes load patterns.** Decision 5 means a user can flip ranges rapidly. `loadChangesForCwd` already guards with a token, so a stale response cannot clobber a newer one, but the rapid-switch path is not covered by an existing test and should get one.

## Out of scope

- Backend changes of any kind. No new RPC, no new `gitinfo` reader.
- Commit provenance ("produced by Run #148"), already deferred by `2026-07-31-git-branch-comparison-design.md`.
- The three-pane layout, the graph gutter, filtering, and paging — untouched.
- Opening an arbitrary directory that is neither an agent's worktree nor a registered project. The origin union has no "plain directory" kind; add one when there is a gesture that needs it.
- Remote (SSH/WSL) repositories, which `GitChanges` / `GitDiff` do not support today (`docs/open-issues.md`).
