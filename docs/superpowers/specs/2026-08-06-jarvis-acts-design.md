# Jarvis acts — the creature stops describing and starts doing

The creature can say a great deal and do nothing. Its panel is a mirror: four rows of telemetry, one line of
prose, and one filled button that navigates to a surface rather than to whatever the panel was talking about.
This spec gives every register a terminus — a named action with a target — and states the law that keeps it
that way.

Companion to `2026-08-04-jarvis-pet-design.md` (the creature, its registers, the capability ladder) and
`2026-08-06-jarvis-volunteered-knowledge-design.md` (what it chooses to say). Neither is superseded: this
document adds the acting half that both deferred. It reverses exactly one prior decision — the split of a
distillation pass into two separate utterances, carried in the pet design's voice contract and argued in the
distillation coordinator's own comment (§7.4 below).

## 1. Why

A live reading of the panel, row by row, is the whole argument:

| What it shows | What you can do about it |
|---|---|
| *"My index is behind on some notes — ask me anything and I will catch it up."* | nothing — the remedy is named in prose and offered nowhere |
| `RECALL  stale — notes have changed since indexing (3)` | nothing |
| `WINDOW  Claude · 71% used · back in 2h 40m` | nothing, correctly — a countdown has no remedy |
| `VAULT   6 queued for cleanup · 0 stale` | nothing — the queue is a real list behind the Memory surface, counted here and unreachable |
| `WAITING nothing waiting` | nothing when empty; when full, still only a sentence |
| *"I went back over 8 sessions while you were out."* | nothing — an activity event with no source grows no buttons by design (`petjoin.ts:129`) |
| **Open Jarvis** | navigate to a surface, not to the thing under discussion |

Six of seven lines terminate in nothing. The seventh is a bare navigation. The creature was built so that
"the system knows a great deal it never says" stopped being true; the panel now proves the successor problem
— **the system says a great deal it never acts on**, which is a smaller failure only in the sense that it is
one step further along.

The 2026-08-04 pet design anticipated this and deferred it: §6 designs a three-tier capability ladder
(carry / fetch / operate) and §12 lists it as designed and unscheduled. This is that work, reshaped by what
turned out to be reachable: nearly every remedy already exists as a Go function or a frontend helper, and is
simply not wired to anything a user can press.

## 2. The law

One invariant replaces three separate complaints:

> **Nothing appears on the creature unless it carries the thing that resolves it.**

Three corollaries:

1. **A condition row carries the act that clears it — or honestly carries none.** The rate-limit countdown is
   the only row where nothing exists to do. It stays a bare readout; a button there would be theatre.
2. **An utterance carries its products, or is not said.** Volume is not a product. Work happening is not your
   world changing.
3. **Acting happens in place and reports back.** Escort — navigating you to where the work is done — is the
   fallback for things that need judgement, never the default.

Corollary 2 is the one with teeth, because it deletes an utterance rather than adding a button. It is also
the durable half: it means the creature only ever interrupts for a change in your world, and whatever it
says hands you the change.

## 3. The spine — one typed act, three verbs

Three action shapes already exist in the codebase, unevenly. `openORef` (`frontend/app/view/jarvis/openref.ts`)
navigates with focus. `askAboutSource` (`jarvissubjectstore.ts`) seeds a Jarvis question. Nothing yet runs an
operation in place. Unify them as one type:

```ts
type PetAct =
    | { id: string; verb: "do"; label: string; op: PetOp }
    | { id: string; verb: "open"; label: string; target: PetTarget }
    | { id: string; verb: "ask"; label: string; seed: AskSeed };

type PetOp =
    | { kind: "reconcile-index" }
    | { kind: "clear-superseded"; count: number }
    | { kind: "gate"; channelId: string; runId: string; phaseIdx: number; action: "approve" | "sendback" };

// where an escort lands. An oref goes through the existing openORef; the two surface targets exist because
// the Memory cleanup queue and the Settings embeddings section are not addressable as orefs.
type PetTarget =
    | { kind: "oref"; ref: string; anchor?: string }
    | { kind: "memory-upkeep" }
    | { kind: "settings-embeddings" };

// the four arguments askAboutSource already takes, carried as data so the pure layer can offer an Ask
// without importing the impure helper
type AskSeed = { ref: string; sourceType: string; title: string; prompt: string };
```

