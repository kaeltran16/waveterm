# Usage surface review fixes (F1-F21)

**Spec:** `docs/superpowers/specs/2026-11-05-usage-review-fixes-design.md` (every decision and why; read it first)
**Verify:** `node scripts/verify.mjs ./pkg/wshrpc/... ./pkg/orchestrate ./pkg/usagestats ./pkg/waveobj`
**Check:** `task check:ts && go vet ./pkg/wshrpc/... ./pkg/orchestrate ./pkg/usagestats ./pkg/waveobj`
**Final:** `node scripts/cdp/final-verify.mjs usage-charts usage-work usage-states workflow-scan workflow-scan-entry`

Findings refer to the review report `C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\usage\report.md`
(gitignored, read by that absolute path; screenshots beside it). Report line numbers are from `35ee176bb`;
re-find them by the quoted code. Logic goes in pure `.ts` models with `.test.ts` beside them, or Go functions
with tests beside them; `.tsx` stays thin. Colors only from existing `@theme` tokens (`frontend/tailwindsetup.css`),
no new tokens; read `DESIGN.md` before styling. UI is verified by the usage scenarios in
`scripts/cdp/scenarios-usage.mjs`, which feed the surface through the dev fixture `wave:dev-usage-buckets`
(`{buckets, sessions, efforts?}`); a fixture session can carry every new wire field.

