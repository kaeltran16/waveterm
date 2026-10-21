# Retire Radar

Date: 2026-10-21. Decision: retire the Radar surface and everything behind it.

**Verify:** `node scripts/verify.mjs ./pkg/jarvis ./pkg/jarvisbackfill ./pkg/jarvisdossier ./pkg/waveobj ./pkg/wstore ./pkg/wconfig ./pkg/wshrpc/... ./cmd/...`
**Check:** `go build ./... && go vet ./pkg/jarvis ./pkg/jarvisbackfill ./pkg/waveobj ./pkg/wstore ./pkg/wshrpc/... ./cmd/... && task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke surface-headers peek-item-views resource-linking ui-drift dag-peek settings-headless route-picker-flat brief-surface`

## Why

Measured 2026-10-21 against the packaged store (`%LOCALAPPDATA%\dev.arc.app\data\db\waveterm.db`) and git:

- 26 scans, 2026-07-13 to 2026-10-15, every one started by hand; none Jul 30 to Sep 14. The newest waveterm
  report's 7 open findings (6 low) were never triaged.
- The fix-sibling pipeline (since 10-06) fed 7 investigation runs: 2 real fixes (`9db5359f`, and `3759a483`
  from run `22fdbe4c`), 4 that found nothing left to fix, 1 re-run of an already fixed finding.
- The six October scans cost about 14.5M tokens, cache reads excluded.
- About 10.9k lines (2.7k in `pkg/reporadar` without tests), 123 commits mention Radar, 21 since 10-06.
- 2026-10-08 the user had already judged the findings not good or stable enough to integrate elsewhere.

`b6fa1229` is the last commit with Radar in it; every recovery command below names it.

## Out of scope

- `docs/superpowers/specs/*radar*` stay (specs are kept). `docs/prototype/*.dc.html`,
  `frontend/app/view/agents/storagefixtures.ts` and `scripts/cdp/seed-brief.mjs` mention Radar only in fixture
  or mockup text: leave them.
- `pkg/jarvisbackfill` itself stays; only its Radar input goes (Task 2).
- The binary font/fontawesome hits for "radar" are glyph names, not references.

## Ordering

Task 1 (frontend), Task 2 (Go) and Task 3 (CDP scenarios and docs) touch no shared file and run side by side.
Task 4 regenerates the bindings once Tasks 1 and 2 have landed: regenerating earlier drops TS types the frontend
still reads, and `task check:ts` breaks. Until Task 4, the generated TS files keep their Radar types, which is
harmless (a superset). The running-app checks of every task are judged by Final after the merge, since the
scenario edits (Task 3) and the UI changes (Task 1) land on separate branches.

### Task 1: Remove Radar from the frontend
**Depends on:** none

Delete outright (and their tests):
`frontend/app/view/agents/radar*.ts{,x}` (radarauditlist, radardevmock, radarfindingdetail, radarfindingslist,
radarmodel, radarnav, radarscanstatepanel, radarstore, radarstoreload, radarstyles, radarsurface) and
`frontend/app/view/jarvis/peek/peekradar.tsx`, `peekradarmodel.ts`.

Then cut every caller. Grep `radar` (case-insensitive) under `frontend/` after each step; when this task is done
the only hits left are `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts` (Task 4 regenerates
them) and `storagefixtures.ts` fixture text.

- **Surface:** drop `"radar"` from `SurfaceKey` and `SURFACE_ORDER` (`agents.tsx`), the nav entry, `Radar` icon
  import and badge count (`navrail.tsx`), the branch in `cockpitshell.tsx`, the entry in `surfacecontext.ts`,
  `g r` and the `ESC_HOME_SURFACES` member (`store/keybindings/bindings.ts`). `Ctrl+1..8` becomes `1..7`
  automatically from `SURFACE_ORDER`; check `bindings.test.ts` and `store.test.ts` expectations.
- **Addresses and opening:** remove `radarreport` from `jarvis/address.ts`, the `radar` target from
  `jarvis/openref.ts` (`loadRadar`, `selectRadar`, the radarstore import), the peek body from
  `peek/peekregistry.ts` and its noun from `peekitemmodel.ts`, `radarReportId` and the `radar` case from
  `cockpit/uiapi.ts` / `uiclient.ts`. The `anchor` hint stays: `task:` records use it.
