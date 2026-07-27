# Jarvis sub-project F — conversation backend — design

**Date:** 2026-07-23
**Status:** Design approved (brainstorming). Plan to follow.
**Type:** Sub-project spec (one `spec → plan → implementation` cycle under the [meta spec](2026-07-23-jarvis-second-brain-meta-spec.md)).

## Where F sits

Sub-project **F** of the [Jarvis second-brain meta spec](2026-07-23-jarvis-second-brain-meta-spec.md) — the app-facing conversation backend the [G UI surface](2026-07-23-jarvis-ui-surface-design.md) talks to. The meta spec's contract-first build order is `G → F → A/B → C → D → E`; G shipped first and pinned the G⇄F contract, so F is built now against that pinned contract, backed by the existing SQLite recall **shim** (`pkg/jarvisrecall`, Plan 2) until sub-project C replaces it behind the same wire protocol.

This spec assumes the meta spec's [cross-cutting invariants](2026-07-23-jarvis-second-brain-meta-spec.md#cross-cutting-invariants) and does not restate them. It inherits invariant 1 (determinism boundary = cost boundary — retrieval is free, only synthesis costs tokens), invariant 4 (collection/scope boundary enforced by the retriever's tool set, not a prompt), invariant 7 (grounding first-class; `weak`/`not-found` are rewarded terminals), and invariant 8/9 (presence D; cockpit design language) as hard constraints.

## What F delivers

Promote the Plan-2 **stateless** shim into the real conversation backend:

1. **Multi-turn conversations** — a follow-up (`"why did we do that?"`) resolves against prior turns instead of being answered cold.
2. **Persistence** — conversations survive restart and populate a durable history rail, as a registered `JarvisConversation` WaveObj in SQLite.
3. **Attached-scope retrieval fixed** — the Plan-2 gap where `AttachedORefs` is passed over the wire but never retrieved.
4. **The F⇄E continuity seam documented** (not implemented — E is a later sub-project).

Retrieval itself stays the shim's per-question recency+scope logic; **one model** is used for synthesis (tiering deferred — see [§Deferred](#out-of-scope--deferred)). The G render path and G's committed code stay untouched: the promotion is contained to Go + the FE store/mapper.

## What F deliberately does NOT do

- **No model tiering.** One (capable) model via the existing `consult.Run` (headless `claude` CLI). Recorded in `docs/deferred.md` ("Jarvis sub-project F — model tiering deferred").
- **No `aiusechat` dependency** — it is on the removal path; the model call stays on the `consult` harness.
- **No context-aware retrieval.** Retrieval stays per-question (recency + scope + attached). Prior-turn context is threaded into the *synthesis prompt*, not the retrieval. Traversal/seed-driven retrieval is sub-project C.
- **No continuity implementation.** The E `resume(task)` narrative is a later sub-project; F only documents the seam.
- **No attribution (D)** — F rides C-shim's layer-1/2 recall; no typed-edge dependency.
- **No semantic recall / embeddings** (v2).
- **No cross-window live streaming sync**, no conversation retention/pruning, no delete-from-rail (all YAGNI / out of v1).

## Architecture (Approach A)

The backend owns the conversation as a WaveObj; the RPC channel stays the live token stream:

- **Ownership.** `wavesrv` owns the `JarvisConversation` record. `JarvisConverseCommand` receives `conversationId` + the *new* prompt; the backend reads prior turns from the record it owns, so multi-turn context is trivial and cannot desync.
- **Live stream.** Working-steps, grounding cards, and prose fragments stream over the existing `JarvisConverseChunk` channel exactly as they do today.
- **Durability.** The backend persists the user turn at the start of a turn and the completed answer turn at the terminal, each with a WaveObj update.
- **Reconciliation is load-time, not a live overlay** (see [§5](#5-streaming--persistence-reconciliation)).

Rejected alternatives: **B** — stream by patching the WaveObj token-by-token (abuses the object store with token-frequency SQLite writes; would persist ephemeral working-step state). **C** — a pure/stateless backend where the FE sends full history and triggers a separate save (splits ownership — WaveObj writes must go through the backend anyway — and contradicts the persist-as-WaveObj choice).

## 1. Data model — the `JarvisConversation` WaveObj

Go is the source of truth; TS is regenerated via `task generate`.

**Registration** (`pkg/waveobj/wtype.go`): add `OType_JarvisConversation = "jarvisconversation"` to the const block and the registry map, mirroring `OType_RadarReport`.

**Persisted struct** (Go type name **`JarvisConvo`** — see [name collision](#name-collision) below), otype `"jarvisconversation"`:

| Field | Purpose |
|---|---|
| `OID / Version / Meta` + `GetOType()` | WaveObj machinery (required for a registered type). |
| `Title` | First question (rail label). |
| `ScopeMode` `ProjectPath` `AttachedORefs` | The conversation's fixed scope, set at creation. |
| `Turns []JarvisConvTurn` | Ordered turns (see below). |
| `CreatedTs` `UpdatedTs` | Rail ordering + freshness. |

**Turn / card / segment types live in `pkg/waveobj`**, not `wshrpc`. `wshrpc` already imports `waveobj`, so the streaming chunk's `Grounding` field becomes `*waveobj.JarvisConvoGroundingCard` — this **removes the current duplicate card definition** (the shim's `wshrpc.JarvisGroundingCard`) and respects one-way layering (`waveobj` cannot import `wshrpc`). Working-steps stay `wshrpc`-only — they are transient and never persisted. (The whole durable family uses the `JarvisConvo` prefix, matching the record type.)

- `JarvisConvoTurn` — discriminated by `Role` (`"user"` | `"jarvis"`). User turn carries `Text` + `Attachments []JarvisConvoSourceRef`. Answer turn carries `Prose` (raw model prose with inline `[n]`), `Grounding []JarvisConvoGroundingCard`, and `Terminal`. No working-steps.
- `JarvisConvoGroundingCard`, `JarvisConvoSourceRef` — the durable shapes (fields as in the G contract's view-model, minus the transient bits).
- **The answer turn persists raw prose, not pre-split segments.** The FE derives display segments from `Prose` by reusing the existing `parseCitations(prose, cards)` (`recallderive.ts`) — so there is one citation parser (FE), not a duplicate in Go.

**Migration** `db/migrations-wstore/000015_jarvisconversation.{up,down}.sql` — the `oid varchar(36) PRIMARY KEY, version int, data json` table, verbatim from `000013_radarreport.up.sql`. Apply with `task build:backend --force` (a new registered type without its table errors with "no such table").

**Store** `pkg/wstore/wstore_jarvisconversation.go` — mirrors `wstore_radarreport.go`: `CreateJarvisConversation`, `GetJarvisConversation`, `GetJarvisConversations` (`DBGetAllObjsByType` → newest-first by `UpdatedTs`), `AppendTurn`/`UpdateJarvisConversation` (`DBUpdateFn`), `DeleteJarvisConversation` (unused in v1 but symmetric).

### Name collision
A generated `JarvisConversation` (from Go) would clash with the FE view-model interface of the same name in `jarviscontract.ts`. To avoid churning committed G code, the persisted Go type is named **`JarvisConvo`** (otype string unchanged, `"jarvisconversation"`); the store maps `JarvisConvo` → the existing view-model for rendering. (Alternative — rename the view-model — touches more committed G files; not chosen.)

### Fixture safety
We are **not** promoting the view-model `JarvisConversation` to a WaveObj (that would force `otype/oid/version/meta` onto it and break G's fixtures per the known promotion gotcha). We add a *new* persisted type plus a mapper. The FE view-model and fixtures are untouched.

### ID format
Conversation OIDs must be valid ORef OIDs (UUID). The FE `startConversation` switches from `conv-${Date.now()}-…` to `crypto.randomUUID()` so `WOS.makeORef("jarvisconversation", id)` + `loadAndPinWaveObject` resolve.

## 2. Conversation lifecycle — create-if-absent
Empty conversations are **not** persisted. `startConversation` (a contextual entry that opens Jarvis with a draft before anything is asked) creates only FE state + a UUID; the record is created on the **first** `JarvisConverseCommand`. So an opened-but-unsent conversation leaves no row — only real conversations reach the rail.

## 3. Converse flow (multi-turn)

`JarvisConverseCommand(conversationId, prompt, scopeMode, projectPath, attachedORefs, requestId)` — the wire input shape already exists (Plan 2 was forward-looking); the change is behavioral:

1. **Load** the record by `conversationId`. **If absent, create it** with the passed scope and `Title = first prompt`. On continuation the scope fields are ignored — the record's scope wins.
2. **Persist the user turn** + WaveObj update. Runs on a **fresh context** (not the RPC ctx — a slow synthesis routinely outlives the request ctx, mirroring `postConsultReply`).
3. **Retrieve** deterministically (shim logic, the record's scope) **+ resolve attached ORefs** ([§4](#4-scope-resolution--attached-fix)).
4. **Assemble prior-turn context** — prior questions + prior answer prose, **capped at the last N turns** (no cheap-model compaction — tiering deferred) — prepended to `buildPrompt`. Multi-turn context lives in the synthesis prompt only.
5. **Stream** working-steps + grounding + prose over the RPC channel (unchanged from the shim).
6. On **terminal** (or error → `weak`), **persist the answer turn** (segments + grounding + terminal; no working-steps) + WaveObj update.

**History rail:** `ListJarvisConversationsCommand() → summaries` (`id/title/scopeMode/updatedTs`). Full turns load via WOS on row selection (`loadAndPinWaveObject`).

## 4. Scope resolution + the attached fix
`object | project | all` behave as in the shim. The Plan-2 gap — `AttachedORefs` passed but never retrieved — is fixed: each attached ORef is resolved to its object (run via `DBMustGet`; radar via report lookup; memory via vault-by-id) and **pinned** into the candidate slice (exempt from the `maxCandidates` recency truncation); scope-filtered recency candidates fill the remainder. Result: "Ask Jarvis about this run/finding/memory" actually grounds on the attached object.

## 5. Streaming ↔ persistence reconciliation
**Load-time rehydration, not a live WOS overlay.** Within a session the RPC stream is authoritative for the in-flight turn (FE atoms, as today); the backend persists in parallel purely for durability. On surface mount / reload, the FE rehydrates `conversationsByIdAtom` from persisted records (`ListJarvisConversationsCommand` + mapped turns on selection). The two converge — the RPC produces the same turn the backend persisted — so there is no dual-source flicker and no mid-stream WOS churn.

**v1 limitation:** a *second* cockpit viewing the same conversation sees a streaming turn only after it completes (persisted), not token-by-token. Cross-window live sync is out of v1.

## 6. F⇄E continuity seam
Two senses of "continuity," kept distinct to prevent reviewer confusion:

- **Quick-ask carry** (continue the same `conversationId` into a full conversation without a context break) — **delivered here** by persistence + multi-turn.
- **E resume-narrative** (`resume(task) → precomputed narrative`, refreshed only on fact change) — a **later** sub-project. F **documents** the intended seam (the signature C/E will honor) but ships **no** continuity code. No dead abstraction before its consumer — same discipline as the tiering defer.

## 7. Error handling
- **Model unavailable** (`claude` CLI absent) → `weak` terminal + explanatory text, persisted.
- **Stream error mid-synthesis** → persist whatever prose streamed, terminal `weak`.
- **Persistence failure** (WaveObj write) → logged; the live stream is never failed (durability degrades for that one turn only).
- **Create-if-absent race** → backstopped by the insert transaction; a duplicate insert is treated as a continuation.

## 8. Testing
- **Go pure** (`pkg/jarvisrecall/cards_test.go` extend): attached-ORef → pinned-candidate resolution; prior-turn context assembly + the last-N cap; terminal selection (unchanged, guard against regression).
- **wstore** (`pkg/wstore/wstore_jarvisconversation_test.go`): create / get / list-newest-first / append-turn / delete, mirroring the radar-report tests.
- **FE pure** (`frontend/app/view/jarvis/recallderive.test.ts` extend): persisted `JarvisConvo` record → view-model mapping; wire-card mapper against the relocated `waveobj` card type.
- **CDP** (`scripts/cdp/scenarios.mjs`, new `jarvis-multiturn`): ask → follow-up `"why?"` resolves prior context; reload → the conversation persists in the history rail. No jsdom (standing decision — wiring is verified live).
- **Migration:** `task build:backend --force` applies `000015`; assert no "no such table".

## File-touch map

**Go — new/changed:**
- `pkg/waveobj/wtype.go` — register `OType_JarvisConversation`.
- `pkg/waveobj/jarvisconvo.go` (new) — `JarvisConvo` + `JarvisConvoTurn`/`JarvisConvoGroundingCard`/`JarvisConvoSourceRef` durable types + `GetOType`.
- `db/migrations-wstore/000015_jarvisconversation.{up,down}.sql` (new).
- `pkg/wstore/wstore_jarvisconversation.go` (new) + `_test.go`.
- `pkg/wshrpc/wshrpctypes_jarvis.go` — `JarvisConverseChunk.Grounding` → `*waveobj.JarvisConvoGroundingCard`; add `ListJarvisConversationsCommand` + its data/rtn types; drop the duplicate `wshrpc.JarvisGroundingCard`.
- `pkg/wshrpc/wshserver/wshserver_jarvis.go` — `JarvisConverseCommand` gains create-if-absent + persist user/answer turns; add `ListJarvisConversationsCommand`.
- `pkg/jarvisrecall/{recall,cards}.go` — attached-ORef resolution; prior-turn context assembly; emit the `waveobj` card type.
- Regenerate: `task generate` (TS + Go bindings) after the type changes.

**FE — changed:**
- `frontend/app/view/jarvis/jarvisstore.ts` — UUID ids; rehydrate from `ListJarvisConversationsCommand`; map persisted → view-model; unchanged live-stream path.
- `frontend/app/view/jarvis/recallderive.ts` (+ test) — persisted-record → view-model mapper; adapt `mapWireCard` to the relocated card type.
- `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` — regenerated (do not hand-edit).

**Docs:**
- `docs/deferred.md` — already carries the tiering-defer entry (2026-07-23).
- Meta-spec tracking table F-row link — deferred to F's feature commit (avoid colliding with the concurrent Plan-4 edit to the same file).

## Open risks
- **`task generate` bootstrap** when changing wshrpc types — regenerate in the right order (Go first, then TS) per the known codegen-bootstrap gotcha.
- **WaveObj-promotion TS breakage** is avoided by design (new type + mapper, not a view-model promotion), but the regenerated `JarvisConvo` must be verified not to shadow the view-model name in any importing module.
- **Prior-turn context size** — the last-N cap is a fixed heuristic; if conversations grow, cheap-model compaction (deferred with tiering) is the intended lever, not a larger N.
