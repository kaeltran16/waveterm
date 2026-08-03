# Jarvis ambient views — one rail section instead of three render branches

**Date:** 2026-08-03 · **Surface:** Jarvis context rail + run body · **Scope:** one new rail section, one pure
module, three deletions, three existing CDP scenarios extended

## 1. Why

Three ambient views — the continuity resume narrative, the proactive "related prior work" suggestion, and the
attribution engine's relevant-past-decisions list — are placed per **run render branch**, so which branch
renders decides what the user sees:

| Run render branch | Resume | Proactive | Relevant decisions |
|---|---|---|---|
| pipeline / quick, unsealed (`frontend/app/view/agents/runbody.tsx:557`) | shown | shown | shown (`:574`) |
| orchestrator (`:539` → `OrchestratorBody` → `RunHeader` at `:338`) | shown | shown | **missing** |
| sealed done + evidence (`:536` → `RunCompletion`) | **missing** | **missing** | **missing** |

`ResumeCard` and `ProactiveCard` sit inside `RunHeader` (`runbody.tsx:190-191`); `RelevantDecisions` sits in
the pipeline branch only (`:574`). `RunCompletion` replaces `RunHeader` wholesale, so it draws none of them.

**The timing makes the sealed hole the important one.** `pkg/jarviscontinuity` writes the resume narrative
*only* on entering a rest state — `awaiting-review`, `blocked` or `done`
(`pkg/jarviscontinuity/continuity.go:41-47`, dispatched from
`pkg/wshrpc/wshserver/wshserver_runs.go:441-472`). For a run that completes, the narrative is written at the
exact transition that switches the renderer to the one view that cannot draw it. The backend even deletes the
dismissal flag at each new boundary so the card re-shows (`wshserver_runs.go:464`) — into a view with no
place to put it.

The test suite records the same gap from the other side. `jarvis-continuity-resume`
(`scripts/cdp/scenarios.mjs:760`) verifies that the run reached `done` and that a later Jarvis question
returns a grounded answer. It never asserts the narrative renders, because it never could.

**This is the third instance of one root cause.** The Ask Jarvis button was the first, fixed by re-adding it
to the completion report's own header — and `frontend/app/view/agents/runcompletionsurface.tsx:103-106`
states the cause in a comment: without it "the Run → Jarvis entry existed only while a run was still
unsealed, i.e. never for a run worth asking about." Consolidated-surface issue JC9
(`docs/jarvis-consolidation-open-issues.md:370`) is the record. Patching each branch again treats the symptom.

**One further reachability fact.** `ResumeVM` carries a `taskId`
(`frontend/app/view/agents/resume.ts:22`), and `jarviscontinuity.CaptureRunBoundary` returns nil when no
dossier references the run. The narrative is a statement *about a dossier*, and a dossier subject has never
been able to show it.

## 2. Decision

All three views move into **one context-rail section**, chosen by the subject on the Stage rather than by a
run render branch, and are **removed** from the run body.

The rail is the right layer because its sections are already selected exactly this way — by
`composeStage(subject.kind)` plus whether there is content, absent rather than empty
(`frontend/app/view/jarvis/stagerail.tsx:4-6`). One derivation replaces three placements, and a record
subject gains the narrative that names it.

Rejected alternatives, and why:

- **One extracted in-thread strip rendered at five call sites** keeps the placement inside the render branches
  that caused this, and spends the thread's vertical space — which the collapse-order work treats as a hard
  constraint (never take space from the thread or the composer, `docs/jarvis-tab.md` §1).
- **Patch `RunCompletion` and `OrchestratorBody` only** is the smallest change and leaves the root cause
  intact for the fourth time; a record subject still shows nothing.
- **Rail section plus a live-run strip** doubles the homes for the same three views.

**A collapsed rail hides the section, and that is correct.** All three views are informational and already
individually dismissible with a flag persisted to `run.Meta`. That is the opposite of Needs you, whose
contract is "always drawn, never filtered" (`stagerail.tsx:5-6`). A user who collapsed the rail has said they
do not want asides; losing an aside is not losing an ask. A per-section badge was considered and rejected on
its own terms: the collapsed strip draws exactly one glyph, `sections[0].icon`
(`frontend/app/element/collapsiblerail.tsx:149`), which for this rail is always the Needs-you bell, and a dot
there would report an ambient suggestion as attention.

## 3. What appears where