**An errand is deliberately not a `PetOp`.** `PetAct` is the set of acts this module *offers* from a signal;
a question the user composes is authored, not offered, so the errand box calls `sendErrand` directly (§5).
Modelling it as an op would put a variant in the union that no mapping function can ever produce.

### Modules

Following the pure-derive / thin-render split the rest of `view/jarvis` already uses:

| Module | Kind | Owns |
|---|---|---|
| `petacts.ts` (new) | pure | `actsForRecall(status)`, `actsForVault(candidates)`, `actsForAttention(item, tier)`, `actsForEvent(event, noteExists)`. Signals in, acts out. `noteExists` is a predicate over note ids, passed in rather than read, so §9's dead-button rule stays testable without a store. |
| `petactrun.ts` (new) | impure | one `runAct(act)` that dispatches each `PetOp` to its RPC and writes the outcome to an atom. The only place an act touches the network. |
| `petstore.ts` (extended) | atoms | `petActStateAtom: Record<actId, { status: "running" \| "done" \| "error"; text?: string }>` |
| `petpeek.tsx` (edited) | render | renders acts; holds no knowledge of which act belongs to which row |

**`PetOp` is a closed union, not a thunk.** A thunk would drag the RPC client into the pure layer and make
*what gets offered* untestable. Splitting "what is offered" (pure, assertable, precedence- and tier-checkable)
from "how it runs" (impure) is the same rule that keeps `petcondition.ts` free of pixels — the one
architectural rule of the pet design (§5 there).

### The act result is transient, never a second source of truth

The recall row's value comes from the index-status poll in `petsources.tsx`; the vault row's from the
cleanup-queue poll in `petdecaypoller.tsx`. After you press Catch up, the act state owns only *running*,
*failed*, or *just now: 41 indexed*. The row's steady value re-derives from the next poll.

The alternative — letting an act's return value become the row's value — drifts from the backend the moment a
poll disagrees with a stale result, which is exactly the class of bug the panel exists to expose.

## 4. The inventory

### 4.1 The condition sentence

`conditionLine` in `petcondition.ts:112` currently reads *"My index is behind on some notes — ask me anything
and I will catch it up."* It becomes a statement of fact — *"My index is behind on 3 notes."* — because a
**Catch up** button now sits on the row directly below.

Prose that describes an action is the original defect. The fix removes the prose; it does not add a button
beside it. Any other line whose text names a remedy gets the same treatment.

### 4.2 Recall — three states, three honest verbs

Fed by `GetEmbedIndexStatusCommand` (`wshrpctypes_jarvis.go:36`) and worded by `recallLine`
(`petjoin.ts:44`), whose reason table already distinguishes the cases.

| State and reason | Act |
|---|---|
| `stale` — content drift, model mismatch, not built | **Catch up** (`do: reconcile-index`) |
| `off` — embeddings disabled, no API key | **Set up** (`open: settings-embeddings`) |
| `off` — provider error, index error, vault error | **Retry** (`do: reconcile-index`) |
| `ok` | none |

**Catch up is a genuine in-place operation.** `Index.Reconcile` (`pkg/jarvisembed/reconcile.go:28`) is
idempotent, loses nothing, and is exactly what the next query would have done lazily — which is why the
current prose can promise it.

**Set up escorts rather than acts** because credentials are a judgement and a text entry, not an operation.
It needs one small addition: the Settings surface is a flat scroll of sections with no ids and no deep-link
mechanism (`settingssurface.tsx:57-69`), and the embeddings section is the **last** of seven — so a bare
surface switch lands you at the top of a long page, which is escort in name only. A `pendingSettingsSectionAtom`
consumed once on mount, plus an id on the section, plus one `scrollIntoView`. That follows the app's existing
pending-focus convention rather than inventing one: `pendingRunFocusAtom` (`runactions.ts`),
`pendingDecisionAnchorAtom` (`petstore.ts`), and `memSelectedPendingPathAtom` (`memstore.ts`) all work this
way. The same mechanism serves the vault row's **Review** escort (§4.4) — hence `memory-upkeep` and
`settings-embeddings` being targets in their own right in §3 rather than orefs.

**Retry is the same operation as Catch up, differently labelled**, because for a transient provider failure
the diagnostic *is* the result line: either it worked or it names the same failure again.

