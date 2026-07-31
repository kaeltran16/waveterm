# A live attention signal, and a past-work matcher that admits whether it ran

Design for one cycle covering two defects that share a property: **the cockpit reports something it cannot
actually see.** A run parked at a review gate produces no badge anywhere, because the data behind the badge
is a snapshot. And the dispatch-time past-work matcher no-ops on six different paths without recording that
it ran, so nobody can tell whether it works.

Both are about making an existing signal trustworthy rather than adding a capability, and they share one
verification pass.

**Sources.** [`docs/superpowers/briefs/2026-07-31-jarvis-integration-brief.md`](../briefs/2026-07-31-jarvis-integration-brief.md)
(the session that found both, including the database measurement quoted in part 2) and
[`docs/jarvis-consolidation-open-issues.md`](../../jarvis-consolidation-open-issues.md). Every file:line
below was read, not inferred.

---

## 1. A server-computed attention signal

### Problem

**The nav-rail badge cannot see a review gate, and counting harder would not fix it.**

The badge counts only agents currently in the `asking` state.
`channelAttributedAskORefs` (`frontend/app/view/agents/channelderive.ts:92-96`) early-returns an empty set
unless some agent is live and asking; `channelPendingAskCount` (`:109-111`) is its size, and
`standalonePendingAskCount` (`:117-121`) is the disjoint remainder. `navrail.tsx:43-50` renders the two.

A run holding at its gate has no asking worker — the phase completed and the run is waiting on a human. So
`reviewGate` (`frontend/app/view/agents/runmodel.ts:54-68`, a pure check on `run.status ===
"awaiting-review"` plus phase shape) never contributes to any badge.

The correct list already exists and is unreachable. `buildNeeds`
(`frontend/app/view/agents/channelneeds.ts:16-50`) composes review gates, Gatekeeper escalations and blocked
workers in that order; `buildRailNeeds` (`frontend/app/view/jarvis/railneeds.ts:18-44`) spreads it across
every channel. It renders in exactly one place — the Jarvis context rail — and every surface except the
Agent one unmounts on navigation.

**The deeper cause: there is no live cross-channel run state on the frontend.** `channelsAtom`
(`frontend/app/view/agents/channelsstore.ts:10`) is filled by one `GetChannelsCommand` call
(`fetchChannelsInto`, `:45-52`) and refetched only by `loadChannels()`, which runs on boot and on channel
create / delete / rename / archive. Only the **active** channel gets live data, through row-backed run and
message streams refetched when its pinned object bumps (`loadActiveChannelStreams`, `:29-35`; the
subscription at `:159-180`). Every other channel is a photograph.

The pending-ask badge gets away with it because its liveness comes from `model.agentsAtom`, not from the
channel snapshot — the channel supplies membership, the live agent list supplies the `asking` state. A
review gate has no such live side.

### Decision

**Compute the attention list on the server and poll it.** Three reasons, strongest last:

1. Attention is a server-side fact. "A run is awaiting review" is a row in SQLite. Deriving it by shipping
   every channel's entire run array to the client and filtering scales with total runs rather than with the
   number of things actually waiting.
2. It gives future attention sources one place to land — failed background jobs, Radar findings needing
   triage, a dead run are all server-side facts.
3. **The structure the frontend alternative would build on is scheduled for deletion.**
   `channelsstore.ts:23-25` documents the embedded per-channel runs and messages arrays as a legacy
   dual-write — *"Phase 2's list-membership signal; Phase 3 replaces this"* — and the active channel already
   reads row-backed streams instead. Making the global channel list live means investing in the blob
   immediately before it goes away.

**The objection that was checked and cleared.** The concern was that a blocked worker's `asking` state is
frontend-only knowledge from the external status reporter. It is not: the states are defined server-side
(`pkg/baseds/baseds.go:32-39`), asks flow through the server as `AgentAskData` carrying a timestamp
(`:85-92`), pending asks are registered in `pkg/agentask`, and `pkg/jarvis/resolve.go:91-133` already
resolves an asking worker back to its owning channel and run phase. The server can compute all three kinds.

