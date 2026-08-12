# Jarvis Work Ledger — Design Spec (Axis 1: substance)

> 2026-08-12. Axis 1 of the
> [jarvis improvement map](2026-08-12-jarvis-improvement-map-meta-design.md): make jarvis
> *know the operator's work* — status, history, decisions, bring-up — and make it askable
> from the jarvis tab, the avatar, and pi agents. Reads on the
> [07-31 integration brief](../../briefs/2026-07-31-jarvis-integration-brief.md) (the
> measurement that set this direction), [`docs/jarvis-tab.md`](../../jarvis-tab.md) (the
> surface), and the open-issues entries J3/J5/J9/J11
> ([`docs/jarvis-second-brain-open-issues.md`](../../jarvis-second-brain-open-issues.md)).

## 1. Goal

The operator uses jarvis almost exclusively as a run dispatcher and "is not finding it
helpful enough". Diagnosed (07-31): under-fed, not under-distributed — and this cycle
verified three structural reasons: the batch distill pipeline is lossy by construction;
interactive agent sessions (agent button) are invisible to the run-centric surfaces;
and recall is prose-shaped while the operator's facts are structured-shaped.

This spec builds the **work ledger**: a deterministic query engine over the two
lossless records that already exist (wstore runs + sealed evidence; transcript files +
the `agentsessions` scan), plus a **stateless ask path** (RPC + CLI + pi tool) that
composes ledger facts with judged prose recall, and the **observability** that makes
every capture skip visible. Success criteria: the four question types the operator
chose — *status* ("where are things"), *history* ("what shipped/when"), *decisions*
("why did we…"), *bring-up* ("what happened while I was away") — answered from the
ledger deterministically, prose recall for the narrative layer, never from the batch
pipeline.

## 2. Ground truth (verified against source, 2026-08-12)

**The two lossless legs:**

- Runs: `pkg/waveobj/wtype.go:249` `Run` — goal, runtime, mode, projectpath, base/end
  commits, status (`planning|awaiting-review|executing|blocked|done|cancelled`),
  phases, created/completed ts, and `RunEvidence` **sealed once at completion**
  (summary, files, add/del totals, verifications). Written synchronously by the
  server (`CreateRunCommand`, seal at completion) — no batch anywhere in the path.
- Interactive sessions: transcript files on disk; `pkg/agentsessions.ScanSessions`
  derives `SessionInfo` deterministically (id, runtime, project, branch, task, model,
  tokens, status, started ts, duration, events). Exposed today via
  `GetRecentSessionsCommand` / `GetSessionsActivityCommand` (`wshserver_agents.go`).

**The batch pipeline (and its three loss mechanisms):**

- `pkg/memdistill` — session-end hook → `MemoryEnqueueSessionCommand`
  (`wshserver_memory.go:109`) → per-cwd bucket queue → flush/sweep → `runDistill`
  (TierCheap) → `RouteLearnings` → committed or pending-review. Errors retain the
  bucket (retry-safe — verified `coordinator.go` `flush`).
- Loss 1 — **truncation**: `buildCorpus` slices each session to
  `combinedBudget / len(sessions)` (`distill.go:75`); a long session is read as only
  its tail, and a big batch shrinks every slice.
- Loss 2 — **semantic skip**: the prompt says "Extract only durable, reusable
  learnings. If none, return `{"candidates":[]}`" — a session that shipped a feature
  with nothing reusable yields zero memory *successfully*.
- Loss 3 — **hook dependence**: a session enters the queue only if the session-end
  hook fires while the backend is up. Any miss is silent.

**Recall today** (`pkg/jarvisrecall`): `Converse` = `retrieve` (L1 ticket Query +
L2 keyword `Search`, ranked structured-first then recency, `seedTopK` 6; L3
per-collection embedding windows `kSemPerCollection` 6, `semSeedFloor` 0.325,
round-robin merge — the J11 fix) → `synthesize` (TierMid, numbered snippets,
`selectTerminal` grades citation discipline). Known gaps for this spec: **no relevance
judge** on the path (the proactive gate has one: `jarvisproactive` `judge` +
`SetJudgeForTest` seam, `proactive.go:20-38`); **no superseded exclusion**
(`wavevault.Filter` has no superseded field; `Search`/`Query` can return a
superseded note as ground truth); a **repeatable live probe already exists**
(`pkg/jarvisrecall/liveprobe_test.go`, 523 lines — the measurement culture to extend).

