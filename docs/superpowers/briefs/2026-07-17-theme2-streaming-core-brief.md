# Design brief — Theme 2: Live-transcript streaming core

**Date:** 2026-07-17
**Status:** Design approved (brief) — ready for a downstream agent to write spec + plan and execute
**Source:** Net-new improvement scan, `docs/deferred.md` §"Net-new improvement scan (2026-07-17)" Theme 2
**Handoff:** Resolved design-decision record, not the formal spec. A downstream agent expands it into
`docs/superpowers/specs/` + `docs/superpowers/plans/` and implements it.

## Problem

The cockpit streams live agent transcripts over the wshrpc websocket. Two defects sit in that core:
a **reconnect freeze** (streams never resume after a socket drop) and a **render/growth cost** that
scales badly with fleet size and session length. This slice fixes both.

## S1 — Streams never restart after a websocket reconnect (confirmed correctness bug)

**Root cause.** Each card opens `StreamAgentTranscriptCommand` with a ~1-year timeout
(`livetranscript.ts:22,40`). On a socket drop the client generator neither errors nor rejects (or the
`catch` at `:67-71` swallows it and "keeps last entries"), and reconnect only runs
`reannounceRoutes`/`wpsReconnectHandler` — nothing restarts streaming RPCs. `startTranscriptStream` is
guarded by `streams.has(id)` (`:35`) and `useCardStreams.streamedRef` still holds the id
(`usecardstreams.ts:38,49`), so no restart ever fires. All live narration, the task chip, and
activity-driven git refresh silently freeze until the surface is unmounted/remounted.

**Server-side leak.** Normal unmount cancels the server ctx via `gen.return()` (`livetranscript.ts:45`),
which tears down the fsnotify watcher. A **socket drop** cannot deliver that cancel, and the server request
ctx is `WithTimeout(1 year)` with no per-connection cancellation found (`transcript.go:139-203`;
`wshserver.go:2124-2136`; `wshutil/wshrpc.go:334-338`) — so the `streamTranscript` goroutine + OS watcher
handle leak (one per active card per reconnect; worst under dev HMR churn).

**Resolved design (chosen: client + server).**

1. **Client restart on reconnect.** Store `path`/`agent` on the `StreamHandle` (small struct addition,
   `livetranscript.ts:29-32`) so a stream is restartable. Add a livetranscript reconnect handler to the
   `reconnectHandlers` set (same mechanism as `reannounceRoutes`, registered in `wshrpcutil.ts:26-29`,
   fired from `ws.ts:148-150`). On reconnect: for each active stream id, stop the hung generator, reset
   that id's accumulated `lines`, and re-open the stream (re-tails `STREAM_TAIL_LINES`=300 — a small,
   acceptable visible catch-up for v1). Restart is module-level (livetranscript owns the `streams` map),
   so `useCardStreams` stays unaware.
2. **Server-side cancel on connection close.** The downstream agent **verifies** whether `pkg/web`'s
   websocket connection lifecycle exposes a per-connection cancel/close hook. If yes: cancel the in-flight
   streaming RPC ctxs bound to a connection when that connection closes (proper fix — kills the goroutine +
   watcher immediately). If the lifecycle does **not** expose such a hook, do **not** expand scope to build
   one here — fall back to client-only restart and file the server leak as a bounded follow-up (bounded by
   the existing 1-year timeout). Record which path was taken.

**Acceptance.** After a simulated socket drop + reconnect, live narration/task-chip/git-refresh resume
without a remount; the server goroutine + watcher count returns to baseline after reconnect (no
per-reconnect accumulation) when the server-cancel path is implemented.

## S2 — Render/growth cost (full refactor)

**Decision note.** The S2 items are **code-inferred, not measured**. The user explicitly chose to do the
full refactor now rather than gate it behind a profiling pass. This overrides the default
measure-before-optimizing stance; it is a deliberate decision, recorded here. Profiling is retained as
**validation** (below), not as a go/no-go gate.

**Root causes (evidence).**
- Whole-map atoms rewritten per chunk (`livetranscript.ts:60-61`); every consumer subscribes to the whole
  map, not a per-id slice (`agentrow.tsx:253-254`; `cockpitsurface.tsx:166-167`; `agentdetailsrail.tsx:55`;
  `runworkercard.tsx:30-32`; `usecardstreams.ts:41`; `subagenttracking.ts:17`). `AgentRow` is not memoized
  (`agentrow.tsx:159`); no `selectAtom` anywhere. → any chunk re-renders the whole surface + every card.
