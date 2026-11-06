# Setup surface review fixes (F1-F26)

> **For agentic workers:** each task below is one worker's. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix F1-F26 of the Setup surface review (Instructions, Skills, Memory tabs): the snapshot guard, the
agentsync and memhygiene backend fixes, and the three tabs' UI fixes, each UI fix seen in a CDP scenario step at the
width where it was broken.

**Architecture:** The agentsync wire lands first (Task 1) and the Setup view and store split by tab (Task 2), so the
Go agentsync work (Task 4), the Instructions tab (Task 6) and the Skills tab (Task 7) run side by side; the memhygiene
backend (Task 3) and the Memory tab (Task 5) start at once. Pure logic in a `.ts` beside its test; thin `.tsx`.

**Tech Stack:** Go (agentsync, memhygiene, wshserver), React 19 + jotai + Tailwind 4, vitest, CDP scenarios.

**Effort:** effort:fdea6d43-219b-4cf2-b4ce-51758338103b
**Spec:** `docs/superpowers/specs/2026-11-06-setup-review-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentsync ./pkg/memhygiene ./pkg/wshrpc/wshserver`
**Check:** `go vet ./pkg/agentsync ./pkg/memhygiene ./pkg/wshrpc/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs setup-instructions setup-skills setup-memory`

## Global Constraints

- **Never attach to CDP :9222 and never run `task verify:ui` against the default port.** See your scenario only in
  an isolated app: `ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>`.
- **Scenarios never touch real user data.** Memory steps use `scripts/cdp/memory-fixtures.mjs` (temp folders), never
  the real `~/.claude`. Instructions and Skills steps use `scripts/cdp/setup-fixtures.mjs` (in-page agentsync
  simulation), never the real agentsync RPCs.
- A UI fix's step runs at the width where it was broken: F14 and F19 at 1000x700, the rest at 1600x950 unless the
  task says otherwise. Viewport and reload traps: `docs/reference/cdp-verification.md`.
- Never lower an existing step's bar; add lettered sub-steps (`6b`) rather than renumbering existing steps.
- Colors, shadows and spacing from the `@theme` tokens in `frontend/tailwindsetup.css` only; no new tokens.
- `setupparts.tsx` belongs to Task 2: Tasks 6 and 7 do not edit it; a part only one tab needs goes in that tab's
  file. `setup-fixtures.mjs` is Task 2's, then Task 7's; Task 6 does not edit it.
- Lint/format only the files you touched; keep prettier off `scripts/*.mjs`.
- Never stop `wave-tauri.exe` / `wavesrv.x64.exe` by image name.
- Comments only for why, lower case. Quote copy exactly as the spec gives it (curly `’` where the spec has it).

## Review Focus

- F11: after the last pending change in a project is applied, that change stays selected with Undo live (the
  null-selection rule applies only when nothing was chosen). Task 5 pins it.
- F4: a dangling link (target gone) in a harness skills folder must not fail Status, the matrix or adopt; it is
  neither a skill nor written through. Task 4 pins it.
- F5: a name both skipped and given a keep is skipped: nothing of it moves or is set aside. Task 4 pins it.
- F15/F17: previewing a harness file and returning to Shared keeps the draft; an armed Discard is disarmed by
  typing. Task 6 pins both.
- F24: if the disk read after a conflict itself fails, the notice still offers Reload and Overwrite and says the
  disk version could not be read. Task 6 pins it.
- F12: Instructions with the status read ok but the steering read failing shows the error with Retry, never
  "Reading…" forever. Task 2 pins it.

---

