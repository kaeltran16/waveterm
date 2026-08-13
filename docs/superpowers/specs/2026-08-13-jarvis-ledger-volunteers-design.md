# Jarvis Ledger Volunteers — Design Spec (Axis 2: delivery, row 3)

> 2026-08-13. The pet learns to volunteer the work ledger: what shipped, what is waiting
> on you — gated by the autonomy ladder's set initiative. Axis 2 row 3 of the
> [jarvis improvement map](2026-08-12-jarvis-improvement-map-meta-design.md), the last
> remaining build item on that map. Reads on the
> [volunteered-knowledge design](2026-08-06-jarvis-volunteered-knowledge-design.md) (the
> spine this extends — its §9 explicitly reserved this shape: "a fourth `Producer`
> implementation and a fourth `PetEvent` kind"), the
> [work-ledger spec](2026-08-12-jarvis-work-ledger-memory-design.md) (the engine it
> reads), and [`docs/jarvis-tab.md`](../../jarvis-tab.md).

## 1. Why

The improvement map's Axis 2 row 3: **"Pet volunteers ledger facts at the autonomy
ladder's set initiative (Concierge quiet / Gatekeeper volunteers / Delegator acts)"**,
deferred on 07-31 because content was thin and unblocked once the ledger shipped —
*"the ledger is the engine, and the ladder is the volume knob."*

The ledger landed (Axis 1): `pkg/jarvisstate` derives ActiveWork/Shipped/Delta from the
two lossless legs, and `JarvisStateCommand`/`JarvisAskCommand` expose it. The volunteer
spine landed earlier (08-06): three knowledge classes (recall / connection / loose-end),
one stateless `Producer` each, a cheap-tier judge picking at most one utterance per quiet
window, say-once enforced by the frontend watermark against fact-stamped `(At, ID)`
pairs. What the pet may *say* is fixed by that 08-06 spec's bar — *"the intelligence must
already exist"* — and the ledger is the first engine that now exists that the pet does
not read.

The user lives at delegator; the design therefore places the value at gatekeeper+ (the
rung delegator implies) and leaves the default tier untouched.

## 2. Decisions taken (this session)

1. **Facts:** the pet may volunteer two ledger facts — *shipped* (7-day window of
   completed runs with sealed evidence) and *needs-you* (attention items). Active work,
   decisions, and the delta/bring-up stream stay with the landing briefing.
2. **Gating:** trigger-scoped to tier. Run-created/run-rest triggers already carry the
   run's `ChannelID`; ledger candidates join only when that channel's meta has
   `gatekeeper:enabled` or `delegator:enabled` (nested). The hourly unattended sweep
   never adds ledger facts — it has no initiating channel.
3. **Rung mapping:** only the new class is tier-gated. The existing three classes behave
   identically at every tier. Concierge = today's behavior, unchanged. Gatekeeper+ adds
   the ledger register. Delegator gets nothing extra from the pet — its differentiator
   is acting, not talking more.
4. **Shape:** per-fact candidates (one per shipped run, one per attention item), ranked
   recency-desc, competing in the ordinary shortlist. Not one summary per class.

## 3. Architecture

A fourth `Producer` implementation in `pkg/jarvisvolunteer`. Nothing about the cadence,
the judge, or the watermark changes.

```
  run-created / run-rest trigger (wshserver_runs.go, carries ChannelID + RunID)
    └─ EvaluateAsync
         └─ producers: recall, connection, loose-end, ledger   ← new
              └─ LedgerProducer
                   ├─ tier gate: channel meta gatekeeper:enabled | delegator:enabled
                   ├─ GetChannelRuns(channelId) → jarvisstate.Shipped(runs, now-7d)
                   ├─ jarvis.GatherAttention → filter to the channel's runs
                   └─ candidates: per-fact, fact-stamped (At, ID), recency-desc
         └─ prefilter (dedupe, drop At==0, cap 5)
         └─ judge (cheap tier) → pick or none
         └─ Publish jarvis:volunteer {class:"ledger", ...}
              └─ petsources.tsx → eventFromVolunteer → PetEvent{kind:"ledger"}
                   └─ petbubble (KIND_LABEL "Work state") / peek / watermark
```

**`ClassLedger = "ledger"`** — "the state of your work": what shipped, what's waiting on
you. One const alongside the three existing classes.

**`LedgerProducer`** (`pkg/jarvisvolunteer/ledger.go`), the stateless `Producer` pattern
with function-field seams for tests, exactly like `RecallProducer`/`LooseEndProducer`:

| Seam | Default |
|---|---|
| `loadChannel` | `wstore.GetChannels` → find by ID (no GetChannel-by-id exists; this mirrors `jarvisstate/fetch.go`'s scan) |
| `getRuns` | `wstore.GetChannelRuns(channelId)` |
| `gatherAttention` | `jarvis.GatherAttention` |
| `now` | `time.Now().UnixMilli()` |

`Candidates(ctx, t)`:

1. `t == nil || t.ChannelID == ""` → nil (run-scoped, like `RecallProducer`).
2. **Tier gate** — load the channel; neither `gatekeeper:enabled` nor `delegator:enabled`
   set → nil. Same meta read `pkg/jarvis/resolve.go` `ResolveGatekeeperChannel` uses
   (`ch.Meta.GetBool`).
3. Fetch the channel's runs; derive shipped via the reused pure
   `jarvisstate.Shipped(runs, windowStartMs)` — single source of truth for "what counts
   as shipped" (status `done` **and** sealed `Evidence`, sorted CompletedTs desc).
4. Fetch attention via `jarvis.GatherAttention`; filter to items whose `RunId` is in the
   channel's run set — "needs-you in this channel".
5. Emit candidates (§4), sorted `At` desc.

**Wiring:** `producersFor` (volunteer.go) appends `NewLedgerProducer()` to
`TriggerRunCreated` and `TriggerRunRest`; not `TriggerSweep`. Import direction
jarvisvolunteer → jarvisstate → jarvis is acyclic (verified; nothing imports
jarvisvolunteer except `wshserver_runs.go`).

**Frontend, two lines:** `"ledger"` in `VOLUNTEER_KINDS` (petjoin.ts) and one
`KIND_LABEL` entry in petbubble.tsx. That Record is exhaustive over `PetEvent["kind"]`,
so TypeScript enforces the addition. `eventFromVolunteer` and the watermark pass the new
class through unchanged.

**No wire changes:** the class is a string in the existing `baseds.VolunteerData`; no
new RPC, no `waveobj` type, no `task generate`, no SQL migration.

## 4. Candidate derivation

Per-fact candidates, per decision 4. `ID` and `At` are stamped from the FACT, never from
`time.Now()` — the watermark's say-once contract (an unchanged fact re-emitted after a
restart carries an identical pair and dies silently).

| Fact | Derivation | `ID` / `At` | Title | Snippet |
|---|---|---|---|---|
| Shipped run | `jarvisstate.Shipped(runs, now-7d)` | `ID: "shipped:"+RunOID`, `At: CompletedTs` | `shipped: <goal>` | evidence `Summary`, truncated ~140 chars |
| Needs-you | `GatherAttention` ∩ channel's runs | `ID: "attention:"+RunId`, `At: WaitingSince` | `needs-you: <source>` | `<action>: <text>` |

Both carry `SourceType: "run"` and `SourceRef: "run:"+<oid>` — the same ref shape the
briefing's `NavTarget` uses. Say-once is free: a shipped run ships once; a cleared
attention item vanishes from `GatherAttention`; a *new* waiting item gets a new RunId →
new pair.

**Ranking:** return all candidates sorted `At` desc (freshest first). `prefilter` keeps
the first 5 unique IDs across all producers, so a busy week's shipped runs cannot crowd
the shortlist — the judge always sees the 5 freshest things any producer noticed.

## 5. Data flow

One run-created event on a gatekeeper+ channel:

```
wshserver_runs.go → EvaluateAsync(Trigger{run-created, ChannelID, RunID})
  → recall / connection / loose-end / ledger producers
  → ledger: tier gate → GetChannelRuns → Shipped(7d)
          → GatherAttention → filter to channel's runs
  → prefilter (dedupe, drop At==0, cap 5)
  → judge (cheap tier, one call) → pick or none
  → Publish jarvis:volunteer {class:"ledger", id, at, title, text,
                              sourcetype:"run", ref:"run:<oid>"}
  → petsources.tsx (subscribed + backlog) → eventFromVolunteer
  → PetEvent{kind:"ledger"} → petbubble / peek; watermark dedupes re-emissions
```

## 6. Error handling

Inherits the spine; no new paths.

- Any seam failure (tier read, run fetch, attention fetch) → `collect()` logs and skips
  the producer; the other three still contribute; silence, never a failed run, never a
  visible error (the 08-06 contract).
- Run without sealed evidence → not "shipped" by `Shipped()`'s own filter; no candidate.
- Undatable fact (`CompletedTs`/`WaitingSince` == 0) → candidate dropped at the source;
  `prefilter` discards `At==0` anyway.
- Judge unavailable → existing `ReasonJudgeError` / `ReasonJudgeDeclined` paths.

## 7. Testing

Repo conventions: pure seams, no jsdom render tests.

- `ledger_test.go` — fixture channel + runs + attention through the seams:
  - tier off (no meta) → nil candidates; `gatekeeper:enabled` → shipped + attention
    present; `delegator:enabled` → same (nested implication);
  - `ID`/`At` stamped from fact timestamps, not `now()`; recency sort; `At==0` dropped;
  - any seam failure → error returned (collect treats it as a skip), never a panic;
  - empty 7-day window → no shipped candidates, attention can still speak.
- `volunteer_test.go` (existing) — `producersFor` includes ledger for run triggers and
  excludes it for the sweep.
- Frontend: `eventFromVolunteer` with `class:"ledger"` → `PetEvent{kind:"ledger"}`
  (petjoin test convention); the exhaustive `KIND_LABEL` Record compile-fails until
  petbubble gains its entry — that is the coverage.
- No CDP scenario: pure event plumbing, no atom-hop state (same reasoning as the
  work-ledger spec §7).

## 8. What changes

- `pkg/jarvisvolunteer/ledger.go` (new)
- `pkg/jarvisvolunteer/volunteer.go` — `ClassLedger` const, `producersFor` append
- `frontend/app/view/jarvis/petjoin.ts` — `VOLUNTEER_KINDS`
- `frontend/app/view/jarvis/petbubble.tsx` — `KIND_LABEL`
- `pkg/jarvisvolunteer/ledger_test.go` (new); producer-list assertions in the existing
  volunteer test

## 9. Named open calibrations

Not tuned now — the map's discipline (and both constants are explicitly UNFITTED today):
constants get changed on evidence, never in the same cycle as the feature.

- **Shortlist starvation:** `shortlistMax=5` with ledger appended last. If
  recall+connection+loose-end routinely fill all five slots, ledger facts never reach
  the judge. Mitigations if dogfooding shows it: raise to 7, or reorder producers.
- **Quiet window** (45 min, shared across classes): unchanged; revisit with the count of
  `ReasonRateLimited` against actual utterances, as its comment already directs.

## 10. Out of scope

- Pattern detection — the 08-06 §9 deferred fourth class ("a pattern is forming");
  needs a new derivation and the J5 calibration discipline. Still out.
- Tier-gating the existing three classes (concierge goes quiet on everything).
- Delegator-specific aggressiveness (shorter quiet window, extra slots).
- Sweep-trigger participation in ledger facts.
- Per-channel volunteers (scope-less events are the 08-06 model).
- Delta/bring-up, active work, and decisions as pet facts — the briefing owns them.