### Task 1: Usage wire fields
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_agents.go`, `pkg/waveobj/wtype.go`, `frontend/types/gotypes.d.ts`
The interface Tasks 2, 3 and 4 build on. Add, exactly as the spec's "Wire changes" table names them:
- `wshrpc.UsageSession`: `TaskTitle` (`tasktitle`), `RunChunk` (`runchunk`), `Effort` (`effort`, an effort oid,
  no `effort:` prefix), `LeadHarness` (`leadharness`), `LeadSession` (`leadsession`), `ProjectName` (`projectname`),
  all `omitempty` strings with a one-line comment each.
- `wshrpc.UsageEffort {OID string "oid"; Title string "title"}` and `CommandGetUsageStatsRtnData.Efforts
  []UsageEffort` (`efforts,omitempty`).
- `waveobj.Run.BrainstormLead string` (`brainstormlead,omitempty`): `"<harness>:<session id>"` of the agent a
  brainstorm builder check or judge was started for.
Run `task generate`; commit the regenerated `frontend/types/gotypes.d.ts` (any other generated file it rewrites
with a real change goes in too). No behavior change. Acceptance: `task generate` is clean on a second run,
`go build ./...` and `task check:ts` pass.

### Task 2: Usage directory in Go: brainstorm leads, task titles, chunks, initiatives, projects
**Depends on:** Task 1 (fills the wire fields it adds)
**Files:** `pkg/wshrpc/wshserver/usagesessions.go`, `pkg/wshrpc/wshserver/usagesessions_test.go`, `pkg/wshrpc/wshserver/wshserver_agents.go`, `pkg/wshrpc/wshserver/wshserver_brainstorm.go`, `pkg/wshrpc/wshserver/wshserver_brainstorm_test.go`, `pkg/orchestrate/stagesession.go`, `pkg/orchestrate/stagesession_test.go`, `pkg/usagestats/usagestats.go`, `pkg/usagestats/usagestats_test.go`
Spec F1, F3 (Go half), F10, F11, F12 (Go half).
- **Session id of a transcript:** one exported helper in `pkg/usagestats` mapping `(harness, transcript path)` to
  the session id the scan gives that transcript (Claude: file stem; Pi: the stem after the last `_`, as
  `walkPiFiles` does). Reuse it wherever the scan derives the same ids, rather than a second copy.
- **F1 record:** `orchestrate.JudgingSession` gains `Lead string`, copied onto `child.BrainstormLead`.
  `launchSessionRun` fills it from the tab: the harness from `session:agent`, the session id from the tab's
  agent block `agent:transcriptpath` through the helper. No transcript path yet: leave it empty and log, never fail
  the launch.
- **F1 directory:** in `linkUsageSession`, a run where `jarvis.IsBrainstormSession(run)` and no dag never becomes a
  run item: leave `RunId`/`ChannelId`/`RunGoal`/`RunMode` empty; set `Role` to its stage role, `Project` from its
  `ProjectPath`, and `LeadHarness`/`LeadSession` split from `BrainstormLead` when set.
- **F10:** `TaskTitle` = the dag task's `Label` for the session's `TaskId` (dag already loaded there).
- **F11:** `RunChunk` = the owning run's `EffortRef.ChunkLabel`.
- **F12:** `Effort` = the owning run's `EffortRef.EffortOID`; for a session no run claims, the `session:effort` tag
  of the tab whose agent block's `agent:transcriptpath` names this session (build that map once per call from all
  tabs that carry the tag). `GetUsageStatsCommand` returns `Efforts` with the title of every effort a session
  names (`effortstore.Get`; a missing effort is logged and left out, its sessions keep the oid).
- **F3:** `repoRootOf` first folds a path inside a linked git worktree to the same relative path in its main
  checkout, from the nearest `.git` file's `gitdir: <main>/.git/worktrees/<name>`, cached per call; a path that no
  longer exists falls back to today's regex. `ProjectName` = the name of the channel whose project path equals
  the session's `Project` (compare cleaned, slash-normalized, case-insensitively on Windows; load channels once
  per call).
Acceptance (focused tests): `go test ./pkg/wshrpc/wshserver -run 'TestUsageSessions|TestRepoRoot|TestBrainstorm'`,
`go test ./pkg/orchestrate -run 'TestLaunchJudgingSession'`, `go test ./pkg/usagestats -run 'TestSessionIdOf'`.
New tests: a judge with `BrainstormLead` carries lead fields and no run id; a judge without one has a role and no
run id; a worker carries `TaskTitle`; a run with `EffortRef` carries `RunChunk` and `Effort`; an unlinked session
in a tagged tab carries `Effort`; a path in a linked worktree (temp dir with a `.git` file) folds to the main
checkout's same subpath; `ProjectName` matches across slash and drive-letter case; the launch records the lead.
Update `TestUsageSessionsBrainstormSession` to the new shape.

### Task 3: By work attribution model
**Depends on:** Task 1 (reads the wire fields it adds)
**Files:** `frontend/app/view/agents/usageattribution.ts`, `frontend/app/view/agents/usageattribution.test.ts`, `frontend/app/view/agents/usagesurface.tsx`
Spec F1, F2, F3, F10, F11, F12, F13 (rows), F18. Everything here is pure; Task 5 renders it. The signature
changes below (`listPage`, `buildAttribution`, the new `WorkScope` kind) reach `usagesurface.tsx`: make only the
edits that keep it compiling and behaving as today (pass the shown count the old boolean meant, pass
`efforts` from the reply as `[]` until Task 5 wires them, treat an initiative scope as a project in `workHead`);
Task 5 renders the new parts.
- **F1:** a session with `leadsession` joins its lead's item: `run:<runid>` when the directory places the lead
  session in a run, else `session:<leadharness>:<leadsession>`. A session item's title is the lead's own title
  when the lead is a member, else the first member title.
- **F2:** `listPage(list, shown)` takes the number of rows shown (start `LIST_COLLAPSED_ROWS`, +25 per step,
  capped at the total). It returns `moreLabel` ("Show 25 more" / "Show the last N") while rows remain, and
  `lessLabel` "Show top 8" once more than 8 show. Export the step and a `nextShown` helper.
- **F3:** a project's label is its `projectname` from any member session, else its folder name; unregistered
  labels that collide get parent segments prefixed (`SIEM-1744-2.6.10.0 / cyber_anomaly_detector`) until unique.
  Used by `ProjectUsage.label` and `WorkItem.projectLabel`.
- **F10:** a run's session row title is `"<taskid> · <tasktitle>"` when both are set, else the session title.
- **F11:** a run item's title: `runchunk`, else its lead session's scanned title (the member with role `lead`, or
  for a quick run its own session), else `rungoal`. Only a real `title` from the directory counts, never the id
  fallback.
- **F12:** `Attribution.initiatives: InitiativeUsage[]` (key `effort:<oid>`, label from `efforts`, else the oid's
  first 8 chars; count, sharePct, amounts), ranked by spend, at most 6, only those with usage. An item belongs to
  the initiative of any member's `effort`. `buildAttribution(buckets, sessions, efforts)`. `WorkScope` gains
  `{kind: "initiative"; initiative}`; `resolveScope`, `scopeId`, `scopeItems`, `scopeBuckets`, `itemScopeKey`,
  `scopeName`, `scopeSplit` (by kind, as a project) and `scopeList` (title "Runs and sessions", meta says
  "runs, and sessions from open tabs") handle it.
- **F13:** `WorkRow.unpriced` is true when the row has tokens, no priced tokens and no reported cost.
- **F18:** categorical fills are `bg-graphlane-1..6` by position, the folded rest `bg-graphlane-fold`
  (replacing `PART_FILLS` and `OTHER_FILL`); `MAX_PROJECT_ROWS` becomes 6; `ProjectUsage.fill` carries the
  project's fill so the card dot and its split row read one value.
Acceptance: `npx vitest run frontend/app/view/agents/usageattribution.test.ts`, with new tests for each bullet
(fold into a session lead and into a run lead; paging labels at 8, 33, total; registered label and collision
prefix; task title row; title precedence chunk > lead title > goal; initiative grouping, scope resolution and
list; unpriced row; six distinct fills and the fold fill; card fill equals split fill). Update the existing tests
that assert the old fills, 8-row rail cap and boolean `listPage`.

### Task 4: Stats, pricing, chart, store and quota-level models
**Depends on:** none
**Files:** `frontend/app/view/agents/usagepricing.ts`, `frontend/app/view/agents/usagepricing.test.ts`, `frontend/app/view/agents/usagestats.ts`, `frontend/app/view/agents/usagestats.test.ts`, `frontend/app/view/agents/usagedaily.ts`, `frontend/app/view/agents/usagedaily.test.ts`, `frontend/app/view/agents/dailychart.tsx`, `frontend/app/view/agents/usagestore.ts`, `frontend/app/view/agents/usagestore.test.ts`, `frontend/app/view/agents/usagerail.ts`, `frontend/app/view/agents/usagerail.test.ts`, `frontend/app/view/agents/agents.tsx`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/usagemeters.tsx`
Spec F5, F7 (store half), F13, F14, F15, F17, F18 (classes), F20, F21.
- **F13:** gpt-6 rows in `MODEL_PRICES`/`priceFor` with the spec's prices (`gpt-6-luna`, `gpt-6.1-sol` and
  `gpt-6-sol`, `gpt-6-astra`), cache write 0, update the file's source comment. `usd` shows `<$0.01` for
  0 < n < 0.005. Export `coverageStr(pct)` (`>99%` below 100, floor otherwise, `100%` only at 100) and
  `estimateStr(spendUsd, pricedTokens, tokens)` (`unpriced` when tokens > 0 and nothing priced, else
  `≈ ${usd}`). Rail rows (`usagerail.ts`) carry `pricedTokens`.