**Poll rather than push, at 10 seconds.** `frontend/app/view/agents/backgroundagentspoller.tsx` is an
always-mounted, renders-nothing 10-second poll driver whose own header states the interval was chosen "so a
`blocked`/needs-input background agent surfaces quickly." Same class of signal at the same urgency; a second
mechanism for it would be worse than a slightly slower one. Push requires auditing every mutation site now,
and its failure mode — a missed emission — is invisible, whereas a missed poll self-heals on the next tick.
Because the RPC command is the contract, converting to push later is a backend-internal change that does not
touch the consumer.

### Design

**One command.** `GetAttentionCommand(ctx) (*CommandGetAttentionRtnData, error)` on `ChannelCommands`
(`pkg/wshrpc/wshrpctypes_channels.go:12`), implemented in `wshserver/wshserver_channels.go` alongside the
existing channel handlers. No new `waveobj` type and no new table, so **no migration**. Adding a command
means `task generate`.

**The item.**

| Field | Meaning |
|---|---|
| `Kind` | `gate` \| `escalation` \| `ask` |
| `Key` | identity, stable **across polls** for the same waiting thing, so a 10-second refetch does not remount every row |
| `ChannelId`, `ChannelName` | **empty for a standalone agent** — see coverage below |
| `RunId` | present for a gate, and for an ask whose worker belongs to a run phase |
| `Source` | what it is about (the run's goal, the worker's name) |
| `Text` | the question, or the prompt to act |
| `Action` | `Review` \| `Decide` |
| `WaitingSince` | epoch ms. **New** — nothing records this today, which is why "waiting 41m" is not expressible |

**Coverage: standalone agents are in the same list.** Today two disjoint badges are maintained by two
derivations that must agree — `channelderive.ts:113-116` documents the disjointness and that they sum to the
fleet-wide total. The server returns every pending ask tagged with a channel id or an empty one; the Jarvis
badge is the count with a channel, the Cockpit badge the count without. The property becomes structural, and
the second frontend counting path is deleted rather than left as the odd one out.

**Ordering.** Kind first — gates, then escalations, then asks, preserving the order `buildNeeds` already
uses, which is a real priority claim: a gate blocks a pipeline, an ask blocks one worker. Within a kind,
oldest first, which is what `WaitingSince` buys.

**Two changes in the pending-ask registry** (`pkg/agentask/agentask.go`):

1. It has `Set`, `Get`, `Drop` and `Claim` but no way to enumerate (`:35-70`). Add `List()`.
2. `PendingAsk` (`:17-21`) stores ask id, block id and questions but no timestamp, while the event that
   creates it already carries one. Store it.

**Frontend.** One always-mounted `AttentionPoller` mirroring the background-agents driver, 10 seconds,
writing a single atom in the cockpit shell (`frontend/app/view/agents/cockpitshell.tsx` is the always-mounted
home for cross-surface concerns). Two consumers: the nav-rail badges read counts, the Jarvis context rail
reads the list.

The Space-scope "outside focus" marking stays on the frontend. It is a view concern, and channel ids are all
it needs.

### What gets deleted

Not duplicated — **deleted**, so Go becomes the only definition:

- `frontend/app/view/jarvis/railneeds.ts` (cross-channel spread) and its test
- `frontend/app/view/agents/channelneeds.ts` (composition) and its test
- the counting paths in `frontend/app/view/agents/channelderive.ts` — `channelAttributedAskORefs`,
  `channelPendingAskCount`, `standalonePendingAskCount` — and their tests

**The leaf predicates need deciding, not assuming.** `channelneeds.ts` is their only production caller, so
deleting it strands two of the three:

- `reviewGate` (`runmodel.ts:54`) — no remaining caller. **Delete it and its tests** rather than leave an
  exported function nothing reaches. The consolidated-surface backlog made exactly this call once already
  (item JC7, on a dismissed-runs filter no input could write): a dead path is a trap for the next reader.

  > **Corrected during implementation (2026-07-31): this was wrong, and `reviewGate` was kept.** It has a
  > second production caller this spec missed — `phaseThread` (`runmodel.ts:206`) sets `showGate` from it to
  > draw the run-detail view's gate card, and `currentPhaseIndex` (`:97`) focuses the gated phase. Both take
  > a `Run` and return view state, so neither can read the polled attention atom. The deletion rationale was
  > "no remaining caller"; with callers, the decision inverts. Its tests were kept for the same reason. Only
  > `escalationPending` genuinely stranded and was deleted.