Considered and dropped: showing *which* three notes drifted. `EmbedIndexStatus` carries only a count; listing
paths needs new Go, and catching up drives the count to zero anyway. Recorded so it is not rediscovered as an
oversight.

### 4.3 Window — no act, by decision

A rate-limit countdown has no remedy. The row stays a readout. This is corollary 1's honest case and the
reason the law says "or honestly carries none" rather than "every row acts".

### 4.4 Vault — escort, plus one bounded operation

**The count is not what it looks like.** "6 queued for cleanup" is `PruneCandidates` (`pkg/memvault/prune.go`)
— notes the gardener *flagged*, awaiting a per-note human decision. Two consequences that shaped this row:

- **`memgarden.Sweep` is not the remedy; it is the producer.** Sweep archives what it is sure about and
  *flags* the rest through `flagFn` (`pkg/memgarden/gardener.go:100-107`). Wiring a "Clean up" button to
  Sweep would refill the queue, not resolve it.
- **Resolving a flagged candidate deletes a file irreversibly.** `prune` in `memstore.ts:260` routes to
  `MemoryDeleteCommand`, and the existing bulk confirm modal says so in as many words.

So:

| Act | Wiring |
|---|---|
| **Review 6** (`open: memory-upkeep`) | the Memory surface, forced to list view, scrolled to the cleanup queue |
| **Clear 3 superseded** (`do: clear-superseded`), only when candidates with reason `superseded` exist | the existing `confirmPruneAllSuperseded` (`memstore.ts:283`) |

**Forcing list view is not a nicety.** The cleanup queue is not a rail — `CleanupQueue` and `ArchivedView`
render inline at the top of the Memory surface's list (`memorysurface.tsx:163-164`), and that component is
**not mounted in graph view** (`memorysurface.tsx:140-141`). If the last Memory view you left was the graph, a
bare surface switch lands you somewhere the queue does not exist — an escort to nothing, which is the exact
failure this document exists to remove. So the escort sets `memViewAtom` to `list` as well as switching
surface.

*Superseded* means a note explicitly replaced by another — the one mechanical subset of the queue. Routing it
through the existing confirm modal rather than bypassing it keeps one rule about irreversible deletion in one
place.

The panel therefore reads the candidate list (`memPruneAtom`, already populated by the cleanup-queue poller)
rather than only its depth.

### 4.5 Waiting — the items themselves, with tier-gated verbs

The row stops being one sentence from `postureLine` and becomes the actual items from `attentionAtom`
(`attentionstore.ts:14`), already polled globally every ten seconds. Per item: the run's goal and how long it
has waited, then

| Act | Availability |
|---|---|
| **Open** (`open`) — the gate in its channel | always; needs no tier |
| **Approve** / **Send back** (`do: gate`) | only when the item's channel is Delegator-enabled |

The tier read is the existing `tierFromMeta` (`channelmessages.ts:66`) against the item's own channel, and
the calls are the existing `approveGate` / `sendBackGate` (`runactions.ts:78`). This implements the pet
design's §6 resolution literally: *capability is a property of the creature-and-target pair, not of the
creature.* A creature in global window chrome still has no tier of its own; it borrows the target's.

**Triage is dropped.** It needs a verdict (`quick | plan`) plus a one-line reason — a form, not a button.
Escort covers it.

**One Go field is needed.** `AttentionItem` (`wshrpctypes_channels.go:109`) carries the channel and run but
not the gate's phase index, which `reviewGateIdx` (`pkg/jarvis/attention.go:53`) computes and discards.
Re-deriving it in TypeScript would duplicate that precedence rule and let the two drift.

### 4.6 What I've said — utterances carry their products

**Volunteered knowledge** (recall, connection, loose-end) already obeys the law: it carries a source and grows
Open and Ask. Unchanged.

**The distillation pass** becomes one utterance carrying its products — *"I went back over 8 sessions and
wrote down 3 things"* — with the three note titles, each openable and askable. A pass that produced nothing
says nothing (§7.4).

