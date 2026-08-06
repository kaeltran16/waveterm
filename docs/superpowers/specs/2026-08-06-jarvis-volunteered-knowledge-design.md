# Volunteered knowledge — the creature says what it knows, not what the system did

**Date:** 2026-08-06 · **Status:** Design settled, implemented 2026-08-06.
**Type:** Design doc. It settles what Jarvis may volunteer unasked, what decides whether it speaks,
how an utterance reaches a destination, and where the boundaries of this cycle are. It is not an
implementation plan; the plan is written separately.

**Scope split.** Four classes of volunteered knowledge were chosen. Three are built here. The fourth —
*a pattern is forming* — is deliberately **out of scope** and gets its own spec; see §9.

---

## 1. Why

The pet design ([2026-08-04](2026-08-04-jarvis-pet-design.md)) opened from the observation that *the system
knows a great deal that it never says*, and built a creature in window chrome to say some of it. It works.
But look at what the creature is actually allowed to talk about, across all three of its registers:

| Register | Vocabulary | Source |
|---|---|---|
| Condition (rank-1 expression) | `cannot-see` · `tired` · `drifting` · `at-rest` | `frontend/app/view/jarvis/petcondition.ts` |
| Posture | `review-gate` · `escalation` · `blocked-worker` | same file, `postureFor` |
| Voice (utterances) | `resume` · `sweep` · `distill-batch` · `notes-written` · `bg-agent-done` | `frontend/app/view/jarvis/petvoice.ts` |

Every one of those reports on **the system's own housekeeping** — the embedding index is stale, the rate
limit is depleting, the vault gardener swept, a distillation batch ran, notes were written. Not one of them
is a thing Jarvis *knows about your work*.

Meanwhile the knowledge engines are all built and all producing. The gap is not intelligence, it is
**delivery**:

| Engine | Produces | Reaches you how |
|---|---|---|
| `pkg/jarvisproactive` | A relevant past item, judged at every run dispatch, persisted to the run's metadata | Only if you navigate to that run's channel — `frontend/app/view/jarvis/ambientrail.ts` scopes it to the subject on the Stage |
| `pkg/jarvisattrib` | Dossier→run attribution edges with provenance and confidence | Ambient tags on rows you are already looking at |
| `pkg/jarvisdossier` | Dossier status, blockers, last-touched time; decisions with rationale | The record thread, once you select that record |
| `pkg/jarviscontinuity` | A resume narrative at every run rest-transition | One rail section on one surface |

The pattern is uniform: **Jarvis computes at the right moment and then waits at a location you must
navigate to.** The proactive suggestion is the sharpest case — a model call already ran, a judgement was
already made, the answer is already on disk, and it is invisible unless you happen to walk past it.

So the statement of the problem for this cycle:

> **Jarvis waits to be asked. It should volunteer — and what it volunteers should be knowledge, not
> housekeeping.**

### What this deliberately is not

Scattering Jarvis cards across the other eight surfaces. That is the pattern the ambient rail design
([2026-08-03](2026-08-03-jarvis-ambient-rail-design.md)) spent a whole cycle *removing*, having traced
three separate defects to one root cause — Jarvis views placed per render branch. This design adds no new
placement: it widens what an existing, already-mounted creature is allowed to say.

---

## 2. The three classes

Each class answers a different question, and each reads an engine that already exists.

| Class | The question it answers | Reads |
|---|---|---|
| `recall` — *"You've been here before"* | Have I done something like this before, and how did it go? | The proactive suggestion already persisted at dispatch |
| `connection` — *"This just connected"* | Did work I just finished attach to something I care about? | Attribution edges, and decisions on the same dossier |
| `loose-end` — *"Still open"* | What did I leave open that is going quiet? | Dossier status, blockers and last-touched time |

The classes were chosen against one bar: **the intelligence must already exist.** Every one of the three is
a read of committed, durable state. None of them adds a retrieval pass, a new model prompt, or a new
derivation. That bar is what keeps this cycle small and is why the fourth class is deferred (§9) — it is
the only one that fails it.

---

## 3. Architecture

