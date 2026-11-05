# Brief live pass fixes: design

The Brief live pass on real data (`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\brief-live\report.md`,
gitignored, read it by that absolute path; shots beside it, named by the numbers the findings cite) reported F1-F16.
Every cause below was re-read against the code at `f15fdc695` before a fix was chosen. Where this design's fix differs
from the report's suggestion, it says why. Out of scope: the report's "Tooling gaps" section and the live-check
confirmations at its top (F14, F19, F20 of the earlier code pass hold).

All frontend paths are under `frontend/app/view/jarvis/` unless a path says otherwise.

## Rules every fix follows

- **Logic in pure files, tested beside them** (AGENTS.md "Logic is extracted, not rendered"). A decision a fix adds
  is a pure function in a `.ts` with its test in the `.test.ts` beside it, or a Go function with a `_test.go` beside
  it. The `.tsx` only calls it. A class-name-only change is proven by a scenario step, not a unit test.
- **Every count is the rows beneath it** (`briefsurface.tsx` header comment). F1, F10, F14 and F16 restore that rule.
- **Colors and spacing come from existing `@theme` tokens** (`frontend/tailwindsetup.css`, DESIGN.md). No new token,
  no new custom variant in `tailwindsetup.css` (run 2c86fd26 edits that file). Copy is sentence case (DESIGN.md Copy).
- **Every fixed visual state or interaction has a step in an existing scenario**, run at the size where it broke
  (`Emulation.setDeviceMetricsOverride`, `{width: 1000, height: 700, deviceScaleFactor: 1, mobile: false}` or 1600x950)
  and cleared in that scenario's teardown or `finally`. A step measures the state (element rects, `scrollWidth` vs
  `clientWidth`, computed style, text) and records pass or fail; a screenshot alone is not a step. Queries are scoped
  to a `data-*` container, never to a window position near the title bar. Each step's text names its finding
  (`"35. F2: ..."`).
- **Live checks run only through Final** (`node scripts/cdp/final-verify.mjs`, its own isolated app). Never attach to
  or kill a dev app on :9222.

## Header

