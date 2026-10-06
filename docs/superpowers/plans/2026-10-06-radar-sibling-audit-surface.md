# Radar sibling-audit surface implementation plan

**Effort:** effort:1557171a-e61d-4b29-83fd-fc7f818e6131
**Verify:** `node scripts/verify.mjs ./pkg/reporadar ./pkg/waveobj ./pkg/jarvis ./pkg/wstore ./pkg/wshrpc/wshserver`
**Check:** `go vet ./pkg/reporadar/ ./pkg/waveobj/ ./pkg/jarvis/ && node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs surface-smoke radar-report radar-scan-states peek-item-views`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\radar-sibling-audit\project\Main.dc.html

## Goal and shape

The Radar surface is rebuilt around what a scan now produces: for each recent fix commit, one read-only audit
that looks for the same bug at sibling sites. A finding is one file with one or more sites (line, trigger,
actual, expected, fix gap), a root cause, and the fix commit it came from. The lens, collector, strength and
evidence UI of the old pipeline is deleted.

The mockup is the spec. It is a folder of boards, all of which the result must match:
`C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\radar-sibling-audit\project\` holds `Main.dc.html`
(report with findings; its `view` prop also draws the next three), `MainAudits.dc.html` (audited-commit list
open), `MainDismiss.dc.html` (Dismiss menu open), `MainPartial.dc.html` (failed audits strip),
`Scanning.dc.html`, `Clean.dc.html`, and `Removed.dc.html` (what is deleted, nothing drawn in its place).
The folder is gitignored and lives only in the main checkout, so read it by that absolute path. The boards use
raw hex because they are mockups: in code, map every color onto the existing `@theme` tokens the current Radar
files already use (`frontend/tailwindsetup.css`), never a hex or rgba, never a new token.

The data is already on `main` (commit 3a617e70): `RadarReport.audits` and, on a finding, `sourcecommit`,
`sourcesubject`, `rootcause`, `sites[]`, in `frontend/types/gotypes.d.ts`. Section 6 of
`docs/superpowers/specs/2026-10-06-radar-fix-sibling-audit-design.md` describes them; sections 3 to 5 say how
a finding is built and carried across scans.

Task 1 adds the new pure model beside the old one, so the old components keep compiling. Tasks 2, 3 and 4
then swap the components over at the same time, each on its own files. Task 5 deletes what nothing reads any
more, in TypeScript and in Go. Task 6 writes the CDP scenarios that Final runs.

## Decisions settled in review (these override the boards where they differ)

1. **Suppress is folded into Dismiss.** No Suppress button, no Suppressed group. The Dismiss menu has four
   reasons: False positive, Low priority, Resolved elsewhere, Intentional (plus the existing leading
   "Addressed by <run>" entry when an investigation finished). Intentional calls the disposition RPC with
   action `suppress`; the other reasons call it with `dismiss` as today. A finding whose wire group is
   `suppressed` shows in the Dismissed group and reads "Dismissed: intentional". "Reopen finding" sends
   `reopen` for either. No new disposition kind.
2. **Two list groups.** Open holds wire groups `new`, `recurring`, `nolonger` and any unknown group. Dismissed
   holds `dismissed` and `suppressed`. A finding is "new" when its wire group is `new`: it gets the "new" chip
   on its row and "new in the latest scan" in the detail header. The Open group's hint is "N new in the latest
   scan" (empty when N is 0); the Dismissed hint is "closed with a reason". The "not detected this scan" notes
   are gone.
3. **Counts are kept hits.** Every per-commit count (scan rows, audit list, header tally) is the audit's
   `keptcount`, the hits that passed the gate.
4. **What the body shows**, for the scoped project's newest report:
   - no report: the never-scanned panel.
   - status `collecting` or `clustering`: the Scanning panel. `collecting` is commit selection, so it has no
     rows yet.
   - any finding lacks `sourcecommit`: the old-format panel. Checked before the rules below.
   - status `cancelled`: the cancelled panel.
   - status `failed` with `fatalerror` and no audits: the fatal panel ("The scan failed", the error, Scan
     again).
   - one or more findings: the report (list and detail).
   - otherwise: the audit list panel. With no failed audit it is the Clean board. With failed audits it is the
     same list where a failed row shows its `error` in place of the root cause.
   The warning strip (MainPartial) shows above the body whenever one or more audits failed, in the report view
   and in the audit list panel alike. That covers the fully failed scan: strip plus list, no new design.
5. **No fix commits to audit.** A finished report with no audits and no findings shows the Clean panel with
   the title "No new fix commits to audit", no list, and the board's footnote. With carried findings and no
   audits, the header line reads "no new fix commits" as plain text, with nothing to open.
6. **Old format.** A report whose findings include one with no `sourcecommit` was written before the rework.
   It shows one panel: title "This report was written by an older Radar", body "It predates the fix-commit
   audit and cannot be shown. Scan again to replace it.", action "Re-scan". Nothing else. An old report with
   no findings falls through to decision 5.
7. **Also deleted, beyond the Removed board:** the "repository changed during the scan" strip line, the
   "Re-run full scan" label (the button always reads "Re-scan"), the "Why it matters" block (the site card's
   Fix gap carries it), and the wide-pane side column (the detail is one column, max width 880px).
   Never-scanned and Cancelled keep their panels with copy that names audits, and no collector list.
8. **Fix commit date** is the `observedts` of the report signal whose id is in the finding's `signalids` (the
   backend keeps one git signal per source commit). Left out when the report has none.
9. **Finding peek** (`frontend/app/view/jarvis/peek/`, not on the canvas): "Root cause" in place of "Why",
   and the sibling sites as `file:line` rows in place of the evidence places.
10. **Run composer goal** is the finding's `mission` alone. Go already writes the source fix, each site as
    `file:line`, and its trigger, actual and expected into it.
11. **Retired wire fields are deleted from Go** and regenerated (Task 5). The RPC keeps the name
    `RetryRadarClusteringCommand`: it now re-audits the failed commits, and renaming it buys nothing.
12. **Reopen returns a finding to `recurring`**, not `new`, so a reopened finding carries no "new" mark.

## Global constraints

- Existing `@theme` tokens only. No new design token, no raw hex or rgba in a component.
- Pure logic lives in `radarmodel.ts` (or `peekradarmodel.ts`) with a vitest test beside it; the `.tsx` files
  stay thin. No jsdom or render tests: rendered output is checked by the CDP scenarios of Task 6.
- Personal-use app: build only the states named here. No extra empty, loading or error states, no onboarding.
- Never hand-edit a generated file (`frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`,
  `pkg/wshrpc/wshclient/wshclient.go`, `pkg/waveobj/metaconsts.go`): change the Go type, then `task generate`.
  Only Task 5 changes wire types.
- Do not touch Settings > Headless AI or its scenario `settings-radar-audit`.
- No keybinding changes: `j`/`k` move, Enter runs the selected finding's primary action, Space peeks.
  `frontend/app/store/keybindings/bindings.ts` and `docs/keyboard-shortcuts.md` stay as they are.
- Delete, do not leave dead code: no commented-out blocks, no unused exports.
- Comments say why, lower case, only when needed. Errors are surfaced or logged with context.
- Check only the files you touched with prettier and eslint; never `--write` the tree.
- In a worktree, typecheck with the Check line's `node ... tsc.js --noEmit`, not `task check:ts`.
- `data-*` hooks named below are the contract the CDP scenarios select on. Keep the names exact.

## File map

| File | Owner | Role |
|---|---|---|
| `frontend/app/view/agents/radarmodel.ts`, `radarmodel.test.ts` | Task 1, then Task 5 | pure model |
| `frontend/app/view/agents/radarstyles.ts` | Task 1, then Task 5 | token class maps |
| `frontend/app/view/agents/radardevmock.ts`, `radardevmock.test.ts` | Task 1 | dev-only fixture reports |
| `frontend/app/view/agents/radarfindingslist.tsx`, `radarfindingdetail.tsx` | Task 2 | report body |
| `frontend/app/view/agents/radarstore.ts`, `radarstore.test.ts` | Task 1, then Task 3, then Task 5 | atoms and RPC calls |
| `frontend/app/view/agents/radarsurface.tsx`, `radarscanstatepanel.tsx`, `radarauditlist.tsx` (new) | Task 3 | header, strip, audit list, panels |
| `frontend/app/view/jarvis/peek/peekradar.tsx`, `peekradarmodel.ts`, `peekradarmodel.test.ts` | Task 4 | finding peek |
| `pkg/waveobj/wtype.go`, `pkg/reporadar/*`, generated files, Go tests | Task 5 | wire cleanup |
| `scripts/cdp/scenarios.mjs` | Task 6 | CDP scenarios |

### Task 1: Pure model and dev fixtures for the reworked surface
**Depends on:** none

Add the new model to `radarmodel.ts` beside the existing exports. Do not delete or rename an existing export
in this task (the old components still import them, and Task 5 removes them); the two exceptions are named
below. New names must not collide with existing ones.

Exports other tasks rely on, exact names and shapes:

```ts
export type RadarListGroup = "open" | "dismissed";
export const LIST_GROUP_ORDER: RadarListGroup[]; // ["open", "dismissed"]
export const DEFAULT_OPEN_LIST_GROUPS: Set<RadarListGroup>; // both: board Main draws Dismissed expanded
export function listGroupOf(f: RadarFinding): RadarListGroup; // decision 2
export function groupForList(findings: RadarFinding[]): Record<RadarListGroup, RadarFinding[]>;
export function isNewFinding(f: RadarFinding): boolean; // wire group "new"
export interface ListGroupMeta { label: string; hint: string; tone: "open" | "muted" }
export function listGroupMeta(group: RadarListGroup, items: RadarFinding[]): ListGroupMeta;

export interface FindingSite { dir: string; file: string; line: number; path: string; more: number }
// first site of the finding's one file. dir ends in "/" ("" at the repo root); path is the repo-relative
// file; more is the count of further sites. null when the finding has no file or no site.
export function findingSite(f: RadarFinding): FindingSite | null;
export function shortSha(commit: string): string; // first 8 chars
export interface SourceFix { sha: string; subject: string; ts?: number }
export function sourceFix(f: RadarFinding, report: RadarReport): SourceFix | null; // decision 8; null without sourcecommit

export type AuditState = "queued" | "running" | "clean" | "hits" | "failed";
export interface AuditRow { commit: string; sha: string; subject: string; state: AuditState; hits: number; detail: string }
// detail is the root cause, or the error for a failed audit. hits is keptcount (decision 3).
export function auditRows(report: RadarReport | null): AuditRow[];
export interface AuditTally { total: number; audited: number; clean: number; withHits: number; failed: number; hits: number }
export function auditTally(rows: AuditRow[]): AuditTally; // audited = clean + withHits + failed
export function auditSummary(t: AuditTally): string;
// "8 fix commits audited, 6 clean" | "8 fix commits audited, 4 clean, 2 failed" | "1 fix commit audited, 1 clean"
// | "no new fix commits" when total is 0
export function auditTallyText(t: AuditTally): string; // "6 clean · 2 with hits" | "4 clean · 2 with hits · 2 failed"
export function failedAuditShas(report: RadarReport): string[]; // short shas, audit order

export type RadarView = "never-scanned" | "scanning" | "old-format" | "cancelled" | "fatal" | "report" | "audits";
export function radarView(report: RadarReport | null): RadarView; // decision 4, in that order
export function isOldFormatReport(report: RadarReport): boolean; // decision 6
export function reportMetaAge(report: RadarReport, now: number): string; // "last scan 4m ago"
export function auditDuration(report: RadarReport): string; // "4m 36s", from clusterstartedts to completedts; "" if either is missing

export function dispositionLabel(d: RadarDisposition): string;
// suppress -> "Dismissed: intentional"; dismiss -> "Dismissed: <reason lowercased>", "no reason" when blank
```

Changed in place (the two exceptions):

- `dismissReasons(f)` returns `{ label, run?, action: "dismiss" | "suppress", reason, note? }[]`. The generic
  list gains "Intentional" last, with action `suppress` and reason `"Intentional"`; every other entry has
  action `dismiss`. `DISMISS_REASONS` gains `"Intentional"`.
- `composeRunGoal(f)` returns `f.mission` and nothing else. `PendingRunDraft` and `RadarRunDraft` lose
  `evidenceRefs`, and `toPendingRunDraft` / `buildRunDraft` stop setting it (nothing outside `radarmodel.ts`
  reads it; confirm with a grep and fix any reader you find).

`radarstyles.ts`: add `LIST_TONE_TEXT` and `LIST_TONE_DOT`, keyed `"open" | "muted"` (accent for open, muted
for dismissed, the same tokens `TONE_TEXT.new` and `TONE_TEXT.muted` use), and `AUDIT_STATE_TEXT` keyed by
`AuditState` (queued and clean rows muted in the scan list; the audit list shows clean in success; hits
accent-soft; running accent-soft; failed error). Keep the old maps for now.

`radardevmock.ts`: rewrite the fixtures as new-format reports, using the mockup's own data (the audited
commits and findings in the script block of `Main.dc.html`, `Scanning.dc.html`, `Clean.dc.html`) so the
screenshots line up with the boards. `setRadarScenario(name: string, opts?: { projectPath?: string })` and
`buildScenario(name, opts?)`: `projectPath` overrides the fixture report's `projectpath` so a scenario can
point the site link at a real checkout. A fresh dev store has no Radar scope, which leaves the project
selector blank and hides Re-scan, so `setRadarScenario` also sets `radarScopeAtom` to the fixture's
`{ name: projectname, path: projectpath }` (the fixtures' `projectname` is `waveterm`), remembering the scope
it replaced the first time; `live` puts that scope back. It writes the atom directly, never through
`initRadarScope`, so nothing is loaded or persisted. Scenario names, exactly:

- `never-scanned`: forces "no report" (the `"none"` value below), so the panel shows on a scanned project.
- `live`: clears the mock, back to the real report.
- `selecting`: status `collecting`, no audits.
- `scanning`: status `clustering`, eight audits as on the Scanning board (three done of which one has 2 kept
  hits, three running, two queued), `clusterstartedts` about two minutes before now.
- `results`: status `completed`, eight audits (six clean, two with hits), the six findings of `Main.dc.html`:
  four open (two with wire group `new`, one with an executing investigation), one dismissed with reason
  "Low priority", one with wire group `suppressed` and a `suppress` disposition. Each finding has one file,
  `sourcecommit`, `sourcesubject`, `rootcause`, `sites`, a `signalids` entry and a matching git signal in
  `signals`. Finding `a`'s file is `pkg/reporadar/scan.go` with a first site at line 122, a real file, so the
  site link has somewhere to land.
- `partial`: `results` with status `partial` and audits `7927fb68` and `9caee0d3` failed, error
  "Timed out after 10 minutes."
- `carried`: status `completed`, no audits, the two `recurring` open findings of `results` (decision 5's
  carried-findings case).
- `failed`: status `failed`, no findings, every audit failed with an error.
- `clean`: status `completed`, five clean audits, no findings, as on the Clean board.
- `no-commits`: status `completed`, no audits, no findings.
- `fatal`: status `failed`, `fatalerror` "not a readable git repository", no audits.
- `cancelled`: status `cancelled`.
- `old-format`: status `completed`, findings with no `sourcecommit` and no `sites`.

`radarstore.ts`, additive only (Task 3 takes the file over after this task):

- `radarDevMockAtom` becomes `PrimitiveAtom<RadarReport | "none" | null>`; `currentReportAtom` returns null for
  `"none"`.
- `export const shownReportIdAtom: Atom<string | undefined>`: the mock report's oid, undefined for `"none"`,
  else `currentReportIdAtom`'s value. The surface's load phase reads it, so a forced "no report" is not read
  as a report still loading.
- `export const radarOpenListGroupsAtom: PrimitiveAtom<Set<RadarListGroup>>`, initialised from
  `DEFAULT_OPEN_LIST_GROUPS`. Leave `radarOpenGroupsAtom` in place.

Until Task 5 regenerates the types, `RadarFinding.strength` is still a required string: set it to `""` in the
fixtures.

Tests, in `radarmodel.test.ts` (append; keep the existing tests passing, changing only the ones the two
in-place changes break) and `radardevmock.test.ts`:

- `listGroupOf` / `groupForList`: `new`, `recurring`, `nolonger` and an unknown group land in open;
  `dismissed` and `suppressed` in dismissed. `isNewFinding` is true only for `new`. `DEFAULT_OPEN_LIST_GROUPS` holds both groups. The open hint counts new
  findings and is empty at zero.
- `findingSite`: splits `pkg/a/b.go` into dir `pkg/a/` and file `b.go`; a root-level file has dir `""`; `more`
  is sites minus one; null with no files or no sites.
- `sourceFix`: sha is 8 chars; ts from the cited signal; ts undefined when the signal is absent; null without
  `sourcecommit`.
- `auditRows`: `ok` with keptcount 0 is clean, `ok` with keptcount 2 is hits with hits 2, `failed` carries the
  error as detail, `queued` and `running` map through, an unknown status reads as queued. `hitcount` without
  `keptcount` is clean. Null report gives `[]`.
- `auditTally`, `auditSummary`, `auditTallyText`: each string form listed above, including the singular and
  the zero-total form.
- `radarView`: one case per branch of decision 4, plus: an old-format finding wins over status `completed`;
  status `failed` with audits and no findings is `audits`; status `failed` with carried findings is `report`;
  status `partial` with no findings is `audits`; `completed` with no audits and no findings is `audits`.
- `dismissReasons`: Intentional is last with action `suppress`; the finished-investigation entry still leads
  with action `dismiss`. `dispositionLabel`: the three forms.
- `composeRunGoal` returns the mission only.
- `radardevmock.test.ts`: every scenario name builds a report whose `radarView` is the expected one
  (`never-scanned` -> the mock is `"none"`, `live` -> null, `selecting`/`scanning` -> scanning, `results`/`partial`/`carried` -> report, `failed`/`clean`/`no-commits` -> audits,
  `fatal`, `cancelled`, `old-format`), `projectPath` overrides `projectpath`, a scenario sets `radarScopeAtom` to the fixture's project, and `live`
  after two scenarios restores the scope that was there before the first.

Run: `npx vitest run frontend/app/view/agents/radarmodel.test.ts frontend/app/view/agents/radardevmock.test.ts frontend/app/view/agents/radarstore.test.ts`

This task renders nothing new; the fixtures are shown by the Task 6 scenarios.

### Task 2: The report body: findings list and finding detail
**Depends on:** Task 1

Owns `radarfindingslist.tsx` and `radarfindingdetail.tsx`. Match `Main.dc.html` and `MainDismiss.dc.html`.
Keep the exported names and props the surface uses: `RadarFindingsList` (`reportId`, `findings`, `selectedId`,
`onSelect`, `onActivate`, `activateLabel`), `RadarFindingDetail` (`model`, `report`, `finding`), and
`runPrimaryAction`. Delete `StrengthPips` (the detail pane is its only other importer and is in this task).

List:

- Two groups from `groupForList`, in `LIST_GROUP_ORDER`, with `listGroupMeta` for label, hint and tone. A group
  with no items is not drawn. The open/collapsed state lives in `radarOpenListGroupsAtom` (added by Task 1).
  The j/k nav list is still the rendered rows only.
- Row, top to bottom: the site line in mono (`dir` muted, `file:line` bright, then "+N site" when `more` > 0);
  the title (`finding.risk`, two-line clamp); then severity pill, "fix <short sha>" in mono, the investigation
  row label when there is one, and the "new" chip when `isNewFinding`. Dismissed rows are dimmed unless
  selected. No lens tag, no strength pips, no subsystem text, no ambient tags on the row.
- Hooks: `data-radar-group="open|dismissed"` on each group container, `data-radar-finding-row="<finding id>"`
  on each row, `data-radar-new` on the chip.
- Footer hints (j/k move, Enter label) stay.

Detail, top to bottom:

- The detail root keeps `data-radar-finding-detail="<finding id>"` and `data-radar-report="<report oid>"`:
  the `resource-linking` and `radar-start-investigation` scenarios select on both.
- Header line: group label with its dot, "new in the latest scan" when new (`data-radar-new`), "<severity>
  severity" pill, the subsystem in mono when `subsystemLabel` is non-empty. `AmbientTags` stays where it is.
- Site link (`data-radar-site-link`): `path:line` in mono with an arrow, `aria-label="Open the sibling site in
  Code"`, calling `openInCode(model, { projectPath: report.projectpath, rel: site.path, line: site.line })`.
  Not drawn when `findingSite` is null.
- Title (`finding.risk`).
- The investigation block and the primary action button, unchanged in behaviour (Investigating, Open run,
  Start investigation, Investigate again).
- Action row: primary button; for a finding with no disposition the Dismiss menu; for one with a disposition
  `dispositionLabel` and a "Reopen finding" button that sends `reopen`. The fingerprint stays at the right.
  No Suppress button.
- Dismiss menu (`data-radar-dismiss-menu` on the popover): heading "Dismiss because", one button per
  `dismissReasons` entry (`data-radar-dismiss-reason="<reason>"`), each calling
  `setDisposition(report.oid, finding.id, entry.action, entry.reason, entry.note)`. Footnote, exact:
  "Closes this finding. Its fix commit is audited once, so it stays closed until you reopen it from
  Dismissed."
- "Sibling site" / "Sibling sites" heading with the file name, then one card per site
  (`data-radar-site-card`): "line N" and the trigger; Actual (error tone label) and Expected (success tone
  label) side by side; "Fix gap" with `whynotcovered`.
- "Root cause" with `finding.rootcause`.
- `RelevantDecisions` stays, after Root cause.
- "Found by auditing this fix" (`data-radar-source-fix`): short sha, subject, and the date when `sourceFix`
  has a ts.
- The closing "Radar never edits files..." line.

Deleted from these two files: the lens badge, strength pips and "evidence" label, the "not detected" notes,
Why it matters, the Suggested investigation block, the Evidence list and its diff snippet renderer, Affected
files, the wide-pane side column and its container queries, and every import only they used.

Acceptance, shown by scenario `radar-report` (Task 6):

- step "1. a report lists Open and Dismissed with site, title, severity and source fix": both groups, a row
  with `file:line`, "fix <sha>" and a "new" chip.
- step "2. the detail shows the site link, site cards, root cause and source fix".
- step "4. the Dismiss menu offers four reasons and the reworded footnote".
- step "6. Intentional closes a finding into Dismissed, and Reopen finding returns it".
- step "7. the site link opens Code at the line".
- step "8. nothing the Removed board marks is on the surface" (the parts this task deletes).

Run before completing: the Check line.

### Task 3: Header, failed-audit strip, audited-commit list and scan panels
**Depends on:** Task 1

Owns `radarsurface.tsx`, `radarscanstatepanel.tsx`, the new `radarauditlist.tsx`, and `radarstore.ts` with
`radarstore.test.ts` after Task 1. Do not change how the scope, the report load or the selection work.

`radarstore.ts`:

- Delete `radarLensPickAtom`.
- Leave `radarOpenGroupsAtom` and `radarOpenListGroupsAtom` alone: the list (Task 2) may still read either.
- Rename `retryClustering` to `retryFailedAudits` (it still calls `RetryRadarClusteringCommand`), with a
  comment saying the RPC re-audits the report's failed commits.
- The comment on `setDisposition` lists `dismiss/suppress/reopen`.

`radarauditlist.tsx`: one component for the audited-commit list, used three times. Props: `rows: AuditRow[]`,
`title: string`, `tally: React.ReactNode`, `live?: boolean`. A row (`data-radar-audit-row="<sha>"`,
`data-audit-state="<state>"`) is glyph, short sha, subject with the detail line under it, and the state text:
"clean", "N hit" / "N hits", "failed", and in a live scan "auditing" and "queued". In a live scan the detail
line is not drawn (Scanning board rows are one line). Glyphs as on the boards: check for clean and hits,
spinner for running, hollow dot for queued, cross for failed. The container is `data-radar-audit-list`.

`radarsurface.tsx`:

- The load phase is computed from `shownReportIdAtom` in place of `currentReportIdAtom`.
- The body switches on `radarView(report)`; `data-radar-view="<view>"` goes on the body container.
- Subject bar: title, scope selector, and "Re-scan" (`data-radar-rescan`) for views `report`, `audits` and
  `old-format` whenever a scope is set; it calls `startScan(scope.path)` as today. Lens tabs
  and the collectors popover are deleted.
- Meta line, for views `report` and `audits`: `reportMetaAge`, then the audit summary, then "N findings". In
  the `report` view with one or more audits the summary is a button (`data-radar-audits-toggle`,
  `aria-expanded`) that opens a popover (`data-radar-audits-popover`, 660px, anchored under the line as on
  MainAudits) holding the audit list titled "Audited in the last scan" with `auditTallyText` as its tally. A
  click outside closes it. Otherwise the summary is plain text. Open state is local component state.
- Strip (`data-radar-health-strip`), when `failedAuditShas` is non-empty, for views `report` and `audits`:
  "The audit of <sha> failed. Sibling bugs of that fix may be missing." for one, "The audits of <sha> and
  <sha> failed. Sibling bugs of those two fixes may be missing." for two, and for more the shas joined with
  `joinAnd` and "those N fixes". The shas are mono. Button "Retry failed audits"
  (`data-radar-retry-audits`) calls `retryFailedAudits(report.oid)`. Put the sentence in the model as a pure
  function with a test if it is more than a join.
- `report` view: list and detail as today, with `findings` passed unfiltered.

`radarscanstatepanel.tsx`, one panel per remaining view:

- `never-scanned`: "<project> hasn't been scanned", body "Radar picks the recent fix commits and runs one
  read-only session on each, looking for the same bug at sibling sites. Nothing runs until you scan.",
  action "Scan repository". No list.
- `scanning`: title "Auditing fix commits", the board's body text, the audit list live, titled "Fix commits",
  tally "<audited> of <total> audited · <hits> hits · <elapsed> elapsed" (hits in accent-soft, dropped at
  zero; keep the ticking `Elapsed` from `clusterstartedts`). With no rows yet the tally reads "selecting fix
  commits". Secondary action "Cancel scan".
- `audits`: with no failed audit, the Clean board: check glyph, "No sibling bugs in N fix commits" (singular
  "1 fix commit"), the board's body, the list titled "Audited" with tally "<clean> of <total> clean ·
  <auditDuration>", and the footnote "A commit is audited once. The next scan picks up fix commits made after
  these." With zero audits: title "No new fix commits to audit", no list, the same footnote. With failed
  audits: no glyph, title "No sibling bugs found", the list with `auditTallyText` as its tally and each failed
  row showing its error; the strip above carries the retry.
- `fatal`: "The scan failed", the `fatalerror` text in the existing error-fact style, action "Scan again".
- `cancelled`: "Scan cancelled", body "Audits that finished before you cancelled were discarded.", action
  "Scan repository".
- `old-format`: decision 6's copy, action "Re-scan".

Deleted from these files: `LensTabs`, `CoveragePopover`, `HealthLineText`, the multi-line `ScanHealthStrip`,
`CollectorList`, the collector and lens `ScanProgress`, `FailureFacts`' collector and payload lines, the
clustering-failed panel, and every import only they used.

Tests: `radarstore.test.ts` keeps passing; add a model test for any pure function you add. Run
`npx vitest run frontend/app/view/agents/radarstore.test.ts frontend/app/view/agents/radarstoreload.test.ts frontend/app/view/agents/radarmodel.test.ts`.

Acceptance, shown by the Task 6 scenarios:

- `radar-report` step "3. the header's audit summary opens the audited-commit list".
- `radar-report` step "5. a partial scan names the failed commits and offers Retry failed audits" (it clicks
  Retry).
- `radar-report` step "9. carried findings with nothing new to audit".
- `radar-report` step "1" and `radar-scan-states` step "3" also assert the project selector names the
  project and `data-radar-rescan` is present.
- `radar-report` step "8. nothing the Removed board marks is on the surface" (lens tabs, collector count).
- `radar-scan-states` steps "1. a scan in progress lists each commit as audited, auditing or queued, with
  hits", "2. selecting commits shows the scan panel with no rows", "3. a clean scan says no sibling bugs and
  lists the audited commits", "4. a fully failed scan shows the strip and each commit's error", "5. no new
  fix commits", "6. a fatal failure shows the error", "7. a cancelled scan", "8. an old-format report asks
  for a re-scan", "9. a project never scanned".

Run before completing: the Check line.

### Task 4: The finding peek reads sites and root cause
**Depends on:** Task 1

Owns `frontend/app/view/jarvis/peek/peekradar.tsx`, `peekradarmodel.ts`, `peekradarmodel.test.ts`.

- `peekradarmodel.ts`: replace `peekEvidence` and `PeekEvidenceRow` with
  `export type PeekSiteRow = { key: string; place: string; trigger: string }` and
  `export function peekSites(finding: RadarFinding): PeekSiteRow[]`: one row per site, `place` is
  `<file>:<line>` with the finding's one file (`findingSite(f).path`), `key` unique per row. Empty when the
  finding has no file or no sites (an old-format finding). `radarPeekFacts` and `peekInvestigation` are
  unchanged. Stop importing `evidenceRows`.
- `peekradar.tsx`: the header is unchanged. Body: "Root cause" with `finding.rootcause` in place of the Risk
  and Why blocks (the header already shows the title; drop the block when there is no root cause), then the
  list block titled "Sibling sites" with "N site" / "N sites", each row the `place` in mono with the trigger
  as its `title`, the block dropped when there are no rows; then the investigation row as today. Mark the
  sites block `data-peek-radar-sites`.

Tests in `peekradarmodel.test.ts`: `peekSites` gives one row per site as `file:line` with its trigger, keys
are unique for two sites on the same line, and it is empty with no sites or no file; the existing
`radarPeekFacts` and `peekInvestigation` tests pass with fixtures that carry `sites`. Run
`npx vitest run frontend/app/view/jarvis/peek/peekradarmodel.test.ts`.

Acceptance: scenario `peek-item-views` step "4. a radar finding peeks as its item view" shows the Sibling
sites block (Task 6 updates the fixture and the assertion).

Run before completing: the Check line.

### Task 5: Delete the retired model code and wire fields
**Depends on:** Task 2, Task 3, Task 4

Nothing reads the old pipeline's model or wire fields any more. Delete them.

TypeScript (`radarmodel.ts`, `radarmodel.test.ts`, `radarstyles.ts`):

- Delete every export no file imports, and its tests. Expect at least: `RadarGroup`, `GROUP_ORDER`,
  `DEFAULT_OPEN_GROUPS`, `groupFindings`, `GROUP_META`, `groupMeta`, `RadarTone`, `isMutedGroup`,
  `missedLatestScan`, `findingDelta`, `findingSignalCount`, `reportSignalCount`, `reportSourceCount`,
  `referencedSignals`, `findingSourceCount`, `evidenceRows`, `strengthPips`, `RadarScanState`,
  `classifyScanState`, `isResultsState`, `rescanLabel`, `COLLECTORS`, `coverageEntries`, `classifyCoverage`,
  `coverageRows`, `LENSES`, `lensRows`, `hasCoverageFailure`, `partialCollectors`,
  `repositoryChangedDuringScan`, the mode and lens block (`RadarMode` through `resolveLens`), `scanHealth`,
  `HealthLine`, `lensHealthText`, `scanMetaLine`; in `radarstyles.ts` `TONE_TEXT`, `TONE_DOT`, `MODE_BADGE`,
  `modeBadge`. Find the real list with a grep per export rather than trusting this one; keep anything still
  imported (`joinAnd` is used by `frontend/app/view/jarvis/runtiming.ts`, `subsystemLabel`,
  `investigationView`, `primaryAction`, `radarLoadPhase`, `resolveSelection` are still used).
- `investigationView` still says "still detected" for a finished investigation on a finding whose wire group
  is `new` or `recurring` with `misscount` 0; keep that check as a private helper.
- `resolveSelection` orders by `LIST_GROUP_ORDER` and `groupForList`.
- `radarstore.ts`: delete `radarOpenGroupsAtom`.
- Rewrite the header comments of the two files to describe what is left.

Go:

- `pkg/waveobj/wtype.go`: delete from `RadarReport` the fields `Coverage`, `PartialSources`, `PayloadTokens`,
  `TotalTokensEstimated`, `ModeRuns`, `LensProgress`; delete the type `RadarModeRun`; delete from
  `RadarFinding` the fields `Mode`, `Strength`, `BoundaryLabel`. Fix the comments that name them (the
  `RadarSignal.Collector` and `RadarFinding.Group` comments too). A stored report that still carries these
  keys must load: Go's JSON decoding ignores unknown keys, and a test pins it (below).
- `pkg/reporadar/lifecycle.go`: `reopen` and `unsuppress` set the group to `GroupRecurring` (decision 12).
  Update the function comment and `pkg/reporadar/disposition_test.go`.
- Fix every Go reference and test fixture the deletions break (`pkg/reporadar`, `pkg/jarvis`, `pkg/wstore`,
  `pkg/waveobj`, `pkg/wshrpc/wshserver`), then `task generate` and commit the regenerated files. Then fix
  the TypeScript fixtures that set a deleted field (`radardevmock.ts`'s `strength: ""`, test fixtures under
  `frontend/`, `scripts/cdp/scenarios.mjs` is Task 6's and is plain JSON, so leave it).
- `docs/open-issues.md`: under "Radar:", drop any entry this rework makes false; add nothing.

Tests:

- `go test ./pkg/reporadar -run 'TestSetDisposition|TestDisposition'` (use the real test names in
  `disposition_test.go`): reopening a dismissed finding and unsuppressing a suppressed one both leave group
  `recurring` and no disposition.
- A new test in `pkg/wstore/wstore_radarreport_test.go`: a report row whose stored JSON carries `coverage`,
  `moderuns`, `lensprogress`, `payloadtokens` and a finding with `strength` and `mode` loads without error and
  keeps its findings. `go test ./pkg/wstore -run 'TestRadarReport'` (name the new test to match).
- `npx vitest run frontend/app/view/agents/radarmodel.test.ts frontend/app/view/agents/radardevmock.test.ts frontend/app/view/jarvis/peek/peekradarmodel.test.ts`

This task changes no rendered view. Run before completing: the Check line, and
`grep -rn "strength\|lensprogress\|moderuns\|partialsources\|payloadtokens" frontend/app` returns nothing
Radar-related.

### Task 6: CDP scenarios for every board and state
**Depends on:** Task 2, Task 3, Task 4
**Chunk:** Frontend: a finding shows its source fix, the sibling site and the trigger

Owns `scripts/cdp/scenarios.mjs`. Read `docs/reference/cdp-run-fixtures.md` for the harness conventions and
the existing `radarStartInvestigation` and `peekItemViews` scenarios for the patterns used below. Scope every
query to a `data-radar-*` container, never the document. Add both new scenarios to `SCENARIOS` and to the
expected-steps table near `surface-smoke`'s entry if new scenarios are listed there.

The dev mock: after `h.goto("radar")`, wait for `typeof window.__setRadarScenario === 'function'`, call
`window.__setRadarScenario(name, { projectPath })`, then wait for the `data-radar-view` the scenario expects.
`teardown` calls `window.__setRadarScenario('live')` (it clears the mock) and reloads.

Scenario `radar-report` (surface `radar`), one screenshot per step under `cdp-shots/`:

1. "1. a report lists Open and Dismissed with site, title, severity and source fix": mock `results`. Assert
   `data-radar-view="report"`, both `data-radar-group` containers, a row whose text has a `file:line` and
   "fix ", one or more `data-radar-new` chips in the Open group, two rows in Dismissed (both groups start
   open), the project selector reading `waveterm`, and `data-radar-rescan`. Shot
   `radar-report.png` (board Main).
2. "2. the detail shows the site link, site cards, root cause and source fix": on the selected finding assert
   `data-radar-site-link` text ends in `:<line>`, one or more `data-radar-site-card` with the words Actual,
   Expected and Fix gap, a "Root cause" heading, and `data-radar-source-fix` holding the 8-char sha.
3. "3. the header's audit summary opens the audited-commit list": click `data-radar-audits-toggle`; assert
   `data-radar-audits-popover` holds eight `data-radar-audit-row`, two of them `data-audit-state="hits"`.
   Shot `radar-audits.png` (board MainAudits). Close it.
4. "4. the Dismiss menu offers four reasons and the reworded footnote": open the Dismiss menu on an open
   finding; assert `data-radar-dismiss-menu` has the four reasons with Intentional last and the footnote
   text of decision 1's menu. Shot `radar-dismiss.png` (board MainDismiss). Close it.
5. "5. a partial scan names the failed commits and offers Retry failed audits": mock `partial`. Assert
   `data-radar-health-strip` names `7927fb68` and `9caee0d3`, `data-radar-retry-audits` is present and
   enabled, and the header summary ends "2 failed". Shot `radar-partial.png` (board MainPartial). Then click
   Retry: the mock report's oid is not in the store, so the RPC is refused and no audit starts. Assert the
   click was dispatched and the surface still shows the report and the strip afterwards.
6. "6. Intentional closes a finding into Dismissed, and Reopen finding returns it": clear the mock (`live`). `window.__openAddress` exists only once the Brief has mounted, so `h.goto("jarvis")`
   and wait for `typeof window.__openAddress === 'function'` first, as `radarStartInvestigation` does. Seed a
   new-format report for the dev app's checkout into the dev store, the way `seedPeekItemsRadar` does (reuse
   `peekItemsDb`; a UUID oid; `projectpath` the checkout's cwd; one open finding with `sourcecommit`,
   `rootcause`, `sites`, file `pkg/reporadar/scan.go`, first site line 122; one `ok` audit), open it with
   `window.__openAddress("radarreport:<oid>", { sourceType: "radar", anchor: "<finding id>" })`, choose
   Dismiss > Intentional, and assert the row is now under `data-radar-group="dismissed"` and the detail reads
   "Dismissed: intentional". Click "Reopen finding" and assert the row is back under Open with no
   `data-radar-new` chip. Delete the seeded report in `teardown`.
7. "7. the site link opens Code at the line": on the seeded finding click `data-radar-site-link`; assert the
   active surface is Code and the open file is `pkg/reporadar/scan.go`. Shot `radar-site-in-code.png`.
8. "8. nothing the Removed board marks is on the surface": with mock `results`, assert inside the Radar
   surface: no `[aria-label="Lens"]`, no text "collectors", "Suppress pattern", "Suppressed", "Recurring",
   "No longer detected", "Evidence", "Affected files", "Suggested investigation", and no element titled
   "<x> evidence" (board Removed).
9. "9. carried findings with nothing new to audit": mock `carried`. Assert `data-radar-view="report"`, the
   meta line holds "no new fix commits", there is no `data-radar-audits-toggle`, and no health strip.

Scenario `radar-scan-states` (surface `radar`), dev mock throughout, one shot per step:

1. "1. a scan in progress lists each commit as audited, auditing or queued, with hits": mock `scanning`.
   Assert `data-radar-view="scanning"`, eight rows, states queued, running and hits all present, the tally
   text holds "3 of 8 audited" and "2 hits", and a "Cancel scan" button. Shot `radar-scanning.png` (board
   Scanning).
2. "2. selecting commits shows the scan panel with no rows": mock `selecting`; no rows, "selecting fix
   commits".
3. "3. a clean scan says no sibling bugs and lists the audited commits": mock `clean`. Assert
   `data-radar-view="audits"`, the title "No sibling bugs in 5 fix commits", five rows all
   `data-audit-state="clean"`, no health strip, the project selector reading `waveterm`, and
   `data-radar-rescan`. Shot `radar-clean.png` (board Clean).
4. "4. a fully failed scan shows the strip and each commit's error": mock `failed`. Assert the strip, the
   Retry button, and every row `data-audit-state="failed"` with its error text.
5. "5. no new fix commits": mock `no-commits`; the title "No new fix commits to audit" and no audit list.
6. "6. a fatal failure shows the error": mock `fatal`; `data-radar-view="fatal"`, the error text, "Scan
   again".
7. "7. a cancelled scan": mock `cancelled`; `data-radar-view="cancelled"`.
8. "8. an old-format report asks for a re-scan": mock `old-format`; `data-radar-view="old-format"`, the
   title of decision 6, a "Re-scan" action, and no finding rows.
9. "9. a project never scanned": mock `never-scanned`; `data-radar-view="never-scanned"`, the title ending
   "hasn't been scanned", a "Scan repository" action and no collector list.

`peek-item-views`: change `peekItemsReport` to a new-format report (finding with `sourcecommit`,
`sourcesubject`, `rootcause`, one file, two `sites`, no `strength` or `mode`; one `ok` audit), and extend the
check behind "4. a radar finding peeks as its item view" to require `data-peek-radar-sites` with two rows.

`surface-smoke` already opens Radar; leave it.

Each step returns `{ step, ok, detail }` with a `detail` that says what was read, so a failure explains
itself. Run `node --check scripts/cdp/scenarios.mjs` before completing; the scenarios themselves run in
Final, which starts its own dev app.
