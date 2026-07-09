# Channels tab — UX improvement backlog

Friction points and improvement ideas surfaced by testing every Channels-tab flow
end-to-end over CDP on 2026-07-03. Each item is grounded in a concrete thing that
tripped up hands-on use, with a proposed fix, rough effort (S/M/L), and the likely
source touchpoints. Companion to `docs/agents/channels-flows.md`.

**Recommended first three:** #1, #2, #5 — one fixes navigation, one fixes
trust-the-UI, one prevents accidental worker spawns. Biggest daily-use payoff.

**Status (2026-07-03):** #5 and #7 implemented + unit-tested (uncommitted; CDP visual
check deferred). #3 in progress in a parallel agent session. Others unstarted.
Design doc for #5/#7: `docs/superpowers/specs/2026-07-03-channels-legibility-design.md`.

**Update (2026-07-09):** a hands-on real-world retest (`docs/agents/channels-realworld-report/`)
drove a fix batch. **Shipped:** #1 (channels can now be named at creation *and* renamed — see #3),
#2 (live rail badges — every tier change now `loadChannels()` like create/delete), #3 rename
(new `RenameChannelCommand` + rail context-menu + inline-edit; archive still unbuilt), #4 (real
search `<input>` + client-side `filterChannels`), #6 (one-time inline confirm before arming
Delegator), #9 (gone workers collapse under a "Done · N" disclosure — per-worker dismiss still
deferred). Plus report-only findings: transcript auto-scroll on send, a `steer` tag on directive
rows, and the top finding — the "NEEDS YOU" panel + rail dot now exclude asks Jarvis already
auto-answered (shared `pendingAsks`/`answeredAskORefs` helpers). **Still deferred:** #8 ambient
nav/titlebar badge; consult inheriting the operator's global CLAUDE.md; routing the Activity-tab
"N need you" count through the same `pendingAsks` helper (unconfirmed double-count).
Plan: `docs/superpowers/plans/2026-07-09-channels-realworld-report-fixes.md`.

---

## Quick wins (small, high-value)

### 1. Distinguish duplicate channels in the rail — (S) — **top friction**
**Observed:** the rail held 5 channels all named "waveterm," separable only by the
tiny one-letter tier badge. Testing had to be driven entirely by numeric index
because rows were visually identical.
**Fix:** enforce unique channel names, or add a per-row subtitle — last-activity
time and/or worker count (e.g. "waveterm · 2 workers · 3m ago").
**Touchpoints:** `channelrail.tsx` (row rendering), `channelsstore.ts` (channel data
/ `channelsAtom`).

### 2. Live rail badges — (S)
**Observed:** switching a channel to delegator left the rail showing `C` until a
tab-cycle; clearing an unread left the count lingering. The commands persist
correctly — only the rail is stale because it reads a cached snapshot.
**Fix:** subscribe the rail to live WOS instead of the `channelsAtom` snapshot so
tier/unread badges update immediately.
**Touchpoints:** `channelrail.tsx`, `channelsstore.ts` (`channelsAtom` derivation).

### 3. Channel archive / delete / rename — (S–M) — **in progress (parallel agent)**
**Observed:** there is no way to remove a channel, so test/dead channels accumulate
forever; the rail was already cluttered from prior runs.
**Fix:** add archive (or delete) + rename actions on a rail row.
**Touchpoints:** new wshrpc command (mirror `CreateChannelCommand`), `channelrail.tsx`
(row menu), `channelsstore.ts`.
**Status:** owned by a parallel agent session (decided: hard delete + confirm, plus
inline rename). `DeleteChannelCommand` mirrors `CreateChannelCommand` → `DBDelete`
(already emits a WOS Delete event); delete/rename must `loadChannels()` to refresh the
snapshot-fed rail.

### 4. Wire up the channel search box — (S)
**Observed:** the rail's "Search channels" field is visual-only (per the
`channelrail.tsx` comment).
**Fix:** make it filter the channel list. Matters once #3 stops capping channel
count.
**Touchpoints:** `channelrail.tsx`.

