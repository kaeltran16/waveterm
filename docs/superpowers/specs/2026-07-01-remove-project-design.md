# Remove a project — design + implementation

Date: 2026-07-01
Scope: trivial (mirrors the existing add-project path; a few tightly-coupled files)

## Goal

Let the user remove a registered project from the project switcher. "Remove"
deregisters the project — it deletes the entry from `projects.json`. On-disk
files and any running agents are untouched. The action is reversible by
re-adding the project.

## Semantics

- Only **registered** projects (present in `projects.json`) are removable. The
  switcher also lists **live** projects derived from scanning agent transcripts
  (`projectsFromAgents`); a live-only project has nothing to delete and would
  reappear on the next scan, so it gets no remove control.
- Deleting a non-existent registry key is an idempotent no-op success.
- If the removed project is the active `projectFilter`, reset the filter to
  `"all"`.

## Layers (mirrors the add path)

1. **`pkg/wconfig/settingsconfig.go`** — `DeleteProjectConfigValue(projName string) error`,
   sibling to `SetProjectConfigValue`: read `ProjectsFile`, `delete(m, projName)`,
   write back. If the map is nil/absent, succeed (nothing to delete).
2. **`pkg/wshrpc/wshrpctypes.go`** — add to the command interface:
   `DeleteProjectCommand(ctx context.Context, data CommandDeleteProjectData) error`,
   plus `type CommandDeleteProjectData struct { Name string \`json:"name"\` }`.
3. **`pkg/wshrpc/wshserver/wshserver.go`** — implement `DeleteProjectCommand`:
   trim name, reject empty (matching create), call `wconfig.DeleteProjectConfigValue`.
4. **`task generate`** — regenerates `frontend/app/store/wshclientapi.ts` and
   `frontend/types/gotypes.d.ts`. Never hand-edited.
5. **`frontend/app/view/agents/projectswitcher.tsx`** — per registered row, a
   trash `×` icon revealed on hover. Click swaps the row into an inline
   `Remove? ✓ ✗` confirm. ✓ calls `RpcApi.DeleteProjectCommand`; if the removed
   name equals the current filter, set filter to `"all"`.

## Supporting change

The switcher must know which rows are registry-backed. Add `registered: boolean`
to `SwitcherProject` and set it in `mergeSwitcherProjects`:
- a live row whose name is also a registry key → `registered: true`
- a registry-only extra row → `registered: true`
- a live-only row → `registered: false`

## Testing

- Go: `TestDeleteProjectConfigValue` (write two, delete one, assert the other
  survives and the deleted one is gone) and `TestDeleteProjectCommandRejectsEmptyName`,
  mirroring the existing project tests.
- Frontend: extend `projectsstore.test.ts` to assert the `registered` flag for
  live-also-registered, registry-only, and live-only cases.

## Implementation order

1. Backend: wconfig helper + RPC type + wshserver impl + Go tests.
2. `task generate`.
3. Frontend: `registered` flag in projectsstore + its test; switcher remove
   control.
4. Verify: `go test ./pkg/wconfig/ ./pkg/wshrpc/...`, `npx vitest run`, tsc.