A new Go package, **`pkg/jarvisvolunteer`**, owns the whole decision of whether Jarvis speaks and what it
says. One package, on purpose: the precedence and cadence rules must live in exactly one file, for the same
reason `petcondition.ts` states that its strict expression precedence "lives here and nowhere else". Split
across producers, the cadence rule would become emergent, and an emergent interruption rate is exactly the
defect that gets a feature like this switched off.

The pipeline copies the staging of `pkg/jarvisproactive/proactive.go`, because that shape has already
survived contact with a real vault:

```
trigger
  └─> rate gate         deterministic. inside the quiet window => stop. no reads, no model call.
  └─> collect           each producer contributes candidates. bounded reads, no model.
  └─> prefilter         drop already-emitted ids, cap the shortlist.
                        empty => reasoned sentinel, NO MODEL CALL.
  └─> judge             consult.SpecForTier("claude", consult.TierCheap) picks one, or declines.
  └─> publish           wps.Broker.Publish with a Persist window.
```

**Why the rate gate runs first.** Putting it before collection means a quiet-window trigger costs zero
reads and zero tokens. The cost is that a genuinely urgent candidate waits out the window — accepted,
because there is no urgency signal to distinguish one, and inventing one would be the speculative
abstraction this design is trying to avoid. Nothing is lost by waiting: see the statelessness property in
§4.

**Why the model judges at all.** The alternative considered was a static precedence table plus a hard rate
limit, mirroring `EXPRESSION_RANK` in `petcondition.ts` — fully pure, zero cost, trivially testable. It was
rejected because rank answers "which class outranks which", and the actual question is "is any of these
worth interrupting for **right now**", which is contextual and not expressible as a fixed order. The cheap
tier is right for it on the same reasoning `proactive.go` records for its own judge: picking one shortlist
entry or "none" is bounded classification, not synthesis.

**Where determinism stays.** The model chooses *what*; code chooses *whether now*, *how often*, and *never
twice*. The rate gate, the dedup and the retry policy are all deterministic and unit-testable. This is the
standing rule — model for judgment, code for determinism — applied at the seam.

### Every terminal path names its reason

`no-candidates` · `rate-limited` · `judge-declined` · `judge-error` · `vault-error` · `index-error` ·
`producer-error`.

Not decoration. `proactive.go`'s own comment records why: returning nothing on failure "is what made six
distinct failures indistinguishable from never having run." It also supplies the cost audit that choosing a
model judge obliges us to have — counting `no-candidates` against `judge-declined` answers "how often are
we paying for a call that says nothing", which is the number that decides whether the judge was the right
call at all.

---

## 4. Two properties that remove work

### Producers are stateless readers of durable state

No producer owns a queue, an outbox, or a cursor. Each one re-reads durable facts on every trigger. The
consequence: **a dropped, failed or rate-limited trigger loses nothing** — the next trigger re-reads the
same facts and the candidate is still there. There is no delivery guarantee to engineer because there is
nothing in flight to lose.

### Idempotence falls out of the existing watermark — so there is no new table

`frontend/app/view/jarvis/petstore.ts` already persists a watermark to `localStorage` under
`wave:pet.watermark`, and `nextUtterance` in `petvoice.ts` only considers events strictly newer than it,
comparing `at` first and breaking ties on `id`. That machinery exists to make "push once per event" survive
a relaunch.

It generalizes for free **if the backend stamps each utterance from the fact rather than from the moment of
emission**:

- `ID` — derived from the fact (class + source reference + a coarse time bucket where re-firing after long
  silence is wanted, as with a loose end).
- `At` — derived from the fact (the run's end time, the dossier's last-touched time), **never**
  `time.Now()`.

A re-emitted identical fact then carries an identical `(at, id)`, fails `isNewer` against the stored
watermark, and dies silently. Idempotence needs no server-side said-log, which in turn means **no new
registered `waveobj` type and no `db/migrations-wstore` migration** — a genuine saving, since a new
registered type without its migration fails at runtime with "no such table".

The in-process prefilter still tracks recently-emitted ids, but only to avoid *paying for a judge call* on
a candidate the frontend would discard. It is a cost optimisation, not the correctness mechanism, so losing
it to a `wavesrv` restart is harmless.

