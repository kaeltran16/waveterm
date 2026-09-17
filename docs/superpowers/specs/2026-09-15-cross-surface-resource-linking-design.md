# Cross-Surface Resource Linking — Design

**Date:** 2026-09-15  
**Status:** Approved 2026-09-17 — cut to the navigation core after review  
**Type:** Cockpit-wide contract, one implementation slice

## Summary

Every cockpit resource that a card, citation, palette row, graph node or pet act points at is addressed by a
string, and those strings come in ten dialects. Several of them open nothing, one opens the wrong thing, and
the same resource opens through different code depending on the caller.

This design fixes that with three pieces and nothing more:

1. **Canonical addresses, emitted by Go.** Producers stop inventing dialects.
2. **One pure parser** that also understands the legacy strings persisted conversation turns still carry.
3. **One `openTarget`** that lands on the requested item or reports why it cannot, never a silent no-op.

The relationship model (Related Work, Work Trail) and cross-surface Back are deferred until evidence. Their
settled decisions are kept under [Deferred until evidence](#deferred-until-evidence).

## Builds on

- `docs/reference/architecture.md` — one cockpit, `AgentsViewModel`, surfaces unmount on switch.
- `docs/superpowers/specs/2026-07-14-cross-surface-consistency-scaffold-design.md` — error posture.
- `docs/superpowers/specs/2026-07-23-jarvis-f-conversation-backend-design.md` — persisted grounding cards.
- `docs/superpowers/specs/2026-08-06-code-surface-navigation-and-handoff-design.md` — `openInCode`, which
  stays the Code landing unchanged.

This supersedes `frontend/app/view/jarvis/openref.ts`'s premise that there is no generic router and that an
unroutable address is "a deliberate no-op" (`openref.ts:104`).

## Problem

Verified against the code on 2026-09-15; line references re-checked against `main` on 2026-09-17.

### Addresses that open nothing or the wrong thing

1. **Conversation citations to vault and memory sources are dead clicks.** Recall emits `vault:<id>`
   (`pkg/jarvisrecall/retrieve.go:270`) and `memory:<id>` (`pkg/jarvisrecall/cards.go:133`, commented "NOT a
   parseable ORef"). The conversation stream keeps each card's `navTarget` as emitted (`jarvisstore.ts:283-285`),
   `jarvisturn.tsx:110` passes it to `openORef`, and `orefNavPlan` classifies both as unsupported.
2. **The Brief's rewrite misroutes non-dossier nodes.** `normalizeBriefingNav` turns every `vault:` into
   `task:` (`briefingmodel.ts:371-378`), applied to grounding cards at `briefingstore.ts:258-263` and to ledger
   blocker and delta rows at `briefingmodel.ts:447,507`. `retrieve.go` emits `vault:` for decisions and
   memory-collection nodes too, so those grounding cards open a dossier peek on an id that is not a dossier.
3. **A Radar finding citation loses its finding.** `radarCandidate` emits `radarreport:<oid>` only
   (`cards.go:121`).
4. **Opening a report from outside Radar can land on a different report.** `selectReport` sets the current
   report, but on a first visit Radar's mount effect derives a scope and calls `initRadarScope`
   (`radarsurface.tsx:121-149`), whose `loadReports` selects the newest report (`radarstore.ts:104-118`).
5. **Silent returns.** `openRunSheet` returns without a word when the run fails to load or has no channel
   (`openref.ts:84-88`); `selectNote` returns silently when the note list has not loaded (`memstore.ts:139-140`).

### Two ways to open the same thing

- **Run.** `openORef("run:…")` → `openRunSheet` → `openChannelSheet`. Radar's "Open run"
  (`radarfindingdetail.tsx:84-90`) and the DAG task fallback (`taskcorrelate.ts:63-71`) instead set
  `pendingRunFocusAtom`, which an effect in `briefsurface.tsx:947-966` consumes. That effect only works while
  the Brief is mounted, and the task fallback never switches surface. It adds nothing `openChannelSheet` lacks:
  `selectChannel` already awaits the runs load (`channelsstore.ts:29-36`, `87-94`) and `setActiveRunId` is a
  plain map write (`jarvissubjectstore.ts:235-238`).
- **Agent.** Addresses route through `model.openTerminal` (`openref.ts:134-135`, `agents.tsx:160-165`) and run
  cards through `jumpToAgent` (`channelsprimitives.tsx:38-42`). Both land on the same view: the Agent surface
  has one, the focused agent's live terminal (`agentsurface.tsx:44-45,96`). The only difference is
  `terminalTargetAtom`, which `openTerminal` sets and `jumpToAgent` clears, and which nothing reads. It is left
  over from a transcript view the surface no longer has (`agents.tsx:75,162`, `channelsprimitives.tsx:40`,
  `cockpitsurface.tsx:285`, `sessionssurface.tsx:74`).
- **Record.** The Brief peek (`task:`) and `openRecordInVault` are two deliberate destinations
  (`openref.ts:154-160`). They stay, as explicit views of one target.

### Address dialects in use

| Address | Producers | Meaning | Opens today |
|---|---|---|---|
| `run:<oid>` | recall cards, Brief peek, graph peek | Run | yes |
| `channel:<oid>` | Wave object ORef (the Brief queue and palette pass a channel id, not this string) | Channel | yes |
| `tab:<id>` | run phase `WorkerORefs`, channel `RefORef` | agent tab | no — callers strip the prefix by hand |
| `agent:<tabId>` | effort `WorkRefs` (`wshcmd-effort.go:369`), Brief queue, pet sources | agent tab | yes |
| `task:<dossierId>` | `jarvisvolunteer`, palette | wavevault record | yes (peek) |
| `vault:<nodeId>` | `retrieve.go:270` (any collection), `jarvisstate.go:89,163` (dossiers) | wavevault node | no |
| `memnote:<id>` | `jarvisvolunteer/recall.go:77`, `proactive.ts:76`, `petjoin.ts:114` | memory note | yes |
| `memory:<id>` | `cards.go:133` | memory note | no |
| `effort:<oid>` | palette | effort | yes |
| `radarreport:<oid>` | `cards.go:121` | report; finding lost | yes |

Go never parses a navigation address: `NavTarget` is only passed through (`wshserver_jarvis.go:991,999`,
`jarvisrecall/ask.go:145`), so producers can change without breaking a Go reader.

Attachment orefs are a separate namespace: `jarvisrecall.resolveAttached` (`recall.go:201-235`) parses `run:`,
`memory:` and `radar:<findingId>` to pin grounding, and nothing opens them. They are out of scope.

## Goals

- Every address a producer emits opens its target, identically from every caller.
- Nothing fails silently: an address that cannot open says why, and the user stays where they were.
- One landing per destination. A migrated caller never writes another surface's selection atoms.
- Go emits canonical addresses. The frontend understands legacy strings only because persisted conversation
  turns and effort `WorkRefs` keep them.

## Non-goals

- Relationship UI, Back history, and the other items under [Deferred until evidence](#deferred-until-evidence).
- View targets. The Pet's memory-upkeep and settings escorts (`petactrun.ts:39-50`) stay as they are.
- Attachment orefs.
- New durable data, a link store, or model calls.

## Design

### 1. Canonical addresses

| Target | Canonical address | Anchor |
|---|---|---|
| Run | `run:<oid>` | — |
| Channel | `channel:<oid>` | — |
| Agent tab | `tab:<id>` (`agent:<id>` accepted as an alias; effort `WorkRefs` persist it) | — |
| Wavevault record | `task:<dossierId>` | decision id, for a decision |
| Memory note | `memnote:<id>` | — |
| Effort | `effort:<oid>` | — |
| Radar report | `radarreport:<oid>` | finding id, for a finding |

Go producer changes:

- **Grounding card anchor.** `JarvisConvoGroundingCard` (`pkg/waveobj/jarvisconvo.go:47-55`) gains
  ``Anchor string `json:"anchor,omitempty"` ``, then `task generate`. Cards persisted before this have none.
- **Vault nodes.** `nodeCandidate` (`retrieve.go:256-274`) addresses by collection:
  - tasks → `task:<id>`;
  - decisions → `task:<parent>` with the decision id as anchor;
  - memory → `memnote:<id>`.
  
  A decision whose parent record cannot be found gets no address, the precedent `jarvisvolunteer` already
  sets (`recall.go:58-62`).
- **One vault-addressing function.** `jarvisvolunteer`'s `address` (`recall.go:63-81`) and `nodeCandidate`
  call one implementation in `pkg/wavevault`. Both packages already import `wavevault`, and neither imports the
  other. The parent lookup is the reverse-link query `liveParentRecord` runs (`recall.go:86-97`), run against
  the caller's open vault rather than reopening it per decision.
- **Memory notes.** `memoryCandidate` (`cards.go:133`) emits `memnote:<id>`.
- **Radar findings.** `radarCandidate` (`cards.go:121`) keeps `radarreport:<oid>` and sets the finding id as
  anchor.
- **Ledger.** `jarvisstate.go:89,163` emit `task:<id>`.

No frontend producer changes: the palette, `proactive.ts` and `petjoin.ts` already emit canonical addresses.

### 2. One parser

`parseAddress(address, hint?: { sourceType?: string; anchor?: string }): OpenTarget | Unsupported` is pure
and total, and replaces `orefNavPlan`. It is the only place a legacy string is understood;
`normalizeBriefingNav` and its three call sites (`briefingstore.ts:262`, `briefingmodel.ts:447,507`) are
deleted.

| Input | Target |
|---|---|
| `run:<id>` | run |
| `channel:<id>` | channel |
| `tab:<id>`, `agent:<id>` | agent |
| `task:<id>` | record, peek view, anchor from hint |
| `vault:<id>`, sourceType `dossier` or none | record, peek view |
| `vault:<id>`, sourceType `memory` | memory note |
| `vault:<id>`, sourceType `decision` | unsupported — a pre-anchor card cannot locate the decision's record |
| `memnote:<id>`, `memory:<id>` | memory note |
| `effort:<id>` | effort |
| `radarreport:<id>` | radar, finding id from hint anchor |
| anything else, or malformed | unsupported |

Citation callers pass the card's `sourceType` and `anchor` as the hint, so `mapWireCard` (`recallderive.ts:68`)
maps the new `anchor` field.

### 3. `openTarget`

```ts
type OpenTarget =
    | { kind: "channel"; channelId: string; runId?: string }
    | { kind: "run"; runId: string }
    | { kind: "agent"; tabId: string }
    | { kind: "record"; dossierId: string; anchor?: string; view: "peek" | "vault" }
    | { kind: "memory-note"; noteId: string }
    | { kind: "effort"; effortId: string }
    | { kind: "radar"; reportId: string; findingId?: string };

type OpenResult =
    | { ok: true }
    | { ok: false; reason: "unsupported" | "unavailable" | "failed" | "superseded"; message: string };

async function openTarget(model: AgentsViewModel, target: OpenTarget, report?: (r: OpenResult) => void): Promise<OpenResult>;
async function openAddress(model: AgentsViewModel, address: string, hint?: AddressHint): Promise<OpenResult>;
```

The union holds only the kinds some address or migrated caller needs today. `openAddress` is `parseAddress`
plus `openTarget`, and is the entry for every caller holding a string.

**Landing order:**
1. Load whatever proves the target exists.
2. Write the destination's selection.
3. Switch the surface.

Selection lands before the switch, as `openDiff` and `openRecordInVault` already do, so the unmounted
destination renders the item on its first frame. Loading before switching is deliberate: the requested item
is never a flash of the wrong one, at the cost of a click that waits on its load. That wait is why a
module-level request counter exists. A landing whose token went stale during its awaits returns `superseded`
and writes nothing.

**Reporting:** a non-ok result keeps the user where they were. By default it is reported through the cockpit
toast (`pushToast`, `frontend/app/cockpit/notificationstore.ts:21`), and `superseded` is never reported. A
caller that renders failure itself passes `report`. Today that is only the Pet, whose acts show their own
failure (`petactrun.ts:7-8`).

**Landings:**

| Target | Landing (existing helpers) | Not ok when |
|---|---|---|
| channel | `openChannelSheet(channelId, runId)` → jarvis | the channel fails to load |
| run | load the Run; `openChannelSheet(run.channeloid, runId)` → jarvis | Run missing; Run has no channel |
| agent | `jumpToAgent` | tab not in the roster |
| record | peek: `pendingDecisionAnchorAtom` + `briefPeekRecordAtom` → jarvis; vault: `openRecordInVault` | id absent from `taskListAtom` once it has loaded — the peek builds nothing until the detail loads (`briefpeekview.tsx:152-162`), so it cannot report a missing record itself |
| memory-note | `loadMemory()` unless `memLoadedAtom`; `selectNote`; memory tab, saved focus → vault | id absent from `memNotesAtom` after load |
| effort | `openEffortSheet` → jarvis | unchanged |
| radar | load the report; if Radar's scope is not the report's project, `await initRadarScope` for that project first; then `selectReport(reportId)`; `radarSelectedIdAtom = findingId` → radar | report missing |

Radar's scope comes first because `initRadarScope` selects the newest report. Setting it before
`selectReport` makes the mount effect keep the owned scope (`radarsurface.tsx:121-123`) instead of re-deriving
it over the landing. A finding id absent from the report still lands on the report and reports that the
finding is no longer in it.

`loadReports` drops any call made while another load is in flight (`radarstore.ts:106-108`). A landing during
a load for another project would therefore return from `initRadarScope` with its own list unloaded, and the
in-flight load would then select its own newest report over the landing. The slice makes the guard per path
and discards a result whose path is no longer the owned scope.

### 4. Caller migration

| Today | After |
|---|---|
| `openORef` callers: `SourceChip` (`briefsurface.tsx:550`), the Brief's `openLine` (`briefsurface.tsx:1273`), `openQueueTarget` (`openref.ts:95-102`, called at `briefsurface.tsx:1270`), `jarvisturn.tsx:110`, `graphpeek.tsx:138`, `briefpeekview.tsx:101`, `command-palette.tsx:367,371`, `proactiveviews.tsx:27` | `openAddress` (citations pass the card's hint) |
| `SourceChip`'s button-or-text gate, `orefNavPlan(target).kind === "unsupported"` (`briefsurface.tsx:539`) | `parseAddress` with the same hint the click passes, so a citation that cannot open still renders as plain text |
| `petactrun.ts:36` | `openAddress` with the Pet's own `report` |
| `openRecordInVault` at `briefpeekview.tsx:259` | record target, vault view |
| `openChannelSheet` + surface write at `command-palette.tsx:327-329` | channel target |
| `pendingRunFocusAtom` at `radarfindingdetail.tsx:88`, `taskcorrelate.ts:69` | run target; the atom and its effect (`briefsurface.tsx:947-966`) are deleted |
| `normalizeBriefingNav` at `briefingstore.ts:262` and `briefingmodel.ts:447,507` | deleted; the parser owns legacy strings |
| `vault:` in `briefingfixtures.ts:102` | `task:`, matching what the ledger now emits |
| `terminalTargetAtom` (`agents.tsx:75`) and its writes at `agents.tsx:162`, `channelsprimitives.tsx:40`, `cockpitsurface.tsx:285`, `sessionssurface.tsx:74` | deleted, with the transcript wording in `openTerminal`'s comment (`agents.tsx:158-159`) |

`openRunSheet` folds into the run landing. `openEffortSheet` and `openRecordInVault` have no caller left outside
the router and become module-private. `openChannelSheet` stays exported for Jarvis's own flows (the Brief's
restore at `briefsurface.tsx:1017`, the investigation draft at `:976`, and `newruncontrol.tsx:162`), not for
cross-surface callers. Two comments that describe `openORef`'s routing (`petacts.ts:131`, `petsources.tsx:177`)
are updated to name `openAddress`; the memnote pre-check at `petacts.ts:129-132` stays, since hiding a known-dead
Open is still better than a button that reports it.

Callers that already hold a live object and call the destination's single landing helper stay as they are:
`jumpToAgent` and `model.openTerminal` on roster rows, `openDiff`, `openInCode`, and Radar's "Start
investigation" draft (`pendingRunDraftAtom`, a launch rather than a navigation). They have no dialect and no
silent path to fix.

### Failure handling

| Case | Result | Message |
|---|---|---|
| Unknown or malformed address | unsupported | "This item can't be opened" |
| Pre-anchor decision citation | unsupported | "This citation can't locate its record" |
| Run deleted | unavailable | "That run no longer exists" |
| Run with no channel | unavailable | "That run has no channel to open it in" |
| Agent tab gone | unavailable | "That agent session has ended" |
| Record absent from the loaded dossier list | unavailable | "That record no longer exists" |
| Memory note absent after load | unavailable | "That memory note no longer exists" |
| Report deleted | unavailable | "That scan report no longer exists" |
| Finding gone from its report | lands on the report | "That finding is no longer in this report" |
| A load throws | failed | the error, with the target named |
| A newer open started during the load | superseded | none |

## Testing

- **Parser:** a table test with one case per dialect row, hint handling, and the unsupported rows, replacing
  `orefNavPlan`'s tests in `openref.test.ts` and keeping "is total on malformed input".
- **Landings:** atom-level tests in the existing `openRecordInVault` pattern (`openref.test.ts:73-107`):
  - Run missing, and Run with no channel;
  - agent not in the roster, and record absent from the loaded dossier list;
  - memory loads before the absent-id check;
  - Radar scopes before selecting the report and finding;
  - a Radar load for another project that is still in flight does not overwrite the landing;
  - a superseded landing writes nothing.
- **Go:**
  - `nodeCandidate` addresses per collection, including a decision with and without a parent;
  - `memoryCandidate` emits `memnote:`, `radarCandidate` sets its anchor, `jarvisstate` emits `task:`;
  - `jarvisvolunteer`'s address tests pass through the shared function.
- **Checks:** `task generate` after the card field, the stack-sized TypeScript check, and a backend build.
- **`task verify:ui` scenarios:**
  - a conversation citation opens a dossier, a decision's record and a memory note;
  - a Radar finding citation lands on the finding on a first Radar visit;
  - Radar's "Open run" lands on the run;
  - an unknown address shows the toast and leaves the surface unchanged.

## Rollout

One slice, one commit that carries this spec:
1. Go producers, the card anchor, and `task generate`.
2. `parseAddress` and `openTarget` with their tests.
3. Caller migration and the deletions.
4. The CDP scenarios.

When it lands, record the deferrals below in `docs/deferred.md`.

## Deferred until evidence

Each keeps the decision already reached, so it is not re-derived.

- **Cross-surface Back.**
  - Session-only history of successful landings, deduplicated, never recording failures or cursor moves.
  - Separate from Code's Back/Forward, which owns `Alt+ArrowLeft/Right` (`bindings.ts:1026,1036`), so it needs its
    own chord.
  - Revive when a real flow shows the need.
- **Related Work.**
  - Forward links and backlinks derived from authoritative data: Run `ChannelOID`/`RadarOrigin`/`DagORef`/
    `EffortRef`/phase `WorkerORefs`/`Evidence`, DAG task `RunID`, Radar `Investigation`, effort `WorkRefs`,
    attribution edges.
  - No persisted link table.
  - Inferred edges show `jarvisattrib`'s own provenance (`dispatch`, `ticket-match`, `structural`,
    `human-accept`, `semantic`), state, and `BucketFor` bucket, never recomputed.
  - Needs a mockup per `DESIGN.md`.
- **Work Trail strip.** Explicit lineage only (finding → Run → task → worker → files); it stops at a branch
  rather than choosing one.
- **Structured resource refs on the wire.** File revisions and nested parents, only once something must persist
  a file revision. Nothing does today.
- **File, diff, commit and session targets in `openTarget`.** Add them when an address or a migrated caller
  needs them. `openInCode` and `openDiff` remain the landings.
- **A shared contextual-action builder** across buttons, menus and the palette.
- **Usage-to-work links.** They need per-session or per-run attribution in the usage scanner first.
- **Unifying the attachment oref namespace** (`resolveAttached`'s `run:`/`memory:`/`radar:`) with open addresses.
