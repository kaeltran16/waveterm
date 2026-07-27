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

**Dependency order.** J1–J4, J6 and J8 are done. J5's *populate a vault* half shipped 2026-07-27 as
`cmd/jarvisbackfill` and J6 (same day) added ~354 federated memory notes to what the vault reads;
what remains is corpus **depth**, not tooling — read J5's "Corpus reality" section before planning any
calibration, because two of D's four weights cannot be measured from today's history at all.

---

## J1 — Ambient layer renders fabricated edges

**Status:** ✅ Resolved 2026-07-27 · **Effort:** S · **Kind:** correctness / product trust

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
**Not done:** the CDP surface-smoke on Cockpit + Radar + Memory, and no check against a *populated*
vault — with an empty vault the correct result is no tags anywhere, which is weak evidence.

---

## J2 — No way to enable embeddings from the app

**Status:** ✅ Resolved 2026-07-27 (reachable; not yet exercised) · **Effort:** S (frontend-only) · **Kind:** reachability

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
**Not verified — the substantive half:** nobody has toggled it on against a real OpenAI-compatible
endpoint, so S1/S2/S3 are *reachable* but still have never run against a provider. The original verify
step (index builds; a differently-worded recall query finds its source; toggling off restores exact v1
behavior) needs an endpoint and key and remains outstanding. **J5 is unblocked in principle only** until
someone does this.

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
  observable confidences are L1 (1.0) and L3 (0.3).
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
(`timeBoxMs`), **6 are hard-blocked on an embedding provider** (`weightLayer4`, `semCandidateN`,
`semThreshold`, `kSem`, `cosThreshold`, `queryK`), and the remainder have no discrimination pressure
because the corpus produces only two distinct confidences. The backfill moved the blocker, it did not
remove it.

**Update 2026-07-27 (J6).** The "populate a real vault" precondition is now satisfied on the memory
side too: root unification federated the agent-native memory dirs into the vault's `memory/`
collection, so a vault `Retriever` returns **375 nodes / 106 edges** where it returned ~3. That makes
U3's dense-graph legibility item live rather than theoretical, and it means the first `jarvisembed`
reconcile after embeddings are enabled will index ~354 nodes on the operator's own key — real spend,
intended, but know it before flipping J2's toggle. The dossier/decision thinness above is unchanged;
L2 and L4 remain uncalibratable from this history.

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

## Out of scope (v3 boundary — do not re-surface)

Settled in the v2 meta spec: multimodal / image embeddings; reranking models and advanced hybrid-search
score fusion; a bundled local embedding model (local = a local-server base URL); auto-promotion of
proactive insights into `memory/**` (stays human-gated); cross-machine sync (the user's own git
remote). Plus all v1 non-goals, and light mode.