---

## 5. The producers

One small interface, three implementations.

```go
type Candidate struct {
    Class      string // "recall" | "connection" | "loose-end"
    ID         string // stable, derived from the fact
    At         int64  // stable, derived from the fact — never emission time
    Title      string
    Snippet    string
    SourceType string // "dossier" | "decision" | "memory" | "run"
    SourceRef  string // frontend navigation address (see §7)
    Anchor     string // optional: sub-object to highlight within SourceRef
}

type Producer interface {
    Name() string
    Candidates(ctx context.Context, t *Trigger) ([]Candidate, error)
}
```

### `recall` — reads a judgement that already happened

`jarvisproactive.EvaluateDispatch` is already called at run creation from
`pkg/wshrpc/wshserver/wshserver_runs.go:292`, in a detached goroutine, and persists a `ProactiveSuggestion`
to the run's metadata. Today that only reaches a user who navigates to the run's channel.

This producer reads a `StatusHit` suggestion back out and shapes it as a candidate. **It adds no retrieval
pass and no model call** — the embedding query and the relevance judge both already ran at dispatch. The
`StatusNone` sentinels are skipped, which is what they were built for.

- `ID` — run OID plus the suggestion's node id.
- `At` — the run's creation time.
- `SourceRef` — resolved per §7 from the suggestion's `SourceType` (`dossier` / `decision` / `memory`).

### `connection` — reads the attribution engine

`jarvisattrib.AllEdges(ctx, v)` already returns every dossier's edges in one shared read, with a per-run
commit cache; it was built for the `ResolveAmbient` command precisely because the ambient layer needs the
object→dossier direction for every object at once.

A candidate is an edge whose run recently reached rest. Decisions bearing on the same dossier come through
`jarvisdossier.LoadDecision`.

- `ID` — dossier id plus run reference.
- `At` — the run's end time.
- Weak/informing edges are eligible but carry their bucket, so the utterance can hedge rather than assert —
  mirroring how `jarvisgraphderive.attributionStyle` renders them dashed.

### `loose-end` — reads dossier state

`jarvisdossier.Dossier` already carries `Status`, `Blockers` and `Updated`. A candidate is a dossier that
is non-terminal **and** either untouched past a threshold or blocked.

- `ID` — dossier id plus a **resurface bucket**: the `Updated` stamp floored to a named constant interval,
  so a loose end that stays untouched can be raised again after a long silence but cannot nag daily. The
  bucket width is one of the three unfitted constants inventoried below, sized alongside the staleness
  threshold and documented the same way.
- `At` — the dossier's `Updated` stamp, floored to the same bucket, so the `(at, id)` pair stays stable
  across re-emissions of one bucket. Stamping `At` with the raw `Updated` value while bucketing `ID` would
  break the idempotence property in §4: the watermark compares `at` first.

### Triggers — all existing cadences

| Class | Trigger | Already exists as |
|---|---|---|
| `recall` | Run created | The detached goroutine at `wshserver_runs.go:292` that calls the dispatch-time proactive evaluation |
| `connection` | Run reaches rest | `wshserver_runs.go:442` — the guarded rest-transition (`jarviscontinuity.IsRestState(postRun.Status) && postRun.Status != preStatus`) that already calls `CaptureRunBoundary` to write the continuity narrative |
| `loose-end` | The unattended hourly pass | The ticker the memory gardener and distillation coordinator already ride (`memdistill/activity.go`: "the unattended passes ride an hourly ticker") |

No new scheduler, no new daemon.

### The one calibration risk, named

The `loose-end` "untouched past a threshold" number is exactly what the second-brain backlog's calibration
item (**J5**, `docs/jarvis-second-brain-open-issues.md`) exists to warn about: it inventories every tuning
constant in the feature as an uncalibrated placeholder.

**Mitigation, and it is a required step of the plan, not a nicety:** fit the threshold by measuring the
actual distribution of `Updated` ages across the real vault's dossiers before picking a number, and record
the derivation in the constant's own comment. The model to follow is `pkg/jarvisproactive/gate.go`, whose
`cosThreshold` comment states the measured range, the probe results, the chosen value, *and* that the
previous 0.82 was set by false analogy and admitted nothing at all. A constant that cannot say where it
came from is the defect J5 is tracking.

