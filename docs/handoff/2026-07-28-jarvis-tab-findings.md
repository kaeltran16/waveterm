# Jarvis tab — verification pass and findings

Driven against the live dev app over CDP at 1600×1000 on 2026-07-28 (commit `948e1bd8`). The standing
reference for the surface is [`docs/jarvis-tab.md`](../jarvis-tab.md); this is the dated record of one
verification pass, kept because the reproductions are worth more than the summary.

Findings 1–5 and 11 were fixed in the follow-up commit; each carries its resolution inline. The rest are
open. `docs/jarvis-tab.md` holds the live status table — trust that over this file for what is still true.

The fixes for findings 3, 4 and 5 were re-verified against the running app the same day by the new
`jarvis-drawer` scenario — 6/6, plus `jarvis-states` 10/10, `jarvis-fleet` 1/1, `surface-smoke` 7/7. That
scenario was itself checked by reverting the rail's mount guard, which turns its steps 1–2 red and leaves
the other four green. Findings 1 and 2 remain covered by reasoning and the unit suite only; neither has a
CDP scenario, because both need a live worker to reproduce.

## Verification table

| Check | Result |
|---|---|
| `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` | exit 0 |
| `npx vitest run` (whole frontend) | 1353 passed, 2 skipped, 0 failed |
| `npx vitest run frontend/app/view/jarvis/` | 17 files, 119 tests, all pass |
| Composition table holds per subject kind | pass — autonomy + ⚙ only on a channel; reach + absence chips only off-channel |
| Composer retargeting | pass — `Jarvis` / `Jarvis · scoped to this record` / `Jarvis · this thread`, and the channel picker on an off-channel `@run` |
| Record band cases | pass — `several` (confirmed·strong + informing·weak), `subject`, `mentions` all render as specified |
| Terminal verdicts | pass — working steps, `Weak grounding`, `Not found` + "No grounding sources." |
| Graph peek opens and closes onto an object | pass |
| Run switcher / subject filter / `+ Channel` / `+ Thread` | pass |
| "Needs you" always drawn | **fail** — finding 5 |
| Profile drawer scoping and dismissal | **fail** — findings 3 and 4 |
| Narrow layout collapses the rail | **fail** — finding 11 |
| Starting a second run in a channel from the composer | **fail** — finding 1 |

Note what the pass rate hides: 1353 unit tests were green while findings 1, 3, 4 and 5 were live. Every one
of them is a cross-atom state machine defect — a hop between atoms, not a branch inside a pure function —
which the unit suite is structurally unable to see. CDP is the only net that catches this class here, and
before this pass the only Jarvis scenarios were fixture-rendering ones.

---

## Findings

Ordered by severity as written. Every one was reproduced against the running app; the reproduction is
stated.

### 1. `＋ New run` cannot break out of the Talk face — you cannot start a second run in a live channel — high

**FIXED.** `composingRunAtom` (keyed by channel id) now forces the Launch face until the user submits or
cancels, and `＋ New run` sets it. A banner over the Launch box says the live run keeps running and offers
Cancel. `resolveActiveRunId`'s comment — the origin of the bug — was corrected.

The composer has two faces, chosen by `composerFace(run, agents)`: **Talk** when the selected run has a
live worker (`steerTarget`), **Launch** otherwise. Only the Launch face can create a run. The documented
escape hatch is the `＋ New run` button in the Talk composer's header — *"a + New run breaks back to the
Launch face"* (`channelcomposers.tsx:173`).

It did not break back. `stagecomposer.tsx:306` wired it to `onNewRun={() => setActiveRunId(channel.oid, undefined)}`,
and the Stage read the run back through `resolveActiveRunId(runs, undefined)`, which falls through to
`defaultRunId(runs)` — *"most-recent non-terminal run (so the user lands on live work)"* — re-selecting the
very run that was being steered. `composerFace` saw the same live `steerTarget`, and the composer returned
to Talk on the next render. The button was a no-op whenever it was visible, because the only condition that
renders it (a live worker) is the same condition that undid it.