| Subject on the Stage | Where this stands (resume) | Related prior work (proactive) | Relevant past decisions |
|---|---|---|---|
| channel, a run resolved | that run's narrative, **any status** | that run's suggestion | that run's oref |
| channel, draft or no run | — | — | — |
| record (dossier) | most recent across attributed runs | — | — |
| thread (conversation) | — | — | — |

Three decisions in that table:

- **Proactive stays run-scoped.** The suggestion is written at dispatch and is about *that goal*
  (`pkg/jarvisproactive`, written from `wshserver_runs.go:289-299`). Aggregated over a record's runs it would
  be several stale suggestions competing, so a record subject shows none. What changes is that a *sealed* run
  keeps its suggestion instead of losing it at the seal.
- **Relevant decisions is omitted on a record subject.** A record already renders its own decision log in the
  thread (`frontend/app/view/jarvis/decisionlog.tsx`, called from `recordthread.tsx:150` and
  `taskdetail.tsx:188`). Two lists of decisions on one screen is worse than one.
- **Most recent wins on a record.** `ResumeVM.updated` gives a deterministic pick, and "where this stands" is
  singular by definition. No "+N earlier" expander: the record's run list already carries a per-run evidence
  summary line (`recordrunrow.ts`), so earlier narratives are reachable as history.

A thread subject yields nothing — all three views are run-scoped and a conversation has no run — so the
section is absent there. Grounding for a thread is already its own rail section
(`frontend/app/view/jarvis/groundingrail.tsx`).

## 4. Structure

**New `frontend/app/view/jarvis/ambientrail.ts`** — pure, and returns **data, not JSX**: given the subject,
the run resolved on the Stage and the record's attributed runs, it returns which of the three views apply and
what each is keyed to (a `Run` for resume and proactive, an oref for decisions), or null when none do. §3's
table lives here and nowhere else, which is what makes it testable without a renderer. Tested in
`ambientrail.test.ts`.

**New `frontend/app/view/jarvis/ambientrailview.tsx`** — exports `ambientSection(...)` returning
`RailSection | null`, following the established builder pattern of `groundingSection`
(`groundingrail.tsx:66`). It reuses `ResumeCard` (`frontend/app/view/agents/resumeviews.tsx`), `ProactiveCard`
(`proactiveviews.tsx`) and `RelevantDecisions` (`ambientviews.tsx`) **unchanged** — no new card components,
no new dismissal path.

**`frontend/app/view/jarvis/stagerail.tsx`** — push the section **last**, after Fleet. Unsolicited dismissible
content must not sit above live fleet state, and it must never be first because `sections[0].icon` is the
collapsed strip's only glyph and has to stay the Needs-you bell.

**Label and icon:** *Worth knowing*, with a `Sparkles` glyph. "Ambient" is the codebase's word
(`ambientcard.tsx`, `ambientviews.tsx`) but not a user's, the rail's own title is already "Context", and the
register should match its siblings — "Needs you", "Consults", "Fleet".

**Three deletions, which are the actual point.** `ResumeCard` and `ProactiveCard` out of `RunHeader`
(`runbody.tsx:190-191`); `RelevantDecisions` out of the pipeline branch (`runbody.tsx:574`). Skipping these
does not produce this design — it produces two homes for the same three views.

## 5. Data flow — no backend change

Nothing in Go moves. Both meta keys are already written by the server and already arrive on the run's
`waveobj:update`.

**The channel case** needs the run the Stage resolved, which `stagerail.tsx` does not currently receive.
Rather than duplicate the resolution or thread a prop through the surface, extract it: a derived read-only
`stageRunAtom` in `frontend/app/view/jarvis/jarvissubjectstore.ts` holding what `stage.tsx` computes today —
the `composing` guard, the `subject.id === channel?.oid` guard, and `resolveActiveRunId`
(`stage.tsx:126-131` and `:186`) — read by both the Stage and the rail. Small, and it removes a resolution
that would otherwise exist in two places.

**The record case** needs no new call. `recordRunsAtom[dossierId]` already holds full `Run[]` loaded through
WOS (`jarvissubjectstore.ts:120-127`), so `.meta` is present and `readResumeCard` works directly on them.

**Dismissal is unchanged.** `dismissResume` (`resume.ts:50`) and `dismissProactive` (`proactive.ts:50`) still
patch `run.Meta` through `ObjectService.UpdateObjectMeta`, and the session-scoped module atoms
(`dismissedResumeAtom`, `dismissedProactiveAtom`) still give the optimistic hide.

