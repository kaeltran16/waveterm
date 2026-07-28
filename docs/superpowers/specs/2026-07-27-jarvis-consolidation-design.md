# Jarvis consolidation — design

- **Date:** 2026-07-27
- **Status:** Awaiting review
- **Design source:** `wave-handoff/wave/project/Wave-jarvis-consolidated.dc.html` — revision 2, 13 live states (Claude Design project `wave`)
- **Briefs:** `docs/superpowers/briefs/2026-07-27-jarvis-consolidation-ui-design-brief.md`, `…-design-addendum.md`
- **Supersedes visually:** `Wave-channels-merged.dc.html`, `Wave-jarvis-second-brain.dc.html`, `Wave-jarvis-presence.dc.html`

## 1. What this changes

Four nav-rail entries — Jarvis, Channels, Graph, Tasks — become one. The nav rail goes from 11 entries
to 8. Memory stays a separate entry.

This is not a re-skin. It restores invariant 8 of the second-brain meta spec, which mandates
"*a* first-class Jarvis surface" — singular. U2 (Tasks) and U3 (Graph) each added a nav entry
incidentally, and U3's placement was chosen only to avoid disturbing the existing `Ctrl+1..8` chords.
The result is one entity spread across four destinations, with the roster, the autonomy control, the
grounding treatment and the left column each built twice.

Two pains drive it, in the user's words: navigation cost, and duplicated UI and code.

**The failure mode this must avoid:** a `Runs │ Recall │ Tasks │ Graph` sub-tab switch inside one
surface. That shortens the nav rail and moves every hop one level inward, changing nothing. Success is
measured in hops eliminated, not nav entries removed.

## 2. Today

| Nav entry | Component | Lines | Left column | Right rail |
|---|---|---|---|---|
| Channels | `channelssurface.tsx` | 471 | `ChannelRail` 244px | `ContextPanel` (`CollapsibleRail`) |
| Jarvis | `jarvissurface.tsx` | 62 | `HistoryRail` 240px | `GroundingRail` (`CollapsibleRail`) |
| Tasks | `taskssurface.tsx` | 87 | dossier list 280px | — |
| Graph | `jarvisgraphsurface.tsx` | 38 | — | — |

Measured duplication:

- Three near-identical left columns at 244 / 240 / 280px.
- Two instances of the same `CollapsibleRail` (`frontend/app/element/collapsiblerail.tsx`), one per surface.
- `fleetmode.tsx` (196 lines) reads the same `activeChannelIdAtom` / `activeChannelAtom` and calls the
  same `buildFleetSnapshot` / `fleetCounts` / `fleetCostUsd` / `tierFromMeta` helpers that
  `ContextPanel`'s "Fleet here" section already uses.
- `jarvisgraph.tsx` (578) is a fork of `memgraph.tsx`; Memory keeps its own Graph│List toggle.
- `channelactions.ts:115-117` — the `@jarvis` handoff sets `pendingFleetSummaryAtom`, flips
  `jarvisModeAtom`, and writes `model.surfaceAtom = "jarvis"`. A cross-tab hop that exists **only
  because** the pieces are separate tabs.

## 3. The one surface

Three regions, left to right. Names are the design's and are used throughout this spec.

```
nav 78px │ Subjects 272px │ Stage (flex) │ Context rail 300/44px
```

**Stage** is four stacked bands, in order: header, record band, thread, composer. Every subject kind
renders all four or explicitly omits a band. Nothing is greyed out and parked.

The Stage's thread region **never swaps out**. The record expands above it, the graph floats over it,
the composer retargets in place. That property is what distinguishes this from sub-tabs and is the
single most important thing to preserve under later change.

## 4. The subject model

The Subjects column holds three kinds of thing, one flat list, grouped:

| Kind | Mark | Backing | Groups |
|---|---|---|---|
| Channel | `#` | `waveobj.Channel` | by project |
| Dossier | `▤` | `SpaceSummary` / `DossierDetail` | "Records · dossiers" |
| Conversation | `~` | `JarvisConversation` | "Threads" |