- **Attention kind `radar-triage`:** `attentionstore.ts` loses the `radar` bucket (navrail used it);
  `palette-needs.ts` `DROPPED_KIND`, `petpeekmodel.ts` `PEEK_EXCLUDED_KIND` and `briefingmodel.ts` (the
  `radar` target kind, `"radar-triage": "triage"`, the `radarORef` branch and the `case "radar-triage"`) go.
  Delete the tests that only cover radar-triage; keep the rest of each test file.
- **Start-investigation handoff:** delete `pendingRunDraftAtom` (`runactions.ts`) and the `radarOrigin` option
  of the run-create helper, the pending-draft branches of `jarvis/briefsheet.tsx` and `jarvis/briefsurface.tsx`
  (the `useEffect` that lands a draft), and `radarDraftLanding` in `jarvis/newrun.ts`. `resolveTargetChannel`
  stays (`projectsstore.ts`, `newrun.ts` use it); reword its Radar comment in `channelderive.ts`.
- **Settings:** remove the `headless.radaraudit` row from `settingsmodel.ts` and `settingssurface.tsx`, the
  `RADAR_*` constants, `radarAuditRoute`, `radarClassifyDefault`, and the "Radar audits keep their own route"
  clause in the headless blurb. `allowPickerSections` in `route.ts` and the picker's `runtimes` prop existed only
  for the Radar row: delete both if grep shows no other caller.
- **Helpers:** `joinAnd` moves from `radarmodel.ts` into `jarvis/runtiming.ts` as a local function (the only
  remaining caller; `finalshotsmodel.ts` keeps its own copy). Delete `ambientRefForFinding` and its test in
  `ambient.ts`; reword the Radar mentions in `ambient.ts`, `ambientstore.ts`, `surfacescaffold.tsx`,
  `codestore.ts`, `graphpeek.tsx`.

Verify: `npx vitest run` and `task check:ts` (2+ minute timeout) both clean; `npx eslint` and
`npx prettier --check` on the touched files only. Do not try the CDP scenarios in this task: they still name
Radar until Task 3 merges. Final judges the UI after the merge, at these steps (Task 3 adds them):

- nav rail without Radar, and its labels matching `SURFACE_ORDER`: `surface-smoke` "nav rail lists no Radar";
- `Ctrl+7` lands on the last surface and `g r` does nothing: `surface-smoke` "Ctrl+7" and "g r" steps;
- Settings > Headless AI without the Radar audit row or blurb clause: `settings-headless` steps 1-3;
- the route picker without the `runtimes` prop: `route-picker-flat` (unchanged scenario, now in Final);
- the Brief draws its non-radar attention rows: `brief-surface` and `ui-drift` (radar-triage items removed).
  A radar-triage row can no longer be produced once Task 2 lands, so its absence is covered by the
  `briefingmodel` unit tests, not a scenario.

### Task 2: Remove Radar from the backend
**Depends on:** none

Go only: touch no file under `frontend/` and do not run `task generate` (Task 4 does).

- Delete `pkg/reporadar/`, `pkg/wshrpc/wshrpctypes_radar.go`, `pkg/wshrpc/wshserver/wshserver_radar.go`,
  `pkg/wstore/wstore_radarreport.go` and `_test.go`, `pkg/jarvis/attention_radar_test.go`.
- `pkg/wshrpc/wshrpctypes.go`: drop `RadarCommands` from the composed interface.
- `cmd/server/main-server.go`: drop the import and `reporadar.RecoverInterruptedScans`.
- `pkg/wshrpc/wshserver/wshserver_runs.go`: remove the five `RadarOrigin` write-back blocks and the
  `run.RadarOrigin = data.RadarOrigin` copy; drop `RadarOrigin` from the create-run request
  (`wshrpctypes_runs.go`).
- `pkg/waveobj/wtype.go`: remove `OType_RadarReport` (const and the registered-types map), `RunRadarOrigin`
  and `Run.RadarOrigin`, every `Radar*` struct, `RadarReport` and its `reflect.TypeOf` registration. Stored runs
  with a `radarorigin` key decode fine with the field gone. Delete the Radar tests in `wtype_test.go`.
