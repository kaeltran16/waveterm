# Jarvis consolidated surface — open issues

Scoped backlog for the **merged Jarvis surface** (Subjects · Stage · one rail — commits `d76d4452` →
`5662f393`) and the entry points that dispatch into it (command palette, Radar handoff).

**Source:** a flow review of [`docs/jarvis-tour.md`](jarvis-tour.md) against the tree, 2026-07-29. The tour
walked the surface by screenshot; this walked the same fifteen flows through the code and found what a
screenshot cannot show — dispatch arguments, atom keying, and effects that never clear. Every citation below
was read, not inferred.

Two items (JC16, JC19) are carried from the 2026-07-28 CDP conformance report
([`docs/handoff/2026-07-28-jarvis-consolidation-design-conformance.md`](handoff/2026-07-28-jarvis-consolidation-design-conformance.md)),
whose two gaps were never tracked anywhere after it was written. Its third finding — the `narrow` fixture
button writing a dead atom — **is fixed** (`jarvisfixturebar.tsx:17` now writes `stageRailOpenAtom`); do not
re-open it.

Sibling of [`docs/open-issues.md`](open-issues.md) (repo-wide) and
[`docs/jarvis-second-brain-open-issues.md`](jarvis-second-brain-open-issues.md) (second-brain residue) —
nothing from either is duplicated here. Items the tour already recorded in its own *"What this pass
surfaced"* section are marked **[tour #n]** and carried here so there is one list to work from; when they are
fixed, that section of the tour gets cut rather than edited (JC18).

