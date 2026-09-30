# Ctrl+P: actions on every thing — design

Status: design settled 2026-09-30; open questions resolved against the code 2026-09-30.

## Problem

The universal search (`frontend/app/cockpit/command-palette.tsx`) finds things and opens them, starts a goal
from typed text, and lists whichever keybindings the current surface has registered. Almost everything the
app can *do to* a thing — cancel a run, answer an ask, change a run's workers, stop a session — is an inline
`onClick` on the view that renders that thing. Nothing names those actions, so the palette cannot list them,
and each feature that adds a button widens the gap. The symptom that started this: there is no way to open
the full New run window from Ctrl+P off the Jarvis surface, and typing "new run" in All starts a Quick run
*named* "new run" because nothing matches it.

## The mockup is the visual spec

`.superpowers/design/palette-actions/project/` (gitignored, local; served by the `design-local` skill).
`Main.dc.html` draws seven states: open, search All, narrow with a prefix, a run's actions, narrow to actions,
Needs you, type a goal. `ScopeRow.dc.html` option F is the chosen scope row. This document does not restate
layout, sizes or copy — the canvas carries them. It records what the canvas cannot: where rows come from,
when an action applies, and the key and parsing rules.

## Decisions

1. **Every row that is a thing has actions.** → (ArrowRight) on the selected row opens its action list in
   place, as a drill (`Run › <title>` chip, the existing drill pattern). → acts only when the caret is at the
   end of the query; otherwise it moves the caret as it does today. ← or Backspace on an empty action filter
   returns to the results with the previous query and selection restored. Enter keeps each row's current
   main action.
2. **Verb-first rows.** An action's label is searchable against every thing it currently applies to:
   "cancel" lists `Cancel run · <run>` once per cancellable run, across projects. They rank in All (as an
   `action` kind, capped like every other kind) and are the content of the Commands scope alongside the
   registry commands. Ranking them in All is what stops "cancel" falling through to the goal block, where
   Enter would start a Quick run named "cancel".
3. **Every scope has a typed prefix**, `n: g: a: r: s: re: p: f: c:`, recognized only as the first
   characters of an empty All query (`typeQuery` in `palette-scope.ts` already does this for sigils). The
   rule is "letters that start exactly one scope label, then `:`"; `r:` resolves to Runs (more frequent than
   Records, which takes `re:`). A prefix followed by `\` or `/` stays text, so a pasted `c:\path` is not
   Commands. The old sigils `@ / # >` keep working and are not shown.
4. **Scope row, option F.** Tabs carry labels only. The empty All placeholder names the prefixes; a scope
   reached by Tab or click says in its placeholder which prefix would have reached it; a lone typed letter
   that starts a scope shows a ghost `: narrows to <Scope>`; a narrowed scope shows as a token in the box.
5. **Needs you scope.** Its rows are `attentionAtom` (`view/agents/attentionstore.ts`, polled every 10s
   from `GetAttentionCommand`, cross-project, already the nav-rail badge source) minus `radar-triage`,
   which keeps its own badge. Grouping by attention kind: `ask`/`escalation` as Asks, `gate`/`dag-gate`
   as Reviews, `dag-blocked` as Blocked; an `ask` that is a doc review also goes under Reviews (see
   Resolved). Kinds outside those three groups (`run-land-held`, `run-unverified`) show under Blocked, so
   nothing the badge counts is missing from the scope. The first three rows also lead the empty All screen.
6. **Inline answers.** When the selected Needs you row is an `ask` that resolves to a live agent in
   `model.agentsAtom` with options, its options render as rows and 1–9 answer through the same path the
   Cockpit uses (`AnswerAgentCommand` with `buildAskAnswers`, `view/agents/agents.tsx`). An ask without
   resolvable options falls back to opening the agent at its question.
7. **Start group on every surface.** New run… (`model.newRunOpenAtom`), New agent…, New initiative… are
   ordinary rows, not surface-local bindings. `jarvis:new-run` stays as Jarvis's `r` key.