**The vault sweep** already only speaks when it archived something; the code states the rule outright
(`gardener.go:126`: *"a pass that changed nothing has nothing to say, and announcing every hourly no-op is
how an ambient signal becomes noise"*). That rule already being in the codebase is precisely what makes the
distillation split the odd one out. The sweep utterance gains **Review** → the archived list
(`MemoryArchiveListCommand`), which is restorable via `MemoryRestoreCommand`. A real product with a real undo.

**Addressing the products needs no new id scheme.** A note's id is its frontmatter `name` or its filename stem
(`pkg/memvault/memvault.go:84,102`) — the same slug `WriteLearning` already returns — so `memnote:<slug>`
routes through the existing `openORef` path.

### 4.7 A new last-pass row

*"18m ago · 8 sessions · nothing written"*.

This row is what makes the silence of §7.4 safe. It moves "a pass happened" from voice into the readout, so a
distillation pipeline that runs and writes nothing becomes **more** visible than it is today rather than
hidden — and it lands on the correct side of the pet design's register split (§3 there: *the event is the
transition, the condition is the level*). A completed pass is a level.

Seeded from activity events as they arrive and persisted to `localStorage`, matching how saved rate-limit
windows work in `ratelimitstore.ts`. Before the first observed pass it reads "not read yet" — the same
convention every other row already uses for an unread signal.

### 4.8 The footer inverts

The errand box takes the primary position; **Open Jarvis** demotes to a small text link. A filled primary
button currently claims the panel's main action is a bare navigation, which is the least meaningful thing on
it. The link stays because the panel should be able to hand off, but it stops presenting as the point.

## 5. The errand box

A text field reusing the consult path exactly as the Channels surface does (`channelactions.ts:61-101`): post
a `consult` message, then stream `ConsultCommand` (`wshrpctypes_jarvis.go:13`) into the panel.

- **It targets the active channel** (`activeChannelIdAtom`, `channelsstore.ts:13`) and names it on the box —
  `→ #wave`. `CommandConsultData` requires a channel and a creature in window chrome has none: the same
  per-channel hole the pet design's §6 named. With no channel active the box is disabled **with that reason
  stated**, not hidden.
- **Deliberately not tier-gated.** The identical gesture is ungated in the Channels surface today. A panel
  stricter than the surface it mirrors is incoherent, and the pet design's own reasoning — that errands need
  the tier legible before acting — is an argument about a capability the app does not currently gate at all.
  Changing that is a separate decision about the Channels surface, not a thing to introduce asymmetrically
  here.
- The reply streams into the panel **and** persists as channel messages, because the backend posts a
  `consult-reply` on completion. Closing the panel does not lose the answer.

This is the literal answer to the panel's own current prose: it says *ask me anything* and gives you nowhere
to type.

## 6. What the backend needs — three Go changes, one widened type, one row that needs nothing

### 6.1 One new command to catch up the index, and it must not be synchronous

`DefaultTimeoutMs` is 5000 (`pkg/wshutil/wshrpc.go:28`) and it binds the **server-side** context, so slow work
inside a handler fails the client even though the work completes. `Index.Reconcile` does a model-change
wipe-and-rebuild and then embeds every changed node — network calls across the whole vault. It cannot run
inside a normal handler.

`EmbedReconcileCommand` therefore starts the reconcile off-band on a detached context, single-flighted so a
double-press cannot run two, and returns immediately. The panel row shows *catching up…* from its own act
state, and re-reading the index status is what tells the panel the work landed — no completion event, no new
subscriber, no timeout risk.

**One thing the poller cannot supply on its own: its cadence.** The ambient index read is every 15 minutes,
correctly, because it parses the whole vault to count drift. Left at that, you press Catch up and the row
keeps saying *stale* for up to a quarter of an hour, which reads as a button that did nothing. So the act
runner owns a bounded burst of its own: re-read every 30 seconds until the index reports `ok` or twelve
minutes pass — long enough to cover the measured 5m17s build — then clear the act and let the row speak for
itself again. Bounded rather than indefinite so a permanently broken index cannot leave a poll running for
the session.

### 6.2 One new field for the waiting items

`AttentionItem` gains `PhaseIdx`, set from the value `reviewGateIdx` already computes. Then `task generate`.

### 6.3 The distillation pass stops discarding what it wrote

- `memvault.RouteLearnings` (`learn.go:110`) drops the slug that `WriteLearning` hands back (`learn.go:119`).
  It returns those identities instead.