| # | Issue | Kind | Effort | Status |
|---|---|---|---|---|
| **A** | **Dispatch contract — the frontend guesses what the channel already decided** | | | |
| JC1 | ⚙ Save never reaches the composer, and the stale value **overrides** the setting just saved | correctness | S–M | ✅ Fixed |
| JC2 | Palette's Run row hard-codes a `pipeline` + gate fallback that beats the channel's strategy | correctness | S | ✅ Fixed |
| JC3 | Palette's Quick row bypasses `CreateRun` — the work leaves **no record** | correctness / trust | S | ✅ Fixed |
| **B** | **State traps — atoms that outlive their subject** | | | |
| JC4 | A pending Radar draft is global: it follows you to every channel and dispatches into the wrong one | correctness | S | ✅ Fixed |
| JC5 | An unresolvable "Needs you" jump hijacks navigation until reload | reliability | S | ✅ Fixed |
| JC6 | Graph peek keeps the previous selection, masking "nothing to focus" **[tour #4]** | correctness | S | ✅ Fixed |
| **C** | **Capability gaps** | | | |
| JC7 | Channel rename / archive / delete and dismiss-run lost their only caller in the merge | regression | M | ✅ Fixed |
| JC8 | A failed Jarvis query renders as "Weak grounding" — no error state, no retry, no cancel | correctness / trust | S–M | ✅ Fixed |
| JC9 | A finished run has no `Ask Jarvis` button **[tour #1]** | legibility | S | ✅ Fixed |
| **D** | **Legibility & layout** | | | |
| JC10 | "Talking to Jarvis" means both *dispatch workers* and *answer a question* | legibility | S | ✅ Fixed |
| JC11 | The `several` record band overflows the Stage **[tour #2]** | layout | S | ✅ Fixed |
| JC12 | At Delegator the header title truncates to 0px **[tour #3]** | layout | S | ✅ Fixed |
| JC13 | `Attach a record` / `Create one from this run` are unclickable spans **[tour, still open]** | legibility | S | ✅ Fixed |
| JC14 | `+ Channel` dead-ends with prose when no project is registered | legibility | S | ✅ Fixed |
| JC15 | The subject filter cannot match a run goal, and the run switcher is the only run list | legibility | S | ✅ Fixed |
| JC16 | The design's narrow-window collapse order was never built — the Stage absorbs every pixel of loss | layout / spec gap | M | ✅ Fixed (all four steps) — then **superseded by JC20**, which replaced the staircase |
| JC17 | `j`/`k` selects as it moves: one `selectChannel` + one thread prune per keypress | perf / polish | S | ✅ Fixed |
| JC19 | The record band's expand control is a `div` with `onClick` — mouse-only | a11y | S | ✅ Fixed |
| JC20 | Every band on the Stage owns its own measure, and the collapse staircase makes the thread *narrower* on a wider window | layout | M | ✅ Fixed (the measure part **revised by JC21**) |
| JC21 | The shared measure missed the band that did not opt in, and centring it left ~175px of dead gutter a side | layout | S | ✅ Fixed |
| JC22 | The two lowest text tiers are below readable contrast, and the record view puts five roles on two of them | legibility | S | ✅ Fixed |
| JC23 | A record's run list repeats the record's own objective on every row — the widest column carries no information | legibility / content | S | ✅ Fixed |
| **E** | **The tour itself** | | | |
| JC18 | Three inaccuracies, a missing teardown flow, an unjustified claim | docs | S | ✅ Fixed |

## What landed (2026-07-29)

Everything except JC17, JC8's cancel half and JC16's step 4 — **all three of which landed on 2026-07-29 in a
follow-up pass**; see "The remaining three (2026-07-29, follow-up)" below. Notes on the three that did not land
exactly as written:

- **JC7 — dismissed runs.** Decided by deletion: `channelDismissedRunsAtom` and the Stage's filter over it
  are gone. Cancel already stops a run and the switcher lists everything, so a filter no input could reach
  was only a trap for the next reader. Rename / archive / delete came back as a per-row context menu on the
  Subjects column, and archiving now moves the channel to a trailing `Archived · N` group — without that,
  the menu item would have had no visible effect. Autonomy deliberately did **not** come back.
- **JC8 — cancel.** The `"error"` terminal, its tone/copy and per-turn `Retry` all landed in this pass;
  cancelling an in-flight query followed in the 2026-07-29 follow-up below.
- **JC16 — step 4.** Steps 1 (context rail → 44px), 2 (Subjects → status dots) and 3 (record band → one
  chip + `+N`, now unconditional via JC11) are driven from one `ResizeObserver` at the surface root through
  the pure `jarvislayout.collapseFor`. Step 4, the nav rail → 56px, was deferred in *this* pass on the
  grounds that the nav rail is global chrome shared by every surface, so collapsing it from inside the Jarvis
  surface would be the wrong layer. The follow-up below built it at the right layer instead
  (`view/agents/navrailwidth.ts`), which is why the objection was about *where*, not *whether*. Rule 5 is
  encoded as a width assertion in two places — `jarvislayout.test.ts` (the arithmetic) and the
  `jarvis-collapse-order` CDP scenario (the live layout).

  Two limits worth stating rather than leaving to the next reader to measure. Below a **~740px surface
  width** (the 640px floor plus both collapsed strips — roughly an 818px window) the order has nothing left
  to yield and the Stage goes under its floor regardless; step 4 would have bought 22px of that. That is now
  gap 11b in `docs/jarvis-tab.md`, which previously read "there is still no genuine narrow-window rule" and
  was stale the moment this landed.

  One deliberate weakening: the width picks the rail's *default* by writing its open atom on the transition
  into narrow, rather than overriding it while narrow. Overriding also disabled the collapsed strip's expand
  button, which traded a broken layout for a dead control. A user who opens the rail on a narrow window can
  therefore push the Stage below its floor — their call.

Measured over CDP at 1920/1440/1100/900/720 (window → Stage px), before → after:
`1100: 372 → 706`, `900: 172 → 722`. Header title span: `0px at Delegator → 78px at every rung and width`.
Record band and document horizontal overflow: `0` at every width.

## The remaining three (2026-07-29, follow-up)

JC17, JC8's cancel half and JC16's step 4 all landed, alongside three gaps carried in `docs/jarvis-tab.md`
(12b, 12c and last-subject persistence). Six independent changes, not one system.

- **JC17 — the cursor commits on idle.** `listnav.ts`'s `cursor == selection` contract is untouched: five
  surfaces share it, and the same keys meaning different things per surface is a worse cost than the one
  removed. Only the *timing* changed — `selectSubject` runs 150ms after you stop moving
  (`subjectcursor.ts`). A click cancels a pending commit, which would otherwise land afterwards and move the
  user off the row they clicked. **The controller must not register `activate`**: `bindings.ts` only lets
  `Enter` pass through while it is unset, so claiming it swallowed Enter across the surface including the
  composer's submit. That regression was caught by `jarvis-subject-state` step 3 going red, not by the unit
  suite — the flush-on-Enter it would have bought was worth 150ms.
- **JC8 — cancel.** No new abort protocol: the RPC generator *is* the handle, so `gen.return()` sends the wire
  cancel and the server's streaming goroutine unwinds through `ctx.Done()`. A `liveStreams` registry keyed
  `conversation:answerIdx` holds it, `streaming` gates the `Cancel` control, and a new `cancelled` terminal
  reads muted — the user stopped it, so it is neither a verdict on the corpus nor a failed request. The flag
  is set *before* `gen.return()` because that call surfaces in the stream's own `catch`, which would
  otherwise report a break to the person who chose it.
- **JC16 — step 4, plus an overlay step nobody had specified.** The nav rail collapses *itself*
  (`view/agents/navrailwidth.ts`, 78 → 56px below a 900px window) — the right layer, which was the original
  objection. Jarvis needs no wiring: its `ResizeObserver` just measures a wider surface. A third step was
  added to `collapseFor`: once both strips are still not enough the context rail leaves the flow entirely and
  floats over the Stage (`railOverlay`), worth another 44px. The floor now holds down to a **696px surface**
  (~752px window) rather than ~740px; below that the residual stands, since rule 5 forbids taking it from the
  thread or the composer. Measured live at 760px: `stage=648px`, `rail.left=716 < stage.right=760`.
- **12b — thread lifecycle.** Two wshrpc commands (`DeleteJarvisConversationCommand`,
  `ArchiveJarvisConversationCommand`) wrapping store functions that already existed, and a thread row menu
  mirroring the channel one. Archived threads join the **same** `Archived · N` group as archived channels.
  One non-obvious half: archiving must also patch the **live in-session copy**, which shadows its own summary
  in `conversationsAtom` and would otherwise leave the row in `Threads` until the next launch. That was found
  by the CDP step reporting an empty Archived group while the backend held two archived records.
- **12c — dedup survives a restart.** `JarvisConversationSummary` now carries `AttachedORefs`, so
  `rehydrateSourceMap` rebuilds `sourceConversationAtom` on load. The frontend only ever sees summaries, so a
  field the summary omitted was unreachable. An in-session mapping always beats a persisted one.
- **Last-subject persistence.** The work is the *validation*, not the storage: a stored id can name something
  deleted, and the three lists load asynchronously, so `taskListAtom` and `persistedSummariesAtom` became
  nullable to distinguish "empty" from "not yet", and `restoreDecision` waits on only the one list its stored
  kind needs. `persistedSubjectAtom` needs `getOnInit: true` — without it the stored value lands one render
  after the first read, so the restore saw `null`, read it as "nothing stored", and latched its one-attempt
  guard forever. Also caught live, not by tsc.

Two things worth carrying forward. `tsconfig.json` sets `"strict": false`, so making an atom nullable produces
**no** tsc errors at its read sites — `dossiers.length` on a `null` typechecks and crashes the first frame.
Read sites have to be found by grep, not by the typechecker. And `jarvis-collapse-order` was latently
order-dependent: the surface persists `railOpen=false` the first time it collapses, so the scenario poisoned
its own next run. Both layout scenarios now pin `jarvis.stagerail.open` in `arrange`.

**Fix order** (followed as written; kept for the record). JC1–JC3 share one root cause and should land as one change (see A's preamble) — they are also
the only items on this list that can put a run into a state the user did not ask for. Then JC4/JC5 (both
one-shot-atom bugs), then the one-line legibility fixes that sit in files those changes already touch
(JC6, JC9, JC13). JC7 and JC8 are their own small features. The layout cluster JC11/JC12/JC16 is one
workstream and one CDP re-measure — JC16 is the largest single item here and the other two are its worst
symptoms, so do it in that order; JC19 rides along in the same file as JC11. JC18 last, so the tour describes
the fixed surface.

---

## A — Dispatch contract

All three share a root cause: **the frontend re-decides what the channel profile already decides, and the
server lets it.** `resolveRunPlan` (`pkg/wshrpc/wshserver/wshserver_runs.go:194-201`) falls back to the
channel's resolved profile only when `data.Mode == ""` — so any non-empty mode the frontend sends *wins*
over the channel's setting. Every frontend fallback is therefore a chance to contradict the channel, and
there are currently three different ones (a stale fetch, a hard-coded literal, and a footer default).

The shared fix is to stop sending `mode`/`planGate` for a plain run and let the server resolve them. `@quick`
stays explicit (it is a per-dispatch override by design), and the labels keep reading the fetched profile —
they just stop feeding the dispatch.

### JC1 — ⚙ Save never reaches the composer, and the stale value overrides what was saved

**Kind:** correctness · **Effort:** S–M

**Problem.** Tour §7 → §3. Open ⚙, set **Run defaults** to `orchestrator`, Save. The Launch footer still
reads *"→ pipeline run · stops at a review gate · set in ⚙"*, and pressing `Run ⏎` dispatches `mode:
"pipeline"` — which now beats the orchestrator setting server-side. The setting you just saved is silently
ignored until you switch subjects or reload.

**Evidence.**
- `frontend/app/view/jarvis/stage.tsx:76-93` — the profile fetch effect is keyed on
  `[subject?.kind, subject?.id]` only; nothing invalidates it.
- `frontend/app/view/jarvis/profilepanel.tsx:469-490` — `save()` writes through `setChannelProfile` /
  `setGlobalProfile` and updates local state only.
- `frontend/app/view/jarvis/stagecomposer.tsx:213-220` — `launchInto` sends `mode: profile?.defaultmode`,
  `planGate: profile?.defaultplangate` from that stale prop.
- `pkg/wshrpc/wshserver/wshserver_runs.go:195-201` — a non-empty `reqMode` wins over `resolved.DefaultMode`.
- The footer's own default compounds it: `frontend/app/view/agents/composercommand.ts:50-56`
  (`runFooterFor(undefined)` states pipeline + gate) via `channelcomposers.tsx:100-105`.

**Fix.** Two halves, both wanted:
1. Drop `mode`/`planGate` from the plain-run dispatch (`stagecomposer.tsx:213-220`) so the server is the only
   thing that resolves strategy.
2. Make the label honest: lift the resolved profile out of `stage.tsx`'s `useState` into a module atom keyed
   by channel id, and have `profilepanel.save()` invalidate/refresh it. While it is unresolved the footer
   should say so rather than assert a default (compare `palette-launch.ts:55`'s
   *"resolving channel strategy…"*).

**Verify.** ⚙ → orchestrator → Save → footer flips without a subject switch; dispatch and confirm the created
run's `mode` is `orchestrator`. Also set it back and confirm no stale override survives.

### JC2 — The palette's Run row can override the channel's strategy

**Kind:** correctness · **Effort:** S

**Problem.** Tour §8. `^P` → type a goal → fire **▸▸ Run** before the channel's profile has loaded (or after
its fetch failed) and the palette dispatches `mode: "pipeline"`, `planGate: true` explicitly — overriding a
channel configured for orchestrator or no-gate. The tour's parenthetical (*"it resolves at click"*) and the
code comment above the effect both claim otherwise; the launch deps are a closure over React state and
resolve nothing at click.

**Evidence.**
- `frontend/app/cockpit/command-palette.tsx:235-236` — `mode: runProfile?.mode ?? "pipeline"`,
  `planGate: runProfile?.planGate ?? true`.
- `frontend/app/cockpit/command-palette.tsx:108-126` — the prefetch effect and the inaccurate
  *"resolves the strategy at click time (see launch deps below)"* comment.
- `frontend/app/cockpit/palette-launch.ts:25-27,55` — the row's label already handles the unresolved case
  honestly, which is why nobody noticed the dispatch didn't.

**Fix.** Pass `undefined` for both and let `resolveRunPlan` decide; delete the stale comment. The row keeps
labelling itself from `runProfile` (that part is correct).

**Verify.** Set a channel to orchestrator, reload, open `^P` and fire Run immediately (before the label gains
its ` · orchestrator` suffix); the created run must still be an orchestrator run.

### JC3 — The palette's Quick row leaves no record

**Kind:** correctness / product trust · **Effort:** S

**Problem.** Tour §3's table and §8's row use "Quick" for two different transports. The composer's `@quick`
creates a single-phase **Run**, which captures a dossier. The palette's `↯ Quick · claude` posts a channel
mention instead: it spawns a bare agent tab with no Run object, so there is no `CaptureRunDispatch`, no
dossier, no evidence seal and no attribution. Work dispatched from the palette escapes the record system
entirely — directly against §9's *"CreateRun captures a dossier for every run it dispatches"*.

**Evidence.**
- `frontend/app/cockpit/command-palette.tsx:231` — `dispatch: (runtime, goal) => … sendText("@<runtime> <goal>")`.
- `frontend/app/view/agents/channelactions.ts:103-111` — `plan.kind === "dispatch"` → `launchAgent` + a
  `dispatch` message row. No run.
- `frontend/app/view/jarvis/stagecomposer.tsx:270-273` — the composer's `@quick` → `launchInto(…, "quick")`
  → `createRun`.
- `pkg/wshrpc/wshserver/wshserver_runs.go:262-264` — `jarviscapture.CaptureRunDispatch`, reached only via
  `CreateRun`.

**Fix.** Point the palette's Quick row at `createRun(ch.oid, goal, { mode: "quick" })`, same as the composer.
(The **Ask** rows are correctly a consult and should keep using `sendChannelMessage`.)

**Verify.** Palette-Quick a goal, then confirm a new row in `RECORDS · DOSSIERS` and a run in the channel's
run switcher — today you get neither.

---

## B — State traps

### JC4 — A pending Radar draft is global, not per-channel

**Kind:** correctness · **Effort:** S

**Problem.** Tour §13. Radar → **Start investigation** lands the draft on the project's channel. Select any
*other* channel before pressing Start and the "From Radar" banner and the goal follow you there; `Run ⏎`
dispatches the investigation into that channel, carrying `radarOrigin` — so the finding's outcome writeback
is attributed to a run in the wrong project. While the draft is pending it also forces the Launch face over
a live worker's Talk face on every channel, and hides whatever that channel's own draft held.

**Evidence.**
- `frontend/app/view/agents/runactions.ts:17-19` — `pendingRunDraftAtom` is a single value.
- `frontend/app/view/jarvis/stagecomposer.tsx:197-200` — `value` and `face` are overridden whenever
  `onChannel && radarDraft != null`; no channel comparison.
- `frontend/app/view/jarvis/stagecomposer.tsx:229-243` — dispatches into `channel.oid` (whatever is on the
  Stage) with `radarDraft.radarOrigin`.
- Contrast `frontend/app/view/jarvis/jarvissubjectstore.ts:133-142` — ordinary drafts are keyed by subject,
  and the comment there states exactly this failure mode for the plain draft.

**Fix.** Either key the draft by channel id like `jarvisDraftAtom`, or keep the single value and render/
dispatch it only when `pendingDraft.projectPath` resolves to the channel on the Stage (`resolveTargetChannel`
is already imported in `stage.tsx`). Second option is smaller and matches the atom's one-investigation-at-a-
time intent.

**Verify.** Start an investigation, switch to another channel: no banner, the other channel's own draft
intact, Talk face preserved if it has a live worker. Switch back: banner still there.

### JC5 — An unresolvable "Needs you" jump hijacks navigation

**Kind:** reliability · **Effort:** S

**Problem.** Clicking a need with a `runId` sets a one-shot focus atom that is cleared **only** when that run
appears in the landed channel's run list. If it never appears (channel load failed, run gone), the effect
re-fires on every subject change and yanks the user back to the need's channel — there is no way out but a
reload.

**Evidence.**
- `frontend/app/view/jarvis/stage.tsx:96-109` — clears `pendingRunFocus` only inside
  `if (allRuns.some(r => r.id === pendingFocus.runId))`; `subject` is in the deps, and the mismatch branch
  calls `selectSubject` back to `pendingFocus.channelId`.
- `frontend/app/view/jarvis/stagerail.tsx:67-75` — `goToNeed` sets the atom.
- `frontend/app/view/agents/runactions.ts:21-26` — the atom, documented as "the guard is clearing the atom".

**Fix.** Clear the atom once its channel is on the Stage and that channel's runs have loaded without the id
(or after a single attempt). Landing on the channel is already useful on its own; silently giving up on the
run is the correct degradation.

**Verify.** Set the atom to a bogus run id in a live channel via CDP, then select a different channel — you
should stay where you clicked.

### JC6 — Graph peek keeps the previous selection **[tour #4]**

**Kind:** correctness · **Effort:** S

**Problem.** Peek from a record (selects it), Esc, peek from a fresh thread that resolves to nothing — the
panel still shows the *record* under `SELECTED NODE`, so the honest "nothing to focus" state (and its node
filter) is unreachable until a reload.

**Evidence.**
- `frontend/app/view/jarvis/graphpeek.tsx:99-110` — the focusing effect returns early when
  `dossierId == null` and never clears.
- `frontend/app/view/jarvis/jarvisgraphstore.ts:23,42-44` — `graphSelectedIdAtom` is module-scope;
  `selectNode(null)` already exists.

**Fix.** One line: `selectNode(null)` in the `dossierId == null` branch.

**Verify.** The sequence above, without a reload. Closes the ordering constraint in the tour's
"Regenerating these images" (shots 18/19 no longer need a fresh page).

---

## C — Capability gaps

### JC7 — Channel lifecycle lost its only caller in the merge

**Kind:** regression · **Effort:** M

**Problem.** A channel, once created (tour §2), cannot be renamed, archived or deleted from the UI, and a run
cannot be dismissed. The store functions still exist and are now dead code; the Stage still *filters* by a
dismissed-runs atom that nothing can write. A mistyped channel name is permanent.

**Evidence.**
- `frontend/app/view/agents/channelsstore.ts:110` (`deleteChannel`), `:128` (`renameChannel`), `:135`
  (`archiveChannel`) — no callers anywhere in `frontend/`.
- `frontend/app/view/agents/channelsstore.ts:28` (`channelDismissedRunsAtom`) — read at
  `frontend/app/view/jarvis/stage.tsx:58,167-168`, written nowhere.
- The affordances lived in the deleted `channelrail.tsx` (a per-row context menu: Open, Autonomy submenu,
  Rename, Archive, Delete + `ConfirmModal`); see `git show 948e1bd8^:frontend/app/view/agents/channelrail.tsx`
  lines 123-167. `948e1bd8` deleted the file; the Subjects column never picked the menu up.

**Fix.** Give the Subjects column a per-row context menu for channels — Rename / Archive / Delete with the
existing `ConfirmModal` copy. Autonomy does **not** need to come back (the header ladder owns it now, and a
second control would be a second source of truth). Decide dismissed-runs separately: either wire a dismiss
affordance or delete the atom and the Stage's filter with it — a filter no input can reach is a trap for the
next reader.

**Verify.** Create a throwaway channel, rename it, delete it; confirm it leaves the column and the vault
records are untouched.

### JC8 — A failed Jarvis query renders as "Weak grounding"

**Kind:** correctness / product trust · **Effort:** S–M

**Problem.** Tour §12 documents six answer states; failure is not one of them. Every error on the converse
stream — dead backend, RPC timeout at 130s, mid-stream abort — is mapped to `terminal: "weak"`, which draws
the amber **Weak grounding** badge. "I looked and found little" and "the request died" are indistinguishable,
and a partially-streamed answer keeps whatever prose arrived under a warning that misdescribes it. There is
no retry and no way to cancel an in-flight query.

**Evidence.**
- `frontend/app/view/jarvis/jarvisstore.ts:246-249` — `catch { patchAnswer(…, { terminal: "weak" }) }`.
- `frontend/app/view/jarvis/jarvisstore.ts:174` — `JARVIS_RPC_TIMEOUT_MS = 130_000`.
- `frontend/app/view/jarvis/jarviscontract.ts:20` — `Terminal = "answered" | "weak" | "notfound"`.
- `frontend/app/view/jarvis/jarvisturnderive.ts:16-25` + `jarvisturn.tsx:51-60` — badge tone table; no error
  case, and nothing renders a retry.
- `frontend/app/view/jarvis/conversationview.tsx` / `recordthread.tsx` — turn lists, no per-turn affordance.

**Fix.** Add an `"error"` terminal to the contract with its own tone and copy (*"couldn't reach Jarvis"* —
error tone, not warning: this is not a statement about the corpus), and a **Retry** on the failed turn that
re-submits the same prompt into the same conversation. Cancel is a separate, larger ask — note it and leave
it.

**Verify.** Kill wavesrv mid-answer: the turn reads as a failure and Retry re-runs it once the backend is
back.

### JC9 — A finished run has no `Ask Jarvis` button **[tour #1]**

**Kind:** legibility · **Effort:** S

**Problem.** `RunBody` early-returns the completion report for a sealed run, and that report never renders
`RunHeader` — the only place `AskJarvisButton` lives. So the Run → Jarvis contextual entry documented in
§13's table exists only while a run is *unsealed*, i.e. it is unreachable for every run you would actually
want to ask about.

**Evidence.**
- `frontend/app/view/agents/runbody.tsx:525-527` — `if (run.status === "done" && run.evidence) return <RunCompletion … />`.
- `frontend/app/view/agents/runbody.tsx:168-170` — `AskJarvisButton` inside `RunHeader`.
- `frontend/app/view/jarvis/contextualentry.tsx:40-51` — the run prompt (*"What changed in this Run and
  why?"*) that currently has no reachable entry point.

**Fix.** Render `AskJarvisButton` in the completion report's own header (`runcompletionsurface.tsx`) with the
same `sourceRefForRun(run)`. Do not un-early-return `RunBody`.

**Verify.** Open a sealed run → `Ask Jarvis` → a thread with the `This Run` chip and the prompt pre-filled;
click it twice and confirm you land on the same thread (the one-thread-per-source rule).

---

## D — Legibility & layout

### JC10 — "Talking to Jarvis" covers two very different consequences

**Kind:** legibility · **Effort:** S

**Problem.** Tour §3 states the *Talking to* line is "the only thing that tells you where a keystroke goes".
On a channel with no live worker the chip reads plain **Jarvis** and Enter *spawns workers and spends money*;
on a thread the same chip reads `Jarvis · this thread` and Enter asks a question. The one signal the surface
relies on does not separate its two loudest outcomes.

**Evidence.** `frontend/app/view/jarvis/composertarget.ts:33-42` (the `workerName == null` branch returns the
bare `"Jarvis"` label for the Launch face) · `frontend/app/view/jarvis/stagecomposer.tsx:34-50` (`TalkingTo`).

**Fix.** Label the launch case `Jarvis · dispatch` (and `@ask` on a channel `Jarvis · consult`), keeping the
accent tone. Pure copy change in one pure function with existing unit tests (`composertarget.test.ts`).

### JC11 — The `several` record band overflows the Stage **[tour #2]**

**Kind:** layout · **Effort:** S

**Problem.** Measured in the tour: at 1440px the band row's content is 826px in a 790px box and the trailing
`Expand` label lands 36px past the Stage's right edge, drawn over the rail; at 1000px it overflows by 476px
and even the `one` case overflows. The row never wraps, so labels simply leave the column.

**Evidence.** `frontend/app/view/jarvis/recordbandview.tsx:59-63` (the row: `flex items-center`, no wrap, no
`min-w-0`) · `:83-94` (the `several` case maps every edge to a `flex-none` chip) · `:134-148` (the expanded
per-record rows already exist).

**Fix.** Cap the collapsed row at the primary chip plus a `+N` affordance; the expanded panel already lists
the others as clickable rows. Do not `flex-wrap` — a band that changes height on selection pushes the thread.

**Verify.** CDP re-measure at 1440 and 1000 on a run with 2+ attributed records; contact sheet shot 06.

### JC12 — At Delegator the header title truncates to 0px **[tour #3]**

**Kind:** layout · **Effort:** S

**Problem.** The title span measures 62px at Concierge/Gatekeeper and **0px** at Delegator (the dispatch-mode
strip takes the space), and 0px at *every* rung at 1000px. The subject you are looking at loses its name.

**Evidence.** `frontend/app/view/jarvis/stageheader.tsx:30-50` — the title is the only `min-w-0 truncate`
item in the row; the reach chip, absence chip, ladder and buttons are all `flex-none` ·
`frontend/app/view/jarvis/autonomyladderview.tsx:44-60` (the strip that claims the space).

**Fix.** Give the title a floor (e.g. `min-w-[10ch]`) and make the ladder yield first — drop the rung labels
to their bars, then the dispatch strip, before the subject's name gives up a pixel.

**Verify.** CDP measure of the title span at all three rungs, at 1440 and 1000; shot 09.

**Superseded 2026-07-30.** The cause is gone, not mitigated: the dispatch strip no longer renders in the
header at all (`docs/superpowers/specs/2026-07-30-jarvis-autonomy-chip-design.md`). The autonomy control is
a fixed-width chip whose box cannot change with the tier, so the title has nothing to lose space to —
measured 164px at every tier and every mode, with the title holding 99px at 1440/1000/860 and no overflow.
The `min-w-[10ch]` floor stays as belt-and-braces, and `jarvis-fleet` now asserts the chip's left edge is
identical before and after selecting Delegator.

### JC13 — `Attach a record` / `Create one from this run` are unclickable spans **[tour, still open]**

**Kind:** legibility · **Effort:** S

**Problem.** The band's `none` case renders two accent-styled `<span>`s that look like buttons and do
nothing. The Go lifecycle they would call has no wshrpc command and no production caller, so this cannot be
made to work as a small fix.

**Evidence.** `frontend/app/view/jarvis/recordbandview.tsx:64-70` · `pkg/jarvisattrib/lifecycle.go:78`
(`Detach`), `:111` (`Accept`), `:245` (`Backfill`), `:262` (`Harden`) — no callers outside the package.

**Fix.** Replace both with the truth for this cycle: *"attribution is machine-maintained"*. Re-add real
buttons only in the cycle that exposes the lifecycle over wshrpc.

### JC14 — `+ Channel` dead-ends with prose when no project is registered

**Kind:** legibility · **Effort:** S

**Problem.** Tour §0 step 2 exists *because* of this: the first thing a new user clicks tells them to go
somewhere else. The palette can already open the New-project modal from anywhere.

**Evidence.** `frontend/app/view/jarvis/subjectscolumn.tsx:210-213` (the text) ·
`frontend/app/cockpit/command-palette.tsx:151-160` (`newProjectOpenAtom`, the action it should call).

**Fix.** Make the empty state a button that sets `model.newProjectOpenAtom`, and drop step 2 from the tour's
§0 preconditions once it lands.

### JC15 — The subject filter cannot match a run goal

**Kind:** legibility · **Effort:** S

**Problem.** Tour §14 filters subject *labels* across the three kinds. Runs are not subjects — the only run
list in the product is the selected channel's inline switcher — so finding a run by what it was about means
selecting every channel in turn and reading each expansion.

**Evidence.** `frontend/app/view/jarvis/subjectscolumn.tsx:90-96` (label-only match) · `:292-328` (the run
switcher, only rendered for the selected channel).

**Fix.** Match run goals too and surface hits as run rows under their channel (selecting one sets the active
run, which the Stage already honours).

### JC16 — The narrow-window collapse order was never built

**Kind:** layout / spec gap · **Effort:** M

**Problem.** Not an open question — the behaviour is **specified** and simply absent. The design devotes a
section to a numbered collapse order (**1.** context rail → 44px, **2.** Subjects column → status dots,
**3.** record band → one-line chip, **4.** nav rail → 56px, **5.** *never* the thread and the composer, which
spec §12 calls "a hard constraint, not a preference"). Nothing is width-responsive, so the order inverts: the
thread and composer are the only regions that lose space. Measured over CDP at five widths — chrome holds a
constant 650px while the Stage goes 1270 → **70px** from 1920 → 720. This is also what makes JC11 and JC12
bite hardest at small widths, though both are already broken at 1440.

**Evidence.**
- `docs/handoff/2026-07-28-jarvis-consolidation-design-conformance.md` § "Gap 1" — the measurement table, the
  design's numbered order, and why the plan's coverage table missed it (it recorded that `CollapsibleRail`
  *supplies* 300/44 + `forceCollapsed`, not that anything drives it from width).
- `frontend/app/view/jarvis/stagerail.tsx:222` — `forceCollapsed` is wired to exactly one input,
  `profileOpen`.
- `frontend/app/element/collapsiblerail.tsx:60-62` — width is a function of the atom alone.
- `frontend/app/view/jarvis/subjectscolumn.tsx:141` — hard `w-[272px]`.
- No `matchMedia` / `ResizeObserver` / `innerWidth` read under `frontend/app/view/jarvis/` outside
  `jarvisgraph.tsx`'s canvas sizing.

**Fix.** Drive the collapse order from one width observer at the surface root, in the design's order. Rule 5
must be encoded as a *width* assertion (the Stage never drops below its minimum), not as "the thread is still
mounted" — the existing check passes on the broken layout, which is how this shipped.

**Verify.** `Emulation.setDeviceMetricsOverride` across 1920/1440/1100/900/720 and re-measure the four
regions; the Stage must stay above its floor at every width.

**Superseded by JC20.** The fix held the floor at all five sampled widths and was still wrong between them —
see below.

### JC20 — Every band owns its own measure, and the collapse staircase inverts on a wider window

**Kind:** layout · **Effort:** M

**Problem.** Two things, one origin: the surface was assembled by merging Channels, Graph and Tasks into one
Jarvis surface, and each region kept the horizontal metrics it had when it was its own screen.

1. **Seven measures.** Measured at a 1500px window, the bands the Stage stacks *directly on top of each
   other* started their content at four different x — header 366 (`px-4`), record band 366 (`px-4`), thread
   382 (`max-w-[900px] px-8`), composer 370 (`px-5`) — plus `CHANNEL_COL`'s 760px centred column for a run
   thread, and for a record subject a 720px centred block over a full-bleed `px-5` activity list, a **414px
   jog** at one divider. Above a 900px Stage the thread detached and floated to the middle while the chrome
   stayed pinned to the edges (a 137px disagreement at 1800px).
2. **A staircase that inverts.** `collapseFor` collapsed the least it could until the Stage cleared its floor.
   The Subjects column's only lever was 272 → 56, a 216px step used to fund a 34px deficit, so the Stage
   overshot on one side of each threshold and sat on the floor on the other. Measured: a **1000px window gave
   the Stage 822px and a 1050px window gave it 656px** — widening the window narrowed the thread and flipped
   the column between labelled rows and anonymous glyphs. The rail's 300↔44 snap did the same at ~1212px.
3. **A rail that never came back.** Step 1 wrote the rail's open atom shut on each transition into narrow.
   The first measurement counts as a transition and the surface unmounts on every nav switch, so the rail was
   a 44px strip at every width — measured still 44 at a 1600px window — until clicked open again.

**Evidence.** CDP measurement of the band edges, the column rules (y=44 / 81 / 96 in two different border
tokens) and a 50px sweep of the Stage's width; `jarvislayout.test.ts`'s old monotonicity test asserted
monotonicity of the collapse *flags*, which held the whole way through the sawtooth.

**Fix.**
- `frontend/app/view/jarvis/stagemeasure.ts` — one shared horizontal metric for every band, and
  `STAGE_HEADER_BAND` (one header height and rule for all three columns). This first landed as a centred
  `max-w-[900px]` column; **JC21 replaced it with a gutter** for the reasons recorded there.
- `collapseFor` → `layoutFor(surfaceWidth, railPx)`, returning a **continuous** `subjectsPx` that gives up
  exactly the deficit. The Stage now pins at exactly its floor across the narrow band instead of overshooting,
  and its width is monotone non-decreasing in the surface's. `subjectsIcons` is a content threshold at 140px,
  crossed without a width step.
- The rail's width is an **input** to the layout, never an output. `railOverlay` still substitutes for the
  44px strip (and now crosses its boundary with no step at all, both sides sitting on the floor), but a rail
  the user opened is never overlaid and never force-closed.

**One accepted cost.** Between a 56px and a 140px column the status-dot strip is drawn in a box wider than
its glyphs need (a 130px column at an ~870px window looks loose). Snapping back to 56 in icon mode would put
an 84px step back into the Stage's width, and showing labels down to 56px gives two ellipsised characters and
a `+ Channel` button narrower than its own text. Recorded in `jarvislayout.ts` beside the constant.

**Verify.** `jarvislayout.test.ts` asserts the Stage's width is monotone at **1px** steps for both rail widths
— the dip was invisible at the five widths the scenario sampled. Live: `jarvis-collapse-order` now sweeps
900→1600 in 50px steps and asserts the Stage never shrinks, the column takes intermediate widths, and
narrowing leaves an opened rail open; the new `jarvis-measure` scenario asserts one left edge across every
band and one header-rule y across all three columns, at 1500 and 1920.

### JC21 — The shared measure missed the band that did not opt in, and centring it left dead gutters

**Kind:** layout · **Effort:** S

**Problem.** JC20's measure was reported as landed on the strength of a probe that collected every element
carrying the measure's own class and checked they shared a left edge. That is circular, and it hid two things.

1. **The band that did not opt in.** `RunCompletion` — the view for *every finished run* — keeps its own
   header band, and only its inner content had been moved onto the measure. The band kept `px-6` full-bleed,
   so at a 950px Stage its content started at **x=24 while every other band started at x=44**: the largest
   text on the Stage, 20px out, and the page title visibly jogged when you switched a record for a run. Two
   smaller members of the same family: `OrchestratorBody` reserved no scrollbar (its measure centred 5px
   right of every scrolling band) and `RunCompletion` used `overflow-y-auto`, so its content left moved by
   5px depending on whether that particular run's evidence overflowed.
2. **Dead gutters.** A 900px column inside a 1250px Stage leaves ~175px empty on each side (~360px at 1920).
   A record's objective wrapped to three lines with 350px unused beside it, while the evidence table, the
   file list and the activity rows were all squeezed to 852px to pay for the symmetry.

**Evidence.** CDP audit of every band by geometry rather than by class, per subject kind: the sealed run
reported content-lefts of `[0, 24, 44]` against `[0, 44]` for the record and conversation views. Screenshots
of the record view at a 1250px Stage for the gutters.

**Fix.** `STAGE_MEASURE` (`mx-auto w-full max-w-[900px] px-6`) → **`STAGE_GUTTER`** (`w-full px-6`). Bands
share a left edge because they carry the same padding, not because each is centred in a box of the same
width — which also removes the whole class of bug where a left edge moves by half a scrollbar. Content then
decides its own width: tables, field cards, file lists and activity rows fill the Stage, and prose caps
itself with **`STAGE_PROSE`** (`max-w-[72ch]`, in `ch` so one token holds for a 19px title and 14px body
alike) on the record objective, the run goal and the completion summary. The thread's turns already carried
their own caps (560px user bubble, 720px answer), so they need nothing new. `RunCompletion`'s header moved
into the gutter with its rule left full-bleed; `OrchestratorBody` took `STAGE_BAND_INSET`.

**Verify.** `jarvis-measure`'s probe now finds bands by geometry — anything as wide as the Stage, keyed on
where its own padding starts — and walks **every subject kind** (fixture conversation, channel, record)
rather than only the fixture conversation, since the regression lived in the run view. It adds a
`no dead gutter` assert: some band's content box must come within 80px of the Stage's width, which the
centred column fails by construction.

### JC22 — The badges and data labels are below readable contrast

**Kind:** legibility · **Effort:** S

**Problem.** Reported as "the badge and other data presentation are too muted, they are hard to scan", and it
measures out. `--color-muted` carries almost every id, status label, count and section heading on the Stage,
usually at 9.5–11px, and against `--color-background` it was **3.92:1** — under the 4.5:1 WCAG AA needs for
text that size — dropping to **3.47:1** on a hovered row. `--color-ink-faint` was **1.90:1**, and it was not
purely decorative: a cancelled run's status label was set in it. Every one of the seven theme presets was in
the same state or worse (One Dark's muted measured **2.60:1** on its background, **1.95:1** on a hovered row).

**Evidence.** WCAG relative-luminance ratios computed for every text token against all four surface levels,
and for each preset against its own palette.

**Fix.** Both tiers lifted so `muted` clears AA on the background *and* on a hovered row, and `ink-faint`
clears the 3:1 non-text minimum for the separators and gutter numerals it draws — in `tailwindsetup.css` and
in all seven `themes.ts` palettes, since `buildThemeVars` overrides both at runtime and the CSS default alone
would not reach the active theme. Midnight: muted `#6b7178 → #7f858b` (3.92 → **5.18**, hover **4.59**),
ink-faint `#3a424c → #646a72` (1.90 → **3.54**). The ramp still steps cleanly rather than flattening:
ink-faint 3.54 < muted 5.18 < ink-mid 7.56 < secondary 13.06. Two badges also stopped inheriting the quietest
tone: the record's status chip set a fill but no text colour, so it rendered `muted` on `surface-hover` — the
one background muted has least contrast against — and `RUN_TONE.cancelled` moved off `ink-faint`.

**A raised floor is not a hierarchy.** Lifting the token fixed readability and did nothing for scanning: the
record view then rendered its section headings, field labels, run ids and statuses in the same two greys — five
roles sharing two tones, reported as "they all have the same color". Contrast is a floor per element; scanning
needs the *differences between* elements. So the record view now assigns tone by role rather than by emphasis:

| Role | Tone | Examples |
|---|---|---|
| Subject | `primary` w700 | the record's objective |
| Identity — what tells one row from the next | `accent-soft` w600 | run ids, the record slug |
| Outcome | tonal | `done` green, `blocked` warning, `failed` error |
| Value — what you actually read | `secondary` | field values, run goals |
| Structure and hints | `muted` | section headings, field labels, `@quick · @run · @ask` |

Measured as a census of distinct colour+weight groups in that view: **2 doing real work → 9, one per role.**

**Verify.** `themes.test.ts` pins the Midnight palette to the `tailwindsetup.css` values and failed on both
tokens the moment they drifted, which is how the presets were caught; it now pins the lifted pair. The per-
element contrast and the colour census were both measured over CDP against the live view, compositing each
element's real background (a probe that reads the token alone proves nothing about what rendered).

**Not done.** 47 `text-ink-faint` call sites were not audited individually. Lifting the token raised them all
to 3.54:1, but any that are genuinely body text (the diff gutter's line numbers, a few 9.5px section labels)
still sit below AA and should move to `muted`. Not swept here — it reaches well past this surface.

**No tone fixed it, and it is now fixed as content (JC23).** A record's run list repeated the same string on
every row: a run's goal *is* the record's objective, so "runs attributed to this record" rendered as N
identical lines whose only distinguishing datum was an 8-character id. The widest column in the row carried
no information.

**Fixed** in `recordrunrow.ts` (pure, `recordrunrow.test.ts`). The headline is now the run's **evidence
summary** — the one field that is written per run, by the run, describing what that run actually did — and
the goal appears only when it genuinely differs from the record's objective, compared after trimming,
collapsing internal whitespace and lowercasing. When neither applies the headline is `null` and the row
renders id, blank, status: absent rather than a repeated title, which is the surface's stated rule. Beneath
it a meta line carries exactly what the issue asked for — when it ran, how long it took, what changed
(`+N/−M across K files`) — with each part **omitted** rather than defaulted when there is no source for it,
because an unsealed run has no duration and a zero would assert one.

Why the evidence summary rather than the phase list or the commit subject: it is the only per-run field that
already exists on the object the list renders, is written at seal time by the worker that did the work, and
does not require a second read. The phase list is structure, not outcome; the commit subject is absent for
any run that did not commit.

### JC19 — The record band's expand control is not keyboard-operable

**Kind:** a11y · **Effort:** S

**Problem.** The band's expand/collapse affordance — the one control in tour §5 — is a `div` carrying
`onClick`, with no `role`, no `tabindex` and no `<button>`. Probing the collapsed band for buttons returns
`[]`: it is reachable by mouse only, on a surface whose thesis is keyboard operability.

**Evidence.** `frontend/app/view/jarvis/recordbandview.tsx:59-63` (the `div` + `onClick`) ·
`docs/handoff/2026-07-28-jarvis-consolidation-design-conformance.md` § "Gap 2" (the live probe).

**Fix.** Make the collapsed row a `<button>` (or add `role="button"` + `tabIndex={0}` + key handling). Watch
the nested-interactive case: the `several` row already contains chips, and the expanded `others` rows are
buttons — the outer control must not swallow them.

**Verify.** Tab to the band, `Enter`/`Space` expands; the expanded per-record rows remain individually
reachable.

### JC17 — `j`/`k` selects as it moves

**Kind:** perf / polish · **Effort:** S · **May be won't-fix**

**Problem.** The list-nav cursor *is* the selection, so every keypress fires `selectChannel` (an RPC),
resolves a record scope, and prunes an unasked thread on the way past. Fine at three subjects; wasteful at
thirty.

**Evidence.** `frontend/app/view/jarvis/subjectscolumn.tsx:100-113` (`setCursor` → `selectSubject`) ·
`frontend/app/view/jarvis/jarvissubjectstore.ts:48-86` (`pruneOnLeave` + `selectChannel` per selection).

**Fix (if wanted).** Separate cursor from selection (cursor moves free, Enter selects) — but that changes a
keyboard contract the rest of the cockpit shares, so it is a deliberate decision, not a tidy-up. Note and
leave unless it is felt in use.

---

## E — The tour itself

### JC18 — Corrections to `docs/jarvis-tour.md`

**Kind:** docs · **Effort:** S · **Do last**, so the text describes the fixed surface.

- **§8** — *"This path calls `createRun` directly and ignores the composer's face entirely"* is true of the
  **Run** row only; Quick and Ask go through `sendChannelMessage` (JC3).
- **§8** — the parenthetical *"it resolves at click"* does not match the code (JC2). Delete it along with the
  code comment it came from.
- **§13 table** — the `Run` row's *"but see below"* becomes plain once JC9 lands.
- **Missing flow.** A task-ordered tour has no teardown: cancelling a run exists and is never shown
  (`runbody.tsx:571-576`, confirm copy at `runactions.ts:104-123`), and rename/archive/delete don't exist at
  all (JC7). *"How do I stop this"* belongs immediately after §3.
- **§1** — *"the last subject is deliberately not persisted"* is asserted without a reason, while the rail's
  open state **is** persisted (`jarvisstore.ts:54`). Either give the reason in a clause or persist the
  subject and drop a step from every session's start.
- **"What this pass surfaced"** — cut the four findings as JC6/JC9/JC11/JC12 close, rather than editing them
  in place; this file is the tracker now.
