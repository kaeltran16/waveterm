# Brief — integrating Jarvis further: what to build, and what the data says not to

> **Explored** 2026-07-31. **Outcome: no new surface yet.** The session converged on a floating companion
> ("desktop pet") as the delivery vehicle for unprompted Jarvis output, then killed it on evidence: the
> engine that would feed it has never evaluated a real goal. Two smaller items survive, and one of them is
> a defect rather than a feature.
>
> This is a decision record, not a spec. It exists so the companion is declined *with reasons* and so the
> measurement below is not re-run from scratch.

## The question

"How do we integrate Jarvis further" — read initially as a distribution problem (Jarvis is reachable from
too few places) and re-read by the end as a substance problem (there is not much in Jarvis to distribute).

## Where Jarvis already reaches

Read from the tree, not inferred. Jarvis → human is well built:

| Path | Implementation |
|---|---|
| Ask about a Run, a Radar finding, or a Memory note | `frontend/app/view/jarvis/contextualentry.ts` builds a source reference, opens the thread keyed by that object's oref (one thread per source, not one per click), and flips to the Jarvis surface |
| Attribution tags and "relevant past decision" cards on rows | The `ResolveAmbient` RPC command returns the whole dossier→object edge map in one read; `frontend/app/view/agents/ambient.ts` joins it per row. Real edges since the fixture provider was deleted (second-brain backlog item J1) |
| Past-work match at run dispatch | `pkg/jarvisproactive` evaluates every dispatched run and writes a suggestion to the run's metadata under `jarvis:proactive`; `frontend/app/view/agents/proactive.ts` draws it as a dismissible card inside the run body |
| A dossier captured for every dispatched run | `pkg/jarviscapture.CaptureRunDispatch`, called from the run-creation handler in `pkg/wshrpc/wshserver/wshserver_runs.go` |

Jarvis → the agents doing the work does not exist. The command-line helper's Jarvis subcommands
(`cmd/wsh/cmd/wshcmd-jarvis.go`) are `hold`, `complete`, `triage` and `run` — all of them a worker
reporting upward. There is no read path.

## Five gaps found

| # | Gap | Evidence | Verdict |
|---|---|---|---|
| 1 | A run parked at a review gate is silent outside the Jarvis surface | The nav-rail badge counts only live workers in the `asking` state — `channelAttributedAskORefs` in `frontend/app/view/agents/channelderive.ts` early-returns an empty set otherwise. The correct cross-channel attention list (review gates + Gatekeeper escalations + blocked workers) is built by `frontend/app/view/jarvis/railneeds.ts` and renders only in the Jarvis context rail, which unmounts when you navigate away | **Build.** A defect, not a feature request |
| 2 | Jarvis only speaks when spoken to | Everything is pull except the two pushes listed above | Deferred — see the measurement |
| 3 | Nothing answers "what happened while I was away" | Per-run continuity exists (`frontend/app/view/agents/resume.ts` + `resumeviews.tsx`, rendered inside `runbody.tsx`); there is no session-level delta | Deferred |
| 4 | You cannot correct Jarvis when its attribution is wrong | `pkg/jarvisattrib/lifecycle.go` has `Detach`, `Accept`, `Backfill` and `Harden` with no RPC command and no production caller. The consolidated-surface backlog recorded this (item JC13) and replaced the two dead buttons with the sentence "attribution is machine-maintained" | **Strongest candidate after #1** — see "The reframe" |
| 5 | Recall cannot answer about spend, sessions or files | The retrieval corpus is 424 nodes — 406 memory notes, 14 tasks, 4 decisions — measured and recorded in the constant comments in `pkg/jarvisrecall/retrieve.go`. The read-only scanners (`pkg/usagestats`, `pkg/agentsessions`, `pkg/gitinfo`) feed their own surfaces and are not indexed | Deferred |

## Paths taken and abandoned

### Letting the agents read Jarvis — declined

First proposal: a read subcommand on the command-line helper (`wsh jarvis ask`) wrapping the existing
conversation RPC command, plus injecting the dispatch-time past-work match into the worker's prompt.

**Declined because it is circular.** The corpus a worker would be served is already on that worker's disk —
the vault is markdown notes under a registered memory root (`pkg/memroots` is the registry), the dossiers
derive from runs the agents themselves reported, and the rest is git history and `docs/`. An agent that
greps a directory beats an RPC round-trip plus a synthesis pass on both latency and precision.

### The floating companion — designed, then deferred

The session's centre of gravity. Four placements were mocked against the real cockpit chrome; **C, floating
over the surface**, was chosen. Reference point: OpenAI's **Codex Pets**, shipped early May 2026 in the
ChatGPT desktop app — a companion floating above other windows reporting coding-agent task status, driven by
a sprite sheet (transparent PNG/WebP, 1536 × 1872), with four states (Running, Needs input, Ready, Blocked),
an activity tray on desktop, and reduced-motion handling that substitutes a still frame.

Two things worth keeping from that comparison:

- **Its state set is better than the one drafted here in two places.** *Ready* (finished, unseen) and
  *Blocked* (failed) are states Arc has and reports only as a colour on a row you must already be looking at.
- **It resolves the idle-animation objection properly** — animate, and honour the operating system's
  reduced-motion setting. "Never idle-loop" was too strict.

The design that followed treated the companion as **Jarvis's body rather than a status badge**: it speaks
unprompted carrying its grounding, takes a question from wherever you are already scoped to what is selected,
proposes work with one click into run creation, and takes its initiative level from the **existing** autonomy
ladder — Concierge asks, Gatekeeper volunteers and proposes, Delegator acts and reports. That last mapping is
the design's strongest idea: the volume knob is already a shipped setting with a stored profile, it just has
no visible body.