- `pkg/jarvis/attention.go`: remove `AttentionRadarTriage`, the `radar*` vocabulary constants,
  `AttentionInput.Radar`, `radarTriageItems` and its call, and the `GetRadarReportsShared` read; fix the
  radar-triage test in `attention_test.go`. `AttentionItem.ORef` (`wshrpctypes_channels.go`) is set only by
  radar triage (checked 2026-10-21): remove the field, and its frontend reads in `briefingmodel.ts` go with
  Task 1's radar branch.
- `pkg/jarvisbackfill`: Radar investigations were its only decision source. `ReadHistory` stops reading
  `db_radarreport`, `BuildPlan` takes runs only, `PlannedDecision`, `provRadarInvestigation`,
  `investigationEnd` and `dedupeDecisionSlugs` go if nothing else uses them, and `Plan.Decisions` with them;
  update `cmd/jarvisbackfill/main.go` (`printPlan`) and `plan_test.go`. `jarvisdossier/decision_test.go` uses
  "radar" only as sample provenance text: leave it.
- Settings keys: remove `radar:auditruntime`, `radar:auditmodel`, `radar:classifymodel` from
  `pkg/wconfig/settingsconfig.go` and `schema/settings.json`. A user's existing settings.json keeping them is
  harmless (wconfig ignores unknown keys).
- Migration `db/migrations-wstore/000025_drop_radarreport.{up,down}.sql`: up `DROP TABLE IF EXISTS
  db_radarreport;`, down recreates it exactly as `000013_radarreport.up.sql` does (empty).
- `cmd/wsh/cmd/wshcmd-ui.go`: drop `radarreport:<id>` from the reveal help and make the `--anchor` help say
  "sub-object to land on (a record's section)".
- Comments only: `pkg/agentobserve/entrypoint.go`, `pkg/wavebase/wavebase.go`, `pkg/memhygiene/model.go`,
  `pkg/wstore/wstore_channel.go`, `pkg/wstore/wstore_maintest_test.go`.
- Generated `pkg/wshrpc/wshclient/wshclient.go` still calls the deleted `Radar*` commands, so nothing compiles
  until they go, and `task generate` cannot run to remove them (its generators import `wshclient`). The one
  sanctioned exception to "never hand-edit generated files": delete the Radar functions from `wshclient.go` by
  hand. Task 4 regenerates it. Leave the other generated files (`metaconsts.go`'s unused `ConfigKey_Radar*`
  strings, the TS files) to Task 4.

Verify: `go build ./...`, `go vet` on the packages above, `node scripts/verify.mjs` on them, and
`git grep -i -l radar -- pkg cmd ':!cmd/wsh/cmd/claude-mod' ':!pkg/wconfig/metaconsts.go'` lists only
`pkg/jarvisdossier/decision_test.go`.

### Task 3: CDP scenarios and docs
**Depends on:** none

`scripts/cdp/scenarios.mjs` (grep `radar` case-insensitive; every hit must go or be reworded):

- Delete the scenarios `radar-start-investigation`, `radar-report`, `radar-scan-states` and `ambient-tags` (its
  only subject is a Radar finding; AmbientTags on runs is covered elsewhere), and their entries in the exported
  list.
- Turn `settings-radar-audit` into `settings-headless` (rename it in the exported list too): no arrange or
  teardown of the `radar:*` keys. Steps: 1. Settings opens on the Headless AI section (keep the current step 1);
  2. the section has no `[data-setting-row="headless.radaraudit"]` and its text has no "Radar"; 3. the section
  has no Mid model row and still lists `headless.cheap` (the current step 7); then a shot
  `cdp-shots/settings-headless.png`. Drop the other steps; rename the `RADAR_AUDIT_PANE` constant it keeps and
  delete the rest of the `RADAR_AUDIT_*` helpers.
