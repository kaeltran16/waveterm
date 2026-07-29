# Jarvis — closing the last six items

Design for the six items left open after the 2026-07-29 flow review closed JC1–JC19. Five were deferred or
declined rather than missed; this spec records what changed about that judgement and what to build.

**Sources.** [`docs/jarvis-consolidation-open-issues.md`](../../jarvis-consolidation-open-issues.md) (JC17,
JC8's cancel half, JC16 step 4) and [`docs/jarvis-tab.md`](../../jarvis-tab.md) § Known gaps (12b, 12c,
last-subject). Every file:line below was read, not inferred.

## What the investigation changed

Three items were deferred on cost grounds that turn out to be wrong. This is the reason the set is worth
doing now rather than on evidence:

| Item | Recorded blocker | Actual state |
|---|---|---|
| 12b | "deleting needs a wshrpc command **and** a wstore delete, neither of which exists" | `wstore.DeleteJarvisConversation` exists (`pkg/wstore/wstore_jarvisconversation.go:60`). Only the wshrpc command is missing. |
| 12c | "needs the summary to carry its attachments" | The conversation already persists `AttachedORefs` (`pkg/waveobj/jarvisconvo.go:16`); only `JarvisConversationSummary` omits it. |
| JC8 cancel | "needs an abort path through the converse stream — its own piece of work" | The abort path exists. `sendRpcCommand` wraps `gen.return()` to send `{cancel:true}` on the wire (`frontend/app/store/wshrpcutil-base.ts:101-109`), and the server's `emit` already unwinds on `ctx.Done()` (`pkg/wshrpc/wshserver/wshserver_jarvis.go:209-214`). |

JC16 step 4 and JC17 were declined on *design* grounds, not cost, and both were re-decided deliberately —
see their sections.

## 1. JC17 — `j`/`k` commits on idle, not on every keypress

**Problem.** The list cursor *is* the selection, so every keypress fires `selectChannel` (an RPC), resolves
a record scope, and prunes an unasked thread on the way past (`subjectscolumn.tsx:100-113`,
`jarvissubjectstore.ts:48-86`). Holding `j` through thirty subjects costs thirty round trips and prunes
threads the user merely passed over.

**Decision.** Debounce the commit; do **not** separate cursor from selection.
`frontend/app/store/keybindings/listnav.ts:19` states the contract as *"cursor == selection: moving IS
selecting"* and five surfaces share it — Files, Memory, Radar, Sessions and Jarvis Subjects. Splitting it
for one surface makes the same keys mean different things per surface, which is exactly the objection that
shelved JC17; splitting it for all five changes four surfaces nobody complained about. Debouncing fixes the
measured cost and leaves the contract alone.

**Design.** The column holds a local cursor id that moves synchronously on every `j`/`k`. A 150ms idle timer
commits it through the existing `selectSubject`. The timer flushes immediately on `Enter`, on a mouse click,
and on unmount, so an explicit selection is never delayed — only a cursor in motion is.

The decision is a pure function so it can be tested without timers:

```
commitAfter(prev: {cursorId, committedId}, next: cursorId) -> "flush" | "defer" | "none"
```

**Tuned constant.** 150ms — the only picked number here. Long enough that a held key coalesces, short enough
that a single deliberate `j` feels immediate.

**Verify.** Unit tests over the pure helper (held key → one commit; single move → one commit; Enter →
immediate). Behavioural check: hold `j` across the column and confirm one `selectChannel` in the network log.

## 2. JC8 — cancel an in-flight query

**Problem.** `submitJarvisQuery` streams under `fireAndForget` with no handle, so a running query cannot be
stopped — only waited out to the 130s RPC budget (`jarvisstore.ts:174`, `:202-251`).

**Design.** Keep the generator. A module map in `jarvisstore.ts` keyed `${convId}:${answerIdx}` holds the
live `AsyncGenerator`; the entry is deleted in a `finally`. `cancelJarvisQuery(convId, answerIdx)` calls
`gen.return()`, which sends the wire cancel that already exists, and patches the turn to the new terminal.
A `Cancel` control renders on a turn that is still streaming, beside its working steps.

**New terminal.** `Terminal` (`jarviscontract.ts:22`) gains `"cancelled"`:

| Terminal | Badge | Tone | Retry |
|---|---|---|---|
| `answered` | none | — | no |
| `weak` | Weak grounding | warning | no |
| `notfound` | Not found | muted | no |
| `error` | Couldn't reach Jarvis | error | yes |
| `cancelled` | **Cancelled** | **muted** | **yes** |

