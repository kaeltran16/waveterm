# Brief code review fixes: design

The Brief (Jarvis) code review of 2026-11-05 (`C:\Users\kael02\IdeaProjects\waveterm\cdp-shots\review\brief-code\report.md`,
gitignored, read by that absolute path) reported 22 findings, F1-F22, from a code-only pass at `35ee176bb`. Every
cause below was re-read against the code at that commit before a fix was chosen; where this design's fix differs
from the report's suggestion, the reason is given. The report's "Not new" section is out of scope, and so is F22 on
run surfaces other than the Brief, beyond the shared change in `runactions.ts`.

All files are under `frontend/app/view/jarvis/` unless a path says otherwise.

## Rules every fix follows

- **Logic in pure model files, tested beside them** (AGENTS.md "Logic is extracted, not rendered"). A decision a
  fix adds (which act a row gets, what a reveal must unfold, which legs are missing) is a pure function in a `.ts`
  file with a test in its `.test.ts`; the `.tsx` only calls it.
- **Every count is the rows beneath it** (`briefsurface.tsx` header comment). F2 and F15 restore that rule; no fix
  may break it.
- **A failure is shown, never only logged.** On the Brief, a failed write or act reports through
  `briefUndo.error(...)` (the toast `BriefToastView` draws), which is what `actOnQueue` already does. A success toast
  appears only after the write resolved.
- **Colors and spacing from existing `@theme` tokens** (`frontend/tailwindsetup.css`, DESIGN.md). No new token.
- **Every fixed visual state or interaction has a step in a Brief CDP scenario** in `scripts/cdp/scenarios-brief.mjs`.
  New steps go into `brief-act`, numbered after its current eleven, each step's text naming its finding
  ("12. F7: ..."). A step that needs a failing RPC uses a `failRpc(h, command, message)` helper added to
  `scripts/cdp/scenarios-shared.mjs` beside `holdRpc`, storing the original in the same `window.__heldRpc` map so
  `releaseRpc` restores it. Fixture-driven steps extend `BRIEFING_FIXTURES` in `briefingfixtures.ts` (the `act`
  fixture or a new named one added to `BriefingFixtureName`).
- No keybinding changes. F16 widens what `j` / `k` walk with a run sheet open, so `docs/keyboard-shortcuts.md`'s
  line for it is reworded to say folded rows are included; the cheat sheet (`frontend/app/cockpit/shortcuts-cheatsheet.tsx`)
  reads binding descriptions, which do not change.

## Waiting on you

**F7 (label).** Verified: `queueLine` takes its kind from `queueKindLabel` (`briefrows.ts:91`), whose default sends
`run-unverified` and `run-land-held` to "blocked" (`briefingmodel.ts:319-331`); the `QUEUE_KIND_LABEL` words reach
only `QueueRow.kind`, which no component renders. Decision: `queueKindLabel` gains `"unverified"` and `"land held"`
(plurals in `KIND_PLURAL`: "unverified", "held lands"), and becomes the one source of a row's kind word: the
`QUEUE_KIND_LABEL` map and `QueueRow.kind` go if a grep finds no other reader, else `kind` is derived from
`queueKindLabel`. Why: two label tables for one row is how they drifted; the test must pin what is drawn
(`queueLine(...).kind` and the summary), not `q.kind`.

**F8 (half-supported).** Verified: `queueAction` has no `run-land-held` case (`briefingmodel.ts:340-348`), while
`petacts.ts:60-64` offers Retry land and Dismiss for the same item. Decision: a held land with a channel and run id
gets two acts, `{ label: "Retry land", kind: "land-run" }` and `{ label: "Dismiss", kind: "dismiss-land" }`.
`actOnQueue` runs them as the pet does (`petactrun.ts` `land` / `ack`): Retry land calls `LandRunCommand` with the
pet's 45-minute timeout (export `LAND_TIMEOUT_MS` and `LAND_STATE_LANDED` from `petactrun.ts` rather than copy them)
and toasts "Landed · <title>" when the result's state is landed, else "Still held · <reason>" as a plain notify
(a land that holds again is not a failed call); Dismiss calls `AckRun` with `land: true`. `QueueActionDeps.rpc`
gains `landRun`. Why: the queue and the pet act on the same item and should offer the same verbs.

