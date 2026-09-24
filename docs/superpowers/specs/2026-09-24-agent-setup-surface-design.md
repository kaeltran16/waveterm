# Agent setup surface: global instructions and skills

**Status:** Shipped (run 29347c08, 2026-09-24), except **Show folder** (see Buttons).

One place in the cockpit to manage the steering files and skills that every harness (Claude Code,
Codex, OpenCode, Pi) reads. Its name in the UI is **Setup**. It replaces the steering and skills
tabs that went away with the Vault surface (7a4c0c18). The backend they used, `pkg/agentsync`,
never left.

Mockups (gitignored, main checkout only):
`C:/Users/cktra/Projects/waveterm/.superpowers/design/agent-setup/project/{Main,Harness,FirstRun,Skills}.dc.html`.
They are HTML files you can read as text. Follow them for layout and copy. `DESIGN.md` wins on
tokens: the mockups use raw hex, but the components must use the `@theme` tokens in
`frontend/tailwindsetup.css`.

## Placement

- The surface key is `setup`, labeled "Setup" in the nav rail.
- It sits in the rail's bottom group directly above Settings, and like Settings it is not in
  `SURFACE_ORDER` (the Ctrl+1..8 chords are unchanged).
- It is reachable through `uiapi` (`SURFACES`), the same way Settings is. It is in the palette's
  "Go to" group only if Settings is.
- It unmounts on switch like every surface except Agent. It keeps no state worth surviving a
  switch except an unsaved shared-doc draft. That draft lives in a jotai atom so switching away
  does not lose it.
- The header reads "Setup" and has a tablist: **Instructions** | **Skills**.

## Instructions tab

A left list and a main pane.

The left list has these rows:
- **For every harness**: the shared doc at `vault/steering/AGENTS.md`. It shows an unsaved dot
  while there is a draft.
- One row per harness in `harness.List()` order: its label, its file path, and a state.

| State | When | Shown as |
|---|---|---|
| In sync | the region is `current` | "In sync" |
| Out of date | the region is `stale` | "Out of date" |
| Has own rules | `Carried > 0` | "Has N own lines" |
| Old memory only | no steering region, but a memory region | "Old memory only" |
| No file yet | the harness is present, but the file is missing | "No file yet" |
| Not set up | the harness is not present | row dimmed, "Not set up" |

**Shared doc selected** (Main.dc.html):
- A monospace editor holds the doc's full text.
- **Save to N harnesses** writes the doc with its mtime guard, then runs `AgentSyncApply`, which
  projects the doc into every present harness. N counts the present harnesses.
- **Discard** drops the draft.
- A conflict (the file changed on disk since it was read) shows an inline notice:
  "Changed on disk since you opened it". It offers **Reload**, which loses the draft, and
  **Overwrite**, which saves again with baseMtime 0.
- The right rail explains how a harness file is split into its three zones, lists the paths a
  save writes to, and shows the last save time.

**A harness selected** (Harness.dc.html) shows the three zones of `ReadHarness`, top to bottom:
1. **Rules only <label> follows** (Own):
   - An editable textarea.
   - **Save** writes it with `AgentSyncHarnessWrite`, using the same conflict handling as the
     shared doc.
   - **Move into shared** runs `AgentSyncFold`. It is enabled when `Carried > 0`.
2. **Instructions for every harness** (Shared):
   - Read-only.
   - A status line, "Same as shared · N lines" or "Out of date: save the shared doc to update".
   - An **Edit shared** link that selects the shared row.
3. **Old memory block · N lines**:
   - Shown only when Memory is non-empty, in the asking (amber) tone.
   - **Show** expands it read-only.
   - **Remove from file** runs the new `AgentSyncHarnessDropMemory`. The first click arms the
     button and the second confirms; no modal.

