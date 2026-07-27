# Jarvis second brain — open issues

Scoped backlog for the second-brain feature only (v1 A–G + v2 S1–S3 / U1–U3). Everything here is
**residue from a shipped sub-project**, not new product scope: each item was deliberately deferred
during its own cycle and is now either unblocked or overdue.

Sibling of `docs/open-issues.md` (the repo-wide backlog) — nothing from that file is duplicated here.
`docs/deferred.md` remains the canonical running log of *why* each thing was deferred; this file lifts
out the currently actionable ones with re-verified citations.

**Source of the sweep:** reconciliation of the two meta specs
([v1](superpowers/specs/2026-07-23-jarvis-second-brain-meta-spec.md) ·
[v2](superpowers/specs/2026-07-24-jarvis-second-brain-v2-meta-spec.md)), `docs/deferred.md`, and the
tree — 2026-07-27. All seven v1 sub-projects (A–G) and all six v2 sub-projects (S1–S3, U1–U3) are
**built and merged**.

| # | Issue | Kind | Effort | Blocked by | Status |
|---|---|---|---|---|---|
| J1 | Ambient layer renders **fabricated** task tags / decision cards | correctness / trust | S | — | ✅ Resolved 2026-07-27 |
| J2 | No way to enable embeddings from the app → S1–S3 are dark code | reachability | S | — | ✅ Resolved 2026-07-27 |
| J3 | Model tiering (invariant 2) never landed — C + E both burn the capable tier | cost | M | — | ✅ Resolved 2026-07-27 |
| J4 | `jarviscontinuity.Resume` has no consumer (no "pick up where you left off") | feature gap | S–M | — | ✅ Resolved 2026-07-27 |
| J5 | Every tuning constant across the feature is an uncalibrated PLACEHOLDER | correctness / tuning | M | corpus depth | 🔲 Open — partially unblocked |
| J6 | Two durable-knowledge roots — `memvault` never unified into the Wave Vault | architecture | M–L | — | ✅ Resolved 2026-07-27 |
| J7 | Evidence-gated smalls (U2/U3/S2/S1/C leftovers) | polish | S each | evidence | ⏸ Held — do not build on spec alone |
| J8 | Task-sharpen "fast" mode points at `fable`, the *priciest* model | cost / correctness | S | — | ✅ Resolved 2026-07-27 |
| J9 | Retrieval reads only part of a note — L2 misses frontmatter, embedding misses the id | correctness / reachability | S–M | — | 🔲 Open — found verifying J2 |

**Dependency order.** J1–J4, J6 and J8 are done. J5's *populate a vault* half shipped 2026-07-27 as
`cmd/jarvisbackfill` and J6 (same day) added ~354 federated memory notes to what the vault reads;
what remains is corpus **depth**, not tooling — read J5's "Corpus reality" section before planning any
calibration, because two of D's four weights cannot be measured from today's history at all.

---

## J1 — Ambient layer renders fabricated edges

**Status:** ✅ Resolved 2026-07-27 (verified end-to-end on a populated profile) · **Effort:** S · **Kind:** correctness / product trust

### Problem
The ambient presence layer — task tags on Run/Radar/Memory rows and "relevant past decision" cards on
their details — still renders **deterministic fake data derived from an oref hash**. Attribution
engine D shipped and exposes real edges; the ambient surface never switched over. This is the layer
the second brain is *felt* through day to day, so the most-seen part of the feature is a fixture.

### Evidence
- `frontend/app/view/agents/ambient.ts:5-7` — the file's own header: *"a deterministic FIXTURE keyed
  off the oref hash … The durable part is the AmbientProvider interface: D replaces
  fixtureAmbientProvider behind it."*
- `frontend/app/view/agents/ambient.ts:25-26` — hardcoded `decision:placeholder-1` / `-2` titles.
- `frontend/app/view/agents/ambientviews.tsx:9,12,32` — `AmbientTags` / `RelevantDecisions` import and
  call `fixtureAmbientProvider` **directly**; the provider is not injected.
- `docs/deferred.md` § "Jarvis sub-project G (Plan 4)" — records the deferral and names D as the
  unblocker. D is built (v2 meta-spec tracking table, row D).

### What shipped
- `jarvisattrib.AllEdges` — `EdgesFor` over every dossier, sharing one run load, one override read and a
  per-run commit cache. Its per-dossier body is now a shared core both entry points call. Neither
  `ResolveSpaceScope` nor `GetDossier` covered this: both are per-dossier, and the ambient layer needs
  the inverse (object → dossiers) for every object at once.
- `ResolveAmbient` (new wshrpc command) returns the whole map in one read: every dossier as a labelled
  tag target, its attributed run edges carrying D's provenance/bucket/state, and its decisions. Loaded
  once per session into a module-scope atom, never per row.
- Frontend joins that map per row. **The seam widened**: `tagsFor(oref)` became `tagsFor({oref, links})`,
  because D only produces dossier→Run edges. A Radar finding has no edge of its own and inherits the
  attribution of the run that investigated it (`investigation.runid`); a memory note resolves through
  its own `[[wikilinks]]` (`MemNote.links` is already client-side, so no extra vault scan).
- Weak/informing edges render dashed and recede, mirroring `jarvisgraphderive.attributionStyle`.

### Verified
Unit-covered: an unattributed object yields no tag; a run attributed to two dossiers gets both, in
confidence order; a wikilink to a non-dossier is not attribution; the pre-load provider yields nothing.
`fixtureAmbientProvider` and the `title="…placeholder"` marker are gone from the tree.
**CDP surface-smoke against a populated profile — ✅ measured 2026-07-27**, after seeding the dev
profile per the procedure below. `task verify:ui -- jarvis-ambient`, 2/2 steps:

| surface | chips | dashed | sample label |
|---|---|---|---|
| cockpit | 0 | 0 | — (no live agents; ambient tags don't render here — see below) |
| channels | 6 | 2 | `how can both items are selected at once · strong confidence · confirmed` |
| radar | 2 | 1 | `Grep the frontend for remaining getApi()… · weak confidence · informing` |
| memory | 0 | 0 | — |

Both buckets are represented and weak edges render dashed, so this exercises the styling branch rather
than just the happy path. The labels are real dossier titles resolved through real Run edges — the
thing J1 was filed about.

Two zero rows that are **correct, not failures**:
- **Cockpit renders no `AmbientTags` at all** — the consumers are `channelchrome`, `radarfindingslist`,
  `radarfindingdetail`, `runbody` and `memorysurface`. Cockpit was in the scenario's surface list as a
  regression tripwire, not because it should ever show a chip.
- **Memory shows none** because a memory note resolves attribution through its own `[[wikilinks]]`, and
  this corpus's memory notes link other memory notes, not dossiers.

### The profile split this smoke keeps running into (measured 2026-07-27)
The reason this leg stayed open is structural, not effort, and it costs an hour to rediscover:

- **The vault is shared, Runs are not.** `memroots.VaultRoot()` is home-based (`~/.waveterm/vault`), so
  every profile sees the same 14 dossiers. Runs live in the per-profile wstore. Ambient tags are
  dossier→Run edges, so they only render where both halves are present.
- **Measured:** the installed profile (`%LOCALAPPDATA%\dev.arc.app`) resolves **14/14** dossier run
  refs; the dev profile (`…-dev`, what `task dev` uses) resolves **0/14** — its 14 runs are unrelated.
  So a smoke run against a stock dev profile renders zero tags and proves nothing, which is the same
  vacuous pass the empty-vault check produced.
- **CDP only exists in dev.** The `--remote-debugging-port` flag is `#[cfg(debug_assertions)]`, so the
  installed build — the one with the data — cannot be driven. `paths.rs` derives the dev base as
  `<base>-dev` with no env override, so the dev shell cannot be pointed at the populated profile either.
- **Therefore:** seed the dev profile before smoking it. Snapshot the installed DB with
  `VACUUM INTO` (consistent against a live app, unlike a file copy), drop the dev profile's stale
  `waveterm.db-wal`/`-shm` — applying them to a different DB corrupts it — and restart `task dev`.
- The `jarvis-ambient` CDP scenario was **stale**: it asserted on
  `span[title="Ambient task attribution (placeholder)"]`, the exact marker J1 deleted, so it could only
  ever report 0. Rewritten against the real title format (`<label> · <bucket> confidence · <state>`).
- **Expect a boot burst of `object.GetObject … context deadline exceeded` on the seeded profile.** The
  imported blocks resolve against a `filestore.db` that is still the dev profile's own, so their
  contents are missing. It is a bounded storm — it stops once boot settles, the cockpit renders, and
  the surfaces are fully drivable — but it looks alarming in the log and is not a symptom of the swap
  having failed. Terminal scrollback for imported runs will be empty for the same reason.

---

## J2 — No way to enable embeddings from the app

**Status:** ✅ Resolved 2026-07-27 (reachable **and** exercised against a real provider) · **Effort:** S (frontend-only) · **Kind:** reachability

### Problem
The whole semantic lane (S1 index, S2 L3 recall + L4 attribution, S3 proactive card) is gated behind
config keys and a secret that **have no UI**. Enabling v2's headline capability today means
hand-editing the settings JSON and calling `secretstore.SetSecret` from Go. Consequence: S1/S2/S3 have
never run against a real provider — they are written, unit-tested, and dark.

### Evidence
- `pkg/wconfig/metaconsts.go:65-67` — `jarvis:embedenabled`, `jarvis:embedbaseurl`, `jarvis:embedmodel`.
- `pkg/jarvisembed/embed.go:24` — `secretKeyName = "jarvis:embedapikey"`.
- Grep for those keys under `frontend/` hits **only** `frontend/types/gotypes.d.ts` (generated) — no
  settings control exists.
- `docs/deferred.md` § "Jarvis S1 — embedding foundation": *"Settings UI for embed config/key … is
  deferred (S2 / a small settings add). Dev sets config via settings file + `secretstore.SetSecret`."*
  S2 shipped without picking it up.

### What shipped
`EmbeddingsSection` in `frontend/app/view/agents/settingssurface.tsx`, after `MemorySection`. No backend
was needed, as predicted: the toggle / base URL / model go through the ordinary `SetConfigCommand` path,
and the key through the already-generated `SetSecretsCommand`. The key field is write-only in both
directions — the UI asks `GetSecretsNamesCommand` *whether* a key exists, never what it is, and clears
the input once the secret lands. Clear deletes it (a `null` value, which the `map[string]*string` handler
treats as a delete; the generated client types values as `string`, so that needs a cast). BYOK framing
per invariant 12. While the toggle is on, a hint names whatever is still missing, since
`jarvisembed.Available()` needs all four. Index state (chunk count / rebuild) was left out as noted.

### Verified
Typecheck and the full vitest suite pass; the section renders through the existing settings primitives.
~~**Not verified — the substantive half:** nobody has toggled it on against a real OpenAI-compatible
endpoint~~ — **partially closed 2026-07-27.** It has now run against a real provider
(`openai/text-embedding-3-small` via OpenRouter), which took three fixes: request batching
(`8fb19f13` — one round-trip per note took 5m17s against a 90s dispatch budget, so the lazy build never
finished), durable secret storage (`bf7bfd98` — the BYOK key could not persist at all under Tauri), and
the blank-note fix (`a01700a6`). Of the three original verify legs:

- **index builds** — ✅ done. 793 chunks / 422 nodes, full build 46s, incremental ~22s.
- **a differently-worded recall query finds its source** — ✅ measured 2026-07-27, below.
- **toggling off restores exact v1 behavior** — ✅ measured 2026-07-27, below.

### Measured 2026-07-27 (paraphrase recall, real provider)
Harness: `pkg/jarvisrecall/liveprobe_test.go` (build tag `liveprobe`, out of the normal suite), run
against a **copy** of the installed profile — its config, its DPAPI secret and its 8.5 MB index — so
neither running app was touched. Five queries, each sharing **zero** ≥4-char tokens with its target,
scored on whether `selectSeeds` returns the target.

| case | embeddings off | embeddings on | semantic rank |
|---|---|---|---|
| dossier — app crash on the memory tab | missing | **found** | #1 of 49 (cos 0.3967) |
| dossier — claude/codex pill colour | missing | **found** | #1 of 46 (cos 0.3758) |
| dossier — auto tab renaming | missing | **found** | #1 of 50 (cos 0.3921) |
| dossier — grep frontend for `getApi()` shims | missing | missing | not in top 37 |
| decision — input-validation boundary | missing | missing | not in top 52 |

**3/5 on, 0/5 off.** The hits are not marginal: every one ranks **#1**, so the paraphrase lands on the
right node rather than scraping in at the window edge. The two misses are **not** a `kSem` problem —
neither target appears at six times the window depth — and both have identified causes, recorded as
[J9](#j9--retrieval-reads-only-part-of-a-note) rather than as tuning debt.

**Toggle-off** was exercised through the real config flag, not a stub: with `jarvis:embedenabled`
false, `Available()` is false, L3 contributes nothing, the seed set is identical (6 both ways), no
error surfaces, and the run drops from 8.67s to 0.47s with zero network calls. Graceful degradation
holds — but read J9 for what "v1 behavior" actually means for the `tasks/` collection.

One caveat on the corpus: an earlier pass of this probe scored 1/5 as a *false pass*, because the
query said "notes" and every dossier body carries a literal `## Notes` heading, which L2 substring-
matches on all 14. Any future paraphrase set must avoid the marker vocabulary the templates emit.

---

## J3 — Model tiering never landed; C and E burn the capable tier

**Status:** ✅ Resolved 2026-07-27 — `consult.Tier` + `SpecForTier(runtime, tier)` (`pkg/consult/consult.go`)
is the shared selector; E's boundary summary takes `TierCheap`, recall's synthesis takes `TierCapable`.
`TierCapable` deliberately emits **no** `--model` flag, so it keeps the operator's configured CLI default
and the capable path is byte-identical to before tiering — the change is additive, not a re-pointing.
Cheap alias is `haiku` (Claude Haiku 4.5, ~1/5 Opus input cost). **Note:** `pkg/tasksharpen` calls
`fastModel = "fable"` "the currently-advertised small-model alias" — that is wrong (Claude Fable 5 prices
*above* Opus), but it drives a user-facing "fast" sharpen mode and was left alone; see J8 below.
The three grunt-tier call sites left on the default (out of J3's stated scope) were picked up in the
2026-07-27 cleanup pass: S3's relevance judge (`pkg/jarvisproactive/proactive.go`) and the gatekeeper
classifier / delegator decomposer (`pkg/jarvis/{classify,decompose}.go`) now all take `TierCheap`. Each
is a bounded, structured-reply call that already fails safe — the classifier in particular degrades
toward *escalate to the human*, not toward a confident wrong answer. **Not test-covered:** neither
`Classify` nor `Decompose` has a seam that exposes the spec, and `jarvisproactive`'s `judge` seam
replaces spec construction wholesale, so no test fails if a site is reverted to `SpecFor`.

**Effort:** M · **Kind:** standing cost

### Problem
Meta-spec **invariant 2** mandates a two-tier model split (cheap Haiku-class for grunt work, capable
for synthesis). F deferred it with an explicit resume condition: *introduce the tier selector together
with the first real cheap-tier consumer, so the abstraction arrives with ≥2 real users.* Both named
consumers — C's traversal and E's boundary summaries — are now built, and **both call the capable
model with no `--model` selection**. The condition is met; the cost is being paid every rest boundary
and every recall.

### Evidence
- `pkg/jarvisrecall/recall.go:34,38` — `consult.SpecFor("claude")` → `consult.Run(...)`, no tier.
- `pkg/jarviscontinuity/continuity.go:23,27` — same pattern for the boundary summary.
- `docs/deferred.md` § "Jarvis sub-project F — model tiering deferred" (the resume condition) and
  § "sub-project E" fork 2 (*"The cheap tier is a shared concern … and lands as its own cross-cutting
  slice, not a one-off inside E"*).

### Fix
A tier selector at the shared `consult.Run` site = choosing the CLI `--model` per call. Wire the two
existing consumers at the same time: E's boundary summary → cheap; recall's final synthesis → capable.
This is the cross-cutting slice E's deferral asked for — not a one-off inside either package.

### Verify
Both call sites select explicitly; a boundary summary runs on the cheap tier and still produces a
usable narrative; recall synthesis quality is unchanged. Cost delta is the point — record before/after.

### Downstream
Unblocks C's deferred **model-in-the-loop traversal** (`docs/deferred.md` § C, item 1), which was
deferred *"against the cost model without model tiering"*. Treat that as a follow-on slice, not part
of J3.

---

## J4 — `Resume` has no consumer

**Status:** ✅ Resolved 2026-07-27 — `CaptureRunBoundary` now returns a `*ResumeCard` and gets it by
reading the dossier **back** through `Resume` (the named seam) on a *fresh* retriever after the write.
Reading back rather than returning the computed narrative is load-bearing: on the invariant-5 conflict
path a concurrent human edit wins, and the card must show the human's text, not the summary this
boundary discarded. `AdvanceRunCommand` persists the card to `run.Meta["jarvis:resume"]` and broadcasts
the existing `waveobj:update` — the same channel S3's card rides, no second ambient path. FE:
`resume.ts` (read + dismiss, mirrors `proactive.ts`) and `resumeviews.tsx`, rendered in `RunBody` above
`ProactiveCard`. A later boundary clears the dismissal flag, since the narrative has changed.
**Chrome unification — done 2026-07-27** (the deferred follow-on, unblocked once J1 landed and all three
cards were in view). With all three visible the "one shell" framing turned out to be half right:
`ProactiveCard` and `ResumeCard` are the same object — a single dismissible card — and now share
`AmbientCard` (`frontend/app/view/agents/ambientcard.tsx`) whole. `RelevantDecisions` is a different
shape (a *list*, no dismiss affordance, eyebrow outside the box), so it borrows only the `AMBIENT_BOX` /
`AMBIENT_EYEBROW` tokens; bending one component to cover both shapes would have cost more configuration
than the duplication it removed.

**Effort:** S–M · **Kind:** feature gap

### Problem
E exposes `Resume(r, taskID) → Narrative`, unit-tested, with **zero callers** — recall reads the
`state` block during ordinary traversal, so nothing invokes the dedicated resume path. The
"pick up where you left off" affordance the continuity engine was built for does not exist in the UI.

### Evidence
- `pkg/jarviscontinuity/continuity.go:164` — `func Resume(...)`; a grep for callers across `pkg/`
  returns nothing outside its own tests.
- `docs/deferred.md` § "Jarvis sub-project E" fork 1: deferred as *"a push affordance adjacent to v2
  proactive resurfacing — an ambient-presence follow-on, not E."*

### Fix
The blocker named in the deferral now exists: S3's persisted, dismissible run card, delivered over the
run's existing `waveobj:update` (`frontend/app/view/agents/proactiveviews.tsx`). Render a resume
narrative through that same mechanism, or through U1's Space chip — whichever reads better. Reuse the
existing card path rather than inventing a second ambient channel.

### Verify
Returning to a task that hit a rest boundary surfaces its narrative without a fresh model call
(the summary was already written at the boundary); dismissal persists.

---

## J5 — Every tuning constant is an uncalibrated PLACEHOLDER

**Status:** 🔲 Open · **Effort:** M · **Blocked by:** corpus depth, not tooling · **Kind:** correctness / tuning

### Corpus reality (measured 2026-07-27 — read this before planning any calibration)
J5's stated precondition, "populate + embed a real vault", was never satisfied, and the gap is deeper
than the missing embeddings. As found: the Wave Vault held **3 dossiers, all
`spawn-test-only-do-nothing` artifacts, and 0 decisions**; embeddings were off with no index on disk;
`memory:vaultpath` pointed at `IdeaProjects/obsidian_vault`, which holds **0 markdown files** (the real
Obsidian vault appears to be `IdeaProjects/obsidian/Work`, 51 files — a separate misconfiguration, not
tracked here). Calibrating against that would have replaced one set of invented numbers with another.

`cmd/jarvisbackfill` was built to fix the corpus half (see below). It was **applied to the real vault
on 2026-07-27**, yielding **14 dossiers and 4 decisions** (the 3 spawn-test dossiers were deleted in
the same pass). Running D's real attribution over that corpus measures:

```
dossiers=14  runs=18  totalEdges=27
edges per dossier: [1 1 1 1 1 2 2 2 2 2 2 2 3 5]
by layer:   L1=14  L2=0  L3=13  L4=0
by bucket:  strong=14  weak=13  mid=0
distinct confidences: {1.0: 14, 0.3: 13}
```

Read that distribution before planning calibration — **the confidence space is bimodal with an empty
middle**, and that is a structural property of this history, not a sample-size problem. Two useful
readings: L3's windowing is *discriminating rather than promiscuous* (≈1 structural sibling per
dossier, not a same-repo blanket), and no amount of additional dogfooding moves L2 off zero unless
dispatch goals start carrying a ticket id. What the corpus does *not* reach:

- **`weightLayer2` and `weightLayer4` can never be calibrated from this history.** L2 needs a ticket
  id and none of the 18 runs carries one; L4 needs embeddings. Neither signal can fire, so the only
  observable confidences are L1 (1.0) and L3 (0.3). *(Half-superseded — see "Measured 2026-07-27 (L4)"
  below. Embeddings are live and L4 was measured, but it still emits zero edges here for a different
  reason than assumed: the L1–L3 gate, not the missing provider. L2 is unchanged.)*
- **The bucket cutoffs are consequently untestable.** `bucketWeakMax` 0.4 and `bucketStrongMin` 0.75
  only ever have to separate 0.3 from 1.0 — a gap so wide that any value between them "passes".
- **Exactly one multi-run dossier exists** (the 5-run `deferred-appendix-briefs` group), so the mixed
  confirmed/informing shape is real but single-sampled.
- **Decisions are thin for a recorded reason:** 42 Radar investigations exist and 33 have a terminal
  status with a worker-written summary, but **12 of the 14 investigated run ids no longer exist in
  `db_run`** — those runs were pruned and the reports kept dangling references. Only the 2 surviving
  runs yield decisions.
- **U3's "legible against a dense vault" stays unverified.** 14 dossiers is not dense.

- **`probationMs` and `timeBoxMs` are unexercised.** All imported history is 4–7 days old, so every
  edge is uniformly past the 24h probation and uniformly inside the 30-day time-box; neither boundary
  is crossed by the data. `timeBoxMs` is the one constant that becomes measurable by *waiting* rather
  than by collecting more — the oldest edges cross it around 2026-08-19.
- **C's traversal bounds are untested, not validated.** `expandFanout` 8 against a measured maximum of
  5 edges (typical 1–2) means the cap never binds; the same holds for `seedTopK` 6.

So the corpus unblocks *some* of J5, not J5. Scored against the ~13 placeholder constants: **1 is now
interrogable** (`weightLayer3` — 13 concrete structural guesses exist to judge, though turning them
into a weight still needs human ground-truth labeling, not just data), **1 unlocks with time**
(`timeBoxMs`), ~~**6 are hard-blocked on an embedding provider** (`weightLayer4`, `semCandidateN`,
`semThreshold`, `kSem`, `cosThreshold`, `queryK`)~~ *(stale — the provider shipped 2026-07-27;
`cosThreshold` and `semThreshold` are now measured, the other four are unblocked but unfitted)*,
and the remainder have no discrimination pressure
because the corpus produces only two distinct confidences. The backfill moved the blocker, it did not
remove it.

**Update 2026-07-27 (J6).** The "populate a real vault" precondition is now satisfied on the memory
side too: root unification federated the agent-native memory dirs into the vault's `memory/`
collection, so a vault `Retriever` returns **375 nodes / 106 edges** where it returned ~3. That makes
U3's dense-graph legibility item live rather than theoretical, and it means the first `jarvisembed`
reconcile after embeddings are enabled will index ~354 nodes on the operator's own key — real spend,
intended, but know it before flipping J2's toggle. The dossier/decision thinness above is unchanged;
L2 and L4 remain uncalibratable from this history.

### Calibrated 2026-07-27 (embeddings on, OpenRouter)
Embeddings went live (`openai/text-embedding-3-small` via OpenRouter) after two defects that made the
BYOK path impossible to use were fixed — see commit `307380ee`. Index: **373 nodes → 647 chunks**.
Two constants are now measured rather than guessed:

| constant | was | now | basis |
|---|---|---|---|
| `jarvisproactive.cosThreshold` | 0.82 | **0.40** | query→chunk over 647 real chunks: best on-topic hit 0.4579, off-topic control 0.2342. At 0.82 the gate admitted **nothing** — the proactive card could never fire. |
| `jarvisattrib.semThreshold` | 0.75 | **0.65** | doc→doc over 14 known dossier→owner-run pairs vs 238 non-pairs: 100% recall at ~2.1% false positives. |

**The load-bearing lesson: these two thresholds measure different comparisons and their distributions
are not interchangeable.** Query→chunk tops out near 0.46; doc→doc positives have a median of 0.961.
An earlier pass set `semThreshold` to 0.33 by transplanting the query→chunk figure and would have
admitted 46 of 238 non-pairs (19.3% FP). The original 0.75 was very nearly right for L4 and badly
wrong for the gate. Any future re-tune must re-measure per comparison type, and per model —
both figures are specific to `text-embedding-3-small`.

Still uncalibrated: `queryK`, `shortlistMax`, `semCandidateN`, `kSem`, `seedTopK`, `expandDepth`,
`expandFanout`, `weightLayer2/3/4`, the bucket cutoffs, `probationMs`, `timeBoxMs`.

**`kSem` now has evidence (2026-07-27, from the J2 probe).** The federated corpus is
**406 memory / 14 tasks / 4 decisions**, so the memory collection outnumbers everything the second
brain writes by ~23:1. Measured across five queries, the `kSem = 6` semantic window went to memory
notes 4–6 times out of 6; tasks got 1–2 slots and only when the dossier ranked #1 outright. `kSem` is
therefore not a neutral bound — on this corpus it is a near-total memory filter, and a dossier that
ranks anywhere below the top two is dropped before recall sees it. Two candidate reads, not yet
separated: raise `kSem`, or take top-k **per collection** rather than globally. The second is the
better shape if the ratio holds, since raising a global k trades cost for a window memory still
dominates. Note this is a *ranking-window* finding only — it does not explain J2's two misses, whose
targets are absent from the ranking entirely (see J9).

### Measured 2026-07-27 (L4 semantic, against the completed index)
The threshold calibration above scored dossier/run pairs offline. This measures L4 through the real
pipeline, after the index was actually complete — the first build indexed only `memory/`, because two
blank notes made every batch containing a `tasks/` or `decisions/` chunk fail (fixed in `a01700a6`;
the index now holds 793 chunks / 422 nodes including all 14 dossiers and 4 decisions).

**L4 emits nothing in production, and the reason is not the one this doc assumed.** `edgesForDossier`
runs the semantic pass *only when L1–L3 are silent* (`pkg/jarvisattrib/lifecycle.go:183`). All **14 of
14** dossiers carry at least one deterministic edge, so the orphan set is empty, `proposeSemanticEdges`
is never reached, and `attrib_vectors` in the live index is **0**. The distribution is unchanged:
`{1.0: 14, 0.3: 13}`. The empty middle stays empty because the gate never opens — not because
embeddings were missing.

**Counterfactual (gate bypassed, L4 forced on all 14 dossiers, scored against their L1 owner refs):**

| | |
|---|---|
| owners correctly proposed | 14 |
| owners missed | 0 |
| extra edges | 4 |
| recall | **1.00** |
| raw precision | 0.78 |

Recall is the load-bearing figure: at `semThreshold` 0.65, L4 recovered **every** known owner through
the real pipeline — independent corroboration of the offline pair-scoring, using cached vectors and
the production fingerprints.

**The 4 "extra" edges are not false positives.** All four belong to the single 5-run
`deferred-appendix-briefs` fan-out — five workers dispatched on one goal, only one of which is recorded
as the dossier's canonical ref. Their cosines (0.978 / 0.982 / 0.982 / 0.989) sit just below the
owner's 1.000 and far above the 0.719 worst true pair, so no threshold separates them without
destroying real recall — and none should, since those runs *did* work on that dossier. Read the other
way: **L4's only disagreement with L1 on this corpus is L1 under-recording a fan-out.** That is the
argument for keeping L4 as an informing layer rather than suppressing it.

**What this does and does not settle.** `weightLayer4` still has **zero** production observations, so
0.2 remains a judgment, not a fit — what the counterfactual adds is a floor it previously lacked:
L4's proposals here are correct-or-sibling, never unrelated. Treat that cautiously — 14 dossiers, one
multi-run group, and the positives are partly circular (a dossier objective is seeded from its run's
goal). "Weak/informing" is defensible; **0.2 specifically is not yet fitted.** `bucketWeakMax` 0.4
remains vacuous: L4 (0.2) and L3 (0.3) both fall below it, L1 (1.0) far above, so nothing measured has
ever landed in the 0.4–0.75 mid band.

**Consequence for J5 planning:** more dogfooding will *not* produce L4 edges. The orphan set only
becomes non-empty when a dossier exists whose work was never dispatch-linked and shares no anchor repo
— i.e. manually-written dossiers, or runs whose `ProjectPath` differs from the dossier's anchors.
Calibrating `weightLayer4` from production requires deliberately creating that case, not waiting.

### Problem
Every threshold, weight, window and cap across the second brain was fabricated to be plausible in
isolation and marked `// PLACEHOLDER`, to be calibrated *"against a populated vault"*. None has been.
D's entry is explicit that its weights must be calibrated **before v2 proactive resurfacing trusts
hardened edges** — S3 shipped on exactly those uncalibrated weights.

### Evidence (the full inventory)
| Area | Constants | Location |
|---|---|---|
| D attribution | `weightLayer1..4` (1.0 / 0.8 / 0.3 / 0.2), `bucketWeakMax` 0.4, `bucketStrongMin` 0.75, `probationMs` 24h, `timeBoxMs` 30d | `pkg/jarvisattrib/edges.go:18-33` |
| C recall | `seedTopK` 6, `expandDepth` 2, `expandFanout` 8, `maxCandidates` 12 | `pkg/jarvisrecall/retrieve.go:19-21` |
| S2 L3 | `kSem` 6 | `pkg/jarvisrecall/retrieve.go:26` |
| S2 L4 | `semCandidateN` 20, `semThreshold` 0.75 | `pkg/jarvisattrib/semantic.go` |
| E continuity | summary cap (≤4 sentences), rest-state set, `continuityCaptureTimeout` 90s | `pkg/jarviscontinuity`, `wshserver_runs.go` |
| S1 index | query `k`, embed batch size, `##`-only section split, 60s HTTP timeout, 240-byte snippet | `pkg/jarvisembed` |
| S3 proactive | `queryK` 8, `cosThreshold` 0.82, `shortlistMax` 5, the judge prompt | `pkg/jarvisproactive/gate.go:18-20` |
| U3 graph | bucket→opacity (1.0 / 0.6 / 0.35), bucket→width (1.4 / 1.0 / 0.7), `DASH_INFORMING` `[3,3]`, `RUN_SQUARE_SCALE` 1.6 | `frontend/app/view/jarvis/jarvisgraphderive.ts` |

All are recorded in `docs/deferred.md` under their sub-project's section.

### Fix
Sequenced, not one pass: (1) land J2 ✅, (2) populate + embed a real vault — **populate** shipped as
`cmd/jarvisbackfill`, **embed** still needs a provider, (3) calibrate the **deterministic** constants
first (D weights, C seeds, U3 visuals — these need no provider), (4) then the semantic thresholds (S2,
S3) against real cosine distributions. Record each calibrated value and strike its `// PLACEHOLDER`
marker plus its `docs/deferred.md` line as you go. Per the corpus section above, step 3 can only
partially succeed on today's history.

### The backfill importer (shipped 2026-07-27)
`cmd/jarvisbackfill` imports recorded wstore history into the vault as a real corpus. It graduates the
"historical backfill from SQLite" item out of J7 (`docs/deferred.md` § C, item 3).

- **Strict fidelity.** Only recorded facts are written. Runs supply the dossier (goal → objective,
  status, window); Radar investigations that reached a terminal state with a worker-written summary
  supply the decisions, rationale verbatim. `ticket`, `acceptance` and rationale prose are left empty
  where the history recorded none, and every gap lands in `Plan.Skipped` rather than being invented.
- **Grouping.** Runs naming the same markdown artifact join one dossier — the only grouping signal
  this history carries, since there are no ticket ids.
- **Owner-only refs.** A canonical ref is written for the group's *owner* run (D layer 1, confirmed,
  1.0); siblings are deliberately left unreferenced so D infers them structurally (layer 3, informing,
  0.3). Referencing every run would report the whole graph at 1.0 and calibrate nothing.
- **Backdating is load-bearing.** `windowsOverlap` requires `runEnd >= dossier.Created`, so a dossier
  stamped at import time attracts *no* layer-3 edges — the importer looks successful and silently
  produces a degenerate corpus. `DossierFacts.Created` was added for this, and the failure mode is
  pinned by `TestAssembleRejectsImportTimeStampedDossier` in `pkg/jarvisattrib`.
- **Safe to re-run.** Read-only against the database (it never opens wstore, whose init would migrate
  a production DB), idempotent via deterministic slugs, `--dry-run` and `--vault` for rehearsal, and
  one git commit in the vault so the whole import reverts at once.

Two collisions found and fixed while running it against real data, both from `boundedSlug` truncating:
two distinct "execute this plan …" dossiers and two same-day decisions each collapsed onto one
filename, silently losing the second. Ids are now deduped at plan time, so an "already exists" at
apply time unambiguously means re-import.

**Prerequisite before calibrating:** delete the 3 `spawn-test-only-do-nothing` dossiers from the real
vault — they are test artifacts and will skew any measurement.

### Verify
No `// PLACEHOLDER` markers remain in the listed files; the U3 graph is legible against a *dense*
real vault (the current visual values were chosen in isolation); S3 does not fire on weakly-related
prior work at the calibrated `cosThreshold`.

---

## J6 — Two durable-knowledge roots

**Status:** ✅ Resolved 2026-07-27 · **Effort:** M–L · **Kind:** architecture / single source of truth

Spec: [`docs/superpowers/specs/2026-07-27-jarvis-j6-memory-root-unification-design.md`](superpowers/specs/2026-07-27-jarvis-j6-memory-root-unification-design.md).

### Problem
`~/.waveterm/memory` (`pkg/memvault`, feeding the cockpit **Memory** surface, harvest, projection and
recall) coexisted with the Wave Vault's own `memory/` at `~/.waveterm/vault/memory/`. A's deferral
states the long-term intent plainly: the vault's `memory/` should be *the single durable-knowledge
root*. Two roots was the interim state, not the design.

### Correction to this entry's original framing
This entry called unification *"a consolidation, not a capability change"*. **That was wrong**, and the
correction is why the work mattered. `~/.waveterm/vault/memory/` **had no writer and never had one** —
it was scaffolded on every `OpenVault` and included in `AllScope()`/`WorkerScope()`, so every
vault-backed consumer traversed it and every one of them read nothing:

- `jarvisrecall.retrieve` → `selectSeeds` + `Expand`
- `jarvisembed` index / reconcile
- `jarvisattrib` semantic attribution (L4)
- `jarvisproactive` gate (S3)
- U3's whole-vault graph surface

The memory lane was a **no-op**, not a duplicate. The only route by which a memory note reached recall
was an explicit user attachment (`resolveAttached`'s `"memory"` case, reaching into `memvault.ScanVault`
directly).

### What shipped
- **`pkg/memroots`** — the single registry of durable-knowledge locations: vault root, memory root
  (the one write target), the external mirrors, project-label + scope derivation, and the one-shot
  legacy-root migration. Leaf package: `memvault` and `wavevault` both import it, neither imports the
  other.
- **`wavevault.Retriever.load`** federates the agent-native memory dirs (`~/.claude/projects/*/memory`,
  `~/.codex/memories`) into the memory collection as **read-only mirrors** — `resolvePath` and `Commit`
  stay `v.Root`-scoped, so a mirrored file can be neither written nor committed. Nodes gain
  `Source` ("vault" | "claude" | "codex") and `Scope` (project label). Id precedence is now explicit
  vault-wins instead of accidental last-seen-wins.
- Mirrors are installed **only by `OpenVault`**, never `openVaultAt` — fixture vaults across
  `jarvisdossier` / `jarvisrecall` / `wshserver` stay hermetic.
- **`memvault`** derives its roots, scope and hub-path helpers from `memroots`; `Root` is now a type
  alias of `memroots.Mirror`, so `memdistill`, `memgarden`, `reporadar` and `wshserver_memory` needed
  no edits. Per-hub `MEMORY.md` index files no longer enter either graph.
- The legacy root is migrated under the vault on first `OpenVault` (idempotent, collisions skipped and
  logged, source dir removed only when empty). A custom `memory:vaultpath` is read in place, never
  moved.
- **`jarvisrecall.nodeCandidate`** carries `Scope` into the citation's `project`, so a mirrored hub note
  is labelled with the project it came from instead of implying it is this one's.

### Deliberately not done
The original **Verify** line *"the Memory surface reads through the vault API"* is amended rather than
met. `memvault.Note`'s typed projection (`Reviewed`, `CapturedAt`, `GardenerFlag`, `SupersededBy`)
drives the review / prune / archive UI, and re-deriving it from `Node.Frontmatter`'s generic
`map[string]any` buys nothing while touching 17 files across 5 packages. The property that mattered —
**both APIs read the same bytes from the same roots** — holds and is measured below.

Also unchanged: the agent-native dirs stay where they are (moving them would break the agents loading
that memory natively), `memory-pending` / `memory-archive` stay outside the graph, and retrieval still
does not filter by project (cross-project notes are tagged, not hidden).

### Verify — measured 2026-07-27 against the real machine
| Check | Result |
|---|---|
| One Wave-owned root on disk | `~/.waveterm/memory` absent; its note under `~/.waveterm/vault/memory/` |
| Vault `Retriever(AllScope())` sees the federated notes | **375 nodes** (354 memory / 17 tasks / 4 decisions), by source `claude:282 codex:71 vault:22`. Before: the memory collection held **1**. |
| Graph density | 375 nodes / 106 edges (was ~3 nodes) |
| Both APIs read the same bytes | `memvault.ScanVault(VaultRoots())` = 354 notes; memvault notes **not** visible to the vault Retriever: **0** |
| `MEMORY.md` index files excluded | 0 nodes with id `MEMORY` (4 rows fewer on the Memory surface) |
| Every memory node scoped | 0 memory notes with an empty `Scope`, across 41 distinct scopes |
| Cross-project retrieval | `Search("_NON_BACKTESTABLE")` → the krypton hub note, `source=claude scope=krypton`, with **no** user attachment — impossible before |
| Vault repo stays clean | `git -C ~/.waveterm/vault status --porcelain` empty after open + federated read; no `~/.claude` or `~/.codex` path ever enters vault history |
| Consumers unaffected | `go test ./pkg/...` green; `memdistill` / `memgarden` / `reporadar` / `wshserver` pass with zero source edits |

Two legs were **not** exercised live, recorded so the table is not read as more than it is:

- The migration *move*. `cmd/jarvisbackfill` had already folded `~/.waveterm/memory` into the vault
  earlier the same day, so `MigrateLegacyRoot` ran here as the no-op it is designed to be. The move
  path is covered by 5 unit tests (happy path, collision-skip, absent source, second run,
  non-markdown leftovers).
- A full recall through the app producing a grounding card. Everything feeding it is verified — the
  Retriever returns the cross-project note, and `nodeCandidate` mapping `Scope` → `project` is
  unit-tested — but the model call itself was not run.

### Known residue
`memvault.parseNote` lets frontmatter `metadata.source` override the root tag (so it reports sources
like `agent`), while `wavevault` sets `Source` purely from the root it walked — the source *vocabulary*
is pinned to `vault|claude|codex` there. The note **sets** are identical (0 missing either way) and
`Node.Source` only drives id precedence, so this is inert today; worth collapsing if `Source` ever
becomes user-visible.

---

## J7 — Evidence-gated smalls (held)

**Status:** ⏸ Held · **Kind:** polish

Each of these was deferred **pending evidence that it matters**, and that evidence has not appeared.
Listed so they are not re-discovered as if new; **do not build them off the spec alone.**

- **U2:** in-Wave `## Notes` editing; editing/superseding existing decisions from the UI (backend
  `SupersedeDecision` exists, no affordance); manual dossier creation; live push.
- **U3:** search/filter over the graph; a read rail; cross-surface nav out of a node; live push;
  whole-vault attribution (bloom is per-focused-task).
- **S2:** recency-aware semantic seed merge; loosening L4 gating to per-run silence.
- **S1:** warm-at-`Reconcile`-on-commit wiring (lazy from `Query` today).
- **C:** learning/cache tier. (Historical backfill from SQLite graduated out 2026-07-27 — shipped as `cmd/jarvisbackfill`, see J5.)
- **E:** app idle/quit continuity flush (A's quit commit already covers it); completed-task prose
  re-freshness.

Promote an item out of J7 only with a concrete trigger — a latency complaint, a repeated question, a
dense-graph legibility failure.

---

## J8 — Task-sharpen's "fast" mode selects the most expensive model

**Status:** ✅ Resolved 2026-07-27 — `fastModel` now reads `consult.CheapModel` (`haiku`) rather than a
second hardcoded alias. J3's `cheapModel` was promoted to exported `CheapModel` for this: `tasksharpen`
builds its own `--model` args (it appends `--tools ""` / `--no-session-persistence` to a cloned spec) so
it needs the alias *string*, not `SpecForTier`'s tiered spec — and two packages independently hardcoding
"haiku" would re-create exactly the desync that made this bug. The `sonnet` mode is untouched.

**Effort:** S · **Kind:** cost / correctness · **Found while doing J3**

### Problem
`tasksharpen` offers two sharpen modes, `fast` and `sonnet`. `fast` resolves to the `fable` alias under
a comment calling it *"the currently-advertised small-model alias"*. That is inverted: Claude Fable 5 is
Anthropic's most capable model and prices **above** Opus ($10/$50 per MTok vs Sonnet 5's $3/$15), with
notably longer turns. So the mode labelled "fast" is the slowest and roughly 3× the cost of the mode
labelled "sonnet" — for a bounded, tool-less prompt rewrite that is textbook cheap-tier work.

### Evidence
- `pkg/tasksharpen/tasksharpen.go:25-28` — `fastModel = "fable"`, with the incorrect comment.
- `pkg/tasksharpen/tasksharpen.go:32-41` — `resolveModel("fast") → fable`, `resolveModel("sonnet") → sonnet`.
- Pricing: Claude Fable 5 $10/$50, Opus 5 $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5 per MTok.

### Fix
Point `fastModel` at `haiku` (the alias J3 already added as `consult` `cheapModel`) and correct the
comment. **Not done in the J3 pass** because `mode` is a user-facing choice surfaced in the New-Agent
flow — swapping the model behind an existing mode changes output quality for a gesture people already
rely on, so it wants its own confirm rather than riding along in a cost refactor.

### Verify
A `fast` sharpen still produces a usable rewrite; measure the before/after cost and latency delta;
`sonnet` mode is unchanged.

---

## J9 — Retrieval reads only part of a note

**Status:** 🔲 Open · **Effort:** S–M · **Kind:** correctness / reachability · **Found while verifying J2**

### Problem
Both retrieval layers read a *different* proper subset of a note, and neither reads all of it. The two
gaps are independent bugs with one shape, and together they explain both of J2's paraphrase misses.

**(a) L2 keyword search never sees frontmatter.** `wavevault.Retriever.Search` matches
`strings.Index` over `r.g.bodies[id]` only (`pkg/wavevault/read.go:186-202`); `parseNode` splits
frontmatter off into `Node.Frontmatter` before the body is stored. A dossier's entire human-readable
content — its `objective` — lives in frontmatter, and its body is two marker-comment pairs plus an
empty `## Notes`. So **no dossier is reachable by keyword search at all**, whatever the query.

**(b) Embedding never sees the node id.** `jarvisembed.embedText` builds frontmatter + heading +
section text (`pkg/jarvisembed/chunk.go:68-92`) — deliberately, and it is why dossiers *are*
semantically reachable. But decision notes carry frontmatter of only `id / created / actor /
provenance / status`, and their body is the rationale prose. A decision's **subject** exists solely in
its filename-derived id. `2026-07-23-the-input-validation-security-boundary-was-modif` embeds as
`actor: radar … status: active` plus prose about which branch the fix was committed on — nothing about
input validation. Querying a decision by its topic cannot match it.

### Evidence
- Measured: the J2 probe's two misses are exactly one instance of each. The decision target is absent
  from the top 52 semantic nodes for a query about its own title.
- The `getApi()` shim dossier is a third, milder case: an identifier-dense objective
  (`getApi().closeTab/setActiveTab/createTab`, `commands.rs`) is lexically reachable but not
  conceptually — and (a) removes the lexical route, leaving it unreachable by either layer.

### Why it matters beyond the miss rate
It changes what J2's "graceful degradation" claim means. Turning embeddings off does restore v1
behavior exactly, as verified — but for `tasks/`, v1 behavior is *unreachable*, not *degraded*.
The semantic lane is not an enhancement over keyword recall for dossiers; it is the only seed path
that exists. That is a materially stronger dependency on a BYOK, opt-in, paid feature than
invariant 11's graceful-degradation contract reads as promising, and it should be stated outright
rather than left implicit.

### Fix
Two small, independent changes; neither needs a re-index of unrelated notes:
1. Include the node id (and, for tasks, `objective`) in the text `Search` matches — or index
   frontmatter values alongside the body. Restores a lexical route to dossiers and decisions.
2. Give decisions a `title`/`subject` frontmatter field written at authoring time
   (`jarvisbackfill` and the live decision writer both already know it — they derive the filename from
   it). Re-embedding the 4 existing decisions is trivial.

Order matters: (2) is a one-line authoring change plus a backfill; (1) touches a shared read path used
by recall, S3's gate and U3's graph, so it wants its own slice.

### Verify
The decision case from J2's probe table retrieves its target; a dossier is reachable by a keyword drawn
from its `objective` with embeddings **off**; the paraphrase probe re-run scores better than 3/5 with
no regression on the three that already pass.

---

## Out of scope (v3 boundary — do not re-surface)

Settled in the v2 meta spec: multimodal / image embeddings; reranking models and advanced hybrid-search
score fusion; a bundled local embedding model (local = a local-server base URL); auto-promotion of
proactive insights into `memory/**` (stays human-gated); cross-machine sync (the user's own git
remote). Plus all v1 non-goals, and light mode.
