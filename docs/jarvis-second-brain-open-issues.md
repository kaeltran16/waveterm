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
| J1 | Ambient layer renders **fabricated** task tags / decision cards | correctness / trust | S | — | 🔲 Open |
| J2 | No way to enable embeddings from the app → S1–S3 are dark code | reachability | S | — | 🔲 Open |
| J3 | Model tiering (invariant 2) never landed — C + E both burn the capable tier | cost | M | — | ✅ Resolved 2026-07-27 |
| J4 | `jarviscontinuity.Resume` has no consumer (no "pick up where you left off") | feature gap | S–M | — | ✅ Resolved 2026-07-27 |
| J5 | Every tuning constant across the feature is an uncalibrated PLACEHOLDER | correctness / tuning | M | J2 | 🔲 Open |
| J6 | Two durable-knowledge roots — `memvault` never unified into the Wave Vault | architecture | M–L | — | 🔲 Open |
| J7 | Evidence-gated smalls (U2/U3/S2/S1/C leftovers) | polish | S each | evidence | ⏸ Held — do not build on spec alone |
| J8 | Task-sharpen "fast" mode points at `fable`, the *priciest* model | cost / correctness | S | — | 🔲 Open (found during J3) |

**Dependency order.** J1 and J2 are independent and both cheap — start there. J5 is gated on J2 (you
cannot calibrate against a vault you cannot embed). J3, J4 and J6 are independent slices of their own.

---

## J1 — Ambient layer renders fabricated edges

**Status:** 🔲 Open · **Effort:** S · **Kind:** correctness / product trust

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

### Fix
Implement `AmbientProvider` over D's `EdgesFor` and swap it in behind the existing interface. The
render components and surface wiring stay unchanged — that was the point of the seam. Two sub-parts:
1. `tagsFor(oref)` → the dossier(s) a Run/Radar/Memory object is attributed to.
2. `decisionsFor(oref)` → decision records reachable from those dossiers.

Needs a read path from the frontend (D's `EdgesFor` is Go-side); check whether U1's `ResolveSpaceScope`
or U2's `GetDossier` already covers it before adding a new command. Low-confidence / probation edges
must render distinctly, matching U3's treatment (v2 invariant: a provisional edge never reads as
canonical).

### Verify
Tags on a Run row match the dossier that Run is actually attributed to; an unattributed object shows
**no** tag (the fixture always showed something); the `title="placeholder"` marker is gone from
`ambientviews.tsx`; CDP surface-smoke on Cockpit + Radar + Memory.

---

## J2 — No way to enable embeddings from the app

**Status:** 🔲 Open · **Effort:** S (frontend-only) · **Kind:** reachability

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

### Fix
Add an embeddings section to the settings surface. **No new backend is required:**
- config writes go through the existing settings-write path used by the other sections;
- the key writes through the **already-generated** `SetSecretsCommand`
  (`pkg/wshrpc/wshrpctypes_secrets.go:12`, `pkg/wshrpc/wshserver/wshserver_secrets.go:35`).

Plugs into `frontend/app/view/agents/settingssurface.tsx` alongside the existing sections
(`MemorySection` at line 67 is the closest precedent). Fields: enabled toggle, base URL, model, API
key (write-only, never read back into the input). BYOK framing per v2 invariant 12 — make it explicit
that the user supplies the endpoint and bears the cost, and that "local" is just a local-server base
URL. Surfacing index state (chunk count / model tag / rebuild) is a nice-to-have, not required.

### Verify
Toggle on with an OpenAI-compatible endpoint → S1 builds an index over a populated vault; a recall
query phrased in different words than the source finds it (S2's L3, the stated "first demoable
semantic win"); toggle off → identical v1 behavior, no error anywhere (invariant 11).

---

## J3 — Model tiering never landed; C and E burn the capable tier

**Status:** ✅ Resolved 2026-07-27 — `consult.Tier` + `SpecForTier(runtime, tier)` (`pkg/consult/consult.go`)
is the shared selector; E's boundary summary takes `TierCheap`, recall's synthesis takes `TierCapable`.
`TierCapable` deliberately emits **no** `--model` flag, so it keeps the operator's configured CLI default
and the capable path is byte-identical to before tiering — the change is additive, not a re-pointing.
Cheap alias is `haiku` (Claude Haiku 4.5, ~1/5 Opus input cost). **Note:** `pkg/tasksharpen` calls
`fastModel = "fable"` "the currently-advertised small-model alias" — that is wrong (Claude Fable 5 prices
*above* Opus), but it drives a user-facing "fast" sharpen mode and was left alone; see J8 below.
Two grunt-tier call sites remain on the default deliberately (out of J3's stated scope): S3's relevance
judge (`pkg/jarvisproactive/proactive.go:23`) and the gatekeeper classifier / delegator decomposer
(`pkg/jarvis/{classify,decompose}.go`). Each is now a one-line change against the same selector.

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
**Deferred:** the three ambient cards (`RelevantDecisions`, `ProactiveCard`, `ResumeCard`) now duplicate
their chrome; unify into one shell **after J1** lands, when all three are in view.

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

**Status:** 🔲 Open · **Effort:** M · **Blocked by:** J2 · **Kind:** correctness / tuning

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
Sequenced, not one pass: (1) land J2, (2) populate + embed a real vault, (3) calibrate the
**deterministic** constants first (D weights, C seeds, U3 visuals — these need no provider), (4) then
the semantic thresholds (S2, S3) against real cosine distributions. Record each calibrated value and
strike its `// PLACEHOLDER` marker plus its `docs/deferred.md` line as you go.

### Verify
No `// PLACEHOLDER` markers remain in the listed files; the U3 graph is legible against a *dense*
real vault (the current visual values were chosen in isolation); S3 does not fire on weakly-related
prior work at the calibrated `cosThreshold`.

---

## J6 — Two durable-knowledge roots

**Status:** 🔲 Open · **Effort:** M–L · **Kind:** architecture / single source of truth

### Problem
`~/.waveterm/memory` (`pkg/memvault`, feeding the cockpit **Memory** surface, harvest, projection and
recall) coexists with the Wave Vault's own `memory/` at `~/.waveterm/vault/memory/`. A's deferral
states the long-term intent plainly: the vault's `memory/` should be *the single durable-knowledge
root*. Two roots is the interim state, not the design.

### Evidence
- `pkg/memvault/memvault.go:207` `VaultRoots()`, `:216` `DefaultVaultPath()` — the legacy root.
- `docs/deferred.md` § "Jarvis sub-project A — memory vault coexists, unify later", whose resume
  condition is *"once A/B/C are proven"* — all three are built.

### Fix
Its own brainstorm → spec → plan slice (the deferral says so, and it carries a data migration):
migrate the legacy memory dir under the vault, point both packages at one root, fold the Memory
surface onto the vault read API, retire the duplicate root. `ScanVault` already unifies multiple roots
into one wikilink graph, so cross-collection `[[links]]` resolve either way — this is a consolidation,
not a capability change.

### Verify
One root on disk; the Memory surface reads through the vault API; existing notes and wikilinks all
resolve post-migration; memvault's other consumers (harvest / projection / recall) still pass.

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
- **C:** learning/cache tier; historical backfill from SQLite.
- **E:** app idle/quit continuity flush (A's quit commit already covers it); completed-task prose
  re-freshness.

Promote an item out of J7 only with a concrete trigger — a latency complaint, a repeated question, a
dense-graph legibility failure.

---

## J8 — Task-sharpen's "fast" mode selects the most expensive model

**Status:** 🔲 Open 2026-07-27 · **Effort:** S · **Kind:** cost / correctness · **Found while doing J3**

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