---

## Medium (prevent costly mistakes)

### 5. Make consult-vs-dispatch legible before send — (M) — **done (uncommitted)**
**Observed:** `ask @claude X` (disposable one-shot review) and `@claude X` (spawns a
persistent worker + tab) differ by a single word but have wildly different
consequences. Easy to spawn a worker when you wanted a quick answer.
**Fix:** a live pre-send chip driven by `planMessage` — e.g. "→ one-shot review" vs
"→ spawns a new worker in \<project\>". Dispatch has real side effects and deserves a
visible tell.
**Touchpoints:** `channelssurface.tsx` (composer), reuse `planMessage`
(`channelmessages.ts`) to derive the preview.
**Status:** shipped via a pure `describePlan(plan, ctx)` helper in `channelmessages.ts`
(7 unit tests) rendered as a right-aligned chip before Send; warn tone for
worker-spawning verbs (dispatch, delegator `@jarvis <goal>`), neutral otherwise, no chip
for plain posts. Uncommitted; CDP visual check deferred.

### 6. Guard the step up to Delegator — (S)
**Observed:** moving the tier dial to delegator silently arms autonomous
worker-spawning. Nothing flags that Jarvis will now act on its own.
**Fix:** a one-time inline confirm the first time a channel enters delegator
("Jarvis will now spawn and run workers on its own"). The escalation contract
already protects forks; this protects the *arming* moment.
**Touchpoints:** `channelssurface.tsx` (tier dial → `SetChannelTierCommand` call site).

### 7. Show the real task alongside the AI title — (S) — **done (uncommitted)**
**Observed:** a worker running "reply with token DELEG8" was titled "Provide
delegation token," which read like a stuck auth prompt and cost an investigation.
**Fix:** keep the AI title as the headline but always show the real task as a
subline (or hover), so "stuck vs. just poorly-titled" is never ambiguous.
**Touchpoints:** fleet-panel roster rendering in `channelssurface.tsx`; the roster
label lives in `agentsviewmodel.ts` (`AgentVM.name`/`.task`), not `sessionviewmodel.ts`.
**Status:** `buildFleetSnapshot` (`jarvisderive.ts`) now carries the literal dispatch
text (`WorkerState.dispatchTask`) for live workers, not just gone ones; `WorkerRow`
subline shows `dispatchTask ?? task` with a full-text hover title. The AI paraphrase
stays the headline. 3 unit tests. Uncommitted; CDP visual check deferred.

---

## Bigger (autonomy legibility)

### 8. Cross-tab attention for escalations — (M–L)
**Observed:** a Gatekeeper escalation *blocks a worker on you*, but if you're on
another tab the only signal is a small rail dot.
**Fix:** route escalations into the Activity tab's "N need you" counter, and ideally
a titlebar/OS badge. As the fleet grows, "which of my workers is waiting on me?"
becomes the core question.
**Touchpoints:** escalation emission (`pkg/jarvis/cards.go` + wps events), Activity
tab counter, titlebar.

### 9. Fleet-panel "gone" hygiene — (S–M)
**Observed:** "FLEET HERE · 0 WORKING" sat directly above a list of finished
("gone") workers, which reads as contradictory; exited workers linger in the roster.
**Fix:** separate active from exited (collapse or a "Done" section) and let finished
workers be dismissed.
**Touchpoints:** fleet-panel rendering in `channelssurface.tsx`; `buildFleetSnapshot`
(`jarvisderive.ts`).

---

## Notes
- Efforts are rough: S ≈ FE-only, localized; M ≈ FE + a small backend command or
  cross-surface wiring; L ≈ new backend behavior or multi-surface coordination.
- None of these are correctness bugs — the flows all work (verified 2026-07-03).
  These are usability/legibility improvements.
- To pursue any of these, run the brainstorming → spec → plan flow before building.