### Task 1: Agentsync wire fields for links, stray copies, skip, dry run and note tone
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_agentsync.go`, `frontend/types/gotypes.d.ts`

Spec D1.

- [ ] In `wshrpctypes_agentsync.go` add exactly the spec D1 fields and type: `AgentSyncHarness.NoteTone`
  (`notetone,omitempty`), `AgentSyncSkillMove.Vault` (`vault,omitempty`), `CommandAgentSyncAdoptData.Skip`
  (`skip,omitempty`), `CommandAgentSyncAdoptRtnData.DryRun` (`dryrun,omitempty`), `type AgentSyncSkillLink struct
  { Runtime, Name, Path, Target string }` (json `runtime`, `name`, `path`, `target`),
  `CommandAgentSyncSkillsRtnData.Linked []AgentSyncSkillLink` (`linked`), `const AgentSyncKeepVault = "vault"`.
  Update the doc comments: `Steering` is `current | stale | absent | blank`; `States` gains `linked`.
- [ ] `task generate`; commit every file it changes (list any beyond `gotypes.d.ts` in your completion note).
- [ ] `go build ./... && task check:ts` pass.

### Task 2: Setup view and store split by tab, per-tab load errors, fixture brought to the wire
**Depends on:** none
**Files:** `frontend/app/view/agents/setupsurface.tsx`, `frontend/app/view/agents/setupinstructions.tsx`, `frontend/app/view/agents/setupskills.tsx`, `frontend/app/view/agents/setupparts.tsx`, `frontend/app/view/agents/setupstore.ts`, `frontend/app/view/agents/setupstore.test.ts`, `frontend/app/view/agents/setupskillsstore.ts`, `frontend/app/view/agents/setupskillsstore.test.ts`, `scripts/cdp/setup-fixtures.mjs`, `scripts/cdp/setup-fixtures.test.mjs`, `scripts/cdp/scenarios-setup-instructions.mjs`, `scripts/cdp/scenarios-setup-skills.mjs`, `scripts/cdp/scenarios.mjs`

Spec D2, F12 frontend for Instructions and Skills.

**Produces** (Tasks 6 and 7 rely on these names):
- `setupparts.tsx`: `Dot`, `HarnessMark`, `BTN_PRIMARY`, `BTN_SECONDARY`, `TONE_DOT`, `TONE_TEXT`, `SECTION_HEAD`,
  `FADE_IN`, `ErrorBanner({ error })`, `LoadFailed({ error, onRetry })`, `FilePreview({ path, className? })`.
- `setupinstructions.tsx`: `InstructionsTab`, `InstructionsHeader`. `setupskills.tsx`: `SkillsTab({ model })`,
  `SkillsHeader`.
- `setupstore.ts`: today's tab/status/shared atoms and actions, plus `setupInstructionsErrorAtom`.
  `setupskillsstore.ts`: today's skills atoms and actions (`setupSkillsAtom`, `setupSkillKeepAtom`,
  `setupSkillSelectedAtom`, `loadSkills`, `selectSkill`, `setSkillKeep`, `adoptSkills`, `openSkillFile`), plus
  `setupSkillsErrorAtom`. `setupBusyAtom` stays in `setupstore.ts` and both use it. `setupTabAtom` stays where
  `openref.ts` imports it.
- Scenario exports `setupInstructions` (name `setup-instructions`) and `setupSkills` (name `setup-skills`).

- [ ] Move the components out of `setupsurface.tsx` as listed, with no behavior change beyond F12; the surface
  keeps the shell. `npx vitest run frontend/app/view/agents/skillsmatrix.test.ts frontend/app/view/agents/setupmodel.test.ts`
  still passes.
- [ ] Failing tests first. `setupstore.test.ts` (mock `RpcApi` as `sessionsarchivestore.test.ts` does):
  `loadSetup` with the steering read rejecting sets `setupInstructionsErrorAtom` and leaves status null; a later
  successful `loadSetup` clears it; a failing `loadSkills` never sets `setupInstructionsErrorAtom`.
  `setupskillsstore.test.ts`: `loadSkills` rejecting sets `setupSkillsErrorAtom`; success clears it and leaves
  `setupInstructionsErrorAtom` as it was.
- [ ] Implement the per-tab atoms (`busy()` takes the atom it reports to) and `LoadFailed` in place of every
  "Reading…" when that tab's first read failed (Instructions file list and center, Skills center). `FilePreview`
  wraps `useFileText`; a failed or empty read shows "Could not read <path>".
- [ ] Align `setup-fixtures.mjs` to the current wire: the commands and fields `wshclientapi.ts` and
  `gotypes.d.ts` carry today, plus spec D1's new fields by the names spec D1 gives (this task does not wait for
  Task 1, so take them from the spec, not the generated types: a write sends `{content, basemtime}` with `basemtime: 0`
  meaning overwrite; adopt takes `{apply, keep, skip}` and returns `{moves, unresolved, dryrun}`; skills return
  `linked`); drop `piskills`, `sourcekind`, `names`, `acknowledged`, `overwrite`, `baseexists`. Add spec D2's
  Instructions-side data: a present `pi` harness row with `note: "pi settings do not point at the synced skills"`
  and `notetone: "warn"`; CLAUDE.md and AGENTS.md written at each present harness's `path` under the temp home; a
  `blank` variant (empty doc, every present row `blank`); a `long-token` variant (the doc holds one 200-character
  unbroken token); a control that rewrites the doc on disk (new content, new mtime) to force a conflict; a fault
  that rejects the first `agentsyncstatus` read. `setup-fixtures.test.mjs` covers the write/overwrite rule, the
  adopt `skip`, the disk-edit control and the fault.
- [ ] Create the two scenario files and register them in `scenarios.mjs`. `setup-instructions` step 1: the tab
  shows the fixture's harness rows and the shared doc. Step 2 (F12): with the status fault, the tab shows the
  error and a Retry button and no "Reading…"; Retry shows the rows; then a Skills tab visit that loads does not
  clear an Instructions error set by a failing save (use a write fault). `setup-skills` step 1: the matrix shows
  the fixture's groups. Step 2 (F12): a failing first skills read shows error and Retry; Retry draws the matrix.
- [ ] `npx vitest run frontend/app/view/agents/setupstore.test.ts frontend/app/view/agents/setupskillsstore.test.ts scripts/cdp/setup-fixtures.test.mjs`
  passes; both scenarios pass in an isolated app.

### Task 3: Memory backend: snapshot guard, readable list, expired Undo, case-blind sort
**Depends on:** none
**Files:** `pkg/wshrpc/wshserver/wshserver_memhygiene.go`, `pkg/wshrpc/wshserver/snapshotguard_test.go`, `pkg/memhygiene/entry.go`, `pkg/memhygiene/entry_test.go`, `pkg/memhygiene/store.go`, `pkg/memhygiene/store_test.go`, `docs/reference/surface-review.md`

Spec D3 (F1, F10 backend, F12 backend, F26).

- [ ] Failing tests first, set up the way the existing tests in each file are:
  - `snapshotguard_test.go`: `TestSnapshotRefusesMemoryCheck` (ARC_SNAPSHOT=1, `CheckMemoryHygieneCommand` returns
    an error with prefix `snapshot store:` and no state changes), `TestSnapshotRefusesMemoryApplyUndo` (verdicts
    `apply` and `undo` refused with that prefix, no file written), `TestSnapshotAllowsMemoryKeepReopen` (`keep`
    then `reopen` succeed on a fixture state).
  - `entry_test.go`: `TestUndoRefusesExpiredBackup`: an applied change with `BackupUntil` in the past returns an
    error containing `its backup expired on` and leaves the change applied.
  - `store_test.go`: `TestListMarksUnreadableProject` (one corrupt state file: `List` returns every project, that
    one with `LastError` starting `Could not read its saved state:` and non-nil empty `Changes`/`SharedWith`);
    `TestListSortsCaseInsensitively` (`MP-Frontend`, `cyber_b`, `cyber_a` → `cyber_a`, `cyber_b`,
    `MP-Frontend`).
- [ ] Run `go test ./pkg/memhygiene -run '^Test(UndoRefusesExpiredBackup|ListMarksUnreadableProject|ListSortsCaseInsensitively)$'`
  and `go test ./pkg/wshrpc/wshserver -run '^TestSnapshot(RefusesMemoryCheck|RefusesMemoryApplyUndo|AllowsMemoryKeepReopen)$'`: fail.
- [ ] Implement: the guard in `wshserver_memhygiene.go` (messages name why: a model call; writes to the real memory
  folders and repo settings); `entryUndo(st, c, now)` checks expiry before `Undo`; `List` logs and marks an
  unreadable project and sorts with a case-folded compare, ties by byte order.
- [ ] `docs/reference/surface-review.md`: add the Memory refusals to the `ARC_SNAPSHOT=1` list (Check, Apply and
  Undo refused; Keep and Review again write only the copied state, `wshserver_memhygiene.go`), and add to the
  "Not guarded" paragraph (actions that call a model) that the Memory tab's check is now refused.
- [ ] Rerun the tests above: pass.

### Task 4: Agentsync backend: links, stray copies, skip, blank doc, Pi's note tone
**Depends on:** Task 1 (uses the wire fields and `AgentSyncKeepVault`)
**Files:** `pkg/agentsync/skills.go`, `pkg/agentsync/skills_test.go`, `pkg/agentsync/adopt.go`, `pkg/agentsync/adopt_test.go`, `pkg/agentsync/status.go`, `pkg/agentsync/status_test.go`, `pkg/agentsync/steering.go`, `pkg/agentsync/steering_test.go`, `pkg/agentsync/agentsync.go`, `pkg/wshrpc/wshserver/wshserver_agentsync.go`, `pkg/wshrpc/wshserver/wshserver_agentsync_test.go`

Spec D4 (F3 tone, F4, F5, F6, F13).

**Produces:** `const KeepVault = "vault"` in `adopt.go` (agentsync imports no wshrpc and must not start to:
`Adopt`/`claimKept` compare against `KeepVault`); `ObservedEntry.Linked bool`, `ObservedEntry.Target string`;
`stateLinked = "linked"`;
`type SkillLink struct{ Runtime, Name, Path, Target string }`, `func SkillLinks(p Paths) ([]SkillLink, error)`;
`SkillMove.Vault bool`; `func PlanAdopt(p Paths, keep map[string]string, skip []string) (AdoptPlan, error)`;
`func Adopt(p Paths, apply bool, keep map[string]string, skip []string) (AdoptPlan, error)`;
`HarnessStatus.NoteTone string`; steering state `"blank"`.

- [ ] Failing tests first:
  - `skills_test.go`: `TestObserveSkillsLinkedEntry` (a junction via `cmd /c mklink /J` on Windows, and a symlink
    via `os.Symlink`, each `t.Skip` only if the OS refuses to create it: observed with `Linked` true, `Managed`
    false, `Target` set); `TestObserveSkillsDanglingLink` (a link to a removed dir: no error, not reported as a
    skill); `TestReconcileNeverWritesThroughLink` (a vault skill whose harness entry is a link: `Apply(p, false)`
    leaves the link target's files byte-identical and reports the link, no write action);
    `TestSkillRowsLinkedState` (state `linked`); `TestSkillLinksListsNonVaultLinks`.
  - `adopt_test.go`: `TestPlanAdoptSkipsLinks` (a linked skill is never a move); `TestPlanAdoptMarksVaultCopy`
    (a harness copy of a vault skill: `Vault` true, delta computed, not in `Unresolved` even if its body differs);
    `TestAdoptLeavesVaultCopyByDefault`; `TestAdoptKeepVaultSetsCopyAside` (`keep[name]="vault"`: the copy ends up
    under `skills-replaced/<runtime>/<name>` and the harness gets the vault copy); `TestClaimKeptVaultOnlyForVaultSkills`
    (`"vault"` for a non-vault name is refused; a runtime keep for a vault name is still refused);
    `TestAdoptSkipList` (a skipped name moves nothing and is not unresolved; a name both skipped and kept is
    skipped).
  - `steering_test.go`: `TestSteeringStateBlank` (blank or whitespace doc → `blank`, with and without a region).
  - `status_test.go`: `TestPiNoteTone` (vault-direct → `ok`; via claude's folder → `warn`; no pointer → `warn`).
- [ ] Run `go test ./pkg/agentsync -run '^Test(ObserveSkills|ReconcileNeverWritesThroughLink|SkillRowsLinkedState|SkillLinksListsNonVaultLinks|PlanAdopt|AdoptLeavesVaultCopyByDefault|AdoptKeepVaultSetsCopyAside|ClaimKeptVaultOnlyForVaultSkills|AdoptSkipList|SteeringStateBlank|PiNoteTone)'`: the new tests fail.
- [ ] Implement per spec D4: a link is observed by its `Type()` (`ModeSymlink` or `ModeIrregular`) and `os.Stat`
  of the target; a new action kind for a linked entry in the reconcile (named beside the existing ones); vault
  copies never seed and act only on `keep == AgentSyncKeepVault`.
- [ ] `wshserver_agentsync.go`: `AgentSyncAdoptCommand` passes `data.Skip` to `Adopt` and sets `DryRun` when
  `data.Apply && wavebase.IsSnapshot()`; `AgentSyncSkillsCommand`'s `PlanAdopt(p, nil)` (the second caller)
  becomes `PlanAdopt(p, nil, nil)`; map `NoteTone`, `Vault` and `SkillLinks` into the replies (`Linked` never null).
- [ ] New `wshserver_agentsync_test.go` (point `agentsync.DefaultPaths` at a temp home the way the package's tests
  can; if `DefaultPaths` has no seam, add a package-level `var defaultPaths = agentsync.DefaultPaths` in
  `wshserver_agentsync.go` and set it in the test): `TestAgentSyncAdoptPassesSkip` (a skipped skill stays in the
  harness folder after an apply), `TestAgentSyncAdoptDryRunUnderSnapshot` (ARC_SNAPSHOT=1 with `apply: true`:
  reply `DryRun` true, nothing moved), `TestAgentSyncSkillsLinkedNeverNull` (no links → `Linked` is an empty
  slice), `TestAgentSyncStatusMapsNoteTone`, `TestKeepVaultMatchesWire` (`agentsync.KeepVault ==
  wshrpc.AgentSyncKeepVault`).
- [ ] Rerun the tests above, `go test ./pkg/wshrpc/wshserver -run '^Test(AgentSync|KeepVaultMatchesWire)'`, then
  `go test ./pkg/agentsync -run '^Test(Adopt|PlanAdopt|Status|Apply|Steering)'`: pass.

### Task 5: Memory tab: labels, statuses, no stray Undo, evidence and diffs, 1000 px layout
**Depends on:** Task 3 (its setup-memory step for an unreadable state file needs `List` to mark that project instead of failing the list)
**Files:** `frontend/app/view/agents/memorymodel.ts`, `frontend/app/view/agents/memorymodel.test.ts`, `frontend/app/view/agents/setupmemory.tsx`, `frontend/app/view/agents/memorystore.ts`, `frontend/app/view/agents/memorystore.test.ts`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `scripts/cdp/scenarios-settings.mjs`, `scripts/cdp/memory-fixtures.mjs`, `scripts/cdp/memory-fixtures.test.mjs`

Spec D5 (F7, F8, F9, F10, F11, F12 frontend, F14, F16 leader label, F20, F21, F23).

**Produces:** in `memorymodel.ts`: `undoExpired(change: MemChange, now: number): boolean`,
`diffLabel(p: MemHygieneProject, path: string): string`, `MEMORY_OVERLAY_PX = 1200`,
`memoryDetailLayout(width: number): "column" | "overlay"`.

- [ ] Failing tests first in `memorymodel.test.ts`, with the spec's exact copy:
  - F7 `changeGroups` own group label `` `${project}’s own memory` ``, hint "Loaded once you switch over" before the
    switch and `Loaded by ${project} sessions` after.
  - F8 `closedText` for a kept settings change: `Kept sharing. Arc no longer checks ${project} each week; Check now still does.`;
    a kept-sharing project with pending split changes is not in `projectsToReview` and sorts with the done half in
    `railOrder`.
  - F9 `toolbarStatus` (the failed part is `` `${count(m, "check")} failed` ``): 2 pending + 1 failed →
    `2 projects to review · 1 check failed` (warn); 0 pending + 2 failed → `2 checks failed` (warn); 0 pending,
    0 failed, 1 never checked → `1 not checked yet` (none); else `Every project checked` (ok).
  - F10 `undoExpired` true only for applied and `backupuntil < now`; `closedText` then ends with
    `The backup expired on ${monthDay}, so this can't be undone.`
  - F11 `pickChange(p, null)` with nothing pending → null; with an explicit id of an applied change → that change;
    `resolveSelection` on a nothing-pending project → change null.
  - F12 `railRow` for a never-checked project with `lasterror` → "Last check failed" (warn).
  - F21 `diffLabel`: shared-folder MEMORY.md → `` `${repo}’s MEMORY.md` ``, own-folder MEMORY.md →
    `` `${project}’s MEMORY.md` ``, a memory file → its base name; works on `\` and `/` paths.
  - F14 `memoryDetailLayout(1199)` → overlay, `(1200)` → column, `(0)` → column (not measured yet).
- [ ] `npx vitest run frontend/app/view/agents/memorymodel.test.ts`: fail; implement in `memorymodel.ts`: pass.
- [ ] Review Focus, failing first in a new `memorystore.test.ts` (mock `RpcApi` as `sessionsarchivestore.test.ts`
  does): with `memorySelectedChangeAtom` null and the one pending change shown by default, `decideMemory(...,
  "apply")` resolving to that change applied leaves `memorySelectedChangeAtom` equal to its id and
  `memorySelection().change` non-null; the same through `applyMemoryGroup` for its last id. Fix in
  `memorystore.ts`: a verdict (and each Apply all step) pins the decided id in `memorySelectedChangeAtom` before
  `advanceFrom`.
- [ ] `bindings.test.ts`: the `.` leader entry's label is `Setup (instructions, skills, memory)` (fails first).
- [ ] View (`setupmemory.tsx`, `memorystore.ts`, `bindings.ts`): F10 Undo disabled and `u` a no-op when expired;
  F11 no detail rail with no selection; F12 a failed first list draws the error with a Retry calling `loadMemory`
  in place of "Reading…"; F14 measured tab width → overlay sheet per spec D5 (open on click/Enter, close on Esc,
  close button, table click; `j`/`k` keep working; an Escape binding in `buildMemoryBindings` while it is open);
  cards stack under a 560 px center, label/value gap, role truncates with a title; F20 code quote on its own line;
  F21 `DiffBlock` header shows `diffLabel` with the full path as title; F23 `min-w-0 [overflow-wrap:anywhere]` on
  the line text; F16 leader label `Setup (instructions, skills, memory)` in `bindings.ts`.
- [ ] `memory-fixtures.mjs`: give the fixtures what the steps need: an evidence item whose text ends with no space
  before its code quote; a move-here change with two MEMORY.md diffs (shared and own folder); a diff line with an
  unbroken 120-character token; an applied change whose `backupuntil` is past; a kept-sharing project with a
  pending shared change; a registered project whose state file is not JSON. `memory-fixtures.test.mjs` covers them.
- [ ] `setup-memory` steps (lettered after the step they extend, or new numbers after 12), each asserting the DOM,
  at 1600x950 unless noted: F7 the own group's label and hint on the split project, before and after the switch;
  F8 the kept-sharing project's rail reads "Kept sharing", is not counted in the toolbar, its closed text is the
  spec's, and the rail foot reads `Arc checks every project once a week, except one kept sharing.`; F9 the toolbar
  with a failed and an unchecked project; F10 the expired change's Undo is disabled with the expiry text, and `u`
  changes nothing; F11 a project with nothing pending opens with no `[data-memory-detail]` and `u` changes
  nothing, and on a project with one pending change, pressing `a` with no click first leaves the detail drawn
  with Undo enabled; F12 the unreadable project reads "Last check failed" and the rest still list, and a
  failing first list (stub the RPC) shows Retry, which then lists; F20 the quote is on its own line (its box's top
  is below the text's); F21 the two diff headers read the two role names; F23 the long diff line's right edge is
  inside the diff block; F14 at 1000x700: the change table's Memory column is at least 200 px wide, the detail is an
  overlay that opens on a row click and closes on Esc, and the index cards' label and value boxes do not touch;
  then at 1600x950 the detail is a column again.
- [ ] `npx vitest run frontend/app/view/agents/memorymodel.test.ts frontend/app/view/agents/memorystore.test.ts frontend/app/store/keybindings/bindings.test.ts scripts/cdp/memory-fixtures.test.mjs`
  passes; `setup-memory` passes in an isolated app.

### Task 6: Instructions tab: Sync now, honest counts, real file list, safer edits, fluid layout
**Depends on:** Task 1 (uses `AgentSyncHarness.notetone` in `gotypes.d.ts`), Task 2
**Files:** `frontend/app/view/agents/setupinstructions.tsx`, `frontend/app/view/agents/setupstore.ts`, `frontend/app/view/agents/setupstore.test.ts`, `frontend/app/view/agents/setupmodel.ts`, `frontend/app/view/agents/setupmodel.test.ts`, `frontend/app/cockpit/cockpit-actions.ts`, `frontend/app/cockpit/cockpit-actions.test.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-setup-instructions.mjs`

Spec D6 (F2, F3 rows, F13, F15, F16 copy, F17, F19, F24, F25).

**Produces:** in `setupmodel.ts`: `HarnessRowState` gains `"blank"`; `headerStatus(rows)` per F13;
`needsSync(rows): boolean`; `diskChanges(base: string, disk: string): { added: string[]; dropped: string[] }`;
`DocEditor.disk: string | null` (null = not read). In `setupstore.ts`: `syncNow(): Promise<void>`.

- [ ] Failing tests first. `setupmodel.test.ts`: F13 `headerStatus` → `1 out of date · 1 not written yet` (warn),
  `2 not written yet` (none), `3 harnesses in sync` (ok), any `blank` → `The shared doc is empty` (none);
  `harnessRowLabel("blank")` → `Shared doc is empty`; F2 `needsSync` true for a present stale or absent row, false
  when all current, false when blank; F24 `diskChanges("a\nb", "a\nc\nd")` → added `["c","d"]`, dropped `["b"]`
  (multiset: a moved line is neither). `setupstore.test.ts`: `syncNow` calls `AgentSyncApplyCommand` then reloads
  status; a rejecting apply sets `setupInstructionsErrorAtom`; a save that conflicts reads the disk doc into
  `disk`, and a failing disk read leaves `disk` null with `conflict` still true (Review Focus).
- [ ] `npx vitest run frontend/app/view/agents/setupmodel.test.ts frontend/app/view/agents/setupstore.test.ts`: fail;
  implement: pass.
- [ ] View per spec D6: F2 Sync now shown exactly when `needsSync`, beside the status whose text and tone stay
  `headerStatus`'s; F3 a row's `note` in its `notetone`; F15 harness rows
  as buttons switching the center to `FilePreview`, Shared back to the editor with the draft kept (Review Focus);
  F16 the two sentences; F17 Discard arms above 2 changed lines and typing disarms (Review Focus), Ctrl+S in the
  textarea saves; F19 `min-w-0` on the tab root, `minmax(0,1fr)`, `[overflow-wrap:anywhere]` on ghost lines and
  textarea, non-wrapping header counts, rail hidden under a measured 1200 px tab width; F24 the notice lists
  added/dropped lines (at most 8, then `+N more`), or says the disk version could not be read; F25 "Last saved …"
  in the editor subtitle.
- [ ] `cockpit-actions.ts`: the launch-time sync failure pushes a warn toast `Harness sync failed: <reason>. Setup →
  Instructions has Sync now.` via `pushToast`; the launch continues. Failing first in `cockpit-actions.test.ts`
  (it already mocks `AgentSyncApplyCommand`): with the apply rejecting `boom`, `pushToast` gets level `warn` and
  that message with `boom` as the reason, and the launch still returns the block id.
- [ ] `docs/keyboard-shortcuts.md`: the `.` leader row reads `Setup (instructions, skills, memory)`; add Ctrl+S
  (Setup, Instructions editor: save).
- [ ] `setup-instructions` steps at 1600x950 unless noted: F2 with no draft and a stale row, Sync now is shown and
  pressing it calls apply and the header turns to in sync; F13 on the `blank` variant the header and rows read the
  blank copy, and a mixed status reads the counted copy; F3 Pi's note shows under its row in the warn tone; F15
  clicking the Claude Code row shows its file text read-only, Shared returns to the editor with a typed draft
  intact, and the selected style follows; F16 the subtitle and launch sentence; F17 a 5-line draft's Discard asks
  first and Cancel keeps the draft, a 1-line draft discards at once, Ctrl+S saves (fixture records the write);
  F24 the disk-edit control then Save shows the conflict listing the outside line as added; F25 "Last saved"
  sits in the editor header and no rail text lies in the bottom 120 px of the window's right 120 px; F19 at
  1000x700 on the `long-token` variant: no horizontal overflow of the tab panel, the editor's right edge is inside
  the window, line number 1's top equals the first ghost line's top, and the "Where this goes" rail is absent.
- [ ] `npx vitest run frontend/app/view/agents/setupmodel.test.ts frontend/app/view/agents/setupstore.test.ts frontend/app/cockpit/cockpit-actions.test.ts` passes; `setup-instructions` passes in an isolated app.

### Task 7: Skills tab: Pi line, links, stray copies, per-skill opt-out, adopt result, preview
**Depends on:** Task 1 (uses `linked`, `vault`, `skip`, `dryrun` in `gotypes.d.ts`), Task 2
**Files:** `frontend/app/view/agents/setupskills.tsx`, `frontend/app/view/agents/setupskillsstore.ts`, `frontend/app/view/agents/setupskillsstore.test.ts`, `frontend/app/view/agents/skillsmatrix.ts`, `frontend/app/view/agents/skillsmatrix.test.ts`, `scripts/cdp/setup-fixtures.mjs`, `scripts/cdp/setup-fixtures.test.mjs`, `scripts/cdp/scenarios-setup-skills.mjs`

Spec D7 (F3 skills, F4, F5, F6, F18, F22).

**Produces:** in `skillsmatrix.ts`: `KEEP_VAULT = "vault"` and `KEEP_LEAVE` (the in-map "leave it" choice, never
sent), `SkillGroupKind` gains `"linked"` and `"stray"`, `adoptSkip(data, keep): string[]`,
`skillNote(row, columns)`, `adoptResultText(rtn: CommandAgentSyncAdoptRtnData, sent: { skip: string[] }): string`.

- [ ] Failing tests first in `skillsmatrix.test.ts`: a `linked` entry with a non-vault name makes a row in group
  "Linked from another folder" with cells "Link" (title the target), not counted by `adoptCount`; a vault skill's
  `linked` state → cell "Link" (warn); a vault skill with a stray copy → kind `stray`, group "Own copy beside the
  vault", not counted until `keep[name] = KEEP_VAULT`, then counted once and sent as `keep: {name: "vault"}`;
  `KEEP_LEAVE` on an unmanaged row → `adoptSkip` lists it, its cells read "Left alone", `adoptCount` drops it;
  `skillNote` for an `only` row with columns Claude Code and Codex names the other present harness, and no note
  says "every harness"; `adoptResultText` → `Moved 3 skills into the vault · 1 wait for a decision · 2 left alone`,
  and with `dryrun` → `Snapshot: nothing moved (would move 3)`.
- [ ] `npx vitest run frontend/app/view/agents/skillsmatrix.test.ts`: fail; implement: pass.
- [ ] Store and view: `adoptSkills` sends `keep` and `skip`, pushes an info toast with `adoptResultText` from the
  reply (`setupskillsstore.test.ts`: the toast text comes from the reply, not the pre-click matrix); the rail's
  choice radios per spec D7; the keep hint names the present harnesses; the header's Pi line from
  `setupStatusAtom` in Pi's `notetone`; "Preview SKILL.md" toggles `FilePreview` in the rail and `openSkillFile`
  with its `openFileInCode` import is removed; the vault card uses `PathTail`.
- [ ] `setup-fixtures.mjs`: add a non-vault linked skill (`linked` entry with a target under the temp root), a
  stray copy of a vault skill (`vault: true` move), adopt replies that honor `keep`/`skip` and can return
  `dryrun`; `setup-fixtures.test.mjs` covers them.
- [ ] `setup-skills` steps at 1600x950: F3 the header's Pi line and no "every harness" text in the rail; F4 the
  linked row and its rail sentence, and Manage's count excludes it; F6 the stray row, choosing Replace raises
  Manage's count by one and the adopt call carries `keep: {<name>: "vault"}`; F5 choosing Leave on a row shows
  "Left alone", lowers the count, the adopt call carries it in `skip`, and the toast shows the reply's counts
  (then once with `dryrun`); F18 Preview SKILL.md shows the file text in the rail, the surface stays Setup and
  Code's project is unchanged; F22 the vault card's text ends with `SKILL.md`. Step at 1000x700: the matrix and
  rail still fit (no horizontal overflow).
- [ ] `npx vitest run frontend/app/view/agents/skillsmatrix.test.ts frontend/app/view/agents/setupskillsstore.test.ts scripts/cdp/setup-fixtures.test.mjs`
  passes; `setup-skills` passes in an isolated app.