- `escalationPending` (`jarviscards.ts`) — same, no remaining caller. Delete.
- `pendingAsks` (`jarviscards.ts`) — **survives.** `channelHasAsk` (`channelderive.ts:82-86`) still uses it,
  and `subjectscolumn.tsx:311` still uses that for the Subjects column's per-channel asking dot. Keep both.

The Go implementations of the two deleted predicates are the port targets, so the logic moves rather than
disappearing.

---

## 2. A past-work matcher that records whether it ran

### Problem

**Measured 2026-07-31** against both live SQLite stores (database plus write-ahead log and shared-memory
file, so recent writes were included), counting runs in `db_run` carrying `jarvis:proactive`:

| Slice | Runs | Carrying an evaluation | Hits |
|---|---|---|---|
| Packaged app (`dev.arc.app`), all real work, 2026-07-20 → 07-23 | 18 | 0 | 0 |
| Dev app (`dev.arc.app-dev`), before embeddings were enabled | 18 | 0 | 0 |
| Dev app, on/after 2026-07-27 | 19 | 1 | 0 |

All 18 production runs predate 2026-07-27, when embeddings became enableable, so that zero is explained. All
19 dev runs after that date are CDP verification dispatches (`spawn-test only: do nothing…`, `ZZZ-4242`,
`ZZZ-7373`). One recorded an evaluation, returning `none`.

**18 of 19 recorded nothing at all.** The evaluator has six ways to finish without a trace: the embedding
index fails to open or the vault fails to open (`pkg/jarvisproactive/proactive.go:50-61`, both return an
error the caller only logs), embeddings are unavailable (`:67-69`, invariant 10), the query errors
(`:70-76`, invariant 11), the metadata write fails
(`pkg/wshrpc/wshserver/wshserver_runs.go:277-283`), or the detached goroutine never completes within its
90-second budget (`:61-67`, `:265-266`).

The design intent was right — a non-essential feature must never fail a run. The cost is that **absence
means six different things**, which is why this question had no answer before today.

### Design

**A record is written before the work starts.** The detached goroutine's first statement stamps the run's
metadata with a `started` marker. This is the half that matters: without it, "never ran" and "ran and
no-op'd" stay indistinguishable, and "never ran" is the state 18 of 19 dispatches are in. A run left holding
`started` is a timeout or a crash, and it is visible.

First statement of the goroutine rather than synchronously in `CreateRun`: synchronous would be marginally
more reliable but adds a database round trip to user-facing dispatch latency, and a goroutine that cannot be
scheduled is a runtime problem, not an observability one.

**Every terminal path overwrites it with a reason.** `EvaluateDispatch`'s contract changes from "returns nil
for a total no-op; the caller leaves metadata untouched" to "always returns something to persist." The
caller stops returning early on a nil result or an error.

**Shape: keep the verdict, add the diagnostic.** `ProactiveSuggestion.Status`
(`pkg/jarvisproactive/suggestion.go:22-30`) becomes `pending` | `hit` | `none` — the product answer, did a
card render, with `pending` as the pre-work marker written before evaluation begins. A new `Reason` field
carries why a `none` is a none: `no-candidates`, `judge-declined`, `judge-error`, `embeddings-off`,
`index-error`, `vault-error`, `query-error`.

The split matters: `Status` answers "should anything render", `Reason` answers "why not". Keeping the
diagnostic out of the status vocabulary means the frontend never enumerates failure values —
`frontend/app/view/agents/proactive.ts` renders only on `status === "hit"` and **needs no change**, including
for the new `pending` value, which it already treats as not-a-hit.

### A deliberate invariant change

Invariant 10 states that embeddings being off is a total no-op leaving `run.Meta` untouched. This breaks it
on purpose. The invariant protects a run from a non-essential feature's failures; writing one metadata field
on a non-fatal path preserves that protection while removing the blindness. Recorded here so a future reader
does not "restore" it.

---

## Verification

**Coverage moves before the TypeScript is removed.** The cases in `channelneeds.test.ts`,
`railneeds.test.ts` and the badge-split cases in `channelderive.test.ts` are ported to Go table tests
*first*. This is an acceptance criterion, not a suggestion — a migration that quietly drops test cases is how
the review-gate gap arrived.