Consequence: while any run in a channel was non-terminal, the channel's own composer could not start
another one. The user had to cancel or wait out the live run first.

Not reproduced live: the verification channel had no live worker, and dispatching one to prove it would run
a real worker against this repo. It followed from four reads — `stagecomposer.tsx:306`, `runmodel.ts:220-224`,
`runmodel.ts:120-128`, `composercommand.ts:61-67` — and was consistent with the observed state (all runs
terminal → Launch face, shot `01-surface-channel.png`).

Two paths **did** reach `createRun` regardless, so this was a dead end rather than a blocker:

- the command palette — `^P`, type the goal, pick `▸▸ Run` (or `↯ Quick`), which calls `createRun`
  directly and never consults the composer face;
- a record or thread subject — type `@run <goal>` and pick the channel (shot
  `10-composer-channel-picker.png`).

### 2. Demo fixture conversations ship in production — high

**FIXED.** The fixture merge in `conversationsAtom`, the `activeConversationAtom` fallback and the
`FIXTURE_STATES` branch in `selectConversation` are all gated on `import.meta.env.DEV`, so
`jarvisfixtures.ts` leaves the production bundle. `activeFixtureAtom` also became nullable with a `null`
default, so "no conversation" is no longer conflated with "the empty fixture" — which is what leaked
fixture scope chips onto records.

`jarvisfixturebar.tsx` was gated on `import.meta.env.DEV`, but the fixture **data** was not.
`conversationsAtom` unconditionally appended all eight fixtures to the Threads group, and
`activeConversationAtom` fell back to `FIXTURES[activeFixtureAtom]` whenever no real conversation was
active.

Reproduced: the Threads group held 20 rows, 8 of them fabricated — *Channel scaling — where we left
off*, *Why avoid per-run worktrees?*, *What do recent Radar findings have in common?*, *Did we decide on
a rate-limit backoff curve?*, *What is the Kafka partition count?*, *Status of the migration run*,
*About this Run*, *New conversation*. They were visually indistinguishable from real threads, and opening
one showed a fabricated grounded answer with fabricated citations and freshness badges.

A second symptom: on a record subject that had never been asked anything, the composer showed the *empty*
fixture's scope chips (`This project` / `All Wave`) rather than the record's own.

### 3. The ⚙ drawer strands the user on non-channel subjects — high

**FIXED.** `selectSubject` closes the drawer when the next subject is not a channel, and `ProfilePanel`
now dismisses on `Esc` (deferring to the graph peek, which is an overlay above it and consumes `Esc`
first). Covered by the `jarvis-drawer` CDP scenario.

`profileRailOpenAtom` was not cleared when the subject changed, but `composeStage` hides ⚙ for `dossier`
and `conversation`. So the drawer stayed open on a subject that has no control to close it, `Esc` did not
close it either, and `StageRail`'s `forceCollapsed={profileOpen}` kept **Needs you** hidden the whole
time. The only escape was to select a channel again and click ⚙.

Reproduced:

```
gear clicked on #waveterm : {gearInHeader: true,  drawerOpen: true, railVisible: false}
switched to a RECORD      : {gearInHeader: false, drawerOpen: true, railVisible: false}
switched to a THREAD      : {gearInHeader: false, drawerOpen: true, railVisible: false}
Esc with the drawer open  : drawer still open
```

### 4. The profile scope toggle latches to Global, and Save follows it — high

**FIXED.** Scope is re-derived from `channelId` at the top of the open effect
(`setScope(channelId ? "project" : "global")`) instead of only ever moving toward global. Covered by the
`jarvis-drawer` CDP scenario, which asserts the Save label across channel → thread → channel.

`ProfilePanel`'s `scope` was component state that only ever moved *toward* global: the load effect called
`setScope("global")` when `channelId` was empty, and nothing set it back when a channel returned. Because
the panel stays mounted, one glance at a record left the drawer editing global defaults for the rest of
the session — including when you went back to the channel.

Reproduced after a full reload:

```
A. fresh open on a CHANNEL        : scope=project, save="Save"
B. switch to a RECORD (no ⚙ here) : scope=global,  save="Save global defaults"
C. back to the CHANNEL            : scope=global,  save="Save global defaults"
```

The button label did change, so it was recoverable — but a user who opened the profile on a channel,
looked at a record, came back and pressed Save wrote global defaults for **all** projects while
believing they were editing that channel.

### 5. "Needs you" is absent in the app's default launch state — medium

**FIXED.** `StageRail` takes `comp: StageComposition | null` and `JarvisSurface` mounts it unconditionally.
Needs you is subject-independent (`buildRailNeeds` runs across every channel) and is now drawn on a fresh
boot; every other section is subject-derived and stays absent, per the absent-rather-than-empty rule.

Persisting the last subject — the other fix option, and the one the state model's own copy implies ("the
last subject you were on, exactly as you left it") — was **not** done. It is a separate feature with its
own design questions: a persisted subject id can name a channel, record or thread that no longer exists,
so restoring one needs validation against lists that load asynchronously and have no loaded/empty
distinction. Worth doing deliberately, not as a bolt-on.

The rail's own copy said Needs you is "always drawn and never Space-filtered — attention beats focus".
But `JarvisSurface` mounted `StageRail` only when `activeSubjectAtom` was non-null, and that atom is not
persisted, so it was null on every app launch.

Reproduced after a reload:

```
fresh boot, no subject : {emptyStage: true,  needsYou: false, railStrip: false}
after selecting one    : {emptyStage: false, needsYou: true,  railStrip: true}
```

A pending ask was therefore invisible on the surface that owns it until the user happened to click a
subject.

### 6. The `@jarvis` handoff is unreachable, and typing it dispatches a run instead — medium

**OPEN.** The atom's comment was corrected to say so — it had just been rewritten to describe the path as
working. The recommendation is deletion, not wiring: `@jarvis` is undiscoverable, and the rail's
"Summarize the fleet" button already does the same thing, so wiring it in means two paths to one action
with a booby trap on one of them. Held because it spans the agents surface.

`channelactions.ts` routes an `@jarvis <focus>` message to `pendingFleetSummaryAtom`, which `StageRail`
consumes to stream a fleet summary into the rail — the documented "`@jarvis` must not move the user off
the subject they are on" behaviour. Nothing can reach it any more.