**F9 (UI/code disagreement).** Verified: `buildAttentionQueue` drops nav for a channel-less item (`:236-239`) and a
blocker with an empty oref (`:296`), but `WaitingRow` always draws the acts, and the fallback Open does nothing.
Decision: `queueActions(row)` returns `[]` when the row has no chunk and `queueOpenTarget(row.nav)` is null. Why: the
model's own comment promises static info rather than a dead button.

**F14 (usage).** Verified: `mutateEffort` updates only the detail cache (`effortstore.ts:50-60`); the queue and the
initiative's "N blocked" come from the snapshot, which reloads through `effort:update` in ~14 s. Decision: an
optimistic settle. A Brief-scoped atom (beside `pendingDeleteKeysAtom` in `briefundo.ts`) maps a `chunkKey(oref,
label)` to the time it was acted on. Unblock and Done settle the key at the click; a failed write and Unblock's undo
(the re-block) remove it. A pure function in `briefingmodel.ts` drops a settled chunk from each effort card's
`blockedChunks` while the snapshot's `queryStartedAt` is older than the settle time. The surface applies it once,
before the queue is built, and hands that one list to `buildAttentionQueue` (which today reads `model_.efforts`
directly) and to every other reader of `efforts`, so the Waiting row, the summary and the Initiatives "N blocked"
all agree. A snapshot started
after the act ends the hide on its own. Why keyed on time rather than cleared on any load: a reload already in
flight when the user clicked returns pre-write data and would bring the row back.

"mark seen" has the same lag (`markBriefingSeen` moves `briefingCursorAtom` at once, the delta follows the reload).
Decision: the surface projects with the later of the snapshot's `actualCursor` and the stored visit cursor (a pure
helper in `briefingmodel.ts`), so Behind you empties at the click and its undo brings the rows straight back.

## Behind you

**F1 (bug).** Verified: the server groups the delta per project and sorts projects by key (`pkg/jarvisstate/fetch.go:190`);
`projectBriefing` flattens without re-sorting (`briefingmodel.ts:604-606`), so `(none)` (decisions, records) sorts
first. Decision: sort `rawDelta` newest first in `projectBriefing`, ties by key, as Shipped already does. The server
is left as is: per-project grouping is its contract, and the cross-project order is the client's to make.

**F2 (bug).** Verified: `capRegion` caps raw events (`briefsurface.tsx:397-401`) before `behindGroups` folds them
into digests (`briefrows.ts:473-521`), so `more` counts hidden events. Decision: group and fold the whole delta
first, then cap the folded lines across the day groups (a pure function in `briefrows.ts` taking the folded groups,
the cap and the expanded flag, returning the kept groups and `more` = folded lines hidden). Shipped keeps its own
cap. Order: fold, filter, cap (a filter still reaches every fold).

