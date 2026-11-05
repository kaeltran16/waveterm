# Usage surface review fixes (F1-F21)

Fixes the 21 findings of the 2026-11-05 Usage surface review (report: `cdp-shots/review/usage/report.md` in
the main checkout, gitignored). Every cause below was checked against the code at `bd89224a8`; where the
report's suggestion and the code disagree, the decision says which way it went and why. The report's
"Checked, not defects" and "Tooling gaps" sections are out of scope.

## Wire changes (one interface, used by Go and the frontend)

`wshrpc.UsageSession` gains:

| field | json | set from | finding |
|---|---|---|---|
| `TaskTitle` | `tasktitle` | the dag task's `Label` for `TaskId` | F10 |
| `RunChunk` | `runchunk` | the owning run's `EffortRef.ChunkLabel` | F11 |
| `Effort` | `effort` | the owning run's `EffortRef.EffortOID`, else the `session:effort` tag of the tab whose agent block's `agent:transcriptpath` is this session | F12 |
| `LeadHarness`, `LeadSession` | `leadharness`, `leadsession` | a brainstorm builder check or judge: the brainstorming agent's session | F1 |
| `ProjectName` | `projectname` | the registered project (channel) whose path equals `Project` | F3 |

`CommandGetUsageStatsRtnData` gains `Efforts []UsageEffort` (`{oid, title}`): the title of every effort a
session names, so the frontend needs no second store to name an initiative.

`waveobj.Run` gains `BrainstormLead string` (`brainstormlead`): `"<harness>:<session id>"` of the agent a
builder check or judge was started for. One string rather than a new struct: it is read in one place.

## Decisions

**F1, brainstorm sessions as quick runs.** Confirmed: `linkUsageSession` makes a builder check or judge its
own quick-run item (`usagesessions.go:99-101`), titled by the prompt (`usageattribution.ts:221`), and the
sheet drops these runs (`wshserver_channels.go:97-110`), so Open run lands on nothing.
- A brainstorm session is never a run item: Go leaves `RunId`/`ChannelId`/`RunGoal`/`RunMode` empty for it
  and sets `Role` (its stage role) and the project. Why: no run list shows these runs, so "Open run" can
  never land, and "quick run" misnames them.
- It folds into its brainstorming agent's work item as a role, through `LeadHarness`/`LeadSession`: the
  frontend keys it to the lead's item (the lead's run item when the directory places the lead in a run,
  else `session:<harness>:<id>`). The brainstorm's cost then reads as one session with its judges and
  checks, which is what the user spent.
- The lead is recorded going forward: `launchSessionRun` already has the tab; it reads the session id from
  the tab's agent block (`agent:transcriptpath`, through one Go helper that maps a transcript path to the
  scan's session id: Claude the file stem, Pi the stem after the last `_`) and the harness from
  `session:agent`, and carries it on `JudgingSession` onto `Run.BrainstormLead`.
- Runs from before this change have no lead: each stays its own **session** item (no Open run), titled by
  its session title. No backfill: the tab meta keeps only the latest judge run, so history can't be rebuilt.

**F2, only 25 rows reachable.** Confirmed (`LIST_EXPANDED_ROWS`, `usageattribution.ts:17,574-588`). The
list pages: the boolean `usageListExpandedAtom` is replaced by `usageListShownAtom`, the number of rows shown (8, then +25 per press of "Show 25
more", the last press showing the rest), with "Show top 8" once more than 8 show. No virtualization: a
1308-row list is reached in pages, and each page is a plain render. The other-folders text stays: with
paging, its promise is true.

**F3, folder labels.** Confirmed (`usageattribution.ts:295`, `usagesessions.go:26-31`).
- A path inside a linked git worktree folds to the same relative path in its main checkout: `repoRootOf`
  reads the nearest `.git` file (`gitdir: <main>/.git/worktrees/<name>`), cached per call, and falls back
  to today's regex when the path is gone. Why: the regex knows three worktree roots; git itself knows every
  linked worktree, sibling `<repo>-worktrees` and ad-hoc checkouts included.
- A project is labelled by its registered name (`ProjectName`), else its folder name. Unregistered labels
  that collide get their parent segment prefixed (`SIEM-1744-2.6.10.0 / cyber_anomaly_detector`), as many
  segments as needed to differ.

**F4, Open in Diff opens Jarvis.** Confirmed (`workflowlensview.tsx` done view calls `openRun`). It calls
`openRunDiff(model, run)` (`agentdiffnav.ts`), the app's own run-to-Diff path. Label kept: it now does what
it says, and the head's Open run stays the way to the sheet.

**F5, failed range switch shows the old range.** Confirmed (`usagestore.ts:91-93,117-126`). The store
records the window the held buckets belong to (`usageHeldWindowAtom`, set only on success; the request-time `heldWindowDays` still decides when the skeleton shows). When the
requested window differs from the held one and the load failed, the detail shows an error panel with
Retry instead of the held data; switching back to the held window shows it at once. Why not revert the
toggle: the revert retriggers a load that clears the error, so the user would see the toggle snap back
with no reason given.

**F6, drill lands mid-page.** Confirmed (`usagesurface.tsx:894`). The detail scrolls to top when the lens,
range, scope or item changes (an effect on those keys), not on the 60 s refresh.

**F7, forecast follows the range.** Confirmed (`usagesurface.tsx:723-732` reads `allStats.daily`). The
forecast reads a fixed 28-day Claude history, loaded by its own `GetUsageStatsCommand {windowdays: 28}` at
most once an hour (module-level, so it survives unmount), whatever the range. One path for both ranges,
rather than deriving from all-time buckets when they happen to be held.

**F8, Scan workflow disabled / silent pick.** Confirmed (`palette-data.ts:70-84`). The lens toolbar gets
the existing `ProjectPicker` beside Scan workflow. Its default is the newest scan's project (the scan run's
channel), else the current `palettePickChannel` rule; a pick is held in a module atom. The button title
keeps naming the project.

