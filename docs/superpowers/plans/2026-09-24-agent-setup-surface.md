# Agent setup surface

**Setup:** `task worktree:prepare`
**Check:** `go vet ./pkg/agentsync/ ./pkg/wshrpc/... && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Verify:** `go test ./pkg/agentsync/ && npx vitest run frontend/app/view/agents frontend/app/cockpit frontend/app/store/keybindings`

The spec is `C:/Users/cktra/Projects/waveterm/docs/superpowers/specs/2026-09-24-agent-setup-surface-design.md`,
and the mockups are `C:/Users/cktra/Projects/waveterm/.superpowers/design/agent-setup/project/*.dc.html`.
Both are in the main checkout only: they are untracked or gitignored, so your worktree does not
have them. Read them by those absolute paths, and never copy them into the worktree or commit them.

Rules for every task:
- Locate code by symbol, not by line number.
- Never hand-edit generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`,
  `pkg/wshrpc/wshclient/wshclient.go`). Change the Go types and run `task generate`.
- Colors come from the `@theme` tokens in `frontend/tailwindsetup.css`, never raw hex. The mockups'
  hex values map onto those tokens.
- Put testable logic in a pure `.ts` module with a `.test.ts` beside it. Write no render tests.
- Do not edit `docs/`. The engine folds the plan into the first merge.
- Do not touch `frontend/app/view/jarvis/*` or `frontend/app/view/agents/runlauncher.tsx`. Another
  session has uncommitted work in those files in the main checkout.

### Task 1: Restore the steering RPCs and add DropMemory
**Depends on:** none

Restore these four RPCs in `pkg/wshrpc/wshrpctypes_agentsync.go` and
`pkg/wshrpc/wshserver/wshserver_agentsync.go`, verbatim from `git show cd41207c^:<file>`:
- `AgentSyncSteeringReadCommand`
- `AgentSyncSteeringWriteCommand`
- `AgentSyncHarnessReadCommand`
- `AgentSyncHarnessWriteCommand`

Restore their types and handlers together. The `agentsync` functions they call still exist.

Add `agentsync.DropMemory(p Paths, runtime string, baseMtime int64) (WriteResult, error)` in
`pkg/agentsync/agentsync.go`, next to `WriteHarnessOwn`, and give it the same guards as that
function:
- It errors on an unknown runtime.
- It errors when the harness is not present.
- It returns an mtime conflict when the file changed since `baseMtime`.

What it does:
- Removes `memoryRegion(existing)` from the file.
- Trims the trailing whitespace before the removed region to a single newline.
- Leaves the own block and the ARC-STEERING region byte-identical.
- On a file without a memory region, writes nothing and returns the current mtime.

Expose it as `AgentSyncHarnessDropMemoryCommand`. Its data is `{runtime, basemtime}`, and it
returns `{mtime, conflict}` in the style of the harness write RPC.

Add tests in `pkg/agentsync/agentsync_test.go` using the existing temp-home helpers:
- The region is removed, and the own and steering bytes are unchanged.
- A stale mtime returns a conflict and leaves the file untouched.
- A file without a region is a no-op.
- An unknown runtime errors.

Run `task generate`, then commit the regenerated files with the change.

### Task 2: Skills RPC with unmanaged rows and the adopt keep choice
**Depends on:** Task 1

1. Restore `AgentSyncSkillsCommand` and its types (`AgentSyncSkill`, `AgentSyncSkillColumn`,
   `CommandAgentSyncSkillsRtnData`) from `cd41207c^`.
2. Extend `CommandAgentSyncSkillsRtnData` with two fields, filled from `agentsync.PlanAdopt`. The
   Go side does no grouping.
   - `Unmanaged []AgentSyncSkillMove` (json `unmanaged`)
   - `Unresolved []string` (json `unresolved`)
3. Add `Keep map[string]string` (json `keep,omitempty`, mapping a skill name to a runtime) to
   `CommandAgentSyncAdoptData`. Thread it through `agentsync.PlanAdopt` and `agentsync.Adopt` as
   a parameter, and update every caller (grep for them: the `wsh agentsync` CLI and the tests).
   Pass nil where there is no choice.
4. For a kept name:
   - The kept runtime's copy is the seed.
   - The name is not unresolved, even when bodies differ.
   - On apply, every other copy of that name is moved, not turned into a delta, to
     `filepath.Join(filepath.Dir(p.SkillsRoot), "skills-replaced", runtime, name)`. If a directory
     is already there, add a numeric suffix.
   - A kept runtime that holds no copy of that name is an error, returned before anything moves.
5. Add tests in `pkg/agentsync/adopt_test.go`:
   - The kept copy seeds, even when it is not first in catalog order.
   - The other copy lands in `skills-replaced`, with its content intact.
   - A bad keep errors, and the filesystem is left untouched.
   - Without a keep, a body-diff skill stays unresolved and in place, as today.
6. Run `task generate`.

### Task 3: Setup surface with the Instructions tab
**Depends on:** Task 1

Add the `setup` surface. Follow how `settings` is wired, and follow the spec's Placement section:
- `SurfaceKey` in `frontend/app/view/agents/agents.tsx`. Keep it out of `SURFACE_ORDER`.
- A navrail entry, rendered next to `settings` in the bottom group of `navrail.tsx`.
  Give it an `ICON` entry; `SlidersHorizontal` or `FileCog` from lucide are good choices.
- `SURFACE_CONTEXT` in `surfacecontext.ts`, as `unsupported`/`unsupported`.
- The `cockpitshell.tsx` switch.
- `SURFACES` in `frontend/app/cockpit/uiapi.ts`.

Update the tests that enumerate surfaces (`surfaceorder.test.ts`, `uiapi.test.ts`,
`bindings.test.ts`) only where they have to change.

Build `frontend/app/view/agents/setupsurface.tsx` with:
- the header "Setup";
- an Instructions | Skills tablist. The Skills tab is a placeholder that Task 4 fills; keep the
  tab switch in an atom.
- the Instructions tab, as the spec describes it: Main.dc.html, Harness.dc.html, FirstRun.dc.html.

It calls these RPCs through `RpcApi`:
- `AgentSyncStatusCommand`
- `AgentSyncSteeringReadCommand`
- `AgentSyncSteeringWriteCommand`, then `AgentSyncApplyCommand` on save
- `AgentSyncHarnessReadCommand`
- `AgentSyncHarnessWriteCommand`
- `AgentSyncFoldCommand`
- `AgentSyncHarnessDropMemoryCommand`

The unsaved shared-doc draft lives in a jotai atom, so it survives a surface switch.

Prior art for the editor and its conflict handling is at
`git show 7a4c0c18^:frontend/app/view/agents/vaultsteering.tsx` and `vaultstore.ts`. Reuse what
fits, but match the new design, not the old one.

Put the pure logic in `frontend/app/view/agents/setupmodel.ts`, with tests in `setupmodel.test.ts`:
- each harness row's state, per the spec's state table;
- the first-run offer: which harness has the most own lines, or none;
- the "Save to N harnesses" count;
- the conflict transitions.

### Task 4: Skills tab
**Depends on:** Task 2, Task 3

Fill the Skills tab of `setupsurface.tsx` (you may split it into `setupskills.tsx`), as the spec
describes it and as Skills.dc.html shows:
- the matrix from `AgentSyncSkillsCommand`;
- the five groups, each with its count;
- the header summary;
- **Manage N skills in Arc**, which calls `AgentSyncAdoptCommand` with `{apply: true, keep}` and
  then refetches;
- the detail rail, with the keep radio for Needs-a-decision skills, **Open SKILL.md** (through
  `openref.ts`, never a hand-rolled surface switch), and **Show folder**. Grep for an existing
  native reveal or open helper first; if none exists, leave the button out and say so in your
  completion note.

The tab creates and edits no skills.

Put the grouping and the keep-map logic in `frontend/app/view/agents/skillsmatrix.ts`, with tests
in `skillsmatrix.test.ts`:
- each group's membership and counts;
- a skill in one harness goes to "Only in <label>";
- an unresolved skill goes to Needs a decision until it has a keep;
- the adopt count excludes skills that are unresolved and have no keep.
