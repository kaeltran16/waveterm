# Setup surface review fixes (design)

Source: `C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\setup\report.md` (F1-F26; screenshots beside it,
named by shot number), initiative effort:fdea6d43 "Surface review on real data", chunk 18 "Review: Setup surface
(Instructions, Skills, Memory tabs)". Every finding was checked against HEAD `bb96e22f1` before this was written;
all 26 are present as the report describes. Every decision below was made by the lead of an autonomous run; the
reason follows each one.

A second fix run (live-run states review) works in parallel. This run keeps to the files the Setup report names
and the ones listed here. No worker attaches to CDP `:9222` or runs `task verify:ui` against the default port: a
worker sees its scenario only in an isolated app started by
`ARC_FINAL_OUT=<a new temp dir> node scripts/cdp/final-verify.mjs <scenario...>`.

## Scenarios: what exists and what this run adds

- **Memory** has `setup-memory` (`scripts/cdp/scenarios-settings.mjs`, fixtures in `scripts/cdp/memory-fixtures.mjs`,
  temp folders only). Every Memory fix gets a lettered or new numbered step there. It never reads or writes the real
  `~/.claude`.
- **Instructions and Skills have no scenario.** `scripts/cdp/setup-fixtures.mjs` (an in-page simulation of the six
  agentsync RPCs, files under a temp root) was written for them and names `setup-instructions` and `setup-skills` in
  `SETUP_SCENARIO_NAMES`, but no scenario was ever built on it, and its runtime has drifted from the wire (it expects
  `overwrite`/`baseexists` on a steering write, `names`/`acknowledged` on adopt, a `piskills` block and
  `sourcekind`, none of which the current RPCs carry; Overwrite, which sends `basemtime: 0`, fails in it). So this
  run first aligns the fixture to the current wire and creates those two scenarios (D2); each later UI fix adds its
  step there. This is the one departure from "a step in an existing scenario": there was none to add to.

## Decisions

### D1. The agentsync wire changes land first, alone

Several fixes need new fields; they land as one small task so the Go and frontend work on them runs side by side.
In `pkg/wshrpc/wshrpctypes_agentsync.go`:

- `AgentSyncHarness.NoteTone string \`json:"notetone,omitempty"\`` (`ok` | `warn`): the tone of `note` (F3). The
  backend knows which of pi's three sentences is a warning; the frontend must not match note text.
- `AgentSyncHarness.Steering` doc: `current | stale | absent | blank`; `blank` = the shared doc is empty (F13).
- `AgentSyncSkillMove.Vault bool \`json:"vault,omitempty"\``: this copy's name is already a vault skill (F6).
- `CommandAgentSyncAdoptData.Skip []string \`json:"skip,omitempty"\``: names the user chose to leave alone (F5).
- `CommandAgentSyncAdoptRtnData.DryRun bool \`json:"dryrun,omitempty"\``: nothing was moved (a snapshot) (F5).
- `AgentSyncSkillLink { Runtime, Name, Path, Target string }` (json `runtime`, `name`, `path`, `target`) and
  `CommandAgentSyncSkillsRtnData.Linked []AgentSyncSkillLink \`json:"linked"\`` (F4).
- `const AgentSyncKeepVault = "vault"`: the `keep` value that picks the vault copy for a vault skill's stray copies
  (F6). The frontend mirrors it as a named constant with a comment naming this one.
- `AgentSyncSkill.States` doc gains `linked` (F4).

Then `task generate`. `agentsync.HarnessStatus` and `agentsync.SkillMove` gain the matching Go fields in the
backend task (D4), not here.

### D2. The Setup view and store split by tab, and the fixture is brought to the wire

`setupsurface.tsx` (784 lines) holds both the Instructions and Skills tabs, and `setupstore.ts` both their stores,
so two parallel tasks on them would collide. Memory already lives in its own `setupmemory.tsx`/`memorystore.ts`;
the other two tabs follow it:

