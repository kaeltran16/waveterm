# The Jarvis tab

Reference for the consolidated Jarvis surface (`frontend/app/view/jarvis/`). This describes how the surface
behaves; [Known gaps](#known-gaps) lists where it does not yet, and the full verification pass with
reproductions is a dated record at
[`docs/handoff/2026-07-28-jarvis-tab-findings.md`](handoff/2026-07-28-jarvis-tab-findings.md).

Jarvis is the merge of three former nav destinations — **Channels**, **Graph** and **Tasks** — into one
surface. Commits `edd49430`…`948e1bd8` did the consolidation; the nav rail went from 11 entries to 8.
The graph became an overlay, a record became a subject, and a thread became a subject. Nothing that used
to be a tab is a tab any more.

Entry point: `JarvisSurface` (`jarvissurface.tsx`), nav rail item **Jarvis** (`Brain` icon), keyboard
`g` `c`.

- [1. The shell](#1-the-shell)
- [2. Subjects column](#2-subjects-column)
- [3. The Stage](#3-the-stage)
- [4. Record band](#4-record-band)
- [5. Thread renderers](#5-thread-renderers)
- [6. The composer](#6-the-composer)
- [7. Context rail](#7-context-rail)
- [8. Autonomy ladder](#8-autonomy-ladder)
- [9. Profile drawer](#9-profile-drawer)
- [10. Graph peek](#10-graph-peek)
- [11. Grounding, citations, freshness](#11-grounding-citations-freshness)
- [12. Entry points from other surfaces](#12-entry-points-from-other-surfaces)
- [13. Keyboard](#13-keyboard)
- [14. State and persistence](#14-state-and-persistence)
- [15. Dev fixtures](#15-dev-fixtures)
- [Known gaps](#known-gaps)

---

## 1. The shell

Three columns: **Subjects** (272px, fixed) · **Stage** (flex) · **context rail** (300px, collapsible to a
44px strip). The rail is always mounted; what it *contains* depends on the subject.

![The Jarvis surface on a channel subject](images/jarvis-tab/01-surface-channel.png)

A **subject** is one of three kinds, and the kind decides everything the Stage draws
(`stagecompose.ts` — one table, so a control cannot drift onto a subject that cannot have it):

| | `channel` `#` | `dossier` `▤` | `conversation` `~` |
|---|---|---|---|
| Autonomy ladder | yes | — | — |
| Profile ⚙ | yes | — | — |
| "Grounded in" chip | — | this record + its runs | all projects |
| Absence chip | — | `Record · not a run` | `No channel · no fleet · no profile` |
| Record band | attributed | subject | mentions |
| Pipeline | yes | — | — |
| Thread | run | record | turns |
| Composer target | worker-or-jarvis | jarvis-record | jarvis-thread |
| Fleet section | Fleet | Fleet · on this record | — |

The rule is **absent rather than empty**: a band a subject cannot have is not rendered, never greyed out
and parked.

With no subject selected the Stage shows its empty state, and the rail carries Needs you alone — every
other section is subject-derived, and an attention channel that waits on a click is not one.

![Empty Stage](images/jarvis-tab/14-empty-stage.png)

## 2. Subjects column

`subjectscolumn.tsx` + `subjects.ts`. One grouped list replacing ChannelRail, HistoryRail and the Tasks
list.

- **Grouping** — channels group by project name in first-seen order, then `Records · dossiers`, then
  `Threads`. A channel's project name is the registered project whose path matches `channel.projectpath`
  (separator-insensitive), else the path tail.
- **Filter** — free-text over subject labels, across all three kinds; groups that empty out disappear.
  ![Filtering subjects](images/jarvis-tab/12-subject-filter.png)
- **`+ Channel`** — pick a registered project, then name the channel (Enter creates, Esc backs out).
  ![New channel picker](images/jarvis-tab/13-new-channel-picker.png)
- **`+ Thread`** — creates an empty `all`-scope conversation and selects it.
- **Row signals** — an `asking` dot and a `N▶` working count per channel, both from the same fleet
  snapshot the rail and the nav badge use, so a lit dot and a counted ask never disagree.
- **Run switcher** — the selected channel expands inline to its runs, each with a status dot and label.
  Clicking one sets that channel's active run. This is the only run list.
- **Space scoping** — all three kinds scope together via `filterChannelsBySpace` + `scopeToRecord`.
  A Space *is* a dossier, so a scoped record list shows that one record, and a scoped thread list shows
  threads that cited it. A `SpaceBanner` reports how many subjects were hidden and offers "show all".
- **Keyboard** — `j`/`k` move a single cursor over the whole column in render order
  (`useSurfaceListNav`).

## 3. The Stage

`stage.tsx`. Four stacked regions — header, record band, thread, composer — plus the graph overlay as a
**last child sibling**, never a wrapper, so expanding a record or peeking the graph cannot unmount live
worker output.

The header (`stageheader.tsx`) carries the subject mark, title, subtitle, the `Grounded in:` reach
statement (a statement, not a picker — Spaces own scoping), the absence chip, the autonomy ladder, ⚙ and
**Graph**.

Two one-shot landings are consumed here:

- `pendingRunFocusAtom` — "open this run" from Radar or the graph peek: select the channel, then select
  the run once that channel's runs load.
- `pendingRunDraftAtom` — a Radar "start investigation" draft: move the Stage to the project's channel and
  hand the goal to the composer, which holds it under a `From Radar` banner until the user presses Start.

## 4. Record band

`recordband.ts` (pure case selection) + `recordbandview.tsx`. Docked above the thread, never a
destination. Its job is making attribution legible — a weak inferred link must not read like a confirmed
one.

Five cases:

| Case | When | Collapsed line |
|---|---|---|
| `none` | channel, no attributed record | "No record attributed to this run" + attach / create |
| `one` | channel, one edge | 🔒 task id + edge chip + "Expand the record" |
| `several` | channel, many edges | 🔒 primary chip + the others, ranked confirmed-first then strong>medium>weak |
| `subject` | dossier | 🔒 "Selected directly from Records — no run beneath it" |
| `mentions` | conversation | the dossier ids this thread cited (`mentions.ts`) |

Each edge chip draws its own line style — solid 2.5px (strong), dashed 1.5px (medium), dotted 1px (weak)
— and labels `state · bucket`. Unknown buckets rank below weak so an unrecognised value never presents as
stronger than it is.

Expanding renders `TaskDetail` in a 420px scroll region; extra edges become one-line rows beneath, each
opening that record as a subject. Expanding never produces a tab strip.

![Record band expanded over a live run](images/jarvis-tab/02-record-band-expanded.png)

## 5. Thread renderers

One thread slot, three renderers:

- **`run`** — `RunBody` (shared with the old Channels surface): phases, evidence snapshot, files touched,
  verification, ask cards.
- **`record`** — `recordthread.tsx`: runs attributed to this record, the append-only decision log, and
  any Jarvis Q&A asked about the record.
  ![Record subject](images/jarvis-tab/05-record-subject.png)
- **`turns`** — `conversationview.tsx`: alternating user turns and Jarvis answers.
  ![Thread subject](images/jarvis-tab/06-thread-subject.png)

Answers are rendered by one shared component (`jarvisturn.tsx`) wherever they appear, so a Jarvis answer
inside a run's thread looks identical to one in a recall thread. An answer carries working steps, a
terminal badge, and prose with inline citation buttons.

| Terminal | Badge |
|---|---|
| `answered` | none |
| `weak` | "Weak grounding", warning tone |
| `notfound` | "Not found", muted — an absence is not a warning |

![Working steps streaming](images/jarvis-tab/08-fixture-working.png)
![Weak-grounding verdict](images/jarvis-tab/08-fixture-weak.png)
![Not-found verdict](images/jarvis-tab/08-fixture-notfound.png)

## 6. The composer

`stagecomposer.tsx` + `composertarget.ts`. **One** composer that retargets in place rather than being
replaced. The `Talking to` line above the input is the only thing telling the user whether a keystroke
reaches a running worker or Jarvis, so its tone carries the distinction: green for a worker, accent for
Jarvis.

On a channel it has **two faces**, chosen by `composerFace(run, agents)`:

- **Talk** — the selected run has a live worker. The box addresses that worker; sending injects a
  follow-up turn (what used to be called "Steer"). `＋ New run` in its header breaks back to Launch.
- **Launch** — no live worker, or `＋ New run` was pressed. A plain goal box with the channel's run strategy
  stated underneath (`→ pipeline run · stops at a review gate · set in ⚙`) and a `Run ⏎` action.

`＋ New run` sets `composingRunAtom` (keyed by channel id), which **forces** Launch until the user submits or
presses Cancel on the banner over the box. It has to be a sticky flag rather than a cleared run id:
`resolveActiveRunId` reads `undefined` as "pick one for me" and lands back on the most-recent non-terminal
run, which is the very run being steered — so the old clear-the-id version was a no-op whenever it was
visible. A Radar draft forces the face the same way.

**Creating a run** therefore means being on the Launch face, or going around it:

| Where | Input | Result |
|---|---|---|
| channel, Launch face | bare goal | managed run using the channel's `defaultmode` + `defaultplangate` |
| channel, Launch face | `@quick <goal>` | one worker, no phases |
| channel, Launch face | `@run <goal>` | explicit managed run |
| channel, Launch face | `@ask <goal>` | one-shot consult — **no** run, lands in the rail's Consults |
| dossier / conversation | `@run …` / `@quick …` | asks which channel to dispatch into, then creates it |
| anywhere | `^P` + goal → `▸▸ Run` / `↯ Quick` | calls `createRun` directly, ignoring the composer face |

The run strategy is the channel's setting, never chosen per dispatch.

Who a keystroke reaches:

| Subject | Draft | Chip |
|---|---|---|
| channel, live worker | anything | `<worker> · run <id>` (green) — steers the worker |
| channel, live worker | `@ask …` | `Jarvis` — an explicit `@ask` beats the worker |
| channel, no worker | anything | `Jarvis` |
| dossier | anything | `Jarvis · scoped to this record` — `askAboutRecord`, one thread per record |
| conversation | anything | `Jarvis · this thread` — `submitJarvisQuery`, streamed |

Off-channel a dispatch must be **typed**: `parseComposerCommand` defaults a bare goal to `@run`, which is
right on a channel but would make every plain sentence demand a channel elsewhere.

![Channel picker for an off-channel @run](images/jarvis-tab/10-composer-channel-picker.png)

Attachments go through `useComposerAttachments`; scope chips above the box show what a contextual entry
attached.

## 7. Context rail

`stagerail.tsx`. One rail, sections present only when they have content. The rail itself is mounted
**with or without a subject** (`comp` is nullable) — everything but Needs you is subject-derived and stays
absent, but Needs you must not wait on the user selecting something.

1. **Needs you** — always drawn, **never Space-filtered**, including on a fresh boot with no subject.
   Attention beats focus: an ask in a hidden channel still surfaces, labelled `outside focus`. Built across
   every channel by `railneeds.ts`, keyed per channel so the same run id in two channels cannot collide.
   Clicking a need moves the Stage there.
2. **Consults** — channel only. Ask-mode results, with a "dispatch this" action per consult.
3. **Sources** — when the Stage's thread has answered. Grounding cards with source type, title, project,
   age and freshness; clicking one opens the source in its native surface.
4. **Fleet** — channel: `N working · M waiting · $cost`. Record: rolled up across every channel owning an
   attributed run (`fleetscope.ts`), deduped by worker oref. `Summarize the fleet` streams a Jarvis
   summary **into the rail** — an `@jarvis` typed in the composer lands here too, so the user never
   leaves the subject they are on.

## 8. Autonomy ladder

`autonomyladder.ts` + `autonomyladderview.tsx`. Channel only. Three **nested** rungs, not alternatives —
delegator implies gatekeeper implies concierge (`pkg/jarvis/resolve.go`). Rendered as accumulating fill
with a growing bar so it reads as accumulation; three separate buttons would misrepresent the backend.

| Rung | Behaviour |
|---|---|
| Concierge | watches and narrates; every ask reaches you |
| Gatekeeper | + answers routine asks itself; real forks still escalate |
| Delegator | + dispatches follow-up work without asking first |

The dispatch mode (`report` / `manage` / `fanout`) appears at Delegator only — below that tier it has
nothing to act on.

## 9. Profile drawer

`profilepanel.tsx`, opened by ⚙ in the channel header. Edits the Jarvis profile at two scopes:
**Global defaults** and **This project** (a per-channel override merged over global).

- **Playbook** — ordered run phases (`brainstorm` / `plan` / `execute` / `custom`), each with an optional
  skill, `GATE` and `FRESH-CTX` flags.
- **Principles** — injected into worker, orchestrator and quick prompts and into the Gatekeeper.
  Per-principle `override` / `disable` against the global list, with backend diagnostics.
- **Run defaults** — `pipeline` / `orchestrator`, plus the plan gate.

Each section badges `GLOBAL` or `PROJECT` with **customize** (copy the inherited section into the
editable override) and **reset to global** (drop it). Save is disabled until dirty.

The drawer shares the right-edge slot with the context rail: it has no collapsed strip of its own, and
the rail force-collapses while it is open, so the two never stack. Because of that force-collapse the
drawer must never outlive its trigger — selecting a non-channel subject closes it, and `Esc` dismisses it
(deferring to the graph peek, which sits above it and consumes `Esc` first). Scope is re-derived from the
channel on every open rather than latched, so a glance at a record cannot leave Save writing global
defaults.

![Profile drawer](images/jarvis-tab/04-profile-drawer.png)

## 10. Graph peek

`graphpeek.tsx`. An overlay over the Stage, never a destination — there is no graph entry in the nav
rail. You enter it from an object and leave it by opening one; every action closes the overlay onto
something.

- Force-directed vault graph (`jarvisgraph.tsx`, lazy `react-force-graph-2d`), node kinds task / run /
  decision / memory.
- Selecting a node shows its kind, label, status and **edges**, each drawn with its attribution style
  (dashed/width/opacity) or marked `wikilink`.
- Actions: *Open run on the Stage*, *Open record*, *Ask Jarvis about this node* (starts an
  object-scoped thread attached to that node).
- `Esc` or **Close** dismisses it.

![Graph peek](images/jarvis-tab/03-graph-peek.png)

## 11. Grounding, citations, freshness

`jarviscontract.ts` is the view-model seam; `recallderive.ts` the pure helpers.

- A Jarvis answer is a list of segments — prose interleaved with citation refs. `parseCitations` turns
  `[n]` into a citation **only** when a grounding card with that `n` exists; unknown refs stay literal
  text, so a citation is never fabricated. It re-runs on every streamed chunk.
- A grounding card carries `sourceType`, title, project, age and freshness. Freshness is
  **surfaced, not hidden**: `Fresh` (green) / `Stale` (warning) / `Unavailable` (error).
- Clicking a citation or a card calls `openORef`, a pure-classifier + side-effect pair. `channel`, `run`,
  `task` and `agent` route to their native surface; everything else is a deliberate no-op, never an error.

![Grounded answer with sources](images/jarvis-tab/07-fixture-grounded.png)

Streaming (`submitJarvisQuery`) runs at module scope under `fireAndForget` with a 130s RPC budget, so a
turn keeps accumulating even if the surface unmounts on a nav switch. A failed stream preserves what
arrived and marks the turn `weak`.

## 12. Entry points from other surfaces

`contextualentry.ts` builds a `SourceRef`, starts an `attached`-scope conversation with a suggested
prompt pre-filled, makes it the active subject, and flips to Jarvis.

| From | Chip | Suggested prompt |
|---|---|---|
| a Run | This Run | "What changed in this Run and why?" |
| a Radar finding | This finding | "Explain this Radar finding." |
| a Memory note | This memory | "Recall decisions related to this." |

![Contextual entry from a Run](images/jarvis-tab/09-fixture-contextual.png)

`openORef` is the reverse direction — a `task:` oref now has a surface for the first time, as a subject
on this Stage rather than a separate tab. The command palette also routes results here.

## 13. Keyboard

| Key | Action |
|---|---|
| `g` `c` | go to Jarvis |
| `Ctrl:2` | go to Jarvis (`SURFACE_ORDER` index 2 of 8; `Ctrl:1`–`Ctrl:8` cover every rail entry) |
| `[` / `]` | cycle the rail order |
| `j` / `k` | move the Subjects cursor |
| `1`–`9`, `Enter` | answer the shown run's asking worker (channel subjects) |
| `Esc` | close the graph peek; otherwise leave the surface for the Cockpit |
| `^P` | command palette |

## 14. State and persistence

The surface **unmounts on nav switch** (only the Agent surface stays mounted), so every survive-worthy
value is a module atom, never component state.

| Atom | Shape | Persisted |
|---|---|---|
| `activeSubjectAtom` | `{kind, id}` | no |
| `recordBandOpenAtom` | keyed **by subject id** | no |
| `activeRunIdAtom` | keyed **by subject id** | no |
| `composingRunAtom` | keyed **by channel id** | no |
| `recordScopeAtom` / `recordRunsAtom` / `recordDetailAtom` | keyed by dossier id | no |
| `recordConversationAtom` | dossier id → conversation id | no |
| `subjectFilterAtom`, `jarvisDraftAtom` | single value | no |
| `stageRailOpenAtom` | bool, default **open** | localStorage |
| `graphPeekOpenAtom`, `profileRailOpenAtom` | bool | no |
| `conversationsByIdAtom` / `persistedSummariesAtom` | conversations | backend |

Keying by subject id is deliberate: switching subjects must return each one to the state it was in.

## 15. Dev fixtures

`jarvisfixturebar.tsx` renders a row of buttons (`empty` `active` `grounded` `working` `weak` `notfound`
`stale` `contextual` `narrow`) that swap the rendered conversation without a backend. The CDP harness drives
these (`task verify:ui -- jarvis-states`).

The bar **and the fixture data** are gated on `import.meta.env.DEV`, so `jarvisfixtures.ts` leaves the
production bundle: a fabricated thread carrying fabricated citations and freshness badges is
indistinguishable from a real one, so it must not exist in a shipped build at all. `activeFixtureAtom` is
`FixtureState | null`, default `null` — "no conversation" is its own state, not the `empty` fixture, which
is what used to leak fixture scope chips onto records nobody had asked anything about.

---

## Known gaps

Open items only. Full reproductions, and the six findings closed on 2026-07-28, are in the dated record at
[`docs/handoff/2026-07-28-jarvis-tab-findings.md`](handoff/2026-07-28-jarvis-tab-findings.md).

| # | Gap | Severity |
|---|---|---|
| 6 | `@jarvis` is unreachable from the composer, and typing it falls through to `@run` — **dispatching a real worker** whose goal is the literal string. Recommendation is to delete the branch, the atom and the `StageRail` effect together; the rail's "Summarize the fleet" button already does the job. | medium |
| 7 | The graph peek only self-focuses for a record. From a channel or thread it opens on the whole vault with nothing selected and no filter. | medium |
| 8 | Two legends in the graph peek — one in `GraphPeek`'s header, one in `JarvisGraph`'s canvas, differing in case and order. | medium |
| 9 | `jarvisDraftAtom` and the channel picker's `picking` flag are global, not keyed by subject, so a half-typed draft and an open picker follow you to the next subject. | medium |
| 10 | The record variant of the rail's fleet line (`N working · across M channels`) is `whitespace-nowrap` and overflows the 300px rail. | medium |
| 11b | There is still no genuine narrow-window rule. The `narrow` fixture now collapses the rail, but a genuinely narrow window does not. | low |
| 12 | The Subjects column is unbounded — no cap, no recency grouping, no delete or archive. | low |
| 13 | `projectNameFor` picks an arbitrary winner when two projects register the same path. Bad data rather than a defect; fix by validating at registration, not by special-casing the resolver. | low |
| — | The last subject is not persisted, so a launch always lands on the empty Stage. Restoring one needs validation against subject lists that load asynchronously — a deliberate piece of work, not a bolt-on. | low |

### Verifying

Unit tests cover the pure seams (`npx vitest run frontend/app/view/jarvis/`). They cannot see this surface's
most common defect class — a bad hop *between* atoms, which is what findings 1, 3, 4 and 5 all were, live
while 1353 tests were green. For those, drive the running app:

```
task verify:ui -- jarvis-states jarvis-drawer jarvis-fleet
```

`jarvis-drawer` is the regression net for the drawer's scope and dismissal and for Needs-you-without-a-subject.
It was checked against the pre-fix code: reverting the rail's mount guard turns steps 1–2 red and nothing else,
so the scenario fails for the reason it claims to.

One gotcha when writing assertions here: rail and section headings are Tailwind `uppercase`, and `innerText`
applies `text-transform`, so the DOM reads `NEEDS YOU`. Match case-insensitively. The rail's `aria-label` is on
the `<aside>`; the button carrying that label exists only in the collapsed strip.