**F1 (label): "N projects" counts work-state keys.** Verified: `briefsurface.tsx:907` reads
`snapshot?.state.projects?.length`, and `pkg/jarvisstate/fetch.go:141-159` keys `ProjectWork` by the normalized raw
path of every item (run worktrees, temp dirs, `(none)`, and the same project as a path and as a name).
Decision: a pure `workProjectCount(keys: string[], projects: Record<string, { path?: string }>): number` in
`briefrows.ts` counts the distinct registered project names the keys resolve to. A key resolves when it equals a
registered name, or when its normalized path (the `norm` rule `projectName` already uses, which this extracts and
shares) equals a registered project's path. An unresolved key (worktree, temp dir, `(none)`) is not a project and is
not counted. The fact keeps its words ("all work · N projects") and still hides at 0. Why: the autonomy chip counts the
same registry (`projectListAtom`), so the two numbers now agree; dropping the fact (the report's alternative) loses the
one place the header says how wide "all work" is. Resolving a worktree to its project is not attempted: nothing on
the wire maps a worktree path to its checkout, and an undercount of a project already counted by its checkout is no
change.

## Waiting on you

**F2 (usage): a direct agent's ask can't be acted on and reads "worker".** Verified: for a pending ask with no owning
channel, `pkg/jarvis/attention.go:362-385` sets `ChannelId` empty and falls back to the name "worker" (also in the
`Why` sentence); `buildAttentionQueue` then sets `action` null and `queueNav` returns null
(`briefingmodel.ts:198-205, 229`), so the row is static. `GatherAttentionFromLedger` already resolves the ask's tab
oref (`AskWorkerORef`, via `ChannelOwnerORef`), and the router already opens `tab:<id>` as an agent
(`address.ts:51-53`, `openref.ts` `selectAgent` → `jumpToAgent`, the same call the Runs row's Answer makes).
Decisions:
- Go (`attention.go`): an ask with no channel whose `AskWorkerORef` is a `tab:` oref carries it in `Oref`. Its source
  fallback is "agent", not "worker", and its `Why` is "The agent is paused until you answer." A channel-less ask with
  no tab oref keeps today's shape. Asks with a channel are unchanged.
- Frontend (`briefingmodel.ts`): `buildAttentionQueue` gains an optional `agents: { id: string; name: string }[]`
  input (the roster `briefsurface.tsx` already holds). A channel-less ask with a `tab:` oref gets
  `nav: { kind: "oref", oref }`, `action: "Answer"`, and `queueActions` gives it one act
  `{ label: "Answer", kind: "open" }`. Its `source` and `detail` are the roster agent's `name` when the tab is in the
  roster, else the wire source. Why: the Runs row already answers this agent this way; one route, one name. The why
  sentence stays server-side and name-free, so the frontend does not rewrite server text.

**F14 (visual): the ask row's age wraps, and its summary has no count.** Verified: the age cell is `w-10`
(`briefrowviews.tsx:79-86`), narrower than "just now" in 11px mono; `summarizeAttentionQueue` prints a single kind as
its bare word (`briefingmodel.ts:436`). Decisions: the age cell is `whitespace-nowrap` and wide enough for "just now"
at 11px mono (measure; every Waiting row uses the same width so the column stays aligned). The summary always counts:
`1 ask`, `1 blocked`, `2 asks` (singular word for 1, `KIND_PLURAL` otherwise); update the comment and the tests that
pinned the bare word.

**F16 (usage): the filter leaves the counts unfiltered.** Verified: `queueSummary` is built from the whole queue
(`briefsurface.tsx:349`), the Initiatives project chips from `perProject` over every card (`:365`), and the Shipped kind
chips from `shippedCounts` over every shipped run (`:435`), while the rows beneath them are filtered. The Runs region's
kind chips use the same `runKindFilter` (`briefprimitives.tsx:195-207`, `briefruns.tsx`) over filtered rows too, so
they are in scope by the same rule. Decision: while a
filter is active, each of those counts counts the rows that match, written "N of M" with M the unfiltered count; with
no filter they read as today. A pure `filterCount(matched: number, total: number, filtering: boolean): string` in
`briefrows.ts` is the one place the format lives. The Waiting summary is built from the matching rows and its title
reads "N of M waiting match the filter" while filtering. The filter-slot option `count` becomes the label string this
returns. Why "N of M" over hiding: the total is still the useful number when the filter matches some rows.

## Initiatives

**F8 (usage): Initiatives hides the initiatives that hold the blocked work.** Verified: the window is
`capRegion(projectEfforts, EFFORT_CAP, ...)` (`briefsurface.tsx:369-372`), a plain head of the list in recent-activity
order. Decisions:
- A pure `initiativeWindow(cards, cap, expanded)` in `briefingmodel.ts` replaces that call: collapsed, the window takes
  the initiatives with blocked chunks first (in list order, up to the cap), then fills the rest of the cap in list
  order; the shown rows keep their original relative order, and `more` counts the rest. Expanded, it is every card.
- `initiativesMeta` (`briefrows.ts:140`) leads with "N blocked" (initiatives with at least one blocked chunk) before
  "paused" and "quiet 7d+".
Why: the Waiting summary says "8 initiatives"; the region under it must be able to show them without a click.

**F10 (label): the inline tracker's footer counts skipped chunks.** Traced: `inlinetracker.ts:113-118` builds the facts
line from `chunks.length`, while the row (`initiativeLine`, done + remaining) and the sheet
(`effortdetailview.tsx:139`) leave skipped chunks out. Decision: the facts line is
`"<counted> chunks · <done> done"` with counted = all minus skipped, plus `" · <n> skipped, not counted"` when any
are skipped, the sheet's wording.

**F15 (visual): the tracker footer's action labels are lowercase.** Verified at `inlinetrackerview.tsx:785-838`.
Decision: sentence case for every label in that footer: Rename, Details, Activity, Post to Jira, Pause / Resume,
Archive, Unarchive, Delete, and the delete confirm's Cancel and Delete. Grep scenarios for the old lowercase texts and
update them in the same task.

**F13 (label): the initiative peek's summary reads "effort created".** Verified: `peek/peekeffortmodel.ts:31` takes
the oldest note as the objective, and `pkg/wshrpc/wshserver/wshserver_effort.go:61` writes "effort created" as every
initiative's first note. Decision: the objective is the oldest note that is not that creation marker; with none, null
(the peek already omits the line). The marker's text is one exported constant in `effortmodel.ts`, named for the Go
literal it mirrors. Why not "the active chunk or latest note" (the report's suggestion): the peek already shows the
remaining chunks and the active one; the line's job, per its comment, is the objective someone wrote.

**F11 (label): Edit initiative contradicts itself and asks for an internal id.** Verified: `effortcreateform.tsx:388`
says "changes apply immediately" beside Save changes; `:233-241` is a free-text "optional · effort id" Parent field in
both Edit and New. Decisions: the Edit footer line is dropped (nothing applies before Save). Parent becomes a
type-to-filter picker of initiatives by title, modelled on `RecordPicker` (an input, a short filtered list under it,
Escape stopped from closing the modal): it shows the chosen parent's title, matches live initiatives by title or
ticket, excludes the initiative being edited, and has a way to clear it. The matching is a pure
`parentChoices(cards, query, selfOid, max)` in `effortmodel.ts`. The value submitted stays the bare oid.

## Behind you, Shipped and the run sheet

**F4 (label): run and record titles are the raw goal, cut mid-sentence.** Traced:
- Shipped rows use `title: s.goal` (`briefrows.ts:548`); the run sheet's collapsed heading is `run.goal`
  (`runsheet.tsx:446-452`).
- The record peek's title is `objectiveParts(objective).headline` (`briefpeek.ts:118-129`), and `headline`
  (`effortfeed.ts:190-198`) ends a sentence at `.` or `;` followed by whitespace, so "…absolute path;" ends a title.
- The good name is the H1 of the run's report (`evidence.summary`), which `parseRunReport` already reads (`runreport.ts`).
Decisions:
- `headline` ends a sentence only at `.`, `!` or `?` followed by whitespace or the end, never at `;`. Update the tests
  that pinned the `;` cut.
- A pure `runTitle(goal: string, summary: string): string` in `runreport.ts`: the report's H1 when the summary has one
  (a leading "Run report:" prefix dropped), else `shortTitle(goal)` (the goal's first line's lead sentence,
  `briefrows.ts:384`). Shipped rows and the run sheet's collapsed heading use it; the sheet's expanded heading still
  shows the whole goal as prose.
- The record peek's title is `runTitle` of the record's origin run when that run's goal equals the record's objective
  (the record was captured from it, `pkg/jarviscapture/capture.go:57`), else the objective headline. A pure
  `recordTitle(objective, runs)` in `briefpeek.ts`; `runs` are the record's runs the peek already loads, `undefined`
  while the scope loads (then the headline). It returns which source it used: when the title came from a run, the
  peek's body is the whole objective, since `objectiveParts` drops the lead sentence only because the title shows it.
- The row tooltip shows the title, which is now bounded by `HEADLINE_MAX` or a report H1, so no separate tooltip cap.
  The report's "cap the row tooltip" is met by the shorter title.

**F7 (visual): at 1000x700 the run sheet leaves about 175px for its body.** Traced: `runsheet.tsx:217-259` pins the
`Reading` head (`flex-none`), scrolls only the middle `div.sc`, and pins the footer (`Dock`, the "Ran with" block, and
`RunComposer`). Decision: below 800px of viewport height, the head and the `Dock` scroll with the body and only the
composer stays pinned. `Dock` and `RunComposer` share one `<footer>`, so the footer splits in two: the `Dock` part
(keeping `data-jarvis-brief-sheet-face="settings"`) and the composer. CSS only, with Tailwind arbitrary media variants on height
(`[@media(max-height:799px)]:...`): the outer column scrolls, the inner `div.sc` stops being its own scroller, and the
composer is `sticky bottom-0` inside the scroller. At 1600x950 nothing changes. Why the media query, not a container
query: Tailwind's container variants are width-only, and the sheet is the window's height.

**F9 (label): "Where we were" says its own name twice.** Verified: `petjoin.ts:37` prefixes "Where we were — " and
`petvoice.ts:55` is already the heading. Decision: the text is the summary alone.

**F12 (label): Check Jira says "2 more" for the same 2 tickets.** Verified: `jiracheck.ts:94-101` always says "more".
Decision: `footerLine(covered, listed)`: "more" only when `listed > 0`; with nothing listed it reads "2 assigned
tickets already have an initiative." `jiracheckdialog.tsx` passes the listed count.

## Record attribution

**F3 (bug) and F5 (usage): runs of other records appear on a record, and a confirmed run offers 31 guesses.** Traced:
commit `0b1f5dcca` made `assembleEdges` (`pkg/jarvisattrib/extract.go:134-183`) consider lead runs only, in every
layer. The runs that still reach "Runs on this record" are other records' lead runs that layer 3 (`extractLayer3`,
`:83-109`) links as weak structural guesses: the run is in one of the record's anchor repos, the windows overlap, and
it finished within the time box. In a busy repo every lead run of the week is a weak guess for every record active that
week. `buildSpaceScope` (`wshserver_jarvis.go:536`) turns every edge into a run of the record, and the ambient layer
(`AllEdges`, used by the record band) shows each as "guessed · weak". The lead-only rule holds; the missing rule is that
a run already confirmed to one record is not a guess for another.
Decision (Go, `pkg/jarvisattrib`): a run claimed by a record is never an inferred edge of another record.
- A pure `claimedRuns(...) map[string]string` (run oref → claiming dossier id) is built from every dossier's layer-1
  run refs that `assembleEdges` would keep (lead runs, or refs to runs missing from the store, the existing rule) plus
  the override log's accepts, minus the log's detaches for that pair.
- `edgesForDossier` drops an edge that is not confirmed when its run is claimed by a different dossier. A confirmed
  edge is never dropped, so a run accepted onto two records keeps both.
- `EdgesFor` and `AllEdges` both build the claim map; `EdgesFor` loads every dossier's refs (front matter only, no
  extra git calls) to do so. `AllEdges` builds it once from the dossiers it already loads.
Result: the record peek lists only its own runs and unclaimed guesses (F3), and a run whose record is confirmed has no
guesses left in its band (F5). Why not the report's suggestions (filter the scope to strong edges; fold guesses in the
band): both treat the symptom on one surface and leave the bad edge feeding the other surfaces and the volunteer layer
(`pkg/jarvisvolunteer/connection.go` reads `AllEdges`). An unclaimed run's weak guesses stay, on both surfaces, as
they are the attribution model working as designed.

**F6 (visual): "open this record" wraps in the record band at 1600.** Verified: the link span at
`recordbandview.tsx:225` has no `whitespace-nowrap` and its button grows the chip. Decision: the span is
`flex-none whitespace-nowrap`, and the `EdgeChip` is the part that truncates (`min-w-0`), at 1000 and 1600.

## Decisions taken without a human (autonomous run)

- F3/F5 fixed at the attribution source rather than per surface (reason above).
- F13 shows the written objective, not the active chunk (reason above).
- F16 uses "N of M" rather than hiding counts (reason above).
- F1 counts registered projects only; worktrees are not resolved to their checkout (reason above).
- Scenario steps for F11 and F12 go in the existing `jira-details` and `jira-check` scenarios, which drive the Brief's
  Edit initiative and Check Jira dialogs; F4's sheet title and F7 go in `run-sheet-polish`. Every other step goes in
  `scenarios-brief.mjs` (`brief-act`, `brief-inline-tracker`, `record-band-detach-restore`).