- Ever-growing `lines[]` never trimmed (`livetranscript.ts:48,58`); full `project(lines)` + `extractTasks`
  over the entire history on each chunk (`transcriptprojection.ts:106-278`) → O(total lines) per chunk,
  O(N²) per session.
- `NarrationTimeline` unvirtualized, receives the full uncapped `entries` (`agentrow.tsx:513`);
  `groupTimeline` runs in render with no `useMemo` (`narrationtimeline.tsx:449`); `MarkdownMessage`
  re-parses ReactMarkdown+remarkGfm per render, unmemoized (`markdownmessage.tsx:48-77`).
- Three independent 1s `nowAtom` tickers (`cockpitsurface.tsx:99`; `agentdetailsrail.tsx:82`;
  `usagesurface.tsx:477`), and `CockpitSurface` itself subscribes to `nowAtom` (`:90`) → a full-surface
  reconcile every second even when idle.
- `liveEntriesByIdAtom`/`lastActivityByIdAtom`/`tasksByIdAtom` never cleared on stream stop
  (`livetranscript.ts:75-82`) → unbounded retention across a session.

**Resolved design (full refactor).**
1. **Per-id subscription.** Replace the whole-map atoms with per-id atoms (`atomFamily` keyed by agent id)
   or per-id `selectAtom` selectors, so a chunk from agent X re-renders only X's card. Migrate all
   consumers listed above to subscribe to their own id.
2. **Memoization.** `React.memo` on `AgentRow`; memoize `MarkdownMessage` on `text`; wrap `groupTimeline`
   in `useMemo`.
3. **Timeline windowing.** Virtualize or cap the rendered `NarrationTimeline` (the card is height-bounded
   with stick-to-bottom scroll, so off-screen history can be windowed).
4. **Bounded projection + retention (folds in the streaming-core hygiene).** Cap the retained `lines`
   window or project incrementally (stateful projector keeping `actionById` + entries across chunks) so
   per-chunk cost stops being O(total history); on stream stop/unmount, delete the id from
   `liveEntriesByIdAtom`/`lastActivityByIdAtom`/`tasksByIdAtom`.
5. **Ticker consolidation.** One owner for the 1s `nowAtom` tick; push `now` consumption down to the leaf
   age-label components so the surface doesn't reconcile every second.

**Validation (not a gate).** Do a before/after CDP + React-DevTools profiler pass on a populated
multi-agent cockpit (`scripts/inject-live-agents.mjs`) to confirm the refactor actually reduced per-chunk
re-renders and that idle reconcile drops. Report the numbers; if any sub-change shows no benefit and adds
complexity, flag it rather than keeping it blindly.

## Non-goals

- No change to the wshrpc protocol shape or the transcript projection *output* (only how/when it runs).
- No stream resume-by-offset protocol (client re-tail on reconnect is the chosen v1).

## Testing

- **Pure/unit:** `diffStreamSet` already tested; add tests for the reconnect-restart selection (which ids
  restart), the bounded-`lines`/incremental projection (projection output equivalent to the current
  full-reproject for a given input, but bounded cost), and drop-on-stop clearing the per-id atoms.
- **Behavioral:** simulated ws drop → reconnect resumes narration (drive via CDP against the dev app);
  render-count check on a card when an *unrelated* agent chunks (should not re-render) if a harness allows.
- **Server:** if the server-cancel path is taken, a goroutine/watcher-count assertion around a
  connect→stream→drop→reconnect cycle.

## Files in play

FE: `livetranscript.ts`, `usecardstreams.ts`, `transcriptprojection.ts`, `narrationtimeline.tsx`,
`markdownmessage.tsx`, `agentrow.tsx`, `cockpitsurface.tsx`, `agentdetailsrail.tsx`, `runworkercard.tsx`,
`subagenttracking.ts`, `usagesurface.tsx` (ticker), `store/ws.ts`, `store/wshrpcutil.ts`.
Backend (S1 server-cancel): `pkg/web` (connection lifecycle), `pkg/wshutil/wshrpc.go`,
`pkg/wshrpc/wshserver/transcript.go`.