**One limit, recorded rather than left to be rediscovered.** The `Run[]` behind a record is a list snapshot
(`jarvissubjectstore.ts:51-53` says so), so on a record subject a persisted dismissal only leaves the list
after the next `reloadRecordScope`. The optimistic atom covers the session, so this is invisible unless the
user reloads mid-session.

## 6. Absence and failure

Absent rather than empty: no section at all when nothing applies, and no "nothing to show" placeholder — the
rail's own rule. No new failure modes are introduced: `readResumeCard` (`resume.ts:32-41`) and
`readProactiveSuggestion` (`proactive.ts:32-40`) already return null on missing, dismissed or malformed meta,
and `RelevantDecisions` returns null on an empty edge list (`ambientviews.tsx:63-65`).

## 7. Verification

**Unit — `ambientrail.test.ts`,** over the pure derivation: a sealed run yields the narrative (broken today);
an orchestrator run yields the decisions input (broken today); a record with three attributed runs picks the
highest `ResumeVM.updated`; a record whose runs carry no narrative yields null; a thread yields null; a
channel with a draft run yields null.

**Live — extend three existing scenarios, add none.** All three already exist and two of them will fail
against this change if they are not updated, which is the coverage working:

- **`jarvis-continuity-resume`** (`scripts/cdp/scenarios.mjs:760`) already builds the exact fixture this needs:
  a real quick-mode run advanced to `done` through `advancerun complete`, which fires the rest-boundary hook
  on the terse deterministic path (no model call). Add the assertion it was always missing — the narrative
  renders in the rail on the sealed run. **Timing caveat for the plan:** evidence is sealed off-band
  (`sealAsync`, `wshserver_runs.go:430`), and the run only reaches the `done && evidence` branch once that
  lands, so the step must poll rather than sample once.
- **`jarvis-proactive`** (`:851`) asserts the suggestion renders on the run body and that dismissal persists.
  Its probes read `document.body.innerText` and an `aria-label="Dismiss suggestion"` button, so they keep
  working once the card is in an **open** rail — retarget them at the rail and keep the dismissal leg intact.
- **`jarvis-ambient`** (`:569`) counts elements whose text is exactly "Relevant past decisions" across four
  surfaces. On the Jarvis surface that count now comes from the rail rather than the run body.

**Every one of the three must pin the rail open in `arrange`.** The helper already exists — `resetRail`
(`:1763`) — and the trap it was written for applies here: `stageRailOpenAtom` is persisted to localStorage, so
a previous scenario that drove a narrow width leaves the rail collapsed and these scenarios would fail on
inherited state. `docs/jarvis-consolidation-open-issues.md:135-137` records this exact order-dependence.

**Name collision to avoid:** there is already a scenario called `jarvis-ambient`. Do not add a second
scenario under that name or a near-variant.

## 8. Files and scope

| File | Change |
|---|---|
| `frontend/app/view/jarvis/ambientrail.ts` | new — pure derivation (§3's table) |
| `frontend/app/view/jarvis/ambientrail.test.ts` | new — six cases |
| `frontend/app/view/jarvis/ambientrailview.tsx` | new — `ambientSection(...)` returning `RailSection \| null` |
| `frontend/app/view/jarvis/stagerail.tsx` | push the section last |
| `frontend/app/view/jarvis/jarvissubjectstore.ts` | new derived `stageRunAtom` |
| `frontend/app/view/jarvis/stage.tsx` | read `stageRunAtom` instead of resolving inline |
| `frontend/app/view/agents/runbody.tsx` | delete `ResumeCard`, `ProactiveCard` (`:190-191`) and `RelevantDecisions` (`:574`) |
| `scripts/cdp/scenarios.mjs` | extend three scenarios; pin the rail in each |
| `docs/jarvis-tab.md` | §7 (context rail) gains the section; §14 needs no new atom row |

**Out of scope.** The other two ambient render sites are untouched: the Memory surface
(`memorysurface.tsx:368`) and the Radar finding detail (`radarfindingdetail.tsx:116`) both render
`RelevantDecisions` in their own detail panels, which is the same shape this change adopts. The collapsed
rail's lack of any content signal — including for Needs you — is a property of the shared
`CollapsibleRail` and a separate question. No Go changes, no codegen, no migration.