A channel row expands to its runs when selected. A dossier row expands to its attributed runs.

Introducing dossiers as a selectable subject is a **decision taken during design review**: the old Tasks
surface was a browsable list of every dossier, and dropping it would have made "show me my open tasks"
impossible. It is kept, as a subject group rather than a destination.

### Stage composition by subject kind

| Band / control | Channel | Dossier | Conversation |
|---|---|---|---|
| Header mark + title | `#` name · run | `▤` id + objective | `~` title · turn count |
| Autonomy ladder | yes | no | no |
| ⚙ profile drawer | yes | no | no |
| Grounding-reach text | no | "this record + its runs" | "all projects" |
| Absence chip | no | "Record · not a run" | "No channel · no fleet · no profile" |
| Record band | 0/1/N attributed | the subject itself, always open | "Mentioned here" (cited dossiers) |
| Phase pipeline strip | yes | no ("a record does not run") | no |
| Thread | run transcript + Jarvis turns | record activity | turn list |
| Composer target | live worker, or Jarvis | Jarvis scoped to record | Jarvis, this thread |
| Rail: Needs you | yes | yes | yes |
| Rail: Grounding | on answer | on answer | yes |
| Rail: Fleet | "Fleet" | "Fleet · on this record" | absent |

"Absent rather than empty" is the rule: a conversation has no workers, so the Fleet section is not
rendered at all rather than rendered with a zero.

## 5. The record band

A run has **zero or more** attributed dossiers. `ambient.ts` `tagsFor()` returns a list, each edge
carrying a confidence bucket (`weak | medium | strong`) and a state (`informing | confirmed`).

| Case | Collapsed band |
|---|---|
| **Zero** | "No record attributed to this run" + *Attach a record* / *Create one from this run* |
| **One** | id, objective, status pill, edge chip (`confirmed · strong` with a matching line-weight swatch), attributed-run count, *Expand ⌄* |
| **Several** | one chip per edge, each with its own state, confidence, and line style — solid/dashed/dotted by strength |
| **Conversation** | "Mentioned here" + dotted chips, captioned "a conversation carries no attribution of its own" |
| **Dossier subject** | always open; CTA reads "the subject itself" |

Expanding a multi-record band opens the strongest edge in full and leaves the others as one-line rows
beneath it. **The band never becomes a tab strip.**

The zero case is ordinary, not an edge case: attribution is inferred, and `ambient.ts` is explicit that an
object with no attribution yields nothing. The design's copy calls it "the most common case today" —
that ranking is unverified and should not be rendered as a claim in the UI; the band states the absence
plainly without editorialising about frequency.

Encoding edge state and confidence on the *collapsed* line is required, not decorative: without it a
weak inferred link is visually identical to a confirmed one, and the whole attribution model becomes
untrustworthy at a glance.

The expanded panel keeps what `taskdetail.tsx` renders today: machine-maintained acceptance / blockers /
refs index (read-only, 🔒), human notes (editable), append-only decision log, status segmented control
with confirmation on the terminal `Done` transition, and the attributed-run cards.

## 6. The thread

Two renderers exist and are structurally different:

- `runbody.tsx` (563) — run-scoped live machinery: liveness clock, per-worker transcript streams, phase
  rail, gate/ask/blocked/ship/cancel cards. Already interleaves Jarvis content: `AmbientTags`,
  `RelevantDecisions`, `ProactiveCard`, `AskJarvisButton`.
- `conversationview.tsx` (102) — a pure turn list over the `JarvisTurn` union.

The union already exists in `jarviscontract.ts`. What is missing is a **shareable renderer**: `Answer`,
`WorkingSteps` and `UserTurn` are module-local functions in `conversationview.tsx`, not exports. The
design requires a full Jarvis answer — working steps, segments with `[n]` citations, and the
`answered | weak | notfound` terminal — to arrive *inside a run's thread* while the run keeps running.

Work required:

1. Extract `Answer` / `WorkingSteps` / `UserTurn` into `jarvisturn.tsx`, rendered by both.
2. Add a per-subject list of Jarvis turns so a channel run can carry them alongside worker output.
3. Keep `ConversationView`'s empty state and max-width column behaviour unchanged.

This is a component extraction plus a store addition — not a rewrite of `RunBody` around a new union.

## 7. Composer

One composer. It retargets in place and states its target above the input ("Talking to …"), with the
chip colour carrying the distinction: **green = a worker hears you, indigo = Jarvis does.**

Commands stay as they are: `@run` (full strategy), `@quick` (one worker), `@ask` (consult, no worker),
`@jarvis` (fleet summary). `composerFace()` and `parseComposerCommand()` are reused.

Two behaviour changes:

- **`@jarvis` no longer navigates.** It posts a fleet summary into the current thread. The
  `pendingFleetSummaryAtom` + `jarvisModeAtom` + `surfaceAtom` handoff in `channelactions.ts:115-117`
  is deleted — the reason it existed is gone.
- On a conversation or dossier subject, `@run` / `@quick` open a **channel picker** rather than failing,
  because there is no channel in scope. From a dossier the created run is pre-attributed to it.

## 8. Graph peek

An overlay over the Stage, not a destination. Opens from an object (header *Graph* button, or "Peek in
graph" on a grounding card), closes on `Esc` or by opening something — the side panel's actions are
*Open run on the Stage*, *Open record*, *Ask Jarvis about this node*.

`jarvisgraphstore.ts` already provides what this needs: `loadGraph()` (5s-bounded `VaultGraphCommand`),
`selectNode()`, and `focusDossier()` with a cached per-dossier attribution bloom. The graph nav entry is
removed; `jarvisgraph.tsx` is retained as the renderer. Memory's own graph is untouched.

## 9. Autonomy control

The tier ladder is **three nested rungs**, not a toggle. Per `pkg/jarvis/resolve.go:32`, `delegator`
implies `gatekeeper`; anything unknown falls to the floor (`concierge`).

Rendered as three rungs with accumulating fill, so it reads as accumulation rather than as three
alternatives. Copy states the nesting: "Gatekeeper — implies Concierge, and answers routine asks
itself. Real forks still escalate."

The dispatch mode (`report | manage | fanout`, `MetaKey_DelegatorMode`) appears **only at Delegator**,
the only tier it can mean anything for. Both write through the existing `SetChannelTierCommand`.
Per-playbook overrides stay in the ⚙ drawer (`profilepanel.tsx`).

## 10. Needs-you badge

`navrail.tsx:64` carries two **disjoint** counts today: `channelPendingAskCount` on Channels and
`standalonePendingAskCount` on Cockpit. Merging Channels away leaves the channel-dispatched count
without a home.

`channelPendingAskCount` moves to the Jarvis entry. **The Cockpit badge is unchanged, and the two stay
disjoint** — every pending ask is counted exactly once, on exactly one entry.

This deliberately departs from the design, whose tooltip reads "3 need you — 2 from channel workers, 1
from a standalone agent", implying both counts merge onto Jarvis. Since the Cockpit badge also survives,
that would count standalone asks twice and inflate the total the user is asked to trust. Jarvis's tooltip
names only what its own badge covers.

A blocked worker must remain visible from every other surface. This is the mechanism that guarantees it.

## 11. Space focus

Unchanged in behaviour, extended in reach. `filterChannelsBySpace` + `spaceRevealAtom` +
`spaceBannerText` already scope the channel list; they now scope the whole Subjects column, with the
in-column banner and its "Show all · N hidden" escape hatch.

**Needs you is never filtered.** An ask from a channel outside the active Space still appears in the
rail, tagged "outside focus". This is load-bearing: attention beats focus.

## 12. Narrow window

`CollapsibleRail` already supports every state needed (300/44px, `forceCollapsed`, `hideWhenCollapsed`,
`extraIcons`). Collapse order:

1. Context rail → 44px strip, sections keep their counts as vertical labels.
2. Subjects column → status dots (green per working channel, amber pulse per asking one); hover overlays.
3. Record band → its one-line chip; expanding at this width **overlays** the thread rather than pushing it.
4. Nav rail → icons only, 78 → 56px. Last chrome to give ground.
5. **Never: the thread and the composer.**

Rule 5 is a hard constraint, not a preference. `cockpitshell.tsx` keeps `AgentSurface` mounted precisely
because re-fitting xterm at a stale size mangles the TUI; tearing down a live transcript to make room
would reintroduce that class of bug.

## 13. Entry points

Every existing handoff must land somewhere visible. None may dead-end.

| From | Lands as |
|---|---|
| Nav rail click | Last subject, as left — thread scrolled, record band in the same state |
| `Ctrl+P` → Ask Jarvis | New `~` thread in Subjects, on the Stage, composer targeted at Jarvis |
| "Ask Jarvis about this" (memory / run / radar finding) | Same, with the object pre-attached as grounding source 1 and a suggested prompt |
| `@jarvis <focus>` | Nothing navigates — summary posts into the current thread |
| Radar finding → investigation | Drafted-run card atop the channel thread, composer pre-filled `@run`, nothing dispatched until *Start run* (`pendingRunDraftAtom`) |
| "Open run" deep link | Channel selected, run on the Stage, record band attached (`pendingRunFocusAtom`) |
| App-bar Space chip → Open dossier | Record band expands in place; the task never becomes a destination |

## 14. Nav, chords, deletions

**`SurfaceKey`** (`agents.tsx:29`): remove `channels`, `graph`, `tasks`. Nine keys remain including
`settings`.

**`SURFACE_ORDER`** (`agents.tsx:44`): 11 → 8 — `cockpit, jarvis, agent, radar, sessions, files,
memory, usage`. `SURFACE_ORDER.slice(0, 8)` in `bindings.ts:70` then binds `Ctrl+1..8` to exactly the
eight visible entries, with no unchorded remainder. This is strictly better than today, where
Graph/Tasks/Usage are unreachable by chord.

**`GO_TARGETS`** (`bindings.ts:28`): `c` currently maps to `channels`. Retarget it to the merged Jarvis
surface — `g c` keeps working for the same intent, and `j` is free if a second letter is wanted later.

**`ESC_HOME_SURFACES`** (`bindings.ts:44`): replace `channels` with `jarvis`.

**Deleted:** `channelssurface.tsx`, `jarvissurface.tsx`, `taskssurface.tsx`, `jarvisgraphsurface.tsx`,
`fleetmode.tsx`, `historyrail.tsx`, `jarvisModeAtom`, the `pendingFleetSummaryAtom` handoff. Also the
`SURFACE_LABEL` harness gap for graph/tasks noted in the 2026-07-27 verification handoff — those keys
stop existing.

**Retained and reused:** `ChannelRail` internals (project grouping, context menus, rename/archive),
`RunBody`, `runcards`, `channelchrome`, `channelcomposers`, `ContextPanel` sections, `GroundingRail`
sections, `taskdetail.tsx`, `decisionlog.tsx`, `profilepanel.tsx`, `jarvisgraph.tsx`,
`CollapsibleRail`, all channel/task/graph stores.

## 15. Data and RPC

Nothing new on the wire for the core merge. Three derivations are new:

1. **"Mentioned here"** — a conversation's cited sources filtered to those that are dossiers.
   `ambient.ts:106` already performs the "a link to a non-dossier note is not attribution" check; reuse
   that predicate over `GroundingCard.navTarget`.
2. **"Fleet · on this record · across N channels"** — a dossier → attributed runs → workers rollup that
   crosses channels. Attribution gives dossier → run ORefs; workers are per-run. New aggregation over
   existing data.
3. **Record-band edge display** — `bucket` and `state` are already on `AmbientTag`; they are simply not
   surfaced on a collapsed row today.

## 16. Resolved during review

- **The header's grounding-reach chip is static text, not a control.** The design drew
  "Grounded in: all projects ▾" with a caret. `JarvisScope.chips` are rendered today as non-interactive
  spans in `composer.tsx:29` — a statement of reach, exactly as the design's own tooltip says. The caret
  is dropped: Spaces already own scoping, and a second scope control would be two sources of truth for
  one thing.

## 17. Non-goals

- **Memory is not merged.** It is a fifth view of the same vault and the overlap is real, but it stays a
  separate nav entry with its own graph. This merge must not make that overlap worse.
- No second command palette; `Ctrl+P` stays the only global entry.
- No new global shortcut.
- No permanent assistant panel on every surface.
- Light mode is permanently out of scope.
- No re-litigation of the ask/answer transport (`agentask/encode.go` keystroke injection, multi-answer
  server gate).
- The Jarvis "acceptance drift" proactive card on the dossier Stage is **in the design but is new
  behaviour, not consolidation.** Flagged for the plan to schedule last or defer.

## 18. Testing

Existing derivation tests must keep passing: `channelderive`, `channelmessages`, `composercommand`,
`tasksderive`, `jarvisgraphderive`, `ambient`, `spacescope`, `palette-*`, `matcher`/`store` keybindings.

New unit coverage, on pure functions only:

- Subject-list construction: three kinds, grouping, Space filtering, reveal escape hatch.
- Stage composition per subject kind — the §4 table as a table-driven test. This is the spec's core
  claim; it must fail if a band appears on the wrong subject.
- Record-band case selection for 0 / 1 / N, and edge → line-style mapping.
- "Mentioned here" derivation, including the non-dossier-link rejection.
- Needs-you counts stay disjoint: Jarvis covers channel-dispatched asks, Cockpit covers standalone, and
  no ask is counted on both. The Space filter is *not* applied to either.
- `SURFACE_ORDER` length 8 and chord coverage — a guard against a future entry silently going unchorded.

Per the standing decision recorded in `surface-render-tests-declined`, there are **no jsdom render or
snapshot tests for surfaces.** Rendering is verified over CDP: extend `scripts/cdp/scenarios.mjs` with
scenarios for each subject kind, the three record-band cases, graph peek open/close, and the narrow
collapse order. `task verify:ui` must pass.

Typecheck with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline is clean).