- `SMOKE_SURFACES`: drop `"radar"`. Add three `surface-smoke` steps after the per-surface loop:
  - "nav rail lists no Radar": the nav buttons' labels include no "Radar" and their count equals the number
    of surfaces in `SURFACE_ORDER` that have a nav button (read the rail, compare with `SURFACE_LABEL`);
  - "Ctrl+7 lands on the last surface": from `cockpit`, dispatch Ctrl+7 the way the scenarios already send
    Ctrl+P (`document.dispatchEvent(new KeyboardEvent('keydown', { key: '7', code: 'Digit7', ctrlKey: true,
    bubbles: true }))`) and assert the active nav label is the last `SURFACE_ORDER` entry's label;
  - "g r does nothing": from `cockpit`, dispatch `g` then `r` the same way and assert the surface is still
    `cockpit` and the which-key overlay, if it opened on `g`, lists no Radar. Close it with Escape.
- `peek-item-views`: drop the radar seed (`seedPeekItemsRadar`), steps 4 and 5 and the teardown step; renumber.
- `resource-linking`: drop steps 5 and 6 (the `radarreport:` landings) and the report lookup in arrange.
- `surface-headers` (arranged around line 23296): drop `"radar"` from `SURFACE_HEADERS_ORDER`, the report
  seed and scope juggling in arrange, the "radar audits popover not clipped" check and its teardown steps.
- `ui-drift`: drop the radar-triage attention items and the Radar Escape checks and their teardown.
- `dag-peek` final-shots fixtures: remove the `radar` capture key (move `"receipt"` to another surface's
  capture list) and `"surface-radar"` from the `surface-smoke` board row and its goto step.
- Then delete the now-unused helpers (`radarFixtureReport`, `seedRadarReport`, `dropPeekItemsRadar`,
  `RADAR_FIXTURE_*`, `RADAR_SCOPE_KEY`, `RADAR_ROOT`, `radarOpen`, `radarMock`, `radarClick`, `radarHas`,
  `peekRadarHeadings`) and `radar: "Radar"` from `SURFACE_LABEL` in `scripts/cdp/attach.mjs`.
- `node --check scripts/cdp/scenarios.mjs`. Do not run prettier on `scripts/*.mjs`.

Docs and skills:

- `skills/cockpit/SKILL.md`: drop the radar finding, `radarreport:` and `radar` surface; then
  `task sync:claudemod` so `cmd/wsh/cmd/claude-mod/skills/cockpit/SKILL.md` matches.
- `README.md`: drop the Radar row. `docs/keyboard-shortcuts.md`: `Ctrl+1..7` without Radar, drop `g r`, Radar
  from the Esc list, "radar finding" from the peek line. `docs/reference/architecture.md`: drop the Radar
  bullet and `_radar` from the wshrpctypes list.
- `docs/open-issues.md`: remove the "Radar:" block. `docs/deferred.md`: replace the three Radar sections with
  one "Radar (retired 2026-10-21)" entry: the Why numbers above, the revive condition (a fix-sibling check is
  wanted again; prefer a post-`fix:` agent step over a surface), and recovery
  `git show b6fa1229:<path>` for `pkg/reporadar/`, the frontend `radar*` files, and the audit prompts in
  `pkg/reporadar/audit.go` / `kinds.go`. Keep the existing `78fe087a` collector recovery line inside it.
- Delete `docs/superpowers/plans/2026-10-06-radar-fix-sibling-audit.md` (shipped plan). Do not delete this
  plan; it is removed after the run lands.

Verify: `node --check scripts/cdp/scenarios.mjs` and `node --check scripts/cdp/attach.mjs`. The scenarios
cannot pass on this branch alone (the Radar UI is still there until Task 1 merges); Final runs them.

### Task 4: Regenerate bindings
**Depends on:** Task 1, Task 2

Task 2 removed the Go types and Task 1 the frontend reads of them; this regenerates the bindings both depend on.

- `task generate`. It rewrites `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`,
  `pkg/wshrpc/wshclient/wshclient.go` and `pkg/wconfig/metaconsts.go`; never hand-edit them.
- `git grep -i radar -- frontend/types frontend/app/store pkg/wshrpc/wshclient pkg/wconfig/metaconsts.go`
  must be empty.

Verify: `go build ./...`, `task check:ts` (2+ minute timeout) and `npx vitest run` clean;
`git grep -i -l radar -- pkg cmd frontend ':!cmd/wsh/cmd/claude-mod'` lists only
`pkg/jarvisdossier/decision_test.go` and `frontend/app/view/agents/storagefixtures.ts`.