- **F14:** `aggregateBuckets(buckets, now, harnessFilter, fromDay?)`: `daily` starts at `fromDay` (or the oldest
  bucket's day if older). Export `windowStartDay(windowDays, now)` (7: the local day key 6 days back; 0: undefined),
  the one source of the start. `allUsageStatsAtom` and `agents.tsx`'s `usageStatsAtom` pass
  `windowStartDay(heldWindowDays)`; Task 5 passes it at the scope aggregation in `usagesurface.tsx`.
- **F5:** `usageHeldWindowAtom` (window days of the held buckets, `null` before the first success), set only on
  success. The module's `heldWindowDays` keeps its job (set at request time, so the skeleton shows once per
  switch); the atom is the success-only truth the surface and F14 read. Export pure `usageLoadView(requestedDays, heldDays, loaded, error)` →
  `"skeleton" | "data" | "data-with-error" | "switch-failed"`; `switch-failed` when the request failed for a
  window other than the held one.
- **F7:** `forecastDailyAtom: DailyTokens[] | null` and `loadForecastHistory(now)`: one
  `GetUsageStatsCommand {windowdays: 28}` at most once an hour (module timestamp), storing Claude's daily tokens
  over the last 28 days (a pure `forecastDaily(buckets, now)` builds them). A failed load logs and keeps the last.
  The dev fixture path (`windowedReply`) serves it too.
- **F15:** `LegendModel.label`: `provider/model` when the model name repeats in its group, else the model;
  `dailychart.tsx` renders `label`.
- **F17:** `HARNESS_META` colors are `var(--color-provider-claude|codex|opencode|pi)`.
- **F18:** `CLASS_FILL`: cache read keeps `bg-cacheread`; output, reasoning, cache write, input take
  `bg-graphlane-1`, `-4`, `-6`, `-2`.