**F9, Esc on an item leaves Usage.** Confirmed (`bindings.ts:195`). A `usage:back` Escape binding runs while
the By work lens is drilled: from an item it goes Back to its scope; from a project or initiative scope it
goes to All usage. `surface:back-home` stands down while it applies. The rule is a pure function.

**F10, worker sessions titled by AI title.** Confirmed: `TaskId` is sent and never read. Go sends
`TaskTitle`; a run's session row reads `t-3 · Wire types`, else its session title.

**F11, run rows titled by goal paragraphs.** Confirmed (`usagesessions.go:120-121`). A run item's title is
its effort chunk label, else its lead session's title (the member with role `lead`, or for a quick run its
own session), else the goal's first line. A member's title counts only when the scan gave one (not the id
fallback).

**F12, initiative scope.** New, smallest that works. A work item belongs to an initiative when any member
carries `Effort`. By work's scope bar shows, after the project cards, up to 6 initiative cards (ranked by
spend, those with usage in the window), named by the effort title. An initiative page works as a project
page: header, kind split, ranked list. Scope key `effort:<oid>` (project keys are paths, so they can't
collide). Sessions are tagged only while their tab still exists: the tag is tab meta, and a closed tab
takes it along. That gap is accepted, not hidden: the initiative page's list meta says "runs, and sessions
from open tabs".

**F13, unpriced reads as priced.** Confirmed (`usagepricing.ts` has no gpt-6; coverage `Math.round`;
`usd` rounds to cents).
- Prices added, per 1M tokens (input / output / cached input): `gpt-6-luna` 0.10 / 0.50 / 0.01,
  `gpt-6.1-sol` and `gpt-6-sol` 2 / 10 / 0.10, `gpt-6-astra` 10 / 50 / 1.00 (OpenAI's GPT-6.1 Sol
  announcement; Luna and Astra from consistent third-party trackers, 2026-11). Lower (≤272K) tier, as the
  file already does for tiered models.
- `usd` shows `<$0.01` for a positive amount under a cent. Coverage floors: `>99%` under 100, never a
  rounded 100. A scope with tokens and no priced tokens shows `unpriced` in place of `≈ $0.00` (scope
  card, list row, API-equivalent card).

**F14, 7-day chart starts at the first active day.** Confirmed (`usagestats.ts:306-314`).
`aggregateBuckets` takes the held window's start day and starts `daily` there (or earlier, if a bucket is
older). Callers, the By work scope aggregation in `usagesurface.tsx` included, pass `windowStartDay` of the held window (F5's atom), the one truth for what the buckets cover.

**F15, duplicate legend rows.** Confirmed. A legend row gets a `label`: `provider/model` when the model name
repeats within its harness group, else the model name.

**F16, list unreachable by keyboard.** Confirmed (`usagesurface.tsx:698-720`). In By work the list cursor
walks the scope cards and then the shown list rows, in one order. Moving onto a scope selects it, as now;
moving onto a row only marks it (ring + scroll into view). Enter on a row opens it; Enter on a scope moves
the cursor to the first row. A pure model (`usagenav.ts`) builds the order and resolves a cursor id.

**F17, provider colors differ.** Confirmed (`usagedaily.ts:12-17`). Chart and legend colors come from the
`provider-*` tokens the cards' dots use, so `success` stops serving as an identity.

**F18, Where it goes colors.** Confirmed (`usageattribution.ts:144-151`, `usagestats.ts:103-109`).
Categorical parts take `graphlane-1..6` by position, the folded rest `graphlane-fold`: project split, kind
split, role split, and token classes (cache read keeps `cacheread`). DESIGN.md has 6 lanes, not the 8 the
report assumed, so the rail shows at most 6 projects (`MAX_PROJECT_ROWS` 8 → 6) and every card's dot equals
its split color; the rest fold into "other folders". Initiative cards keep a neutral dot: they are not a
part of All usage's split.

**F19, card facts clipped.** Confirmed (`usagesurface.tsx:242-248`). The fact moves to its own line under
tokens and spend, truncated with a `title`.

**F20, quota level colors differ.** Confirmed. One level→fill and level→text map beside `usageLevel` in
`agentsviewmodel.ts`, read by the Usage card and the app bar. `ok` is `accent`: a quota under the warning
line is not a success status, and the app bar is where it is read most.

**F21, chart entrance cascade.** Confirmed (`dailychart.tsx` per-column delay). Columns grow together; a usage-charts step samples column heights mid-entrance to show it.

## Verification

Go and vitest tests beside each changed model. UI through `scripts/cdp/scenarios-usage.mjs` in
final-verify's isolated app, with the dev usage fixture carrying the new wire fields: usage-charts,
usage-work, usage-states, workflow-scan, workflow-scan-entry.