Muted, not warning or error: `weak`/`notfound` are statements about the corpus and `error` is a statement
about the request, but a cancel is the user's own decision. Drawing it in amber or red would repeat the
conflation `error` was added to remove. Whatever prose streamed is preserved, and `retryJarvisQuery`
(`jarvisstore.ts:258`) already does the right thing for it unchanged.

**Ordering note.** The `catch` that sets `error` must not overwrite `cancelled` — `gen.return()` can surface
as a throw. The cancel path sets the terminal first and marks the entry cancelled; the `catch` skips
patching when it sees that mark.

**Verify.** Unit tests over `terminalBadge("cancelled")` and the catch-ordering guard. Manual: start a query,
cancel it, confirm the badge, the preserved prose, and that Retry re-runs it.

## 3. JC16 — step 4, plus the step that actually holds the floor

**Problem.** The collapse order stops after two regions. `collapseFor` yields the context rail then the
Subjects column (`jarvislayout.ts:49-64`), which holds the Stage's 640px floor down to a 740px surface and
no further.

**Why step 4 alone is not the fix.** Step 4 (nav rail 78 → 56px) buys 22px. Because the nav rail sits
*outside* the surface, that 22px widens the surface for a given window — it moves the breach from a ~818px
window to a ~796px window without changing the surface-relative floor at all. Worth having, but it does not
close gap 11b.

**Design.** Two independent layers, deliberately not coordinated.

*Layer 1 — the nav rail collapses itself.* `navrail.tsx:81` observes window width and renders `w-[56px]`
(icon only, dropping the `text-[10px]` label at `:76`) below **900px**. It lives in the nav rail because the
nav rail is global chrome shared by every surface; driving it from inside Jarvis was the original and
correct objection. Every surface benefits. No coordination with Jarvis is needed: the surface's existing
`ResizeObserver` (`jarvissurface.tsx:33`) simply measures a wider surface.

*Layer 2 — the context rail becomes an overlay.* `LayoutCollapse` gains `railOverlay: boolean`. When
collapsing both regions still leaves the Stage under its floor, the rail stops occupying inline width and
floats over the Stage's right edge instead. Inline chrome drops from 100px to 56px.

Resulting ladder, in **surface** width:

| Surface | State | Chrome | Stage |
|---|---|---|---|
| ≥ 1212 | nothing collapsed | 572 | ≥ 640 ✓ |
| ≥ 956 | rail → 44px strip | 316 | ≥ 640 ✓ |
| ≥ 740 | + Subjects → 56px dots | 100 | ≥ 640 ✓ |
| ≥ 696 | + rail → overlay | 56 | ≥ 640 ✓ |
| < 696 | nothing left to yield | 56 | breaks |

So the overlay buys 44px of surface floor (740 → 696) and the nav rail buys 22px of window (818 → 796).
Both are additive; neither alone holds it. Below a 696px surface the floor still breaks — that is the
residual, and gap 11b narrows to it rather than closing.

**Tuned constant.** 900px window for the nav rail. Everything else is derived from `STAGE_MIN_PX` and the
mirrored region widths.

**Verify.** `jarvislayout.test.ts`'s width-assertion loop extends to the overlay step, with its lower bound
moved to the real breach point (696 surface, not the conservative 1034 window it uses today).

One test-shape change falls out of layer 1: the suite converts window → surface through
`const surfaceFor = (w) => w - 78` (`jarvislayout.test.ts:8`), which stops being a single number once the
nav rail is 78 *or* 56. `collapseFor` is surface-relative and knows nothing about the nav rail, so the
arithmetic tests should assert on surface widths directly and drop the helper; the window-level relationship
belongs to the CDP scenario, which measures the real thing.

A `jarvis-narrow` CDP scenario measures the Stage across widths spanning every rung and asserts the rail
overlays rather than displaces below the threshold.

## 4. Gap 12b — a thread can be deleted or archived

**Problem.** A genuinely distinct question is a permanent row. Channels got a per-row context menu in the
JC7 fix (`subjectscolumn.tsx:205-241`); threads got nothing.

**Decision.** Delete and Archive only. **No** recency grouping — the column already groups by kind and by
project, and a third axis beside the `Archived · N` group earns its complexity only once the list is
genuinely long. **No** rename — a thread's title derives from its first turn and nothing reported it wrong.

**Design.** Mirror the channel path exactly rather than invent a second shape.

*Backend.* Two commands on `JarvisCommands` (`pkg/wshrpc/wshrpctypes_jarvis.go:12`):

- `DeleteJarvisConversationCommand(ctx, data) error` — wraps the existing `wstore.DeleteJarvisConversation`.
- `ArchiveJarvisConversationCommand(ctx, data) error` — sets an `archived` flag on the conversation's
  `Meta` (`pkg/waveobj/jarvisconvo.go:20` — `MetaMapType` already present, same mechanism the channel uses).

