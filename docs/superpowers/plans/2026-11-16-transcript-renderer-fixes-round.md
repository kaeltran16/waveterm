# Transcript renderer fixes: round 1

**Goal:** Fix three defects the run's landed tasks left behind:
- After a full read, the merged-thought and bubble clamp is dropped.
- A websocket reconnect throws Show earlier away.
- A blob URL in the bubble attachments can leak.

**Architecture:** Two tasks with disjoint files, run side by side. The first owns `narrationtimeline.tsx`, the spec
line and the transcript-base step. The second owns `livetranscript.ts` and its test.

**Effort:** effort:2bd27b27-0403-43cd-a540-ff66edce3b3c
**Spec:** `docs/superpowers/specs/2026-11-16-transcript-renderer-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/remotemode/...`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs transcript-base transcript-arc transcript-initiative transcript-media transcript-agents transcript-dag transcript-dagactions transcript-notes transcript-boards transcript-runs narration-feed sessions-find agent-rendered`

### Task 1: The clamp follows find, not renderAll; no leaked blob URL
**Depends on:** none
**Files:** `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/narrationfeedfixture.tsx`, `scripts/cdp/scenarios-transcript-base.mjs`, `docs/superpowers/specs/2026-11-16-transcript-renderer-fixes-design.md`

**What to build:**
- **The clamp.** Today NarrationTimeline passes `clamp={!renderAll}` to the user bubble, the standalone thought and the
  thought inside a step box. So Sessions detail, once the whole session is loaded, and the Rendered view after Show
  earlier both draw every bubble and merged thought unclamped. The user decided that merged thoughts are clamped.
  - The clamp exists to hide text, and only a find must never sit in hidden text. So the clamp turns off under
    `unfold`, the prop Sessions detail sets while a find is active, and no longer under `renderAll`.
  - `renderAll` keeps only its other meaning: it lifts `TIMELINE_RENDER_CAP`.
  - Update the comments that state the old rule: on ClampedText, and on the `renderAll` and `unfold` props.
  - In the spec, section 2's "Find" bullet says "`renderAll` keeps its meaning (lift the item cap, no bubble clamp)".
    Change it so `renderAll` lifts the item cap and `unfold` also drops the bubble and thought clamp.
- **The blob URL leak.** In `useLocalImages`, a fetch can resolve before the effect's cleanup and its `resp.blob()`
  after it. The blob URL is then created after cleanup has already revoked the list, so it is never revoked. Create a
  URL only while the effect is still live, or revoke one made after cancel at once.

**Acceptance:**
- With `renderAll` set and no `unfold`, a merged thought and a user bubble longer than their clamp are still clamped,
  each with a working Show more.
- With `unfold` set, neither is clamped and neither has a Show more.
- A transcript-base step draws the long-thought fixture with `renderAll` and shows `[data-clamp-more]` on the thought.
  It draws the same fixture with `unfold` and shows no `[data-clamp-more]`. The fixture seam
  (`narrationfeedfixture.tsx`) gains whatever options this needs, as dev-only fixture options.
- No blob URL made by `useLocalImages` outlives its effect: one whose blob resolves after cleanup is revoked. Shown by
  reading the code path; a unit test is not required for this hook.

### Task 2: A reconnect keeps Show earlier
**Depends on:** none
**Files:** `frontend/app/view/agents/livetranscript.ts`, `frontend/app/view/agents/livetranscript.test.ts`

**What to build:** `restartActiveStreams` stops every stream and restarts it, and the restarted stream re-tails
`STREAM_TAIL_LINES`. For a stream on which Show earlier has already read the whole file, this has two effects:
- the first chunk sets the agent's earlier state back to `hidden`;
- the retained records shrink back to the capped tail, so the earlier rows vanish and the control comes back.

A stream that was whole before the restart must stay whole after it:
- the restarted stream reads the whole file (`maxlines -1`, as Pi does);
- it starts with `whole` set, so retention stays uncapped;
- the agent's earlier state stays `shown`.

A stream that was not whole restarts as it does today. A Show earlier read still in flight when the restart lands keeps
today's rule: a read that lands after its stream was replaced is dropped. Its state must then not stay stuck at
`loading`. It goes back to whatever the restarted stream's first chunk decides.

**Acceptance:**
- A stream with whole set, restarted by `restartActiveStreams`, opens its new stream with maxlines -1. After the new
  first chunk, the earlier state is still `shown` and retention is not capped.
- A tail stream that is not whole, restarted the same way, still opens with `STREAM_TAIL_LINES`. A full first chunk
  still marks it `hidden`.
- A restart while a Show earlier read is in flight leaves no stuck `loading` state. The first chunk of the restarted
  stream sets the state.
