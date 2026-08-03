# Jarvis attribution: layer-derived confidence buckets + a per-collection proactive window

**Date:** 2026-08-03 · **Status:** design, approved · **Scope:** two provable defects plus a
no-cost corpus probe and a tracker rewrite.

Closes the *provable* part of the uncalibrated-tuning-constants item (J5) in
[`docs/jarvis-second-brain-open-issues.md`](../../jarvis-second-brain-open-issues.md). The
evidence-gated polish item (J7) stays held and is untouched by this slice.

## Why this slice, and what it deliberately excludes

The tuning-constants item (J5) has been open on one stated precondition: *calibrate against a
populated vault*. That framing turned out to hide two things.

First, **two of the remaining problems are not calibration problems at all** — they are defects that
no corpus can fix, and both are fixable today with zero new data. Those are the whole of the code
change here.

Second, the item's own measurements show most of the genuinely-uncalibrated constants cannot be
measured from the recorded history at any corpus size: the identifier-match layer (layer 2) needs a
ticket id and none of the runs carries one, and the semantic layer (layer 4) only runs when layers
1–3 all fall silent, which never happens. Waiting for more dogfooding does not change either. So the
third part of this slice is to say that in the tracker instead of leaving `// PLACEHOLDER` markers
that imply actionable work.

**Excluded on purpose:** any change to how confidence values combine; any re-fitting of the already
calibrated thresholds (`semSeedFloor` 0.325, `cosThreshold` 0.40, `semThreshold` 0.65); any
deliberately manufactured orphan dossier to force the semantic layer to emit production edges; and
every item in the held polish list (J7).

## Defect 1 — the "medium" confidence bucket is unreachable by construction

### Problem

`confidenceFor` (`pkg/jarvisattrib/edges.go:67-86`) takes the **maximum** of the firing layers'
weights. It never blends them. Every site that writes a confidence writes one of those same four
fixed weights or delegates to `confidenceFor`:

- `pkg/jarvisattrib/extract.go:48` — identifier match, `weightLayer2` (0.8)
- `pkg/jarvisattrib/extract.go:103` — structural correlation, `weightLayer3` (0.3)
- `pkg/jarvisattrib/extract.go:123` — `confidenceFor(cur.Layers)`
- `pkg/jarvisattrib/semantic.go:84` — semantic similarity, `weightLayer4` (0.2)
- `pkg/jarvisattrib/lifecycle.go:175` — copies a candidate's confidence

So the reachable confidence set is exactly `{0.2, 0.3, 0.8, 1.0}`. Meanwhile `Bucket`
(`pkg/jarvisattrib/edges.go:108-117`) labels `[0.4, 0.75)` as `"medium"` — a band no edge can ever
occupy.

The dead band propagates outward. `frontend/app/view/jarvis/jarvisgraphderive.ts:65-66` maps bucket
to opacity and stroke width across three cases, whose middle case cannot render. And
`pkg/jarvisattrib/edges_test.go:19` only passes because it asserts `Bucket(0.5)` against a
hand-written float that no edge holds, so it validates nothing.

The tracker filed this as *"the bucket cutoffs are untestable until the corpus produces intermediate
confidences."* That reading is inverted: the cutoffs are inconsistent with the weight set, and no
corpus will reconcile them.

### Fix

Replace the float-threshold derivation with a total mapping over the firing layers.

```go
// before — two coupled constant sets, medium unreachable
func Bucket(c float64) string {
    case c < bucketWeakMax:   return "weak"    // 0.2, 0.3
    case c >= bucketStrongMin: return "strong" // 0.8, 1.0
    default:                  return "medium"  // unreachable
}

// after — one total mapping over what actually fires
func BucketFor(layers []int) string {
    switch strongestLayer(layers) { // lowest layer number present; 0 when empty
    case 1:    return "strong" // canonical dispatch reference
    case 2:    return "medium" // identifier (ticket) match
    case 3, 4: return "weak"   // structural correlation, semantic similarity
    default:   return ""       // no layers: absent, never a fabricated "weak"
    }
}
```

`strongestLayer` is a new unexported helper returning the lowest layer number present, or 0 for an
empty list. The existing `provenanceFor` (`pkg/jarvisattrib/edges.go:89-106`) already computes
exactly that inline, so the helper is extracted from it rather than invented, and `provenanceFor`
switches to calling it — one definition of "strongest layer" instead of two.