**First run** (FirstRun.dc.html) applies when the shared doc is missing or empty:
- The main pane explains that the rules reach only the harnesses that already hold them.
- If one or more harnesses hold rules, it offers the one with the most lines ("Start from
  Claude Code's rules", N lines). While the shared doc is missing, a harness's rules are its own
  block plus the body of any ARC-STEERING region an earlier sync left in its file. That region is
  then its only copy of those rules, and the first save of a new doc would overwrite it, so
  `ReadHarness` counts it in `Carried` and a fold seeds from it (`foldBlock`).
  - **Share with all N harnesses** runs Fold on that harness. A fold into an empty doc seeds it
    verbatim (own rules, then the leftover region), then projects the doc.
  - **Edit first** runs the same fold, then opens the shared editor.
- A text link, "start with an empty page", opens the shared editor on an empty draft.
- A notice lists the harnesses whose file carries a memory block, with its size, and links to
  that harness's row.

## Skills tab (Skills.dc.html)

The tab only views and syncs skills. It does not create or edit them: agents author skills. It is
a matrix with one row per skill and one column per `SkillColumns` harness. A column that is not
present shows "not set up" in its header.

A skill is managed when it lives in `vault/skills`, and unmanaged when it lives only in a harness's
own skills directory. A harness entry counts as a skill only if it holds a `SKILL.md` and its name
does not start with a dot, so Codex's bundled `.system` set and other tools' stores are never listed
or adopted (`isSkillDir`). The matrix shows both kinds:
- Managed rows come from `SkillRows`, with per-cell states synced, differs, unmanaged, or absent.
- Unmanaged rows come from `PlanAdopt`. Each move is a harness copy, and the cell shows either
  "same" or what that copy overrides (keys and files), or "differs in body text" when BodyDiff is
  set.

Rows are grouped, and each group heading carries its count:
1. **Needs a decision**: unresolved names from `PlanAdopt`, where the copies differ in body text.
2. **Differs between harnesses**: the copies carry key or file deltas.
3. **Same copy in N harnesses**: identical copies.
4. **Only in <label>**: a skill found in a single harness.
5. **Managed by Arc**: canonical skills.

The header summary reads "N skills · M managed by Arc". The primary button,
**Manage N skills in Arc**, runs `AgentSyncAdopt{Apply: true}` with the current keep choices. It
is disabled when nothing is adoptable.

**Detail rail** (a selected row):
- It shows the description, each harness's copy path, and what differs.
- For a Needs-a-decision skill, a radio group picks which harness's copy to keep.
  - The choice feeds the adopt call's `Keep` map.
  - Without a choice, the skill stays unresolved and adopt skips it, as it does today.
- Buttons:
  - **Open SKILL.md** opens the file on the Code surface through `openFileInCode`
    (`frontend/app/cockpit/openfilestore.ts`), the file router `wsh open` uses; `openref.ts` has
    no file target.
  - **Show folder** (not shipped) would reveal the directory in the OS file manager. The app has
    no opener for it: `getApi().openNativePath` is a stub in the Tauri bridge, and the
    `open_external` command allows only http/https/mailto.

## Backend

Restore the five RPCs that cd41207c removed, verbatim from `cd41207c^`. They are types in
`pkg/wshrpc/wshrpctypes_agentsync.go` and handlers in `pkg/wshrpc/wshserver/wshserver_agentsync.go`:
- `AgentSyncSteeringReadCommand`
- `AgentSyncSteeringWriteCommand`
- `AgentSyncHarnessReadCommand`
- `AgentSyncHarnessWriteCommand`
- `AgentSyncSkillsCommand`

Add these:

- **`agentsync.DropMemory(p, runtime, baseMtime) (WriteResult, error)`** and
  **`AgentSyncHarnessDropMemoryCommand`**.
  - This removes `memoryRegion(existing)` from the harness file. The own block and the steering
    region stay byte-identical, and the trailing whitespace between them is trimmed to one
    newline.
  - It uses the same mtime guard as `WriteHarnessOwn`.
  - A file with no memory region is a no-op that returns the current mtime.
- **Adopt keep choice.** Add `Keep map[string]string` (skill name to runtime) to
  `CommandAgentSyncAdoptData`, and give `agentsync.Adopt` and `agentsync.PlanAdopt` a matching
  keep parameter. For a kept name:
  - The kept runtime's copy seeds the shared tree, whatever the catalog order.
  - Every other copy of that name is not turned into a delta. It is moved to
    `<vault>/skills-replaced/<runtime>/<name>`, so the loss is recoverable.
  - Then the reconcile renders the kept copy into every harness.
  - A keep that names a runtime which holds no copy of that skill is an error.
- **Unmanaged rows.** `AgentSyncSkillsCommand` gains:
  - `Unmanaged []AgentSyncSkillMove`: the `PlanAdopt` moves.
  - `Unresolved []string`.

  The frontend builds the groups from these. The Go side does no grouping.

Run `task generate` after changing the types. Never hand-edit the generated files.

## Out of scope

- Creating, renaming or deleting a skill, or editing its body.
- Project-level `AGENTS.md` and `CLAUDE.md` files. Setup manages only the global ones.
- A diff view between skill copies. The rail lists what differs; it does not render a diff.

## Testing

- **Go:** `pkg/agentsync` tests for `DropMemory` (region removed; own and steering bytes unchanged;
  mtime conflict; no-op on a file without a region) and for the adopt keep choice (the kept copy
  seeds; the other copy is moved to `skills-replaced`; a bad keep errors; no keep leaves the skill
  unresolved).
- **Frontend:** the state and grouping logic is extracted into pure modules with vitest tests, per
  the frontend conventions. There are no render tests.
  - `setupmodel.ts` derives each harness row's state and the first-run offer from the RPC data.
  - `skillsmatrix.ts` groups rows and builds the adopt keep map.
- `surfaceorder.test.ts` and the uiapi tests are updated for the new surface key.