- **F20:** `USAGE_LEVEL_FILL` / `USAGE_LEVEL_TEXT` beside `usageLevel` in `agentsviewmodel.ts` (`ok` → accent,
  `warn` → warning, `hot` → error); `usagemeters.tsx` uses them. (Task 5 switches the Usage card to them.)
- **F21:** `dailychart.tsx` columns enter together: drop the per-column delay.
Acceptance: `npx vitest run frontend/app/view/agents/usagepricing.test.ts frontend/app/view/agents/usagestats.test.ts frontend/app/view/agents/usagedaily.test.ts frontend/app/view/agents/usagestore.test.ts frontend/app/view/agents/usagerail.test.ts`,
with tests for each gpt-6 price, `<$0.01`, `coverageStr` at 99.6/100/50.4, `estimateStr` unpriced, the 7-day
`daily` padded to 7 columns for a scope active 3 days, `usageHeldWindowAtom` unchanged and `switch-failed` after a
failed switch, `forecastDaily` 28-day cut and the hourly guard, legend dup label, provider colors, class fills.
Visible effects are shown by Task 5's scenario steps (usage-charts legend, colors, 7-day columns, forecast,
column entrance; usage-states switch-failed, quota level colors).

### Task 5: Usage surface rendering
**Depends on:** Task 3 (renders the attribution it reshapes), Task 4 (uses the store, stats and level helpers it adds)
**Files:** `frontend/app/view/agents/usagesurface.tsx`, `frontend/app/view/agents/usagestore.ts`, `frontend/app/view/agents/usagestore.test.ts`, `scripts/cdp/scenarios-usage.mjs`
Spec F2, F5, F6, F7, F12, F13, F18, F19, F20 (card). Thin wiring only; anything with a branch goes in Task 3/4's
models.
- **F2:** in `usagestore.ts`, replace the boolean `usageListExpandedAtom` with `usageListShownAtom` (number,
  default `LIST_COLLAPSED_ROWS`; every reset sets it back to that); the list renders "Show 25 more" /
  "Show the last N" and "Show top 8" over it (`data-usage-more`, `data-usage-less`).
- **F5:** `usageLoadView` picks the skeleton, the data, the data with the "Couldn't refresh" banner, or a
  `data-usage-switch-failed` panel naming the window and a Retry button (`loadUsage(requested)`).
- **F14:** the scope aggregation (`aggregateBuckets(scopeBuckets(...), Date.now())`) passes
  `windowStartDay(heldWindow)`, so a narrow scope's 7-day chart still has 7 columns.
- **F6:** the `[data-usage-detail]` container scrolls to top when lens, range, scope or item changes.
- **F7:** the Claude projection reads `forecastDailyAtom`; mount calls `loadForecastHistory`.
- **F12:** `loadUsage` stores `reply.efforts` in `usageEffortsAtom`, passed to `buildAttribution`. The dev fixture
  path today builds and windows only `{buckets, sessions}`: `devUsageFixture` and `windowedReply` must carry
  `efforts` through as well (sessions already pass whole, so their new wire fields survive; keep it so). Initiative cards after the project cards and the other-folders
  text, behind a thin divider,
  `data-usage-initiative=<oid>`, neutral dot, share pill, count fact; selecting one opens its page like a project.
- **F13:** scope cards, list rows and the API-equivalent card use `estimateStr` / `coverageStr`; a list row with
  `unpriced` shows `unpriced`.
- **F18:** project card dots use `ProjectUsage.fill`.
- **F19:** a scope card's fact moves to its own line, `truncate` with a `title`.
- **F20:** `QuotaRows` uses `USAGE_LEVEL_FILL` / `USAGE_LEVEL_TEXT`; delete the local maps.
Scenario steps (add to the usage scenarios, fixtures carrying the new wire fields), named in this task's
acceptance: usage-work "paging past 25" (33-row fixture: Show 25 more, then Show top 8), "brainstorm judge folds
into its lead" (no quick-run row, role split shows the judge), "task-titled worker rows", "chunk-titled run row",
"registered and disambiguated project labels", "initiative card and page", "card dots match split", "drill
scrolls to top", "card fact on its own line" (scrollWidth <= clientWidth); usage-charts "unpriced and <$0.01",
"7-day chart has 7 columns for a 3-day scope" (a By work project scope), "provider colors match cards", "legend
dup label", "forecast unchanged across the range switch" (a 28-day fixture and a saved Claude weekly reading in
`wave:ratelimits`: the projection text is the same under 7 days and All time), "columns enter together" (sample
every column's height about 100 ms after the chart mounts: all sit at the same fraction of their final height,
within 5%); usage-states
"failed switch shows switch-failed panel, Retry recovers", "quota level colors match app bar".
Acceptance: `task check:ts`; `npx vitest run frontend/app/view/agents/` stays green; the steps above exist and
pass in `node scripts/cdp/final-verify.mjs usage-charts usage-work usage-states`.