- `MemoryActivityData` (`pkg/baseds/baseds.go:85`) gains the written notes as `{id, title}` pairs.
- The distillation coordinator publishes **one event per pass, always**, carrying what the pass produced —
  replacing today's unconditional pass announcement plus conditional notes announcement
  (`pkg/memdistill/coordinator.go:150-157`).

One fact, one id — which makes the say-once watermark simpler than it is today, not more complex.

**Publishing unconditionally is what keeps §4.7 honest, and it is the correct split of responsibility.**
Suppressing a barren pass here would leave the last-pass row with no data, so a pipeline that runs eight
times and writes nothing would be *invisible* rather than quiet — the precise failure that row exists to
prevent. The backend reports the fact; the frontend owns the law about whether a fact is worth saying, and
`eventFromActivity` returns no utterance for a pass with no products. A dropped adapter result never reaches
`petEventsAtom`, so a silent pass does not touch the watermark either.

### 6.4 Nothing at all for the vault row

The payoff from §4.4: Review is escort and Clear-superseded reuses `MemoryDeleteCommand`. The row that looked
like it needed a new sweep command needs no Go.

### 6.5 One frontend type widens

`PetEvent.source?: PetEventSource` becomes `sources?: PetEventSource[]` (`petvoice.ts:41`), since one
distillation pass writes several notes. Touches `petvoice.ts` (the type and the say-once logic), `petjoin.ts`
(the wire adapter), and `petpeek.tsx` (rendering).

## 7. Decisions taken

1. **Do it here, report back — not escort by default.** Escort is the same complaint one click further in. It
   survives only where the remedy is a judgement (vault candidates, credentials, triage) or where nothing is
   executable (the rate-limit countdown).
2. **Act state is transient; polls own the row values.** §3. Prevents the panel from drifting from the
   backend.
3. **Capability is borrowed from the target, never held by the creature.** §4.5, implementing the pet design's
   §6 resolution. No global tier, no new flag, read-only.
4. **An utterance with no product is not said — reversing the two-facts split.** The distillation coordinator
   currently splits "I did work" from "here is what I now believe" on the argument that they are two facts
   (`coordinator.go:148-149`). The first fact alone is the utterance this whole document was opened in
   response to. Merging them costs nothing that §4.7's last-pass row does not preserve, and it buys the law
   in §2. The sweep already works this way, so this makes the two consistent rather than introducing a new
   rule.
5. **The products are named, not summarised.** The note titles are already model-written distillations;
   generating a second summary of summaries would add a model call, a latency cost, and a failure mode to a
   background pipeline in exchange for duplicated judgement. A cluster summary can later replace the text
   field within the same `text + sources` contract, with no rework.
6. **Triage dropped, courier and pocket dropped.** Triage needs a form. Carrying objects between surfaces
   needs a whole drag-and-drop interaction model; it stays in the pet design's §6 as the architecturally
   interesting deferral it already is.
7. **The errand box is not tier-gated.** §5.

## 8. Staging

A spine, then five independent add-ons. Not a sequence — after the spine each piece stands alone and can land
in any order.

| Piece | Needs | Answers |
|---|---|---|
| **Spine** | nothing new | the act type, the runner, the act-state atom, the panel rendering acts |
| **Vault + recall escorts + footer inversion** | nothing new | two rows act; Open Jarvis stops being the headline |
| **Catch up / Retry** | 1 new off-band RPC (§6.1) | the top-precedence row acts in place |
| **Waiting items** | 1 Go field (§6.2) | gates resolve without leaving the panel |
| **Products + last-pass row** | Go plumbing in 3 files (§6.3) | utterances carry what they produced; barren passes go quiet without going invisible |
| **Errand box** | nothing new | the panel stops telling you to ask and gives you somewhere to type |

The spine plus the first add-on is already a shippable answer for two of the four rows.

## 9. Error handling

The point of this work is trust, so **a failed act says so on the row it belongs to, with the reason** — never
a toast, never silence. A silently-failing button is worse than no button, because it also spends your
attention.

- Act state is keyed per act, so a slow index catch-up never freezes the vault row.
- Non-idempotent acts (approve, send back) disable while running and stay disabled after success. The
  attention poll drops the resolved item within ten seconds regardless.