`JarvisConversationSummary` also gains `Archived bool`, populated from that Meta key by the list handler.
Without it the flag is write-only: the Threads list is built from summaries, so the column could set
`archived` and never see it. This lands in the same edit as 12c's `AttachedORefs`, which touches the same
struct and the same handler.

Both commands follow `wshserver_projects.go`'s handler-plus-test shape. `task generate` regenerates the TS
client; no new waveobj type and no new column, so **no migration**.

*Frontend.* Thread rows get the same right-click menu channels have, with the same `ConfirmModal` copy
shape, and archived threads fall into the existing trailing `Archived · N` group (`subjects.ts:140`) rather
than a new one.

**Verify.** Go tests per command. A CDP step: create a thread, delete it, confirm the row leaves; archive
another and confirm it moves to `Archived · N`.

## 5. Gap 12c — dedup survives a restart

**Problem.** `sourceConversationAtom` is session state and `ListJarvisConversationsCommand` returns no
attachments, so asking about the same Run after a restart starts a second thread.

**Design.** `JarvisConversationSummary` (`wshrpctypes_jarvis.go:109`) gains `AttachedORefs []string` —
alongside 12b's `Archived bool`, one edit to the struct and one to the handler for both. The
list handler already holds the whole conversation (`wshserver_jarvis.go:287-301`), so populating it is one
line. On load, `loadJarvisConversations` (`jarvisstore.ts:109-114`) rehydrates `sourceConversationAtom` from
those orefs, and `conversationForSource` then finds the persisted thread.

The existing dead-id guard stays as-is: a mapping that resolves to a conversation nothing holds mints a
fresh one rather than submitting into a void.

**Verify.** Go test that the summary carries the orefs. Unit test that rehydration produces the same map
`conversationForSource` would have built in-session.

## 6. Last-subject persistence

**Problem.** `activeSubjectAtom` (`jarvissubjectstore.ts:31`) is not persisted, so every launch lands on the
empty Stage. Restoring was deferred because a persisted id can name a subject that no longer exists, and the
lists load asynchronously.

**Correction to that objection.** It holds for two of three kinds, and the fix is smaller than recorded.
`channelsAtom` is already `Channel[] | null` (`channelsstore.ts:10`). The thread list's load result is
`persistedSummariesAtom` (`jarvisstore.ts:65`), which is separate from the live `conversationsByIdAtom` map
— so making the *list* nullable does not disturb locally-created conversations. Only `taskListAtom`
(`tasksstore.ts:13`) and `persistedSummariesAtom` need the shape.

**Design.**

- `taskListAtom: SpaceSummary[] | null` and `persistedSummariesAtom: JarvisConversationSummary[] | null`,
  both `null` until their first load — matching `channelsAtom`, so "loaded" is expressed one way across all
  three kinds.
- The active subject's `{kind, id}` persists through `atomWithStorage`, the pattern already used one file
  over for `stageRailOpenAtom` (`jarvisstore.ts:54`).
- On boot the restore waits for **the matching kind's** list to become non-null. If it holds the id, select
  it. If not, clear the stored key and stay on the empty Stage — silent, matching the surface's
  absent-rather-than-empty rule. One attempt only, like `pendingRunFocusAtom`'s `landed` guard.

The decision is pure and unit-testable:

```
restoreDecision(stored, listState) -> {action: "wait"} | {action: "select", subject} | {action: "clear"}
```

**Cost to flag.** Making two atoms nullable surfaces `tsc` errors at every read site. That is the point —
each site has to say what it means by empty — but it makes this the widest-touching item of the six despite
being conceptually the smallest.

**Verify.** Unit tests over `restoreDecision` for all three list states × present/absent id. A CDP step on
`jarvis-subject-state`: select a subject, reload, confirm it returns; delete it, reload, confirm the empty
Stage and a cleared key.

## Scope boundaries

Deliberately **not** in this spec:

- Recency grouping for threads and thread rename (declined above).
- Any change to `listnav.ts` or the four non-Jarvis surfaces that share it.
- Holding the Stage floor below a 696px surface. Nothing is left to collapse without breaking rule 5, and
  gap 11b narrows to that residual rather than closing.

## Documentation

`docs/jarvis-tab.md` § 1 (the collapse ladder), § 2 (thread lifecycle), § 5 (the `cancelled` terminal), § 13
(unchanged keys, changed commit timing) and § 14 (persistence) all describe behaviour this changes, and gap
11b, 12b and 12c and the last-subject row all move. `docs/jarvis-consolidation-open-issues.md` closes JC17,
JC8's cancel half and JC16 step 4. Both are part of the implementation, not a follow-up.