`bucketWeakMax` and `bucketStrongMin` are deleted. `Confidence` is untouched and keeps doing what it
already does — ordering and display.

The empty-layers case is not a new behaviour, it is an existing guard moving inward.
`pkg/wshrpc/wshserver/wshserver_jarvis.go:588-593` already branches on `len(e.Layers) > 0` before
calling `Bucket`, precisely so a detached edge does not render a strength it no longer has. Making
the function total over layers absorbs that guard, and returning `""` for no layers is the contract
already documented at `pkg/wshrpc/wshrpctypes_jarvis.go:236`.

### Blast radius

Three production call sites, all in `pkg/wshrpc/wshserver/wshserver_jarvis.go` (lines 592, 747,
865); each already has the edge in hand, so each passes `e.Layers` instead of `e.Confidence`. Two
tests need the new signature (`pkg/jarvisattrib/edges_test.go:19`,
`pkg/jarvisattrib/semantic_test.go:23`). The wire type `AmbientEdge.Bucket` and its documented
`weak | medium | strong` vocabulary (`pkg/wshrpc/wshrpctypes_jarvis.go:216`) do not change, so no
regeneration and no frontend type churn.

### Nothing a user sees changes today — which is the point

Layer 1 stays `strong`, layers 3 and 4 stay `weak`. The only edge whose label moves is an
identifier-matched one (`strong` → `medium`), and no run in the recorded history carries a ticket
id. So the graph's middle styling case becomes *reachable in principle* while staying unoccupied on
this corpus.

The gain is not a visible improvement. It is that the code stops contradicting itself, the dead
branch is gone, a future ticket-carrying run renders correctly, and the test can no longer pass by
asserting an impossible value. It also makes the change safe to land: no visual regression is
possible on the current data.

## Defect 2 — the proactive gate queries one global semantic window

### Problem

`pkg/jarvisproactive/proactive.go:73` calls `ix.Query(ctx, v, run.Goal, queryK, wavevault.AllScope())`
— a single global top-8 across every collection. On the measured corpus (406 memory notes, 14
dossiers, 4 decisions — roughly 23:1) memory notes take all eight slots, so the proactive
resurfacing card can essentially never surface a dossier or a decision.

This is the same defect that was found and fixed in the recall path, and the tracker predicted it
would still be live here: *"S3's gate has the identical global-window shape and is now a follow-on
with a known fix and a proven method rather than an open question."* The fix already exists and is
tested — `Index.QueryPerCollection` (`pkg/jarvisembed/index.go:150`) runs one nearest-neighbour
search per collection, embeds the query **once**, and each search is a local indexed lookup against
the vector table's `collection` metadata column, so the fan-out adds no network round trip. The
recall path consumes it at `pkg/jarvisrecall/retrieve.go:80`.

### Fix — and why swapping the query alone is not enough

Two changes, because the recall slice already proved one is insufficient.

**(a) Per-collection retrieval.** `Query` → `QueryPerCollection` in
`pkg/jarvisproactive/proactive.go:73`, with `queryK` renamed `queryKPerCollection` to mirror the
recall path's `kSemPerCollection` and make the changed unit obvious at the call site.

**(b) Round-robin shortlisting.** `QueryPerCollection` merges its per-collection windows **by raw
score**, and that merge is itself a global ranking. Downstream, `prefilter`
(`pkg/jarvisproactive/gate.go:55-80`) walks those chunks in score order, drops anything under
`cosThreshold`, dedupes by node id, and truncates at `shortlistMax = 5`. Fix only (a) and memory
notes still fill all five slots handed to the model judge — the crowding simply moves one stage
downstream, which is exactly the trap the recall work documented. So `prefilter` emits **round-robin
across collections, best-first within each**, mirroring `orderCandidates` in the recall path. Every
collection's top hit can then reach the judge.

`ScoredChunk` already carries `.Collection`, so (b) needs no new plumbing.

No new relevance floor: the gate already has a calibrated one (`cosThreshold = 0.40`, fitted
2026-07-27 against 647 real chunks), and it sits above the recall path's `semSeedFloor` of 0.325.

### On `queryK` and `shortlistMax`

Both remain unfitted and this slice does not fit them. `queryK` keeps its value of 8, reinterpreted
as per-collection; with the relevance floor and the round-robin merge now bounding what reaches the
judge, `k` is not what constrains admission — the same honest position the recall path records for
`kSemPerCollection`. This gets stated in the comment rather than implied by silence.