### Task 6: Keyboard: Esc goes Back, list rows by keyboard
**Depends on:** Task 5 (walks the shown rows its `usageListShownAtom` holds; shares `usagesurface.tsx` and the scenario file)
**Files:** `frontend/app/view/agents/usagenav.ts`, `frontend/app/view/agents/usagenav.test.ts`, `frontend/app/view/agents/usagesurface.tsx`, `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/store/keybindings/whenstate.ts`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-usage.mjs`
Spec F9, F16.
- **usagenav.ts (pure):** `usageBackStep(lens, scopeKey, item)` → `{scope, item: null}` target or null (item →
  its back scope; project/initiative scope → All usage; else null). `usageNavIds(scopeIds, rowKeys)` and
  `resolveUsageCursor(id, scopeIds)` → `{kind: "scope" | "row", id}`.
- **F9:** a `usage:back` Escape binding (group Navigation, label "Back to the scope, else All usage") under the
  same guards as `surface:back-home`; `surface:back-home` stands down while `usageBackStep` is non-null on usage.
  Both `when`s read `usageLensAtom`, `usageWorkScopeAtom` and `usageWorkItemAtom` through `globalStore`, so add
  those atoms to `PREDICATE_ATOMS` in `whenstate.ts` (store.test.ts's completeness test requires it).
- **F16:** By work's list-nav controller walks scope cards then the shown list rows; a row cursor
  (`data-usage-cursor` on the row, ring, scroll into view) marks without opening; `activate` opens a row, or on a
  scope moves the cursor to the first row.
- `docs/keyboard-shortcuts.md`: Esc row and the Usage section (j/k over cards and rows, Enter). The cheat sheet
  is generated from bindings, so the binding's label is its entry.
Scenario steps in usage-work: "Esc from an item goes Back, from a project to All usage, then home", "j past
the cards reaches rows, Enter opens the row".
Acceptance: `npx vitest run frontend/app/view/agents/usagenav.test.ts frontend/app/store/keybindings/bindings.test.ts frontend/app/store/keybindings/store.test.ts`
(including the no-conflict assertion), `task check:ts`, the steps pass in `final-verify.mjs usage-work`.

### Task 7: Workflow lens: Open in Diff, project picker
**Depends on:** none
**Files:** `frontend/app/view/agents/workflowlensview.tsx`, `frontend/app/view/agents/workflowlens.ts`, `frontend/app/view/agents/workflowlens.test.ts`
Spec F4, F8. Another run (8028cea5) edits `openref.ts`, `briefsurface.tsx`, `runactions.ts`: do not touch them.
- **F4:** the done view's Open in Diff calls `openRunDiff(model, run)` (`agentdiffnav.ts`).
- **F8:** pure `scanHomeChannel(picked, newestScanChannelId, channels, active, rows, recent)` in `workflowlens.ts`:
  the picked channel, else the newest scan's channel, else `palettePickChannel`'s rule. The toolbar shows the
  existing `ProjectPicker` (`jarvis/projectpickerview.tsx`, register action as `newruncontrol.tsx` wires it)
  left of Scan workflow, `data-workflow-project`; the pick lives in a module atom so it survives unmount.
Acceptance: `npx vitest run frontend/app/view/agents/workflowlens.test.ts` with tests for the precedence;
`task check:ts`. Task 8 adds the scenario steps that show both.

### Task 8: Workflow lens scenario steps
**Depends on:** Task 6 (shares the scenario file), Task 7 (shows the picker and Diff landing it adds)
**Files:** `scripts/cdp/scenarios-usage.mjs`
In workflow-scan: "Open in Diff lands on the Diff surface for the scan run's commit"; "the picker defaults to the
newest scan's project with several projects registered, and a pick changes the button title". In
workflow-scan-entry, keep the existing entry steps green with the picker present.
Acceptance: `node scripts/cdp/final-verify.mjs workflow-scan workflow-scan-entry` passes these steps.