8. **Goal block.** Enter = Quick, Ctrl+Enter = Orchestrate from any row of the block, and **Set up the
   run…** opens the New run window prefilled with the goal, the project and the shape. `NewRunPrefill`
   (`view/jarvis/newrun.ts`) is generalized: shape becomes a field and prototype becomes optional
   (today `prefillToLaunch` forces orchestrator because its only caller is a canvas's Build this…).
   A successful start opens the run (`openTarget` with its `runId`), as the New run window does, instead of
   only switching to Jarvis.

## The action registry

The one new piece of structure. Pure definitions, one module per thing kind, under
`frontend/app/cockpit/actions/`:

```ts
interface ThingAction<T> {
    id: string;                        // "run:cancel"
    label: string;                     // "Cancel run" — also the verb-search text
    group: "open" | "steer" | "stop";  // the action list's sections
    applies: (thing: T) => boolean;    // pure; copied from the view that owns the button today
    run: (thing: T, deps: ActionDeps) => void | Promise<void>;
    destructive?: boolean;             // red; the handler owns its confirm, as confirmCancelRun does
}
```

- **`applies` is copied from the view's own condition, never re-invented.** Where the view's condition is
  inline JSX, it is extracted into the view's pure model file and both call it. That extraction is what
  keeps the palette and the button from disagreeing about when an action exists.
- **`run` calls the handler the view already calls.** Most exist as exported functions:
  `confirmCancelRun`, `stopRunWorker`, `resumeRun`, `endFinalStage` (`view/agents/runactions.ts`);
  `dagAction` (`leadcardactions.ts`, e.g. `relaunch-lead`); `openRunDag` (`runrailsections.tsx`);
  `openDiff` + `diffScopeOfRun` (`agentdiffnav.ts`); `jumpToAgent` (`channelsprimitives.tsx`);
  `driveAgent` + `NUDGE_INPUT`, `confirmCloseSession` (`agentactions.ts`); `runSessionPrimary`
  (`sessionsdetail.tsx`); `workOnInitiative` (`initiativeworkaction.ts`); `openTarget`/`openAddress`
  (`jarvis/openref.ts`). Inline ones are extracted to a function first: the lead card's worker-count save
  (`SetRunSettingsCommand` with `settingsChangePayload`, `leadcard.tsx`) and the run header's steer send
  (`runbody.tsx`).
- **Views keep their buttons.** Migrating every view to render from the registry is not part of this
  work: the handler and the availability predicate are shared, which is the drift that matters; labels
  may differ between a button and its palette row.
- **"Not now" line.** An action list names the actions of that kind that do not currently apply, so a
  missing action reads as unavailable rather than nonexistent.

### v1 inventory

Only actions that already exist as a button somewhere; availability is whatever that button checks.

| Kind | Actions |
|---|---|
| Run | Open in Jarvis · Open the DAG · Open the diff · Open the lead's terminal · Message the lead · Workers at once · Relaunch the lead · Focus the cockpit on it · Stop a worker… · Cancel run · Resume · End final stage |
| Agent | Open terminal · Answer (asking) · Review changes · Nudge (continue) · Interrupt · Compact · Clear · Background / dismiss · Focus the cockpit on it · Close |
| Session | Resume · Open in Sessions · Stop |
| Record | Open · Change status · Focus on it |
| Initiative | Open · Work on it / go to its agent |
| Project | Switch to it · New run in it · Run defaults · Remove |

A drill that needs input (Workers at once, Stop a worker…, Message the lead, Change status) opens a second
drill level or an inline field in the palette; it never opens the owning surface just to type there.

## Data the palette needs that it does not load today

- **Projects before Jarvis has mounted.** Only `briefsurface.tsx` calls `loadChannels`, so a palette
  opened first thing on Cockpit has no project: no launch rows, empty Projects and Runs, "No project to
  search" in Files. The palette calls `primeChannels` on open, as `NewRunModalHost` does, and falls back to
  the last-picked or only project when none is active.
- **Runs in every project.** `activeChannelRunsAtom` holds the active project's runs only, and there is no
  cross-project run list RPC. v1 fans out `GetChannelRunsCommand` per channel on palette open, which is
  what `wsh runs` does (`cmd/wsh/cmd/wshcmd-runs.go`). A single list RPC is added only if the fan-out is
  measurably slow.

## Out of scope

- Radar findings in Needs you or as a palette scope (they have their own badge).
- Actions on files and canvases.
- Rendering view buttons from the registry.
- Rebindable palette keys.

## Resolved (were open)

- **Doc reviews are already attention items.** A lead's spec or plan review is an ordinary ask under a
  known header (`docreview.ts`, `DOC_REVIEW_HEADERS`), so it reaches `GetAttentionCommand` as an `ask` item
  like any other; `docReviewAtom` only holds which agent's review dialog is open. No server change. A
  Needs you `ask` row whose resolved agent's ask passes `parseDocReview` groups under **Reviews** (not
  Asks), and Enter opens that agent and sets `docReviewAtom` to it, as the Agent surface's Review binding
  does; it gets no inline 1–9 options.
- **Channel-less agents' asks resolve.** An ask item's key is `ask:<block oref>` (`ask:block:<oid>`,
  `pkg/jarvis/attention.go`, standalone or not), and every `model.agentsAtom` entry carries its `blockId`, so
  an ask resolves to its agent by `blockId` whatever its channel. An ask whose block is not in
  `agentsAtom` falls back to opening the agent at its question (decision 6).

## Verification

- Pure modules with tests beside them: prefix parsing and ghost-hint rules (`palette-scope.ts`), action
  `applies` predicates per kind, verb-row expansion and ranking against the name floor
  (`palette-groups.ts`), Needs you grouping from attention items, prefill generalization (`newrun.ts`).
- A `verify:ui` scenario (`scripts/cdp/scenarios.mjs`) that opens the palette, types `r:`, selects a run,
  presses →, and asserts the action list; and one that types a goal and fires Ctrl+Enter against fixtures.
