# Jarvis Improvement Map — Meta Design

> 2026-08-12. The full map of "how to make jarvis actually helpful", in response to a
> dogfooding verdict: *"I barely use it — the only thing I use is the run channel."* One
> axis (Substance) is specced in
> [`2026-08-12-jarvis-work-ledger-memory-design.md`](2026-08-12-jarvis-work-ledger-memory-design.md);
> this document records the whole map, the sequencing, and what is explicitly out, so
> the delivery axis can be specced later without re-deriving the reasoning. It reads on
> the [2026-07-31 integration brief](../../briefs/2026-07-31-jarvis-integration-brief.md)
> (the decision record this supersedes) and on
> [`docs/jarvis-tab.md`](../../jarvis-tab.md) (the surface's own documentation).

## 1. The question

"How can we improve jarvis further — I am just not finding it helpful enough." The
07-31 brief answered a narrower question ("how do we distribute jarvis further") and
landed on a measurement: *"Jarvis is not under-distributed. It is under-fed and lightly
used."* The corpus was 424 nodes (406 memory / 14 tasks / 4 decisions), and the
past-work matcher had never evaluated a real goal.

This cycle re-asked the question from the operator's side. Three dogfooding corrections
shaped the answer, each removing a wrong approach:

1. **Transcript collection already exists** (`pkg/memdistill` enqueues finished
   sessions at session-end, batches them per project, distills durable learnings, and
   routes them through the memory tab's pending-review band). A session harvester would
   have duplicated it.
2. **The batch pipeline is lossy by construction** — per-session tail truncation
   (`combinedBudget / len(sessions)` in `buildCorpus`), semantic skips ("extract only
   durable learnings; if none, return empty"), and session-end hook dependence. Nothing
   about knowing the operator's work may depend on it.
3. **Runs are not the only way to use the app** — the agent button creates interactive
   sessions that never get a `Run` row. Their lossless record is the transcript file +
   the deterministic `agentsessions.ScanSessions` derivation (task, status, events,
   timestamps).

## 2. The reframe

The structured record of the operator's work **already exists and is complete**; the
app was just not querying it. Two lossless legs, both written outside any batch
pipeline:

| Leg | What writes it | Record |
|---|---|---|
| Runs (channels, background agents, pi runs) | wstore, synchronously per event | `Run` rows: goal, harness, status, project, commits, phases, timestamps + **sealed evidence** at completion (summary, files, verifications) |
| Interactive sessions (agent button) | transcript files on disk | `agentsessions.ScanSessions`: runtime, project, branch, task, model, status, started, duration, events |

Plus the derived layers already maintained: dossiers (vault `tasks/`: status,
blockers, refs, state narrative) and the attention list (`pkg/jarvis`, the "needs you"
set).

**The gap is a query model, not capture.** Recall is prose-shaped (semantic search over
notes); the facts are structured-shaped (wstore rows + transcript scans). "Where are
things", "what shipped", "what happened while I was away" are answerable
deterministically from data that already exists — nobody built the query.

## 3. The map

### Axis 1 — Substance (this cycle; specced)

**Feed the brain and make it askable.** A work-ledger query engine over the two
lossless legs; an ask path that composes ledger facts + judged prose recall; the batch
distill demoted to enrichment with visible accounting; a retrieval-correctness stack
(judge, superseded exclusion, liveprobe). Full detail in
[`2026-08-12-jarvis-work-ledger-memory-design.md`](2026-08-12-jarvis-work-ledger-memory-design.md).

### Axis 2 — Delivery (next cycle; deferred with reasons, now unblocked)

All four items were deferred on 07-31 because content was thin. The ledger removes that
objection — it is deterministic content with no LLM dependence.

| Item | 07-31 status | Now |
|---|---|---|
| **Jarvis tab landing = work-state briefing** (active work, needs-you, shipped recently, one-click ask) instead of an empty stage | not proposed (surface was in flux) | unblocked; the direct fix for "I barely use it" |
| **Bring-up brief** — "what happened while I was away" (new runs, status changes, decisions, attention since last visit) | deferred (gap 3) | unblocked; a deterministic delta over the ledger, no synthesis needed for the facts |
| **Pet volunteers ledger facts** at the autonomy ladder's set initiative (Concierge quiet / Gatekeeper volunteers / Delegator acts) | deferred (gap 2; companion killed on "the engine has never evaluated a real goal") | unblocked; the ledger is the engine, and the ladder is the volume knob |
| **Attribution correction** — ~~`jarvisattrib` has `Detach/Accept/Backfill/Harden` with no RPC and no consumer~~ **stale as of 2026-08-24:** Detach/Accept/ListDetached ship end-to-end (wshserver RPCs + the record view's detach/accept/undo UI); Backfill/Harden had no consumer and were unexported. Item closed — remaining attribution work would be new scope, not this gap. | closed | shipped |

### Axis 3 — Explicitly out (with reasons)

| Item | Reason |
|---|---|
| Floating companion window (desktop pet, Codex-Pets-style) | the in-tab pet + ledger covers the value at a fraction of the cost; revisit after dogfooding the delivery axis |
| Git commit indexing into memory | flood risk against an already-dense memory tab; agents can grep `git log` for line-level detail; dossiers + sessions cover "what happened" |
| Outcome notes from the distill pass | redundant with sealed run evidence + dossier state, which are synchronous and lossless |
| Proactive-matcher (`jarvisproactive`) re-measurement and tuning | a dogfooding gate after the substance lands, not build work; observability (`pending` reason records) already shipped 07-31 |
| Recall tuning constants (J5 category 3) | awaiting named triggers (elapsed time, complaints, labels) — see the open-issues entry |

## 4. Sequencing

Substance first, delivery second. Every Axis-2 item reads the ledger, so the ledger is
the dependency of all of them. The correctness stack (judge + probe) rides with
substance so the delivery axis starts from measured retrieval quality rather than hope.

1. **This cycle:** Axis 1 — ledger, ask path (RPC + CLI + pi tool), distill demotion +
   observability, correctness stack. Spec: the work-ledger design doc.
2. **Next cycle:** Axis 2 — landing briefing + bring-up, pet volunteers, attribution
   correction. Each gets its own spec against this map.

## 5. Explicitly not decided here

- Whether the bring-up brief is a landing-view header, a pet utterance, or both (delivery-axis scope).
- Whether attribution correction ships as panel UI, RPC-only, or both.
- Whether the "since last visit" cursor is per-window or per-profile (delivery-axis detail; the ledger delta is cursor-agnostic).