## 19. Risks

- **Largest single risk: the merged surface becomes a 1,500-line component.** `channelssurface.tsx` is
  already 471 lines and gains two more subject kinds. The Stage must decompose by band (header, record
  band, thread, composer) with subject-kind dispatch at the top, not by conditionals threaded through
  one render.
- Per-channel atoms exist because the surface unmounts on nav switch (`surfaces-unmount-on-nav-switch`).
  The merged surface still unmounts; per-subject state must stay in module-scope atoms keyed by subject.
- Deleting three `SurfaceKey`s breaks `cockpitshell.tsx` until the merged surface exists. The nav
  reduction is not independently landable — it goes in the same change.
- Editing frontend modules while `task dev` runs can blank the page (`hmr-blank-after-git-mv`); a full
  reload is needed before trusting a CDP verification.

## 20. Suggested phasing

For `writing-plans` to decompose. Ordering is chosen so every step leaves a working app.

1. **Shared renderer.** Extract `jarvisturn.tsx`; `ConversationView` renders it. No behaviour change.
2. **Subjects column.** Generalise `ChannelRail` to three subject kinds behind a subject union, still
   inside the existing Channels surface.
3. **The Stage.** Band decomposition + subject-kind dispatch; conversation and dossier Stages.
4. **Record band.** All four cases; edge encoding.
5. **Rail + graph peek.** One `CollapsibleRail`, scoped Fleet section, graph as overlay.
6. **Cut over.** Delete the three `SurfaceKey`s, `SURFACE_ORDER` → 8, chords, badge merge, delete the
   four surfaces and `fleetmode`. One commit with steps 1–6.
7. **Deferred.** Acceptance-drift proactive card.