**Go tests.**

1. The attention builder — ported cases, plus ones that do not exist today: a review gate in a channel that
   is not active, ordering across kinds, oldest-first within a kind, and a pending ask with no channel
   yielding an empty channel id.
2. The pending-ask registry — the new enumeration method and the stored timestamp, including that a claimed
   ask leaves the list.
3. The evaluator's reason paths. `pkg/jarvisproactive/proactive_test.go` already covers a hit, a declining
   judge, a below-threshold prefilter, self-exclusion and a disabled index; each gains a reason assertion,
   plus new cases for the index and vault open failures.

**Trap:** `pkg/jarvisproactive` depends on the embedding package, so its tests need the `CGO_CFLAGS` include
path for the vendored sqlite-vec header in **Windows form**. A Git-Bash POSIX path fails with an
identical-looking error.

**Frontend unit tests, deliberately thin.** The only pure client logic left is the badge split (items with a
channel versus without) and the Space-scope "outside focus" marking. No render tests, matching the standing
decision that "does it render" is covered live.

**The live check.** A CDP scenario:

1. Arrange a channel and a run, then put the run at its gate by calling the phase-report command with the
   `hold` action — the same path `wsh jarvis hold` uses (`cmd/wsh/cmd/wshcmd-jarvis.go:21-33`). Driving a
   real agent to a gate would take up to two minutes; this takes a round trip.
2. Select a **different** channel, then navigate to a surface that is not Jarvis.
3. Assert the nav-rail badge is non-zero.

That sequence is the whole defect in three steps: today step 3 reads zero.

**Each fix is broken on purpose.** Revert the server-side gate detection and step 3 must go red; stop the
poller firing and it must go red for a different reason. A green scenario that cannot fail is not a net.

---

## Tuned constants

One: the **10-second poll interval**, inherited from the background-agents poller rather than picked. The
90-second evaluator timeout is untouched and remains a placeholder recorded in `docs/deferred.md`.

## Scope boundaries

Deliberately **not** in this spec:

- **A shell-level attention drawer.** The badge is corrected; the list keeps its single home in the Jarvis
  context rail. A second renderer is added when the destination hop proves annoying — and when it is, the
  list component moves out of the surface rather than being copied.
- **Push delivery.** Polling first; the command is the contract, so this is reversible.
- Unifying the two nav-rail badges into one. They stay disjoint; only their source changes.
- **The Subjects column's per-channel asking dot.** `channelHasAsk` (`channelderive.ts:82-86`), read by
  `subjectscolumn.tsx:311`, derives from the same channel snapshot and could trivially read the new atom
  filtered to `kind: "ask"` for that channel — removing one more duplicate. Considered and held back: it
  changes a rendered control outside this cycle's stated scope, and unlike the badge it is not currently
  wrong (its liveness comes from the agent list, same as the ask badge). Fold it in only when something
  else touches that file.
- Any new attention source (failed background jobs, Radar triage). The shape admits them; this cycle does
  not add them.
- Anything about the floating companion, which the source brief defers pending the measurement this spec
  makes possible.

## Documentation

`docs/jarvis-tab.md` § 12 (entry points from other surfaces) describes the attention list's single home and
changes. `docs/jarvis-consolidation-open-issues.md` gains no new item — the review-gate gap was never tracked
there. The source brief's "what to do next" list has items 1 and 2 closed by this spec; item 3 (dispatch real
work, then re-run the measurement) becomes possible once this ships. Both edits are part of the
implementation, not a follow-up.

## Risks

- **The pending-ask registry is in-memory and process-wide** (`pkg/agentask/agentask.go:23-33`), so pending
  asks do not survive a `wavesrv` restart. The current frontend path degrades identically — agent state
  arrives as events and goes stale after a restart until the next hook fires — so this is parity, not a
  regression. The attention list is authoritative for the current server lifetime, not absolutely.
- **Up to 10 seconds of staleness** in the badge, by construction.
- **Adding an RPC command requires `task generate`.** The known bootstrap trap in this repo applies to
  *removing* commands; adding one is the safe direction, but the frontend deletions must land after the
  regenerated client, not before.