## A repeatable corpus probe, at no API cost

The corpus distribution that the tuning-constants analysis rests on (`dossiers=14 runs=18
totalEdges=27`, confidences `{1.0: 14, 0.3: 13}`) was measured ad-hoc. There is no harness for it:
`pkg/jarvisrecall/liveprobe_test.go` and `pkg/tasksharpen/liveprobe_test.go` exist, `jarvisattrib`
has none.

Add `pkg/jarvisattrib/liveprobe_test.go` on the same `liveprobe` build tag (out of the normal
suite), reading a `VACUUM INTO` snapshot of the installed profile per the procedure recorded in the
tracker's J1 entry — snapshot rather than file-copy so it is consistent against a live app, and drop
the stale write-ahead-log sidecars.

It measures only what needs no embeddings, and therefore costs nothing:

- dossier, run and edge counts; edges per dossier
- per-layer edge counts and the confidence histogram (is the middle still empty?)
- whether any edge currently sits inside the 24-hour `probationMs` window — never yet exercised,
  because all imported history was uniformly past it
- whether the `expandFanout` (8) and `seedTopK` (6) caps bind against real edge counts
- the age of the oldest edge against the 30-day `timeBoxMs`

Value beyond this slice: `timeBoxMs` becomes measurable by *waiting* — the tracker puts the crossing
around 2026-08-19 — so a repeatable probe means re-checking is cheap instead of another ad-hoc pass.

Running it needs the Windows-style `CGO_CFLAGS` include path that `jarvisembed`'s vendored
sqlite-vec header requires; a POSIX-style path silently fails with an identical error.

### The paid semantic re-measure is a separate checkpoint

Deliberately **not** in this slice. Querying the index embeds the query and reconciles lazily first,
so against a vault that has drifted for a week it may re-embed a batch of changed notes — real spend
on the operator's own key. The free numbers above come first; whether a paid re-measure is worth it
is decided after seeing them, not assumed. The already-fitted thresholds are only seven days old.

## Rewriting the tuning-constants tracker entry

Restructure item J5 in `docs/jarvis-second-brain-open-issues.md` so every remaining constant sits in
exactly one of three categories:

1. **Fitted** — with its evidence and the model it is specific to. (`semSeedFloor`,
   `kSemPerCollection`, `cosThreshold`, `semThreshold`.)
2. **Unmeasurable by construction** — with the structural reason. `weightLayer2` needs an identifier
   no run carries; `weightLayer4` needs the layer-1–3 gate to fall silent, which dogfooding does not
   produce. More data does not help either.
3. **Awaiting a named trigger** — `timeBoxMs` awaiting roughly 2026-08-19; `weightLayer3` awaiting a
   human ground-truth labeling pass over its structural guesses.

Strike the `// PLACEHOLDER` markers whose honest state is category 2, since they advertise
actionable work that does not exist. Record both defects fixed here, and note that the bucket-cutoff
line in the constant inventory table is retired rather than calibrated.

## Testing

Each defect gets its failure demonstrated **before** the fix lands — a test passing over
already-correct behaviour proves nothing, a lesson this feature already recorded when the model-tier
work shipped without a guard.

- **Bucket mapping.** Assert every layer combination maps to its intended bucket, that the mapping
  is total, and that an empty layer list yields `""` rather than `"weak"`. Reverting to the float
  cutoffs must fail it.
- **Proactive shortlist.** A crowded-vault fixture mirroring
  `TestQueryPerCollectionReachesCrowdedOutCollections` (`pkg/jarvisembed/index_test.go:152`) — many
  memory notes plus one dossier and one decision, all scoring above `cosThreshold`. Assert the
  shortlist handed to the judge contains the dossier and the decision. This must fail against
  today's global query **and** fail with the query fixed but round-robin shortlisting omitted, so it
  pins both halves rather than just the first.
- `go test ./pkg/...` with the sqlite-vec `CGO_CFLAGS` set, and `npx vitest` if the graph derivation
  is touched.

## Risks

- **Low.** Both fixes are internal; no wire type changes, no regeneration, no migration.
- The bucket change is visually inert on the current corpus (established above), so it cannot cause
  a graph regression on this data.
- The proactive-gate change *does* alter what the model judge sees, and the judge is the only
  non-deterministic element. The relevance floor is unchanged, so the change is strictly "the same
  bar, applied per collection" — it can admit a dossier or decision that previously lost its slot to
  a memory note, which is the intent.