- `setupinstructions.tsx`: `InstructionsTab`, `InstructionsHeader` (today's `HeaderStatus`), the file list, the
  conflict notice, the line editor, the shared editor and rail.
- `setupskills.tsx`: `SkillsTab`, `SkillsHeader`, the matrix, the rail, the keep choice.
- `setupparts.tsx`: what both use: `Dot`, `HarnessMark`, the button and tone class constants, `SECTION_HEAD`,
  `FADE_IN`, `ErrorBanner`, and two new parts: `LoadFailed` (the error text and a Retry button, drawn in place of
  "Reading…" when a tab's first read failed, F12) and `FilePreview` (a read-only view of one file: path line, mono
  text that wraps, scrolls in its box, "Could not read <path>" on failure; built on `useFileText` from
  `usefiletext.ts`; used by F15 and F18).
- `setupsurface.tsx` keeps only the shell: tabs, toolbar, panel.
- `setupstore.ts` keeps the tab, status and shared-doc atoms and actions; a new `setupskillsstore.ts` takes the
  skills atoms and actions.

F12's frontend part lands here, since it reshapes both stores: one error atom per tab
(`setupInstructionsErrorAtom`, `setupSkillsErrorAtom`), each cleared by its own successful read and set by its own
actions' failures; a failed first read (status or skills still null) draws `LoadFailed` with Retry instead of
"Reading…", in both the Instructions file list and center, and the Skills center. Rejected: one atom with a tab key
(a second tab's success must not touch the first's banner, and two atoms say that with no logic).

The fixture is aligned to the current wire (the commands and fields `wshclientapi.ts` and `gotypes.d.ts` carry,
including D1's), its stale fields dropped, and given the Instructions-side data later steps need: a Pi harness row
with a warn `note`/`notetone`; harness files (CLAUDE.md, AGENTS.md) written under the temp home so a preview reads
real bytes; a `blank` variant (every present row `blank`, empty doc); a variant whose doc has a 200-character
unbroken token (F19); a control that edits the doc "on disk" (new content and mtime) to force a conflict; a fault
that fails the first status read. The two scenarios are created in their own files,
`scripts/cdp/scenarios-setup-instructions.mjs` and `scripts/cdp/scenarios-setup-skills.mjs`, registered in
`scenarios.mjs`, each with step 1 (the tab draws the fixture's rows) and an F12 step (a failed first read shows the
error and Retry; Retry loads the rows; a Skills read success leaves an Instructions error alone). Later tasks own
these files; the Skills task also owns `setup-fixtures.mjs` after this one (the Instructions task does not edit it,
so it must get everything it needs here).

### D3. Memory backend: the snapshot guard, a readable list, an honest Undo, a case-blind sort

- **F1.** `CheckMemoryHygieneCommand` and `DecideMemoryChangeCommand` with verdict `apply` or `undo` refuse under
  `wavebase.IsSnapshot()` with an error starting `snapshot store:` that says why (a check calls a model; apply and
  undo write the real memory folders and repos' settings). `keep` and `reopen` write only the copied state and go
  through. The guard sits in `wshserver_memhygiene.go`, beside the other snapshot guards' RPC-level placement.
  Tests in `snapshotguard_test.go`. `docs/reference/surface-review.md` lists the three refusals in the
  `ARC_SNAPSHOT=1` list, and its "Not guarded" paragraph (actions that call a model) says the memory check is now
  refused.
- **F12 (backend).** `List` no longer fails the whole tab on one unreadable state file: that project is listed with
  its registry path, empty `changes`/`sharedwith`, and `lasterror` = `Could not read its saved state: <err>`; the
  error is also logged. Rejected: a new wire field (the rail already shows `lasterror`; D5 puts it ahead of "Not
  checked yet").
- **F10 (backend).** `entryUndo` refuses an applied change whose `BackupUntil` has passed, with
  `can't undo "<title>" in <project>: its backup expired on <date>`, instead of the raw "manifest not found".
- **F26.** `List` sorts names case-insensitively (byte order breaks ties, so the order stays total).

### D4. Agentsync backend: links, stray copies, skip, blank doc, Pi's note tone

- **F4.** `observeSkills` reports a symlink or junction (`ModeSymlink`, or `ModeIrregular` for a Windows mount
  point) whose target is a directory as `ObservedEntry{Linked: true}`, never `Managed`. A linked entry is never
  written into: the reconcile reports it (a new action kind) and skips it, as it does an unmanaged one; the skills
  matrix state for a vault skill whose harness entry is a link is `linked`; `unmanagedCopies` leaves links out, so
  adopt never moves one; `SkillLinks(p)` lists the links whose name is not a vault skill, returned as
  `CommandAgentSyncSkillsRtnData.Linked`. Tests make a junction with `cmd /c mklink /J` (Windows) and a symlink
  with `os.Symlink`, skipping only when the OS refuses to create it.
- **F6.** A harness copy whose name is a vault skill is planned with `Vault: true` and its delta against the vault
  tree (so the UI can say whether it differs), is never `Unresolved`, and `Adopt` leaves it where it is unless
  `keep[name]` is `"vault"` (`agentsync.KeepVault`: agentsync imports no wshrpc and keeps it that way, so it
  defines its own constant, and a wshserver test asserts it equals `wshrpc.AgentSyncKeepVault`), which sets the copy aside under `skills-replaced` (as a lost keep choice is
  today) so the reconcile then writes the vault copy. `claimKept` accepts `AgentSyncKeepVault` only for a vault
  skill (`KeepVault`) and still refuses a runtime keep for one. Rejected: letting a harness copy replace the vault's (no request
  for it, and the vault is the source of truth).
- **F5.** `Adopt` and `PlanAdopt` take a skip list; a skipped name contributes no move and is not unresolved. The
  RPC returns `DryRun` when the snapshot turned the apply into a dry run. The Go callers of `Adopt`/`PlanAdopt` are
  all in `wshserver_agentsync.go` (`wsh agentsync adopt` goes through the RPC, so it needs no change).
- **F13.** `steeringState` returns `blank` when the shared doc is empty or whitespace, whatever the harness file
  holds.
- **F3.** `Status` sets `NoteTone`: `ok` for "via the vault directly", `warn` for the other two sentences (pi gets
  none of Arc's own skills, or none of the vault's).

### D5. Memory tab: honest labels and statuses, no stray Undo, readable at 1000 px

- **F7.** The `own` group is labelled `<project>’s own memory`; its hint is "Loaded once you switch over" before
  the switch and "Loaded by <project> sessions" after it. The harvester sentence is gone (the group holds the
  judge's changes on the project's own folder, `check.go:125`).
- **F8.** A kept settings change reads "Kept sharing. Arc no longer checks <project> each week; Check now still
  does." (`closedText`), matching `sweepDue`. A kept-sharing project has nothing to review: `hasPending` (and so
  `railOrder`, `projectsToReview`, the toolbar) ignores its pending changes, matching the rail's "Kept sharing". The
  rail foot reads "Arc checks every project once a week, except one kept sharing." Rejected: counting its moot
  move-here changes (keeping the shared memory makes them meaningless until Review again).
- **F9.** `toolbarStatus`: pending → "N projects to review" (warn), with " · M checks failed" when any failed
  ("1 check failed" for one); else failed → "M checks failed" (warn); else never checked → "N not checked yet" (none); else "Every project
  checked" (ok).
- **F10.** `undoExpired(change, now)` (applied and past `backupuntil`): the Undo button is disabled, `u` does
  nothing, and `closedText` says "The backup expired on <date>, so this can't be undone."
- **F11.** `pickChange` with no chosen id and nothing pending returns null: the project opens with no change
  selected, the detail rail is not drawn, and `a`/`x`/`u` act on nothing. An explicit pick still selects an
  applied change with Undo live, and after the last verdict the decided change stays selected (Undo right after
  apply is wanted): a verdict pins the decided id in `memorySelectedChangeAtom` before advancing, since a change
  shown by default leaves that atom null and the new rule would otherwise drop it. Rejected: arming Undo on first press (a second keypress habit defeats it).
- **F12 (frontend).** A failed first list draws the error with Retry in place of "Reading…". `railStatus` puts
  `lasterror` ahead of "Not checked yet" (so D3's unreadable project reads "Last check failed").
- **F14.** Below a measured 1200 px tab width (the Diff surface's measured-width pattern, `difflayout.ts`), the
  change detail rail becomes a right-docked overlay sheet (`shadow-sheet-side`, `w-[min(400px,92cqw)]`), opened by
  a click or Enter on a row and closed by Esc, its close button, or a click on the table; `j`/`k` move the table
  selection whether it is open or not, and the verdict keys act on the highlighted row. The project rail stays, so
  at 1000x700 the center gets ~650 px. The index cards stack to one column when the center is under 560 px; a
  card's label and value keep a gap, and its role text truncates with a title. Rejected: collapsing the project
  rail (its names are the tab's navigation) and a narrower fixed rail (the 258 px center is the defect).
- **F20.** An evidence item's code quote renders on its own line under the text. Rejected: joining with " — " by a
  trailing-character rule (a heuristic over model text).
- **F21.** A diff header names the file by role, as the index cards do: a MEMORY.md in the shared (or former
  shared) folder is `<repo>’s MEMORY.md`, one in the own folder `<project>’s MEMORY.md`, anything else its base
  name; the full path is the title. Pure `diffLabel(p, path)` in `memorymodel.ts`.
- **F23.** A diff line's text span gets `min-w-0` and `[overflow-wrap:anywhere]`.
- **F16 (bindings).** The leader label reads "Setup (instructions, skills, memory)".

### D6. Instructions tab: a way to sync, honest counts, a real file list, safer edits, fluid layout

- **F2.** When any present harness is `stale` or `absent` and the doc is not blank (`needsSync`), a "Sync now"
  button sits beside the header status; the status's own text and tone stay `headerStatus`'s (F13), so only
  not-written rows show Sync now beside a none-toned status. Sync now runs `AgentSyncApplyCommand`, then a reload, any error in the
  Instructions banner. The launch-time sync in `cockpit-actions.ts` stops swallowing its error: a failure pushes a
  warn toast ("Harness sync failed: <reason>. Setup → Instructions has Sync now."); the launch still goes on.
- **F13.** `headerStatus` counts by state: "1 out of date · 1 not written yet" (warn when any is out of date, none
  when only not written), "N harnesses in sync" (ok), and with a `blank` doc "The shared doc is empty" (none). A
  `blank` row reads "Shared doc is empty" in the none tone.
- **F3 (rows).** A harness row with a `note` shows it under the state line, in the `notetone` tone.
- **F15.** Harness rows become buttons (a row whose harness is not set up stays disabled): picking one shows that
  file read-only in the center (`FilePreview`), the Shared row brings back the editor with its draft intact, and
  the selected style follows what the center shows. Rejected: opening it in Code (the F18 complaint: it leaves Setup
  and repoints Code's project).
- **F16 (copy).** "Saving writes this into each harness file listed on the left." The launch line reads "Arc also
  re-applies it whenever it launches an agent." `docs/keyboard-shortcuts.md` gets the new leader label and Ctrl+S.
- **F17.** Discard of a draft with more than 2 changed lines arms first ("Discard N lines" with Cancel, the
  memory tab's Apply all pattern); typing disarms it. Ctrl+S in the editor saves (a key handler on the textarea, as
  the tablist handles its arrows; no global binding).
- **F19.** The tab root gets `min-w-0`; the editor grid's column is `minmax(0,1fr)`, and both the ghost lines and
  the textarea get `[overflow-wrap:anywhere]` so line numbers stay level; the header's counts do not wrap. Below a
  1200 px tab width the "Where this goes" rail is not drawn (the file list already names every target).
- **F24.** On a conflict the store reads the doc as it is on disk and keeps it beside the draft; the notice lists
  the lines the disk version adds and drops against the editor's base (pure `diskChanges(base, disk)` in
  `setupmodel.ts`, multiset like `changedLineCount`, at most 8 shown with "+N more"), and says Overwrite drops the
  added ones. Rejected: a three-way merge (a large feature for a rare case).
- **F25.** "Last saved …" moves from the rail foot into the editor's subtitle, out of the avatar's corner.

### D7. Skills tab: Pi said plainly, links and stray copies listed, a per-skill opt-out, a result, a preview

- **F3 (skills).** The Skills header adds a Pi line from the status atom (Pi's `note` in its `notetone`) when Pi is
  set up. "Every harness" copy names the harnesses instead, from the present columns: `skillNote(row, columns)`
  and the keep hint ("Claude Code and Codex get it").
- **F4.** A non-vault link is a row in a "Linked from another folder" group, cells "Link" (title: the target); its
  rail says Arc leaves links alone (never moves one into the vault or writes through it). A vault skill's `linked`
  cell reads "Link" in the warn tone with that title. Links never count toward Manage.
- **F5.** Every unmanaged row's rail has the choice "Move it into the vault" (default) / "Leave it where it is";
  a body-differs row keeps its copy choices plus "Leave these copies alone". The choice lives in the one keep map,
  which `adoptKeep`/a new `adoptSkip` turn into the wire's `keep` and `skip`. A left-alone row's cells read "Left
  alone". After Manage, a toast: "Moved N skills into the vault" plus " · M wait for a decision" and
  " · L left alone" when non-zero; with `dryrun`, "Snapshot: nothing moved (would move N)". The counts come from
  the adopt result, not the pre-click matrix.
- **F6.** A vault skill with stray harness copies leaves "Managed by Arc" for a group "Own copy beside the vault":
  its rail lists the vault card and each copy with its delta, and the choice "Leave the own copy" (default) /
  "Replace it with the vault copy" (sent as `keep[name] = "vault"`; the copy is set aside under
  `skills-replaced`). It counts toward Manage only once Replace is chosen.
- **F18.** "Open SKILL.md" becomes "Preview SKILL.md", which toggles a `FilePreview` in the rail; Setup stays put
  and Code's project is untouched (`openSkillFile` and its `openFileInCode` import go).
- **F22.** The vault card uses `PathTail` (the tail with the skill folder and SKILL.md stays).

## Not in scope

F1's frontend needs nothing: a refusal shows in the Memory error banner as any decide error does. No new design
tokens: every color and shadow above is an existing `@theme` token.
