# Jarvis Brief — meta spec

**Date:** 2026-09-09
**Status:** B1–B5 built. B3 wave 2 and all of B4/B5 are not yet live-verified, and the CDP suite has not been reconciled with the retired composition (see the tracking table). Design settled in the mockups. B4–B5 were built from this file directly.
**Type:** Meta spec — umbrella / decomposition index. It settles the one new cross-cutting decision this work introduces (where a record is read and where it is written) and sequences the rest. It is not an implementation plan.

**Scope.** This file sequences the replacement of the Jarvis surface's composition with the Brief. It does *not* touch the second brain's backend: A–G, S1–S3 and U1–U3 are built and stay built.

It is **not** purely a frontend re-composition, which is what an earlier draft of this line claimed. A source audit (§4b) found that three of the queue's item kinds, the live spend total, a session's held-at-gate state and resolved-gate recency have no cockpit-wide source today. The Brief is a re-composition over the same Go packages *plus* a real, enumerated set of backend reads, carried by B2.

It does not re-decide what is already settled in:

- [v1 meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — the nine cross-cutting invariants. Invariant 8 (**Presence D**) and invariant 9 (**Wave cockpit design language**) are constraints here, not suggestions.
- [Jarvis consolidation UI brief](../briefs/2026-07-27-jarvis-consolidation-ui-design-brief.md) — the decision that Jarvis is *one* surface. This file continues that work rather than reopening it.
- [v2 meta spec](2026-07-24-jarvis-second-brain-v2-meta-spec.md) — the embedding foundation and its consumers.

## What this document is

An index, and the only design document for this work. The mockup settles the design; this file settles what the mockup cannot (§2) and what must be carried (§4).

**Sub-projects do not get their own design specs.** A prose restatement of a mockup that has already been exercised is a second source of truth, and it rots. Step lists normally live as notes on the effort chunks. B3 wave 2 is the exception for implementation planning: discovering that Vault had no record destination expanded it across two surfaces, the ask wire, contextual entry, graph routing, and restore behavior. Its approved design still lives here, but it gets a plan so that cross-surface landing states cannot be half-built. B4–B5 remain direct builds from this file. Each still needs its approach approved before code — that gate is unchanged, it just costs a paragraph instead of another design document.

The tracking table at the bottom is the source of truth for what is built.

## The design artifact

The Brief design is settled and lives at **`docs/prototype/jarvis-brief-launch.dc.html`** (2,494 lines), served over HTTP and driven over CDP. The B3 Vault destination is settled separately at **`docs/prototype/jarvis-vault-records.html`**. These are not sketches: the Brief states have been exercised, and the audit that closed them is recorded in §4; the Vault artifact carries its own audit checklist.

Read the mockup before starting any sub-project. Where this file and the mockup disagree, the mockup is a *proposal* and this file is the decision — but every disagreement is a bug in one of them and should be reconciled, not worked around.

## 1. What is being replaced

The consolidation brief merged Channels, Jarvis, Graph and Tasks into one surface. That surface is three panes, assembled in `jarvissurface.tsx` (64 lines):

| Pane | File | Lines | Fate |
|---|---|---|---|
| Subjects column | `subjectscolumn.tsx` | 980 | **Retired.** ⌘K replaces browsing; nothing unbounded sits on the surface. It also holds boot subject restore and the surface's `j`/`k` nav, which must be re-homed — §4a items 8, 9. |
| Stage | `stage.tsx` | 306 | **Kept, re-homed.** Becomes the body of the right-hand work sheet, not a centre pane. |
| Stage rail | `stagerail.tsx` | 335 | **Retired,** but not cleanly: it is the sole mount of the channel profile drawer, the consults renderer, the grounding cards and the resume/proactive cards — §4a items 7, 10, 11, 12. Its bands move onto the objects that own them only where such an object exists. |

`stage.tsx` has no dependency on either the column or the rail, which is what makes this a re-composition rather than a rewrite: the Brief replaces two of three panes and the third becomes a drawer body.

`briefingview.tsx` (644 lines) is the closest existing thing to the Brief and is where B1 starts — over `briefingmodel.ts` (450 lines, 534-line test), which already projects all four of the Brief's regions from live data. B1 reshapes and extends that pair; it does not start from a blank file.

**Graph and Tasks are not separate surfaces and are not being retired.** `SURFACE_ORDER` holds nine keys and neither is among them; the consolidation already absorbed both. `GraphPeek` is mounted by `stage.tsx`, `TaskDetail` by `recordbandview.tsx`. They are components inside the surface the Brief replaces, and they get re-homed with it — the graph to ⇧G "the map", the task detail split per §2. U1's Spaces chip lives on the **Cockpit** surface (`cockpitsurface.tsx`) and is untouched.

## 2. The decision this file settles: where a record is read and where it is written

The Brief moves record *browsing* to the Vault surface. That moved ownership without drawing a line, which left five capabilities with no home. The line:

> **The record peek keeps what is live and what you set. Vault keeps history, the decision log, and every past correction.**

Concretely, on the peek:

- **What is running against this record.** Its attributed runs and its own fleet count. This is a Brief question — it is the reason you opened the record from a queue item.
- **Its status.** `SetStatus` (active / paused / completed / archived) is a triage judgement you make while reading the queue, and it changes what reaches you afterwards. It belongs where the queue is.
- **Its structural absence.** A record cannot be messaged. The peek says so rather than leaving you hunting for a composer.

And on Vault:

- The full record, its history, and its decision log.
- `AppendDossierDecision` — writing a decision with rationale and links is composition, not triage.
- Browsing, including archived.

**B3 Vault design, approved 2026-09-10.** Vault gains a fourth `records` collection using a split ledger: a searchable, keyboard-navigable index grouped by `active`, `paused`, `completed`, and `archived` on the left, and the selected record on the right. The record side shows the complete current dossier plus a record timeline: created/updated metadata and the append-only decision log, including superseded and reverted entries. “History” in this release means that record timeline, not raw vault Git revisions or a diff browser. Status is visible but read-only in Vault; the Brief peek remains the place that changes it. On a narrow window the list and detail become two explicit views with Back rather than compressing both below a usable reading width.

The implementation reuses `ListTaskDossiersCommand`, `GetDossierCommand`, `taskListAtom`, `recordDetailAtom`, `TaskDetail`, and `DecisionLog`; it adds no backend read for the Vault collection. The Brief peek’s `Open in Vault` action sets the selected record, switches to the `records` collection, and opens Vault. Palette results continue to open the bounded Brief peek first.

Everything else in `recordactions.ts` (`detachEdge` / `acceptEdge`) is already covered by the edge controls, which the Brief carries unchanged.

**Alternative considered and rejected:** put the runs band on Vault too, leaving the peek purely prose. Rejected because it splits one question across two surfaces — you would open a record from a gate to find out whether anything is still running against it, and have to leave the Brief to find out.

## 3. Cross-cutting invariants for this work

In addition to the v1 nine, which all still hold:

1. **One surface, one palette.** ⌘K is the existing `Ctrl+Shift+P` palette extended, not a second one. Invariant 8 forbids a second command palette and a new global shortcut; any new chord must come out of Jarvis's own budget.

   **Reconciled 2026-09-09.** The mockup draws its own ⌘K overlay inside the Brief, which contradicts this. The spec wins: `briefpalette.ts`'s index feeds `command-palette.tsx` as additional entry sources — records, threads and initiatives, archived included — rather than becoming a second overlay. This is the disagreement-is-a-bug case from "The design artifact" above, resolved in the spec's favour; the mockup's overlay is a drawing of what the extended palette should *contain*, not an instruction to build a new one.
2. **Nothing unbounded sits on the Brief.** Records, threads and finished sessions are reachable only through the palette. The surface shows what is waiting, what is moving, and what just happened — all three bounded.
3. **Absence is stated, never rendered as an empty frame.** A band with nothing in it says what is not there in one line. Carried from the peek brief and already honoured throughout the mockup.
4. **A mono chip is a label. If it does something, it cannot look like one.** Derived from two failures in this design cycle where a control was camouflaged among labels and users could not find it.
5. **Every count is derived.** A hand-tuned total that disagrees with the rows beneath it is a defect, not a rounding choice. The mockup has one surviving violation, listed in §6.
6. **The composer's target is never ambiguous.** `composertarget.ts`'s rule is load-bearing: a keystroke must never be able to reach a running worker when the user meant Jarvis, or the reverse.

## 4. Coverage — what the Brief must carry

Audited against `stagecompose.ts`'s table (6 subject kinds × 11 bands) and all 82 non-test modules under `view/jarvis/`. Six gaps were found and closed in the mockup:

| # | Capability | Source | Where it lands |
|---|---|---|---|
| 1 | A record's own attributed runs + per-record fleet | `recordrunrow.ts`, `recordband.ts`, `fleetscope.ts` | `Fleet · on this record` band in the record peek |
| 2 | Archived records and threads | `subjects.ts` | Searchable in ⌘K, marked, sorted last; excluded from thread resume |
| 3 | Record mutations | `recordactions.ts` | Status control in the peek; decisions to Vault (§2) |
| 4 | A thread's citation set in aggregate | `mentions.ts` | `Drew on` band, derived from answers and deduped by record |
| 5 | The record kind's structural absence | `stagecompose.ts` `absenceChip` | Dashed chip in the peek |
| 6 | **Contextual entry from another surface** | `contextualentry.tsx` | Arrival opens an attached thread with the prompt pre-filled |

Gap 6 was breaking. Five shipped call sites already say "Ask Jarvis" and hand over a source object plus a suggested prompt — `runbody.tsx:210`, `runcompletionsurface.tsx:109`, `radarfindingdetail.tsx:328`, `vaultrail.tsx:379`, `vaultreader.tsx:150`. Without a landing zone every one of them drops the user on the morning queue with the source and prompt discarded.

**Fidelity note for B3:** the mockup's per-record fleet counts sessions. The real one counts *workers*, deduped by oref across every channel that owns an attributed run — `fleetscope.ts` exists for exactly this and must be used rather than re-derived.

Verified covered without change: briefing, effort list and detail, run/session drawer, conversation turns, autonomy ladder, profile and principles, `composerTarget`/`reachText`, the attributed record band, edge controls, the record picker, the global fleet, the map, the decision log.

### 4a. Corrections from the retirement audit (2026-09-09)

A blast-radius audit of the two doomed panes found three claims above this line to be **wrong**, and five capabilities the six-gap sweep missed because it read `stagecompose.ts`'s table rather than the panes' own mounts. Recorded here rather than quietly fixed, because two of them need a decision and one is an invariant breach.

| # | Capability | Only mount / provider today | Lands in |
|---|---|---|---|
| 7 | **Per-answer grounding cards, with source freshness** | `groundingrail.tsx`; `freshnessLabel`/`freshnessClass` render nowhere else in the repo (`:50`–`:51`) | **B1** — the band, incl. `"unverified"`; **B2** — the feed. *Both landed.* |
| 8 | Boot subject restore + the once-per-launch Briefing landing | `subjectscolumn.tsx:231`–`:282`; nothing else restores a subject on boot | ~~B1~~ **no B1 work; restore half → B3** (below) |
| 9 | The surface's `j`/`k` list navigation | `subjectscolumn.tsx:342`–`:357` — the only production provider of a jarvis `ListNavController` | **B1** |
| 10 | The channel profile drawer | `stagerail.tsx:332` — the app's **only** mount of `ProfilePanel` | **B4**, and it must land *before* B5 |
| 11 | Ask-mode consult results | `ConsultsSection` (`channelcontextpanel.tsx:183`) — no other renderer | **Open, see §6** |
| 12 | Resume / proactive ambient cards | `ambientrailview.tsx:40`, `:41` — no other mount | **Open, see §6** |

Two smaller couplings, **reassigned to B5 on inspection**: the `d` key toggles `stageRailOpenAtom` (`bindings.ts:454`), and `briefingview.tsx` has four `MoreLink`s whose only action is `openRail()` (`:275`, `:370`, `:476`, `:545`). An earlier draft put both in B1, which was wrong — while the two compositions coexist behind the toggle, both behaviours are *correct* in the three-pane branch and merely unreachable in the Brief. Neither is broken until the rail is deleted, so fixing them in B1 would be churn. What **is** B1's is that the Brief's own overflow affordances need real targets, since there is no rail for them to open.

**The corrected claims, for the record.** "Resume on the pet" was wrong — the pet carries resume *data* (`ResumeCardData` through `petjoin`), not the card. "Proactive on the Agent surface" was wrong — no such mount exists. "Grounding covered without change" was wrong — the `Drew on` band is an aggregate citation list, and carries no freshness. Only "decisions in the record thread" holds: `RelevantDecisions` has two live mounts outside Jarvis (`radarfindingdetail.tsx:145`, `vaultrail.tsx:316`).

**Item 7 forced a contract change, landed in B1.** Moving freshness onto the `Drew on` band exposed that the band's only live feed cannot report it: `CommandJarvisAskRtnData.sources` is `{oref, sourcetype, title}` — no age, no project, no freshness. The first implementation resolved that by calling every routable citation `fresh`, which printed the word "Fresh" in `text-success` over a check nobody ran — the precise fabrication invariant 7 exists to prevent, on the only path that runs today. So `Freshness` gained a fourth member, `"unverified"` (`jarviscontract.ts`): the absence of a reading, rendered as the word "Unverified" in `text-muted` and deliberately kept off the success/warning/error scale, because not having checked is not a health reading. `briefdrew.ts` ranks it `fresh < unverified < stale < unavailable`, so an unverified citation reads as weaker footing than a verified-fresh one and can never mask a known-stale one. Only the ask path emits it; the recall path always carries a real reading from the wire. The band's mechanism is complete and will carry genuine `stale` readings the moment the all-work ask returns grounding cards — **which is the remaining half of item 7, and belongs to B2** with the rest of the ask/attention backend work.

**Item 7 closed in B2, and the fix was subtraction.** `jarvisrecall.Ask` already held each candidate's project, timestamp and freshness the whole way through, then discarded all three when it flattened to `JarvisConvoSourceRef` on the way out. The feed did not need building — it needed to stop being thrown away. `AskResult` and `CommandJarvisAskRtnData` now carry `[]waveobj.JarvisConvoGroundingCard`, the same card `Converse` builds through the same `buildCards`, which also keeps a second lossier definition of a source off the wire. `askGrounding()` in `briefsurface.tsx` is deleted rather than fixed. Two consequences worth recording. First, `"unverified"` survives with a *better* justification than the one it was created for: every wire freshness now enters through `recallderive.wireFreshness`, which degrades a value this build cannot interpret to `"unverified"` — without that, `briefdrew`'s `SEVERITY` would score an unknown reading `undefined`, every comparison against it would answer false, and the one reading nobody can interpret would silently rank as the mildest there is. Second, the routability override is gone: an unroutable citation is no longer relabelled `unavailable`, because "I cannot open this" and "the source is stale or gone" are different facts, and `SourceChip` already expresses the first by rendering a label instead of a button. The `memory:` navTarget is exactly that case — a fresh note with no route yet, which used to read "Unavailable" in `text-error`. `DrewChip` now prints the real age beside the word, which is the visible payoff.

**Item 8 has no B1 work, and the audit that assigned it was reading the code as it no longer behaves.** Split the item in two. The *once-per-launch Briefing landing* needs nothing: in the Brief composition the Brief **is** the briefing, so the landing is satisfied by construction. The *boot subject restore* has no destination — a stored subject is a channel, dossier or conversation on the Stage, and the Brief has no Stage. There is nothing to restore it into until the Brief grows a detail view, which is **B3**. This is the same reasoning the spec already applied to the `d` key and the `MoreLink`s: nothing is broken while both compositions coexist, because the three-pane branch still does all of this correctly, and building a Brief-side restore now would mean inventing a destination for it.

Worth recording, because it is the evidence for the split: `jarvis-subject-state` steps 9 and 10 ("the last subject is restored after a reload", "a stored subject that no longer exists degrades to the empty Stage") **fail today, on `main`, in the three-pane composition** — verified 2026-09-09, 8/11. They are not a Brief regression. The step was written 2026-07-29 (`121d043d`); the landing-Briefing feature landed 2026-08-13 (`7dcdfdd8`) and made a fresh launch land on Briefing *instead of* restoring the stored subject — `subjectscolumn.tsx` returns from the landing branch before it ever reaches `restoreDecision`. So boot restore has already been subordinate to the landing for four weeks, in the composition that owns it. Step 11 ("archiving a thread moves it into the shared Archived group") also fails, for an unrelated reason: it grabs a channel row, and this profile has zero persisted conversations. **B5 owns reconciling all three** with the rest of its scenario audit.

**Deliberately dropped, and to be recorded in `docs/deferred.md` by B5:** the subjects column, the stage-rail shell, and the ambient rail *as a container* — but not its feeds, whose disposition is now items 11 and 12 above rather than an assumed re-home.

**B5's real cost.** Around seventeen CDP scenarios in `scripts/cdp/scenarios.mjs` assert against DOM contracts only these two panes emit — `[data-jarvis-subject-kind]`, `[data-jarvis-region="subjects"]`, `aside[aria-label="Stage context"]` — plus the shared `newThread`, `resetRail` and `setRail` helpers. Four of them (`jarvis-drawer`, `jarvis-collapse-order`, `jarvis-narrow`, `jarvis-measure`) exist *only* to assert the three-pane layout and should be retired, not ported. No vitest test imports either pane, so the unit suite stays green; the break is `tsc`/`eslint` on `jarvissurface.tsx`'s unresolved imports.

### 4b. What each region can read today

Audited region by region against the live atoms, RPC commands and Go packages. This is what makes B1 buildable and what B2 must add.

| Region | Reads today | Missing |
|---|---|---|
| Waiting on you | `attentionAtom` (`attentionstore.ts:14`), 5 kinds — `gate`, `escalation`, `ask`, `dag-gate`, `dag-blocked` (`pkg/jarvis/attention.go:24`–`:32`); 10s poll, keeps last-good on failure | *All four closed in B2.* **Radar triage** — `attention.go` never referenced `reporadar`. **Plan gates** — `awaiting-plan` was absent from `BuildAttention`. **Per-task DAG gates** — rolled up to one row per group. **Ask question text** — the item's `Text` was the literal `"Waiting on your reply"` |
| Initiatives | Three live paths: `WorkState.efforts`, `EffortListCommand` (with `IncludeArchived`), `EffortGetCommand`. Progress already derived by `buildEffortCard` (`effortmodel.ts:44`) | **All reactivity** — `wshserver_effort.go` never imports `wps` and no effort event exists in `pkg/wps/wpstypes.go`, so a `wsh effort` write or a second window never updates an open view. **Workref → run resolution** — `RunCommands` has no list or get (`wshrpctypes_runs.go:12`–`:19`); only per-oref WOS pins, i.e. N+1 |
| Sessions | Fully reactive roster: `agentsAtom` (`agents.tsx:68`) ← WOS + wps `agent:status` + `agent:ask`. Per-session spend on `AgentVM.usage.costusd` | **Held-at-gate state** — `AgentState` is `asking\|working\|idle` (`agentsviewmodel.ts:7`), so a gated worker reads as `working`. **Owning channel** — no field; derived backwards by matching `channel.messages[].reforef` (`jarvisderive.ts:31`) against a snapshot refreshed only on channel mutations |
| Behind you | `WorkState.projects[].shipped` and `.delta` (`jarvisstate.go:109`, `:183`), cursored in localStorage | **Resolved gates** — the events are written (`runevent.go:15`, `:16`, `:60`, `:61`) but the only reader is scoped to one `(channelid, runid)`; `WorkState.delta` has no gate-resolution kind. Also a done-but-unsealed run appears nowhere |
| Header fleet line | Reactive per-agent spend and a reactive roster | **No atom sums spend across the roster.** The only global figure is historical, a client-side price estimate, and stops refreshing when the Usage surface unmounts (`usagesurface.tsx:520`–`:529`) |
| Palette | Commands, agents, sessions, channels, MRU | Records reachable only as "Focus on task" rows over a list the server filters to `active\|paused` (`wshserver_jarvis.go:444`); threads and efforts unreachable; archived effectively unreachable |

**The palette gap is FE-only work**, which is the one piece of luck here: `ListTaskDossiersCommand` (archived included — the server keep-fn accepts every status, `wshserver_jarvis.go:448`), `ListJarvisConversationsCommand` (archived included and flagged) and `EffortListCommand` (`IncludeArchived`) are all already generated into `wshclientapi.ts`. Gap 2 closes without touching Go.

**`briefingview.tsx` takes nothing from fixtures in production.** The seam is `briefingFixtureAtom`, gated on `import.meta.env.DEV` (`briefingstore.ts:41`), written only by the dev fixture bar. Every region above is already wired to real data — so B1 is re-composition over live reads, not new plumbing.

## 5. Decomposition

| # | Sub-project | One line | Depends on |
|---|---|---|---|
| **B1** | Brief surface | The three-region body — waiting on you, initiatives, sessions, behind you — plus the composer, thread expansion and ⌘K | — |
| **B2** | Queue composition and its missing sources | The pure queue derivation, plus the backend reads §4b found absent: radar triage and plan gates into the attention aggregate, per-task DAG gates un-rolled, ask text on the item, and ask durability | B1 |
| **B3** | Record peek and the Vault line | The runs band over `fleetscope`, the status write, the absence chip, the Vault Records collection, and the contextual-entry/map landings | B1 (v1 B, D) |
| **B4** | Profile and run reconfigure | The per-project profile sheet, standing rules, and changing a live run's shape | B1 |
| **B5** | Retirement | Delete the column and rail, re-home the stage as the sheet body, record the drops, remove `showPipeline` | B1–B4 |

**B3 wave 2 data flow, approved 2026-09-10.** `CommandJarvisAskData` gains `attachedorefs`; `jarvisrecall.ScopeArgs.AttachedORefs` is already the deterministic pinning boundary, so the widening is pass-through rather than a second retrieval path. The Brief’s launch-local draft, thread, and attached scope move from component-private atoms into its store so contextual entry can seed them before the surface mounts. `openJarvisWithSource` branches on the composition: the three-pane path keeps its persisted conversation, while the Brief path opens one attached stateless thread and sends the same orefs on every turn. `GraphPeek` mounts in the Brief and uses those same two exits: records open the Brief peek; Ask opens an attached Brief thread. Opening a run is deliberately absent in Brief mode until B5 gives runs a Stage sheet destination.

Restore is likewise composition-aware and one-shot. A stored dossier opens the Brief peek; a stored conversation hydrates the Brief thread after its object arrives; a missing target clears rather than retrying forever. A stored channel still has no Brief destination and stays B5 work. List/detail failures keep the last good Vault reading and show retry; decision-write failures leave the draft in place; attached-ask failures retain their scope and remain retryable.

**Sequencing.** B1 first and alone. B2, B3 and B4 each add to the composition B1 establishes and are independent of each other. They run **sequentially** rather than in parallel worktrees: there is one dev app on `:9222`, so CDP verification serializes anyway, and three concurrent dev apps on one machine is where the HMR teardowns start. B5 last, because it is the one that deletes the old surface — and it is now **blocked on B4**, which owns the only mount of the channel profile drawer (§4a item 10).

**B1 is the risk.** B2–B4 are additive — each one bolts onto whatever composition exists. B1 is not: it replaces two of the three panes at once, so a half-landed B1 leaves no working Jarvis surface. It therefore lands *beside* the current composition rather than on top of it, so that B5's deletion is the only irreversible step.

**How it lands beside.** `jarvisfixturebar.tsx` is already dev-only — `import.meta.env.DEV` is statically false in production, so the whole bar is compiled out — and it already switches composition through a jotai atom. B1 adds one toggle to that bar, `three-pane` / `brief`, and `JarvisSurface` branches on it: `three-pane` renders today's `SubjectsColumn · Stage · StageRail` untouched, `brief` renders the new surface. No `wconfig` flag, no user-facing setting, nothing to migrate, and no production code path that can see a half-built surface. B5 deletes the toggle along with the panes it guards.

**B2's original name was right and an earlier draft of this section was wrong.** That draft claimed there was no durability question at all, on the grounds that every queue item kind is already persisted. Gates are: `Gate` and `Held` on a run phase, `Gate` and `Released` on a DAG task (`pkg/waveobj/wtype.go:249`, `:251`, `:319`, `:322`), and findings live in `pkg/reporadar`. **Asks are not.** `agentask.Registry` is an in-memory map for the server's lifetime (`pkg/agentask/agentask.go:28`, `:39`), listed via `List()` (`:56`) and pruned against live blocks by `livePendingAsks` (`pkg/jarvis/attention.go:331`), and there is no list-asks RPC at all — `AskCommands` is ask / answer / clear only (`pkg/wshrpc/wshrpctypes_ask.go:14`–`:16`). A `wavesrv` restart therefore drops every pending ask out of the queue until its agent re-registers.

**Landed in B2, with one honest limit.** `db_pendingask` (migration 000019) plus a single write-through hook on the registry — every add is `Set`, every removal is `Drop`/`Claim`, so the mirror has one choke point rather than six lifecycle call sites across three packages. Only **job-backed** asks are restored: an in-process shell is a child of the wavesrv that spawned it, so a restart killed the agent and restoring its question would put a row in the queue whose answer has nowhere to go. A `wsh ask --wait` ask is never persisted at all — its delivery is an in-memory channel, so a restored copy could only be a question nobody is listening to. Liveness is read off persisted objects (`Block.JobId` → `Job.JobManagerStatus`), never the live controller registry, because a durable block's controller re-attaches only once the frontend re-mounts it — long after the restore has to decide. The paired change is in `livePendingAsks`: it now also retires an ask whose job manager has stopped, because a restored ask has no other retirement path — the daemon that would have sent the clear is the thing that died.

And B2 writes **no new `queuecompose.ts`.** An earlier draft called for one; `briefingmodel.ts` (450 lines, 534-line test) already exports `buildAttentionQueue` (`:143`) producing `QueueRow[]` (`:122`) straight off the live attention poll, and its docblock already records the two rules that matter — wire order *is* the priority claim, and a standalone item with no channel renders static rather than as a button that navigates nowhere. B2 extends that function to carry the new kinds. Its real content is the Go work in §4b's table, and it is where the queue stops being partial.

## 6. Open decisions, carried into the sub-project specs

Each names the spec that must resolve it. None blocks starting.

| Decision | Where | Owner |
|---|---|---|
| `n` is bound to `jarvis:new-thread` (`bindings.ts:465`, gated `onStage`); the Brief wants it for New run. One moves. | Keybindings | B1 |
| Duplicate initiative names are unguarded. | Effort creation | B4 |
| ~~No gesture to ask Jarvis *about* a session from inside its drawer.~~ **Resolved in B2: no new gesture.** The Brief's own composer already answers it — the all-work ask classifies a "what is X doing" prompt as `AskKindStatus` and attaches the ledger facts for it, so the question is answerable without a second entry point, and the drawer's composer stays a channel to the lead rather than becoming two things wearing one control (invariant 4). The cost, stated rather than hidden: you name the session instead of having it pre-scoped. | Composer | B2 |
| ~~The header fleet line derives its count but hardcodes its spend.~~ **Resolved.** Sum `AgentVM.usage.costusd` across `agentsAtom` in a new derived atom. Both inputs are reactive, so the line becomes fully derived and invariant 5 holds. The historical estimate in `allUsageStatsAtom` is the wrong number for this line — the header describes the *live* fleet. | Fleet summary | B1 |
| `showPipeline` is declared in `StageComposition` and set for `channel`, and nothing reads it. Confirmed: its only reader is its own test. **Removed in B5** — with `stagecompose.ts`. | Dead field | B5 |
| ~~**Ask-mode consult results have no renderer but `ConsultsSection`.**~~ **Resolved in B5: dropped.** `ConsultsSection` was mounted only by the rail and went with it; the loss is recorded in `docs/deferred.md` rather than re-homed, on the decision that the Brief's composer already answers the questions consults existed for. | §4a item 11 | B5 |
| ~~**Resume and proactive cards have no mount but the ambient rail.**~~ **Resolved in B5: dropped**, with `ResumeCard` / `ProactiveCard` / `ambientSection` recorded in `docs/deferred.md` as orphaned-but-kept. | §4a item 12 | B5 |

## Tracking

Specs are deliberately absent — see "What this document is". Only B1 carries a plan.

| # | Sub-project | Plan | Built |
|---|---|---|---|
| B1 | Brief surface | — | **Built** — composition toggle, four regions, composer + thread + `Drew on`, palette extension, `j`/`k` cursor, `brief-surface` scenario (7 steps). Item 8 carries no B1 work (above). |
| B2 | Queue composition | n/a | **Built** — the four missing kinds (plan gates, per-task DAG gates, radar triage, real ask text), ask durability, and item 7's freshness feed. Not yet live-verified: the four new row kinds need a backend rebuild to be seen against real data. |
| B3 | Record peek and the Vault line | [Wave 2 plan](../plans/2026-09-10-jarvis-brief-b3-wave-2.md) | **Built, not live-verified** — wave 1 record peek (16 tests; `brief-peek` scenario) plus wave 2: the Vault Records split ledger over `ListTaskDossiersCommand`/`GetDossierCommand` (no new backend read), `attachedorefs` on the stateless ask wire, the Brief's store-owned draft/thread/scope, contextual entry branching on composition, one-shot dossier/conversation restore, and the Brief's graph mount. Verified: `go test ./pkg/jarvisrecall ./pkg/wshrpc/wshserver`, `npm test` (2879 passed, 2 skipped), `tsc --noEmit`, the plan's full eslint list, `task build:backend` — all exit 0. CDP is **registered but not run**: `vault-records`, `brief-contextual-map` and `brief-restore` are in `scripts/cdp/scenarios.mjs` and were statically checked (41 scenarios, no malformed entries), but a live run needs a `wavesrv` restart that the effort ledger defers, so the attached-source payload has no end-to-end proof yet. One plan-listed check is red for a pre-existing reason: `prettier --check` on this plan document, whose fenced samples are 4-space and which `.editorconfig` does not cover as JS/TS — left as authored rather than reformatted. Remaining B5 dependency: `Open run` stays absent from the Brief's graph (`canOpenRuns={false}`) because runs have no Stage-sheet destination yet. Residual risk: a stored channel is deliberately left stored and re-examined on every launch, so a deleted channel defers silently until B5 clears it. |
| B4 | Profile and run reconfigure | n/a | **Built** — `JarvisProfile`/`ProfileOverride` gain machine, parallelism and workerRoute; `Run` gains `PlanGatePending`, which `CreateRun` resolves from the profile and `DagSubmit` consumes; the launcher hydrates from the resolved profile with a draft-scoped manual override; new `SetRunSettingsCommand` writes pre-DAG settings on the run and post-DAG settings on the TaskGroup under the scheduler's own mutation lock; the Brief gains a header Profile modal and a run session sheet. Committed as `0a42343e` (32 files, +3165/-61). Not live-verified. Two residuals: `resolveRunPlan` still ignores `DefaultMode` (pinned by `TestResolveRunPlanDefaultsToQuickRegardlessOfProfile` — the profile's shape reaches launches through the hydrated launcher control instead), and `Save as project defaults` stores the run's flattened lead route rather than re-deriving the profile's. |
| B5 | Retirement | n/a | **Built, not live-verified** — the Subjects column, the Stage, the Stage rail and their exclusive views are deleted (`stage`, `stagecompose`, `stagecomposer`, `stageheader`, `stagerail`, `subjectscolumn`, `subjectcursor`, `jarvislayout`, `briefingview`, `conversationview`, `effortslistview`, `groundingrail`, `ambientrailview`, `ambientrail`, `profilepanel`, `composertarget`, `recordthread`, `channelcontextpanel`, plus `subjects.ts`'s grouping model and `usefleetsummary.ts`): 25 files, ~5.8k lines. The `jarvisComposition` toggle, the `jarvis.composition` / `jarvis.stagerail.open` keys, the `d` chord, `stageRailOpenAtom`, `profileRailOpenAtom` and `showPipeline` went with them. The Stage's body is re-homed rather than rewritten: a new `briefsheet.tsx` draws the **active subject** in the B4 sheet shell — a channel's live `RunBody` with the record band and the settings panel below it, or its launcher with a goal row that dispatches (`RunLauncher` alone is the config half of a launch), or an initiative's `EffortDetailView` — and `sheetFace` (`briefsheetmodel.ts`) is the routing table that says which subjects the sheet owns and which keep another Brief destination (dossier → peek, conversation → thread, briefing → the Brief). Everything that had no mount left is recorded in `docs/deferred.md`; nothing was deleted for it. Entry points became real: queue rows open the sheet, session rows open for runs, initiative rows open the detail, the graph's `canOpenRuns` is true, and the two landings moved off the Stage (a `Open run` focus request and a Radar draft both land on the channel's sheet; the draft prefills the goal row and carries its `radarOrigin`). A stored channel now restores: `briefRestorePlan` lost `defer-channel`. `+ Channel` moved to the Brief header (`newchannelcontrol.tsx`) because the column held the app's only channel-creation path. Verified: `tsc --noEmit` exit 0, `vitest` 2865 passed / 2 skipped, eslint **unchanged** against HEAD on every touched file — the 13 pre-existing `no-undef` errors in `scripts/cdp/scenarios.mjs` still stand, so "clean" would have been the wrong word — 25 dead files removed. A review pass after the build deleted one more pair of dead files, `jarvisfixtures.ts` and `jarviscontract.test.ts`: the conversation fixtures' only reader was that test, once `activeConversationAtom` and its renderer went, so the suite stands at 2857 passed / 2 skipped. **CDP is only partly reconciled**: the eleven scenarios that read the deleted panes are gone, so the suite is 30 registrations rather than 41, and the ask/composer helpers drive the Brief — but several of the survivors still select a channel row from the deleted column and assert the composition toggle, so no live pass has been run. |