**F17 (UI/code disagreement).** Verified: groups with no match are dropped while filtering (`briefsurface.tsx:452-454`)
and `BehindRegion` then says "Nothing new since you last looked." and hides mark seen; Shipped with no match shows
nothing. Decision: `BehindRegion` takes `filtering`; with a filter and no matching line it draws `NoMatch` (the
other regions' component), in the delta part and in Shipped. "mark seen" shows while the unfiltered delta has rows,
since it acts on all of them, not on the matches.

**F18 (unreachable).** Verified: Behind you's head is a span (`briefbehind.tsx:183-200`), so "show only this region"
cannot be reached. Decision: use `RegionHead` (exported from `briefprimitives.tsx`) for the label, so the head is the
same button the other three regions have, wired to `toggleOnly("behind")`; "since" and "mark seen" stay beside it
as siblings, never nested inside the button. Why not drop the case: the other three regions have it, and keeping
the four heads alike is the surface's own rule.

## Runs

**F5 (bug).** Verified: `mergeActiveWork` appends `":" + i` to every key (`briefingmodel.ts:470`), and the line id is
`"sessions:" + key`, so a roster change shifts every later row's id; the cursor falls back to the first row and the
scroll effect jumps there; rows that did not arrive replay their entrance. Decision: drop the index suffix. Keys are
`run:<oref>` and `agent:<id>`; where several rows share a key (a run item with no navtarget reads `run:`), they
take `<key>:<ts>`, and rows that still share that take an ordinal counted among those identical rows only, in
sorted order: never a position in the whole list, so a roster change elsewhere cannot move it. `sessionLine`'s
`agentId` parse keeps working. Why: an id must name the thing, not where it sits.

**F6 (bug).** Verified: an agent row has no target (`briefrows.ts:171`), so `onOpenSheet` is undefined and Answer
does nothing; a run row whose Run object has not loaded draws an "agent" badge, a dead Answer and no Stop.
Decision: `RunRowFace` gains `answer: "sheet" | "agent" | null`, decided in `runRowFace`: a run line answers in its
sheet (loaded or not), a direct agent's line jumps to the agent (`jumpToAgent(model, line.agentId)`). A run line
whose Run has not loaded takes its type badge from the snapshot's run mode, carried from `RunRow.mode` through
`ActiveWorkRow` to the line, not "agent".

**F15 (label).** Verified: the kind chips count all of `model_.activeRuns` (`briefsurface.tsx:357-364`) while the
head's "N live" excludes stale runs. Decision: the chips count only non-stale rows, by the same staleness rule
`sessionWindow` folds on (a pure function in `briefrows.ts`), so "all" equals "N live". Why not a separate stale
count: the fold already states it ("+N runs older than 7 days").

**F16 (half-supported).** Verified: `briefRunListAtom` publishes only the drawn rows (`briefsurface.tsx:857-864`), so
the sheet reads "3 / 3" and its arrows and `j` / `k` stop at the fold. Decision: publish the whole kind-filtered list
(every Shipped run the kind filter keeps; every session run, live past the cap and stale). `runNavLines` walks lines
built for that whole list, and landing on a line the region does not draw opens the fold that hides it (Shipped's
"+N more", the stale fold, or Runs' "+N more"), decided by a pure function in `briefnav.ts`, so that closing the
sheet leaves the cursor on a drawn row.

**F22 (unhandled).** Verified: `confirmCancelRun` wraps the cancel in `fireAndForget` (`agents/runactions.ts:175`),
which only logs, and `BriefRunRow` passes `run.channeloid ?? ""`. Decision, the shared fix: `confirmCancelRun` takes
an optional `onError(message)`; a rejected cancel calls it, and a run with no channel calls it without sending the
RPC. Omitted, it logs as before, so the other run surfaces are unchanged (out of scope). The Brief's Stop passes
`briefUndo.error`.

## Initiatives

**F3 (bug).** Verified: `showInitiative` clears the project filter, the fold and "only" but not the text query
(`briefsurface.tsx:658-667`); the plan opens only if the initiative line is in the filtered `view.visible`, and a
Waiting row matches on chunk label and needs that the initiative line does not carry. **F4 (bug).** Verified:
`briefEffortIndexAtom` includes archived cards, so ↳ is drawn for an archived initiative, but `showInitiative` looks
only at live efforts and an archived line is drawn only with Show archived on. Decision for both: a pure function in
`briefmutations.ts` takes the oref, the live and archived cards, the picked project, the drawn window, the query and
"only", and returns what to change so the line is drawn: clear the project, open the region's fold, turn Show
archived on (archived oref), clear the query (only when the initiative's line would not match it, checked with
`filterLines(initiativeLine(card))`), clear "only". The surface applies it in `showInitiative`. Why clear the query
rather than keep the line in `filterLines`: a filter that silently admits a row it does not match is a second rule
to learn; landing is an explicit navigation, so dropping the filter is the honest result.

**F11 (unhandled).** Verified: Move to project and Pause / Archive call `run()` and `notify()` at once
(`briefmutations.ts:77-79, 96-101`); a rejection goes to `mutateError`, drawn only under the open initiative.
Decision: `effortOps` and `moveToProjectItems` await the write, toast its text and Undo only after it resolves, and
report a failure (and a failed undo) through `deps.undo.error`. The plan footer uses the same `effortOps`, so it
reports the same way: one path. Plan-row edits (`trackerEdits`) keep `mutateError`, which is drawn where those edits
are made.

**F13 (unhandled).** Verified: the plan load is `fireAndForget` (`briefsurface.tsx:498-505`); effort sync refreshes
only orefs already cached (`effortsync.ts:45-52`), so a failed first load is never retried. Decision: `effortstore.ts`
keeps a per-oref load error (set on a failed `loadEffortDetail`, cleared on success); the open initiative draws it in
place of "Loading this initiative's plan…", with a Retry that loads again. `openChunkInPlan` stops early when the
load fails, leaving the error in view.

**F19 (bug).** Verified: the menu's Details sets `detailsOpen`, the form renders only once `openEffort` exists, and
only the form's close resets it. Decision: `detailsOpen` and `renamingTitle` reset whenever `openInitiative` changes.
An open rename's input commits on blur before its row collapses, so no typed title is lost.

**F21 (bug, low).** Verified: `openChunkInPlan` numbers stages over the server's list, pending deletes included
(`briefmutations.ts:245-246`); `trackerRows` numbers them without pending deletes. Decision: `RevealDeps` gains
`pendingDeletes: () => Set<string>`, and `openChunkInPlan` groups the chunks without the pending ones, as
`stepTarget` already does.

## Snapshot health, records, the pet

**F10 (unhandled).** Verified: a failed leg degrades to empty and is reported in `Sources` (`fetch.go:60-134`);
`health.missingLegs` is computed and never rendered, and counts neither efforts nor sessions; `complete` is
`runs && dossiers` (`briefingstore.ts:129`). Decision: one pure `missingLegs(sources)` in `briefingmodel.ts`, read by
both `projectBriefing` and `briefingstore`'s `complete`, naming Runs (`runs`), Records (`dossiers`) and Initiatives
(`efforts`). A band under the toolbar, built like the stale band (`data-jarvis-brief-band="partial"`, existing
tokens), says "Partial snapshot: couldn't read <legs>. Behind you stays unread until a full load." with a Retry that
calls `refreshBriefing`. The regions a missing leg feeds stop claiming absence: with Runs missing, Runs and Shipped
say they could not be read instead of "Nothing is running…" / "Nothing shipped…"; with Initiatives missing,
Initiatives says the same instead of "No initiative is active.". Sessions is left out, a deliberate departure from
the report: the Brief projects no row from the sessions leg (client-side it reads only `run`, `blocker` and
`attention` items, and drops `session` delta events), and a cold transcript scan reports it incomplete on routine
launches, so naming it would show the band with nothing missing on screen. An incomplete efforts leg now also holds
back the visit ack, since Behind you's initiative events come from it.

**F12 (unhandled).** Verified: `recordactions.ts`'s `write` sets `tasksErrorAtom`, which no component renders; worse,
`openref.ts:553` reads that atom as the record list's load error, so a failed write can later make a missing record
read as a load failure. `detachEdge` and `acceptEdge` (`recordactions.ts:134-157`) do not go through `write`: each has its own catch that
sets the same atom. Decision: one report function replaces every `tasksErrorAtom` write in the module, used by
`write` (status, decision) and by `detachEdge` / `acceptEdge` ("Couldn't detach the run" / "Couldn't attach the
run"); it reports through `briefUndo.error` ("Couldn't <what>: <reason>") and `console.error`. Every caller sits on
the Brief (peek, record band, sheet), where the toast is mounted. The
decision form stays open on failure, as now. The palette's status change (`cockpit/actions/record.ts`) can run off
the Brief, where no toast is mounted; it still logs, which is recorded here as a known limit rather than solved with
a second channel.

**F20 (bug, low).** Verified: the scroll container's `onScroll` dismisses "Where we were" (`briefsurface.tsx:917`),
and the cursor effect's `scrollIntoView` scrolls it on mount and on every cursor change. Decision: dismiss on user
input only (`onWheel`, `onTouchMove`, `onPointerDown`, `onKeyDown` on the container), not on scroll. brief-act step
10 changes with it: it closes the bubble with a wheel event, and a new step shows a programmatic scroll leaves it
open. That step moves the cursor with no key or pointer event (the list-nav controller or the cursor atom): a `j`
press with focus in the rows is user input and closes the bubble by design.
