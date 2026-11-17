# Fix round 1: Brainstorm and canvas inline in the Rendered transcript

The run's plan is `docs/superpowers/plans/2026-11-17-rendered-brainstorm-canvas.md`; its Verify, Check, Final and
Prototype hold.

Final failed one step of 197, `rendered-bs-mockup` "a board file rewritten reloads the shown board and puts the
unseen dot on the other tab": `noDot` was false, so States carried the unseen dot right after it had been shown.

Cause (lead's reading of the code): `pollAndMerge` (`canvaspoller.ts`) snapshots the canvas state, awaits
`pollCanvasOnce`, then spreads the patch over the current state. The patch's `boardViewedMs` is built from the
snapshot, so a `showInlineBoard` that lands while the poll is in flight (a tab click) is overwritten by the older
map, and the board shown reads as unseen. `lastViewedMs` has the same shape. Final's load makes polls slower and
the window wider, which is why the step passed in its own tree.

### Task 1: Viewed times survive a poll that was in flight
**Depends on:** none
**Files:** `frontend/app/view/agents/canvaspoller.ts`, `frontend/app/view/agents/canvaspoller.test.ts`

**What to build:** a poll's result never moves a board's viewed time, or the canvas's `lastViewedMs`, backwards:
when the poll's patch is merged, each board's `boardViewedMs` is the later of the current state's and the patch's,
and `lastViewedMs` likewise. Every other field merges as today. Fix it where the patch meets the current state
(`pollAndMerge`), not in the scenario.

**Acceptance:**
- A board shown through `showInlineBoard` while a `pollAndMerge` is awaiting its reads keeps that viewed time
  after the poll lands, and `boardUnseen` is false for it when its file is older than the show.
- A `setCanvasMode(…, "canvas", now)` during an in-flight poll keeps its `lastViewedMs` after the poll lands.
- A poll with no concurrent show still records the boards on screen as viewed at the poll's time (existing
  behaviour).
- The `rendered-bs-mockup` step "a board file rewritten reloads the shown board and puts the unseen dot on the other
  tab" passes.