`planMessage`'s `@jarvis` branch only fires on text handed to `sendChannelMessage`, and there are exactly
two callers. `stagecomposer.tsx` always synthesizes `` `ask @${runtime} ${body}` ``; the command
palette synthesizes `@<runtime> <goal>` or `ask @<runtime> <goal>` (its own comment: "The user never types
`@`/`ask @` — we synthesize that transport string internally"). Neither can produce a leading `@jarvis`.

The sharp edge is the fallthrough. `parseComposerCommand` only recognises `@quick`/`@run`/`@ask`, so a
draft of `@jarvis what's blocked?` returns `{mode: "run", body: "@jarvis what's blocked?"}` and
`sendOnChannel` calls `launchInto` with it — **creating a real run and dispatching a worker** whose goal is
the literal string. Not reproduced live, deliberately: confirming it would dispatch a worker against a real
repo. It follows directly from `stagecomposer.tsx`'s send path.

Mitigating: the composer hint advertises only `@quick · @run · @ask`, so `@jarvis` is not discoverable —
the trap is for anyone carrying the habit over from the old Channels surface.

### 7. The graph peek only self-focuses for a record — medium

**OPEN.** The peek's stated contract is that it "opens from an object … rather than on the whole vault", but
the focusing effect only fires for `subject?.kind === "dossier"`. Opened from a channel or a thread it shows
the entire vault — 432 nodes here — with nothing selected and the detail panel reading "Click a node to
open it." There is no search or filter in the overlay, so finding the node you came from means hunting
visually.

Reproduced: shot `03-graph-peek.png`, opened from the `#waveterm` channel.

Fix: bloom from the channel's active run (a run node already carries its own oref) and from a thread's
attached source; failing that, add a node filter to the overlay.

### 8. Two legends in the graph peek — medium

**OPEN.** `GraphPeek`'s header draws a legend (`task run decision memory`, lowercase, dot + label) and the
embedded `JarvisGraph` draws its own in the bottom-left (`Task Decision Memory Run`, title case, different
order). Same information, twice, inconsistently. Visible in `03-graph-peek.png`. Drop one — the header's,
since the canvas legend sits with the thing it labels.

### 9. Composer draft and channel picker are global, not per-subject — medium

**OPEN.** `recordBandOpenAtom` and `activeRunIdAtom` are keyed by subject id precisely so "switching subjects
returns each one to the state it was in". `jarvisDraftAtom` is a single string, and the channel picker's
`picking` flag is `useState` on a component that never unmounts. Switching threads therefore carries a
half-typed question — and an open "Dispatch into which channel?" prompt — into the next subject.

Reproduced: typed `@run tighten the record band copy` on one thread, switched subject twice; the draft and
the open picker followed.

Fix: key `jarvisDraftAtom` by subject id like its siblings, and clear `picking` when the subject changes.

### 10. The record fleet line overflows the rail — medium

**OPEN.** `countsLine` for a record subject is `"N working · across M channels"` inside a `whitespace-nowrap`
span that also shares its row with the `Fleet · on this record` title. At the rail's fixed 300px it runs off
the edge.

Measured on a record subject at a 1600px viewport: the span is 165px wide and its right edge lands at
x=1637 — 37px past the viewport, clipped to "…across 0 ch". Visible in `05-record-subject.png`.

Fix: let the title wrap or truncate, or shorten the record variant (`0 working · 0 channels`).

### 11. `GroundingRail` is dead code, and the `narrow` fixture no longer does anything — low

**PARTLY FIXED.** `GroundingRail` and `groundingRailOpenAtom` are deleted; the fixture bar now drives
`stageRailOpenAtom`, so the `narrow` fixture collapses the rail that actually exists. The **genuine**
narrow-window rule — collapsing the rail below some viewport width, rather than only when a dev fixture
asks — is still missing.

After the consolidation the rail is built from `groundingSection()` inside `StageRail`'s single
`CollapsibleRail`, which is driven by `stageRailOpenAtom`. The exported `GroundingRail` component
(`groundingrail.tsx:88`) had **zero callers**, and `groundingRailOpenAtom` was read only by that dead
component while still being written by the dev fixture bar.

Consequence: clicking the `narrow` fixture collapsed nothing. Reproduced at 900×780 — the rail stayed fully
expanded and the Stage was squeezed to roughly 250px of readable text, which is also the state a genuinely
narrow window lands in.

### 12. The Subjects column is unbounded — low

**OPEN.** 18 records and 20 threads render as one flat scroll with no cap, no "show more", no recency
grouping and no delete or archive. Every ask that starts a new conversation adds a permanent row: four
distinct questions occupied 12 rows because each was asked 2–3 times. (8 of the 20 threads were fixtures —
finding 2 — so the real count is lower, but the unbounded growth is real.)

Fix: at minimum a delete/archive action per thread; ideally collapse the older tail behind a count the
way the run list does.

### 13. `projectNameFor` picks an arbitrary winner on a path collision — low

**OPEN — bad data, not a defect.** `Object.entries(projects).find(...)` returns the first project whose path
matches, with no tie-break. The dev config registers two projects at the same path:

```json
{ "rw-test-checkpoint": { "path": "C:/Users/kael02/IdeaProjects/waveterm" },
  "waveterm":           { "path": "C:/Users/kael02/IdeaProjects/waveterm" } }
```

so the channel named `waveterm` is filed under the group header **RW-TEST-CHECKPOINT** (visible in every
screenshot from this pass). The resolution is silent and non-deterministic in ordering.

The suggested fix in the original write-up — prefer an exact name match — is worse than the disease: it
adds a special case to paper over duplicate registration. Validate at registration or dedupe the config.