**Deferred anyway.** A companion is a *delivery channel*, not a capability — it does not improve retrieval,
widen the corpus or fix attribution. Delivery work pays off when content is good and under-consumed. See the
measurement.

## The measurement

Read from copies of both live SQLite stores (database, write-ahead log and shared-memory file, so recent
writes are included), counting runs in `db_run` that carry the past-work matcher's metadata key
`jarvis:proactive`.

- Packaged app — `%LOCALAPPDATA%\dev.arc.app\data\db\waveterm.db` — 18 runs
- Dev app — `%LOCALAPPDATA%\dev.arc.app-dev\data\db\waveterm.db` — 37 runs

| Slice | Runs | Carrying an evaluation | Hits |
|---|---|---|---|
| Packaged app, all real work, 2026-07-20 → 07-23 | 18 | 0 | 0 |
| Dev app, before embeddings were enabled | 18 | 0 | 0 |
| Dev app, on/after 2026-07-27 | 19 | 1 | 0 |

**The denominator is empty.** All 18 production runs predate 2026-07-27, the day embeddings became
enableable from the app (second-brain backlog item J2), so that zero is explained by the feature being off.
Every one of the 19 dev runs after that date is a verification-scenario dispatch — goals reading
`spawn-test only: do nothing, make no file changes, stop immediately`, plus the `ZZZ-4242` / `ZZZ-7373`
markers the CDP scenarios use. The one recorded evaluation returned `none`.

So the past-work matcher **has never evaluated a real goal**. Nothing follows about whether unprompted
Jarvis would be welcome, in either direction.

### The finding that is actionable

Of 19 post-enablement dispatches, 1 recorded an evaluation and 18 recorded nothing. The evaluator runs in a
detached goroutine under a timeout, and every failure path is non-fatal and silent: index unavailable,
embeddings off, provider error and a failed metadata write all return to a log line and leave the run
untouched (`pkg/jarvisproactive/proactive.go` documents these as invariants 10 and 11; the call site is in
`pkg/wshrpc/wshserver/wshserver_runs.go`). The embedding index exists on disk (8.24 MB in the dev data
directory) and one run completed to a verdict, so the machinery is at least sometimes alive.

**There is currently no way to tell whether it ran.** A feature that no-ops invisibly, and distinguishes
"found nothing" from "never executed" only in a log line, is unmeasurable by construction — which is why
this question had no answer before today.

## The reframe

Production holds **2 channels, 3 Jarvis conversations, 16 Radar reports and 18 runs**, the most recent on
2026-07-23. The retrieval corpus is 406 memory notes and **4 decisions**. The second-brain backlog already
says the binding constraint is corpus depth rather than tooling (item J5), and that two of the four
attribution weights cannot be measured from today's history at all.

Jarvis is not under-distributed. It is under-fed and lightly used. Every deferred item above — companion,
away-briefing, global ask — is a way to deliver more of something there is not much of.

This is also why **gap 4 (correcting attribution) is the strongest remaining candidate**: corpus *quality* is
the constraint, and the only thing that improves it is the operator correcting and adding to the record. That
compounds. A delivery channel is a one-time multiplier on whatever is already there.

## What to do next, in order

1. ~~**Make the dispatch evaluator observable.**~~ **Shipped 2026-07-31.** `ProactiveSuggestion` gained a
   `Reason` field and a `pending` status written before evaluation begins, so a run that never reached a
   verdict is distinguishable from one that ran and found nothing. Every terminal path in
   `pkg/jarvisproactive/proactive.go` now returns a record naming its reason, and `CreateRun` persists it
   whatever happens. This deliberately breaks the package's invariant 10.
2. ~~**Fix the review-gate blind spot.**~~ **Shipped 2026-07-31.** The list moved server-side to
   `pkg/jarvis/attention.go` behind `GetAttentionCommand`, is polled every 10 seconds, and feeds both
   nav-rail badges as well as the rail. `railneeds.ts` and `channelneeds.ts` were deleted rather than
   duplicated. See `docs/jarvis-tab.md` §12.
3. **Dispatch real work for a period, then re-run the measurement.** The query is saved as a script (see
   Artifacts) and costs nothing to repeat. **Now possible:** item 1 makes every attempt leave a record, so a
   repeat measurement can distinguish "never ran" from "ran and found nothing", and name which of the seven
   reasons a `none` was. Before this, all six silent failure paths looked identical to never having run.
4. **Then reconsider the companion.** It is not wrong, it is premature. If step 3 shows the matcher hitting
   on a reasonable fraction of real dispatches, the argument becomes easy.

## Explicitly not decided here

- Whether the companion should observe continuously or only react to events the backend already emits.
  Panels 1 and 3 of the mockup imply continuous observation (e.g. "three Radar findings share one cause"),
  which does not exist — the past-work matcher only runs at run creation. That is a backend addition, not a
  UI change.
- Whether "acts without asking" at the Delegator rung is in scope for a first cycle.
- The unresolved collision in placement C: below a 696px surface width the Jarvis context rail already
  leaves the layout and floats over the Stage's right edge, which is the same corner the companion docks in.
  The rail is load-bearing there and the companion is not.
- Widening the retrieval corpus to include spend, sessions and git state (gap 5).

## Artifacts

- Mockups (four placements, six states, the four-panel "Jarvis with a body" set):
  `.superpowers/brainstorm/1919-1785471990/content/` — gitignored, persisted for reference.
- The measurement script: `hitrate.mjs` in the session scratchpad. It copies nothing itself; point it at
  copies of `waveterm.db` and it prints the table above.