**Wire/CLI/pi:**

- `wsh jarvis` subcommands today: `hold`, `complete`, `triage`, `run` — all worker
  reporting upward; no read path (`cmd/wsh/cmd/wshcmd-jarvis.go`).
- pi tools: `pi/extensions/waveterm-tools.ts` registers `wave_*` tools that shell out
  to `wsh`, fail closed outside a Wave block; args live in `waveterm-tools-core.ts`;
  `task sync:piartifacts` copies both into `cmd/wsh/cmd/` (embedded)
  (`Taskfile.yml:172-177`). No jarvis read tool exists.
- Human decisions: `AppendHumanDecision` RPC exists (`wshserver_jarvis.go:461`) —
  the lossless primary decision path; only 4 decisions exist in the corpus, a
  production-shape problem, not a plumbing one.

## 3. Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │                JarvisAskCommand               │
                    │   (wshserver_jarvis.go; stateless, 1:1)      │
                    └───────────────┬──────────────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
   │   ledger layer   │   │  recall layer    │   │   judge layer    │
   │  pkg/jarvisstate │   │ jarvisrecall     │   │ (jarvisproactive │
   │ deterministic    │   │ retrieve (L1-L3) │   │  pattern, cheap  │
   │ facts: active /  │   │ + synthesize     │   │  tier, one call) │
   │ shipped / delta  │   │ (TierMid)        │   │                  │
   └───────┬──────────┘   └────────┬─────────┘   └────────┬─────────┘
           │                       │                      │
   wstore Run + Evidence ──────────┘   vault notes /      │
   agentsessions scan ──────────────   decisions /        │
   dossiers (vault tasks/) ─────────   dossiers corpus    │
   attention (pkg/jarvis) ──────────                      │
                                                          ▼
                                          shortlist: judged on-topic only