- **A product whose note is known to be gone renders without an Open button.** `openORef` no-ops on anything
  it cannot route (`openref.ts:41`), so rendering the button blindly produces exactly the dead click target
  the volunteered-knowledge design went out of its way to avoid (`petjoin.ts:129-131`).

  The check is **three-state, and that is load-bearing rather than pedantic**: `loadMemory()` has only the
  Memory surface as an entry caller, so `memNotesAtom` is empty whenever you have not visited it. A two-state
  "does this note exist" gate would therefore suppress *every* product's Open almost all of the time. So the
  predicate answers true / false / unknown, and only an explicit false suppresses — the same
  no-reading-is-not-a-clean-bill-of-health rule that `petcondition.ts` applies to its signals and
  `memPruneLoadedAtom` applies to the cleanup queue.
- An escort whose target surface fails to load is the surface's problem, not the panel's; the panel closes on
  escort as it does today, because an overlay anchored to the creature left open over a surface it just
  navigated away from is stranded (`petpeek.tsx:207-210`).

## 10. Testing

- **`petacts.test.ts`** — the bulk of it, pure: every index state maps to its expected verb; a Concierge-tier
  channel yields Open only while a Delegator channel yields Approve and Send back; a vault queue with no
  superseded candidates yields Review only; a productless distillation event yields no utterance; a product
  whose note does not resolve yields no Open.
- **`petjoin.test.ts`** (extended) — the widened activity payload maps N written notes to N sources, and a
  payload with none maps to no event.
- **Go** — `RouteLearnings` returns the identities it wrote; the distillation coordinator publishes one event
  with products and none without; the gate's phase index reaches `AttentionItem`.
- **A CDP scenario named `pet-acts`** in `scripts/cdp/scenarios.mjs`: click the creature, assert the panel's
  act buttons render with their labels, and assert the escorts land somewhere real — Review reaches a Memory
  surface with a visible cleanup queue (the §4.4 graph-view trap), Set up reaches a Settings surface scrolled
  to embeddings. Per the standing decision in this repo, "does it render" is CDP's job — there are no jsdom
  render tests. Scope the DOM queries to a `data-*` container on the panel: a document-wide
  `button` query picks up the app bar, a mistake this repo's scenarios have already made once.

### Verification commands

```powershell
# Frontend unit tests (the pure modules carry the design's assertions)
npx vitest run frontend/app/view/jarvis/petacts.test.ts frontend/app/view/jarvis/petjoin.test.ts

# Go. Anything touching jarvisembed fails to BUILD without the vendored header, and the -I path must be
# Windows-style — a Git-Bash POSIX path fails identically and silently.
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/memvault/... ./pkg/memdistill/... ./pkg/jarvis/... ./pkg/jarvisembed/...

# Wire changes (AttentionItem.PhaseIdx, MemoryActivityData notes, EmbedReconcileCommand)
task generate

# Typecheck — bare `npx tsc` stack-overflows on this repo
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit

# Rendered check against the live dev app
task verify:ui -- pet-acts
```

A backend rebuild (`task build:backend`) is required before the new RPC and the new field are reachable from
a running dev app, or the frontend gets a route error against a stale `wavesrv`.

## 11. Out of scope, and one known gap

- **Courier and pocket** — dragging a commit, finding, or note onto the creature so it carries it across a
  surface switch. Architecturally the most interesting capability in the pet design's §6 (the creature is the
  only object in the app that survives a surface unmount) and a whole new interaction model. Stays deferred
  there.
- **Triage from the panel** — §7.6.
- **Generated cluster summaries for a distillation pass** — §7.5. Fits the same contract later.
- **Gating the consult gesture by tier anywhere** — §5. That is a decision about the Channels surface.
- **Listing which notes drifted** — §4.2.
- **Known gap, not addressed here:** the utterance kind for a finished background agent (`bg-agent-done`) is
  declared in the voice type (`petvoice.ts:33`) and labelled in the bubble (`petbubble.tsx:34`), but nothing
  produces it. Under §2's law it would need to carry the finished agent as its product. Either it gets a
  producer that does, or the kind should go. Recorded rather than silently inherited.

## 12. What this changes

Before: seven lines, six terminating in nothing and one in a bare navigation.

After: every row either acts, escorts to a judgement, or honestly carries nothing; every utterance hands you
what it produced or is not said; and the panel has somewhere to type. The creature keeps its one
architectural rule — pure modules decide, thin renderers draw — and gains one more: **what it decides to say,
it must also be able to answer for.**