**The full inventory — three constants, none of them fitted at design time:**

| Constant | Governs | How it gets a value |
|---|---|---|
| Staleness threshold | How long untouched makes a dossier a loose end | Measured against the real vault's `Updated` distribution, per above |
| Resurface bucket width | How long before one loose end may be raised again | Sized with the threshold; must be the coarser of the two, or a loose end re-fires before it has gone stale again |
| Rate-gate interval | Minimum silence between any two utterances | Shipped conservative, adjusted on evidence |

All three ship on the quiet side, because the failure modes are asymmetric: too quiet is a feature that
underdelivers, too chatty is a feature that gets turned off. Each one carries a comment stating what it
governs and whether its value was measured or chosen — a constant that cannot say where it came from is the
defect J5 is tracking.

---

## 6. Delivery

The creature's existing pipe is reused wholesale.

**Transport.** `wps.Broker.Publish` with a `Persist` window, mirroring `memdistill.PublishActivity` exactly
— deliberately scope-less, because this is a fact about your work rather than about one object, so a
consumer subscribes by event name alone. Retained so a frontend connecting late still replays what it
missed. The buffer is in the broker's memory, so a `wavesrv` restart replays nothing; that is acceptable
here for the same reason it is for memory activity, and the statelessness property in §4 means the next
trigger re-derives anything genuinely still true.

**Subscription.** `frontend/app/view/jarvis/petsources.tsx` already subscribes to the memory-activity event
with a history backlog at mount. It gains one more subscription in exactly that shape. Its existing rule
holds unchanged: a failed read leaves the previous value alone.

**Vocabulary.** Three kinds join the `PetEvent` union in `petvoice.ts` — `recall`, `connection`,
`loose-end`. Because `petbubble.tsx` types `KIND_LABEL` as a total `Record` over that union, the compiler
refuses the change until each has a label. The register stays the design's own voice:

| Kind | Label |
|---|---|
| `recall` | You have been here before |
| `connection` | This just connected |
| `loose-end` | Still open |

**One new field.** `PetEvent` gains `source?: { ref, anchor?, title, sourceType }`. Housekeeping events
leave it unset and behave exactly as today, so nothing regresses.

**Nothing about the bubble's behaviour changes.** It still auto-dismisses after six seconds, on the
existing reasoning that "a bubble that persists until acknowledged is the thing you come to resent over a
live terminal", and it still opens the peek when clicked. See §8 decision 3 for why the new affordances do
not go on it.

---

## 7. Navigation and ask

### Navigation: one new route, not three

The first pass assumed `frontend/app/view/jarvis/openref.ts` would need new address namespaces for
decisions and for memory notes. Two readings collapsed that.

**A decision does not need its own route.** `jarvisdossier.Decision` carries `Links`, and
`DecisionFacts.TaskID` "is auto-added to the links block", so a decision always knows its parent dossier.
And a decision has no surface of its own: `frontend/app/view/jarvis/decisionlog.tsx` renders it *inside*
the record thread. So a decision candidate addresses its **parent dossier** through the `task:` route that
already works, carrying the decision id in `Anchor`. The only new frontend piece is a pending-highlight
atom that `decisionlog.tsx` reads to scroll to and flash the right card — the same shape as
`pendingRunFocusAtom`.

**The claim that memory needs new plumbing is stale.** `openref.ts`'s header says "memory and radar need
new per-object focus plumbing". `selectNote(id)` in `frontend/app/view/agents/memstore.ts` already exists
and opens the note drawer, and `memorysurface.tsx` calls it from five separate call sites. So the memory
route is `selectNote` plus a `surfaceAtom` flip. **That stale comment gets corrected as part of this work** —
leaving it costs the next reader the same hour it cost this pass.

Resulting route table for `orefNavPlan`:

| `SourceType` | Address | Route | New? |
|---|---|---|---|
| `dossier` | `task:<dossierID>` | `selectSubject({kind:"dossier"})` | no |
| `decision` | `task:<parentDossierID>` + `Anchor=<decID>` | above, plus highlight | anchor only |
| `memory` | `memnote:<nodeID>` | `selectNote` + surface flip | **yes** |
| `run` | `run:<oid>` | existing pending-focus path | no |

Using vault node ids inside oref-shaped strings is not an invention: `askAboutRecord` in
`jarvissubjectstore.ts` already builds `"task:" + dossierId` from a vault node id. **Guard worth writing
down:** these are frontend navigation addresses only, and the Go side must never push them through
`waveobj.ParseORef`, which expects a UUID.

### Ask: generalize a gesture that already exists

`askAboutRecord` already does the whole thing for dossiers — build the reference, call
`conversationForSource`, call `submitJarvisQuery`. It widens to
`askAboutSource(ref, sourceType, title, text)`.

Because `conversationForSource` keys one thread per source oref, asking twice about the same utterance
continues one thread rather than minting duplicates — the property the `jarvis-contextual` browser-driven
scenario already guards.

---

## 8. Decisions taken

1. **A new package rather than widening `pkg/jarvisproactive`.** Fewer files would be nice, and the judge
   is already there. Rejected because that package is built around one card per run, written to the run's
   metadata at dispatch, with a "recompute never" lifecycle. A stream of utterances governed by a
   watermark is a different contract, and fusing them would make one package answer to two.

2. **Backend producers rather than client-side derivation.** Deriving candidates in the browser was
   genuinely tempting — the attribution map is already loaded once per session by `ResolveAmbient`, and
   attention and decay are already in atoms, so the producers could have been pure functions over existing
   state. Rejected because the judge must run server-side regardless, and dossier state is a vault read the
   client does not hold. It would have been two implementations of one decision.

3. **The new affordances live on the peek row, not on the bubble.** The bubble vanishes after six seconds
   by explicit design; a click target on something that disappears mid-reach is a worse trap than no
   target. The peek already reads back everything said (`petSaidAtom`) and already carries the unread
   marker, so it is the natural place for a navigable list. The bubble stays clickable to *open the peek*,
   which is what it does today.

4. **The rate gate runs before collection, not after the judge.** Cheapest correct order. Cost stated in
   §3.

5. **No new database table.** Consequence of the stamping rule in §4, not an independent choice.

6. **Shipped conservative.** Both unfitted constants (the rate-gate interval, and the loose-end staleness
   threshold before it is measured) start on the quiet side. Asymmetric failure modes: underdelivering is
   recoverable, being resented is not.

---

## 9. Out of scope: *a pattern is forming*

The fourth class chosen during design — repetition across runs that no single run reveals, e.g. a third
failure this week in the same package — is **not built here**. It gets its own spec.

It is the only one of the four that fails §2's bar. The other three read committed state through an engine
that already computes; this one needs a new derivation over run history, and with it a genuinely hard
calibration question — how many repeats over what window constitutes a pattern rather than a coincidence?
J5 in `docs/jarvis-second-brain-open-issues.md` is a standing record of what shipping uncalibrated
constants against a thin corpus costs.

Splitting it out is cheap because the spine is built for it: it arrives as a fourth `Producer`
implementation and a fourth `PetEvent` kind. Nothing in §3 through §7 needs revisiting.

---

## 10. Error handling

**The hazard that dominates: the judge is slow, and this repo has been bitten by that exact shape.**
`DefaultTimeoutMs` is `5000` (`pkg/wshutil/wshrpc.go:28`) and it binds the *server's* context, so slow
synchronous handler work returns a timeout to the client even though the work completes and persists — the
Jarvis conversation seal path hit this and was fixed by dispatching off-band. The judge here is a headless
CLI process that can run for many seconds.

Therefore: **evaluation is off-band by construction** — a detached goroutine that publishes through the
broker when it finishes, never a synchronous RPC the frontend awaits. This is the same shape
`wshserver_runs.go` already uses for the dispatch-time proactive evaluation.

The remaining rules are the ones the neighbouring code already states about itself:

| Rule | Where it is already stated |
|---|---|
| Never fail the user's work — a broken vault, dead index, unavailable model or panicking producer yields silence, never a failed run and never a visible error | `proactive.go`: "a provider error degrades to no card, never fails the run" |
| One failing producer is logged and skipped; the others still contribute | new here, same principle |
| Every terminal path names its reason | `proactive.go`, and §3 above |
| A failed frontend read leaves the previous value alone | `petsources.tsx` |

---

## 11. Testing

Matching this project's conventions rather than inventing new ones. There are deliberately **no jsdom
render or snapshot tests** for surfaces; pure glue is extracted and unit-tested, and "does it render" goes
to the browser-driven smoke scenario.

**Go units**, against a fixture vault with the model mocked through the existing `SetJudgeForTest` seam:

- Each producer's candidate shape, against fixture dossiers, edges and suggestions.
- The deterministic prefilter: already-emitted ids dropped, shortlist capped.
- The rate gate: inside the quiet window, no reads happen and no judge is called.
- Reply parsing, including a declining judge and a malformed reply.
- **The idempotence property — emit the same fact twice, assert the second is silent.** Highest-value test
  here, because it is the entire justification for having no new database table.

**Frontend units** on the pure seams:

- `nextUtterance` in `petvoice.ts` with the three new kinds, including a re-emitted identical fact.
- `orefNavPlan` in `openref.ts`, including the decision-anchor and memory-note paths.
- `askAboutSource`, including that a second ask about one source continues one thread.

**Browser-driven scenario** — one new entry in `scripts/cdp/scenarios.mjs`. It must **inject a pet event
directly** rather than arrange a real utterance: a real one needs a live headless CLI run, and
`docs/jarvis-tab.md` already records that as the reason the cancel path and the thread-archive path have no
live steps. It asserts the delivery chain — bubble appears, peek lists it, clicking through lands on the
right surface with the right subject selected, and the decision anchor highlights the right card.

Each scenario step must be checked by breaking the fix and watching the right step go red. A green scenario
that cannot fail is not a net — the standard `docs/jarvis-tab.md` already holds its five regression
scenarios to.

### Verification commands

```powershell
# Go. The new package depends on jarvisembed, so a bare `go test` fails to BUILD with a missing
# sqlite3.h. The -I path must be Windows-style; a Git-Bash POSIX path fails identically and silently.
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/jarvisvolunteer/ ./pkg/jarvisproactive/ ./pkg/jarvisdossier/
```

```
npx vitest run frontend/app/view/jarvis/
node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit   # bare `npx tsc` stack-overflows
task build:backend && task verify:ui -- jarvis-volunteer
```

`task build:backend` is not optional before the browser-driven check: a new wave event and a new backend
package do nothing in a running dev app until `wavesrv` is rebuilt.

---

## 12. What this changes

| File | Change |
|---|---|
| `pkg/jarvisvolunteer/` | **New.** Producers, prefilter, rate gate, judge, publish. |
| `pkg/wshrpc/wshserver/wshserver_runs.go` | Trigger the `recall` and `connection` evaluations off-band. |
| `pkg/wps` | One new event name. |
| `frontend/app/view/jarvis/petvoice.ts` | Three new kinds; `source` field on `PetEvent`. |
| `frontend/app/view/jarvis/petbubble.tsx` | Three new entries in `KIND_LABEL`. |
| `frontend/app/view/jarvis/petpeek.tsx` | Open and Ask affordances on a knowledge row. |
| `frontend/app/view/jarvis/petsources.tsx` | One more subscription, in the existing shape. |
| `frontend/app/view/jarvis/openref.ts` | Memory-note route; decision anchor; **delete the stale header claim about memory needing new focus plumbing**. |
| `frontend/app/view/jarvis/decisionlog.tsx` | Consume a pending-highlight atom. |
| `frontend/app/view/jarvis/jarvissubjectstore.ts` | `askAboutRecord` → `askAboutSource`. |
| `frontend/app/view/agents/memstore.ts` | Nothing — `selectNote` already does the job. |
| `scripts/cdp/scenarios.mjs` | One new scenario. |
| `docs/jarvis-tab.md` | Document the volunteered register. |