```

Three layers, one seam each, all swappable for tests. The ledger is a *query*, never
a write: it reads existing tables and scans; nothing new captures on this axis
except the human decision append, which already exists.

## 4. Components

### 4.1 `pkg/jarvisstate` — the ledger query engine (new)

Pure derivation functions over fetched inputs, plus a thin wire layer. Each function
is unit-testable without the OS or RPC (fixture runs/sessions/dossiers in, model out —
the repo's pure-seam convention).

| Function | Inputs (all already exist) | Output |
|---|---|---|
| `ActiveWork` | wstore runs (non-terminal), `agentsessions.ScanSessions` (live), attention items, dossiers | per-project: in-flight runs with status, live sessions, needs-you items, dossier blockers |
| `Shipped(window)` | completed runs with sealed evidence | per-project: shipped list — goal, summary, files, verifs, completed ts |
| `Timeline(window)` | runs (created/completed), sessions (started/finished), decisions (created), dossier status changes | merged, timestamp-desc events — the "what happened when" backbone |
| `Delta(sinceTs)` | same sources, filtered by a cursor | new runs, status changes, new decisions, new attention items — the bring-up answer (cursor-agnostic; delivery-axis detail, see meta doc §5) |

Wire: `JarvisStateCommand` (new wshrpc command) — filters `{project?, since?, kind?}`
over the four derivations, returning a structured `WorkState`. **Source health is part
of the response** (`Sources` status per leg): a failing leg degrades to empty and says
so — the "never ran vs ran and found nothing" discipline from 07-31, applied to the
ledger.

### 4.2 `JarvisAskCommand` — the stateless ask (new RPC)

Request `{prompt, cwd}` → response `{answer, sources}`. Flow:

1. **Ledger resolution** — reuse `jarvisrecall`'s ticket/keyword extraction (export
   `analyzeQuery` for the ask path)
   plus a small status/history word set ("status", "blocked", "in flight", "shipped",
   "since", "last week"…): when the query is status- or history-shaped, attach the
   ledger's `ActiveWork`/`Shipped` facts for `cwd`'s project as structured numbered
   snippets — and `Delta` only when the prompt names an explicit time window (the
   stateless ask cannot know "last visit"; that cursor is a delivery-axis detail,
   meta doc §5). Deterministic — no model call decides routing.
2. **Prose recall** — the existing `jarvisrecall` retrieval (L1–L3, unchanged) for
   decisions and notes.
3. **Judge** — §4.4 filters the merged shortlist to on-topic candidates.
4. **Synthesize** — existing TierMid path over the judged snippets (ledger facts are
   just numbered snippets like notes; they carry run/dossier ids as citations).

Implementation note: `jarvisrecall.Converse` (streaming, durable turns) and `Ask`
(stateless) share one retrieval→judge→synthesize core; `Ask` is the same core minus
conversation state and with the judge step inserted. The thread path inherits the
judge for free.

### 4.3 `wsh jarvis ask` / `wsh jarvis status` — CLI

- `wsh jarvis ask "<question>" [--cwd <path>] [--json]` — prints the answer plus a
  compact source list (note ids/paths, run/dossier ids). This is the seam pi and any
  other consumer shells out to, and it makes the feature testable from a terminal.
- `wsh jarvis status` — capture accounting, the observability this project keeps
  relearning it needs: vault note counts per collection, embedding index availability,
  last distill pass per cwd (from the activity feed `memdistill.PublishActivity` /
  queue state), sessions enqueued recently. Every section degrades to "unavailable"
  rather than failing the command. "Did it skip my session?" becomes answerable in one
  command instead of a silent maybe.

### 4.4 The relevance judge (recall correctness, layer 1)

Pattern from `jarvisproactive` (`judge` + `SetJudgeForTest` + prompt builder + reply
parser), adapted to a **batch call**: one cheap-tier call over the numbered shortlist
(question + candidates) returning the kept indices. Bounded cost (the shortlist is
≤ `maxCandidates` 12), cheap tier, and it *removes* wrong memories before synthesis
instead of hoping the model ignores them. Judge failure degrades to "keep candidates,
log" — a lost judge is a slower answer, never no answer. `selectTerminal`'s weak-grade
stays as the second, post-hoc check.

### 4.5 Superseded exclusion (recall correctness, layer 2)

One filter in both seed paths (`selectSeeds` L2 and `semanticSeeds` L3): nodes whose
frontmatter `superseded_by` is set never reach the shortlist. Today a superseded note
can still be cited as ground truth; the memory tab already computes supersession
(cleanup reasons), the retrieval side just never consulted it. (Verified: the vault
metadata key is `superseded_by`, `pkg/memvault/memvault.go:61`.)

### 4.6 Distill demotion + observability

- **No outcome notes** — redundant with sealed run evidence + dossier state (the
  synchronous, lossless record). The distill pass's only job stays durable learnings.
- **Decision emission as a bonus**: add `decision` to the distill candidate types with
  prompt guidance ("emit only when the session ends with an explicit choice, naming
  the alternative considered"). The *primary* decision path stays the human append
  RPC; distill decisions flow through the existing pending-review band (human gate).
- Queue semantics are already retry-safe (verified) — no change; the spec's
  verification step just pins it with a test that a failed flush retains the bucket.
- `wsh jarvis status` (§4.3) is the visible-accounting half.

### 4.7 `wave_vault_ask` — the pi tool

Registered in `pi/extensions/waveterm-tools.ts` like the other `wave_*` tools; args
builder in `waveterm-tools-core.ts`; installed through the existing
`install-agent-hooks` wiring; `task sync:piartifacts` regenerates the embedded copy.
Parameters `{question, cwd?}`. Description tells the agent when to use it and how to
treat the answer: *advisory — use when the user asks about past work, decisions, or
project state; verify or cite the returned sources before treating as ground truth.*
Fails closed outside a Wave block. This answers "can the agent access second-brain
knowledge" (the 07-31 brief declined a read path on circularity; the counter is: the
ledger assembles derived state — dossier status, evidence, session events — that raw
disk grep cannot, and the tool returns source paths so the agent can check).

## 5. Data flow

Ask (one request → one response):

```
wsh jarvis ask "did the ask bridge ship?" --cwd <repo>
  → JarvisAskCommand
  → ledger: Shipped(window) for <repo> → run "pi ask bridge" done, evidence: files+verifs
  → recall: decisions/notes touching ask bridge (judged on-topic)
  → synthesize (TierMid): "Yes — run <id> completed <ts>, changed <files>, verified <n>."
  → sources: [run:<id>, note:<id>, decision:<id>]
  → CLI prints answer + sources / pi tool returns {content, details}
```

Status command reads the same sources the ledger does, plus distill queue/activity —
read-only, no side effects.

## 6. Error handling

- **Ledger**: per-leg reads independent; failure → that leg empty + `Sources` status
  in the response. No all-or-nothing.
- **Recall**: existing invariants hold (index unavailable → L3 degrades to L1/L2).
- **Judge**: failure → keep candidates, log, answer anyway (slower, never absent).
- **Synthesize**: failure → error response like `Converse` today.
- **CLI**: nonzero exit + stderr on RPC failure; `--json` for machines.
- **Distill**: unchanged (retry-safe); visibility via `wsh jarvis status`.

## 7. Testing

- **jarvisstate**: unit tests per derivation over fixtures (the repo's pure-seam
  style; no live model).
- **Ask**: handler test with stubbed judge + synthesize + retrieve (the
  `converse_test.go` / `SetSynthesizeForTest` pattern), asserting ledger facts are
  offered as snippets and sources pass through.
- **Judge**: seam test (`SetJudgeForTest`), batch-reply parser unit tests, and the
  failure-degrades-to-keep behavior.
- **Superseded**: unit test that a superseded node is excluded from both seed paths.
- **Distill**: parse test for the new `decision` candidate type; a flush-retains-bucket
  test pins the verified retry semantics.
- **CLI**: round-trip test for `wsh jarvis ask` and `wsh jarvis status`.
- **Extension**: `waveterm-tools-core` arg-builder test in the existing `.test.ts`
  files.
- **Liveprobe**: extend `pkg/jarvisrecall/liveprobe_test.go` with a labeled
  query→expected-node fixture (~10 queries spanning the four question types + 2
  off-topic controls), run as a command against the real profile per the existing
  instructions — the guard that "too many memories" degradation becomes a number, not
  a feeling. The judge's effect is visible here too: off-topic seeds admitted vs
  removed.
- No CDP scenario: the ask path has no atom-hop state, the defect class CDP exists
  for; the frontend thread path is untouched this cycle.

## 8. Wire changes and generation

- New wshrpc types: `CommandJarvisAskData`/`CommandJarvisAskRtnData`,
  `CommandJarvisStateData`/`CommandJarvisStateRtnData` (`wshrpctypes_jarvis.go`),
  handlers in `wshserver_jarvis.go`. **Run `task generate`** after the types land;
  never hand-edit `wshclient.go`/`gotypes.d.ts`.
- No new `waveobj` types → no SQL migration.
- Frontend: no component changes this cycle (types appear in `gotypes.d.ts`; the
  jarvis tab continues to use `JarvisConverseCommand` unchanged).

## 9. Out of scope (this spec)

- Axis 2 delivery items (landing briefing, bring-up UI, pet volunteers, attribution
  correction) — see the meta doc; the ledger's `Delta` is their dependency.
- Git commit indexing (parked — flood risk; agents can grep).
- Kind-aware retrieval windows (deferred until machine-generated notes exist in
  Axis 2; the per-collection window already partitions memory/tasks/decisions).
- J5 tuning beyond this spec's correctness stack (category-3 constants await their
  named triggers — see the open-issues entry).
- Proactive-matcher re-measurement (a dogfooding gate after this lands).
