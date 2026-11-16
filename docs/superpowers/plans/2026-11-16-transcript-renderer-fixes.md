# Transcript renderer fixes

**Goal:** Fix the twelve pending chunks of the transcript-renderer initiative: earlier turns in Rendered, pasted and
attached images in bubbles, thumbnails with zoom, one fold per finished turn, merged thoughts, readable command titles,
closed past wakes, the Skill fold phrase, queued messages and notices, and wsh cards with `$VAR` ids.

**Architecture:** A one-file types task opens the fold chain, so the projection, wsh var expansion and image thumbnails
run beside it. The feed changes then chain through `narrationtimeline.tsx` and `transcriptlayout.ts`, which three tasks
must edit in turn; the fold task owns every scenario that asserted cards outside the fold, so Show earlier (which shares
agent-rendered) waits for it and runs beside the rest of the chain. Every decision is in the spec.

**Effort:** effort:2bd27b27-0403-43cd-a540-ff66edce3b3c
**Spec:** `docs/superpowers/specs/2026-11-16-transcript-renderer-fixes-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/remotemode/...`
**Check:** `task check:ts`
**Final:** `node scripts/cdp/final-verify.mjs transcript-base transcript-arc transcript-initiative transcript-media transcript-agents transcript-dag transcript-dagactions transcript-notes transcript-boards transcript-runs narration-feed sessions-find agent-rendered`

### Task 1: AgentEntry fields for pasted images, queued messages and notices
**Depends on:** none
**Files:** `frontend/app/view/agents/agentsviewmodel.ts`

**What to build:** the type half of spec section 1, so the projection and the feed can proceed beside each other. No
behaviour change.

**Interfaces:** on `AgentEntry`: `user` gains `images?: ToolImage[]` and `queued?: true`; `notification` gains
`notice?: true`. All optional, so every other projector and consumer compiles unchanged.

**Acceptance:**
- `task check:ts` passes with the three fields present and documented in the type's comments

### Task 2: Claude projection: pasted images, queued messages and notices
**Depends on:** Task 1 (the AgentEntry fields it fills)
**Files:** `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `pkg/remotemode/web/static/projectors.js`, `pkg/remotemode/web/projectors.test.js`

**What to build:** the projection half of spec section 1. Regenerate `projectors.js` with
`node scripts/sync-remote-web.mjs` (never hand-edit it); keep every other asset that script writes unchanged.

**Acceptance:**
- a user record `[text "look [Image #1]", image(base64 png)]` projects one user entry with that text and one image; a
  record of an image block only projects a user entry with empty text and the image; an image block with a
  non-`image/*` media type is dropped
- an attachment record `{type:"queued_command", commandMode:"prompt", prompt:"land them"}` projects
  `{kind:"user", text:"land them", queued:true, ts}` at its place among the entries, ts from the attachment's timestamp
- a `task-notification` prompt with `<task-id>`, `<summary>`, `<status>` projects a `notification` with that summary
  and status and `notice:true`; a free-text one projects a notice whose summary is the text inside the tag; another
  `commandMode` projects nothing
- `projectors.js` is the script's output for the new sources (rerunning the script leaves it unchanged)

### Task 3: wsh calls resolve `$VAR` ids, and unresolved ids never fetch
**Depends on:** none
**Chunk:** wsh cards: a shell variable as the id shows a load error
**Files:** `frontend/app/view/agents/wshcall.ts`, `frontend/app/view/agents/wshcall.test.ts`, `scripts/cdp/scenarios-transcript-initiative.mjs`

**What to build:** spec section 10, all inside `wshcall.ts`. Update the `wshcall.test.ts:90` pin of `['$E', ...]` to
the new rule.

**Acceptance:**
- `E=2bd27b27 && wsh effort chunk add $E "x"` parses args `["2bd27b27", "x"]`; `${E}` and `export E=...` likewise
- `wsh effort chunk add $E "x"` with no assignment, and an id holding a backtick or `$(`, resolve to key
  `"other-change"`; a view-key call (`wsh effort show $E`) with an unresolved id yields no wsh key
- transcript-initiative gains a step: a resolved `$E` call draws the initiative card for that id, and an unresolved
  one draws the generic change row with no "Couldn't load" text

### Task 4: Image thumbnails that open the zoom view
**Depends on:** none
**Chunk:** Images draw as thumbnails in step cards
**Files:** `frontend/app/view/agents/imagethumbs.tsx`, `frontend/app/view/agents/toolrenderers.tsx`, `frontend/app/view/agents/composerattachments.ts`, `frontend/app/view/agents/composerattachments.test.ts`, `scripts/cdp/scenarios-transcript-media.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:** spec section 7's `ImageThumbs` and its use in step cards, and section 8's parsing half
(`splitAttachments` and the shared header constant). Reuse `ImageZoom`; no new viewer, no new tokens. Register the new
`transcript-media` scenario (harness: `transcript-fixture.mjs`, `renderers: true`).

**Interfaces:**
- `ImageThumbs({ images, compact, onError }: { images: ZoomImage[]; compact?: boolean; onError?: (index: number) => void })`
  from `imagethumbs.tsx`, owning its zoom state; each thumbnail is a button with `data-image-thumb`; `onError` fires
  with the index of an image that failed to load
- `splitAttachments(text: string): { text: string; paths: string[] }` and `ATTACHMENTS_HEADER` from
  `composerattachments.ts`; `appendAttachments` uses the constant

**Acceptance:**
- `splitAttachments(appendAttachments(t, atts))` returns `t` and the ready paths, for blank and non-blank `t`; text
  without the block returns unchanged with no paths; a header not at the end (followed by prose) is left in the text
- transcript-media: an image Read's card draws thumbnails no taller than the thumbnail bound (not ~500px); clicking one
  opens the zoom view (the `ImageZoom` dialog is present), Escape closes it

### Task 5: One fold per finished turn
**Depends on:** Task 1 (the `queued` user flag decides turn starts), Task 3
**Chunk:** One fold per finished turn
**Chunk:** Fold phrase calls a Skill 'other tool'
**Files:** `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/permissionmodel.ts`, `frontend/app/view/agents/permissionmodel.test.ts`, `frontend/app/view/agents/sessionsdetail.tsx`, `frontend/app/view/agents/agentsviewmodel.ts`, `scripts/cdp/scenarios-transcript-base.mjs`, `scripts/cdp/scenarios-transcript-initiative.mjs`, `scripts/cdp/scenarios-transcript-agents.mjs`, `scripts/cdp/scenarios-transcript-dag.mjs`, `scripts/cdp/scenarios-transcript-dagactions.mjs`, `scripts/cdp/scenarios-transcript-notes.mjs`, `scripts/cdp/scenarios-transcript-boards.mjs`, `scripts/cdp/scenarios-transcript-runs.mjs`, `scripts/cdp/narrationfeed.mjs`, `scripts/cdp/scenarios-agent-rendered.mjs`, `scripts/cdp/scenarios-sessions-find.mjs`

**What to build:** spec section 2, as a new layout item for a folded turn holding its items in order, drawn with the
existing `FoldLine` and `PaneReveal` (moment 6b), plus the `unfold` prop and the Skill phrase. Remove
`CollapseRunThreshold` and the `threshold` option if nothing uses them after (grep first). Every scenario on the Files
line that asserted a wsh card outside the fold (initiative:286, agents:258, dag:399, dagactions:163, notes:266/355,
boards:652, runs:300/345) or counted folds (narrationfeed, agent-rendered) is updated to the new layout: open the
turn's fold and assert the card inside it, never drop the check.

**Acceptance:**
- a finished turn `user, message, step, thought, step, message, card, step, message` lays out as user, one fold, final
  message; opening the fold shows the interim items in order
- a queued user entry, an interrupt, a compaction or a permission mark inside a finished turn stays outside and splits
  it into one fold per side; a turn of prose only has no fold; a single-step turn folds
- the live turn while `active` lays out as today; a turn with a tool output card (image, test, git diff) starts open
  when `renderers` is set, and a turn holding only wsh cards starts closed; `unfold` draws every turn open
- fold N runs from the prompt to the final reply; a turn with one Skill call reads "used a skill", two "used 2 skills"
- transcript-base's fold steps show one "Worked for" line per finished turn and a queued bubble splitting a turn;
  sessions-find gains a step whose term matches interim prose of a finished turn, and the hit is visible with that
  turn's fold open; every scenario named above passes

### Task 6: Rendered view: Show earlier
**Depends on:** Task 5 (shares the agent-rendered scenario)
**Chunk:** Rendered view: no way to reach earlier turns
**Files:** `frontend/app/view/agents/livetranscript.ts`, `frontend/app/view/agents/livetranscript.test.ts`, `frontend/app/view/agents/livetranscriptatoms.ts`, `frontend/app/view/agents/livetranscriptatoms.test.ts`, `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/sticktobottom.tsx`, `scripts/cdp/scenarios-agent-rendered.mjs`, `scripts/cdp/agent-page-fixtures.mjs`

**What to build:** spec section 9. Extract the merge of a full read into the streamed records (dedupe by `uuid`,
uncapped retention after it) as a pure function so it is unit-tested; the RPC and atoms stay thin. The control matches
Sessions detail's Show earlier in wording and style. The prepended rows get no entrance fade by remounting the
NarrationTimeline with a new `key` from `renderedview.tsx` when the full read lands; never edit `narrationtimeline.tsx`
(the fold chain owns it).

**Acceptance:**
- a first chunk of 300 lines (non-Pi) marks the agent as having earlier turns; fewer lines, or a Pi session, does not
- merging a full read with records streamed during the read yields each `uuid` once, in file order, and later chunks
  append
- after Show earlier the feed renders past `TIMELINE_RENDER_CAP` and the control is gone
- agent-rendered gains a step with a fixture transcript longer than 300 lines: the feed first opens without the first
  prompt, shows "Show earlier", and after it the first prompt is in the DOM while the item at the top of the viewport
  before the click is still within a few px of where it was

### Task 7: Merged thoughts, command titles, past wakes and notice rows
**Depends on:** Task 5, Task 3
**Chunk:** Merge consecutive thoughts into one clamped block
**Chunk:** Command-only steps read as raw shell
**Chunk:** Past Arc wake cards draw every section open
**Chunk:** Messages sent mid-turn (queued steering) are not drawn
**Files:** `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/arcmessagerow.tsx`, `frontend/app/view/agents/commandtitle.ts`, `frontend/app/view/agents/commandtitle.test.ts`, `frontend/app/view/agents/wshcall.ts`, `scripts/cdp/scenarios-transcript-base.mjs`, `scripts/cdp/scenarios-transcript-arc.mjs`

**What to build:** spec sections 3, 4, 5 and 6. The thought clamp and the bubble clamp become one measured
clamped-text component, kept in `narrationtimeline.tsx`. Command splitting reuses `wshcall.ts`'s tokenizer (export it)
rather than a second shell parser. The notice row reuses existing tokens and the disclosure moment for its expand.

**Acceptance:**
- two thoughts with nothing between them lay out as one thought holding both texts, inside a step box and standalone;
  a step between them keeps two
- `commandTitle`: `python - <<'EOF' ...` → "Ran a Python script"; `cat > out/plan.md <<EOF ...` → "Wrote plan.md";
  `F=a && O=b && git status --short` → "Ran git status"; a short one-liner (`ls -la`) → undefined
- only the latest wake's sections are open; an earlier wake's heads show and their bodies do not
- a `notice` notification draws the muted row, not the "Subagent finished" box; a queued user entry draws as a user
  bubble
- transcript-base gains steps for a merged clamped thought (Show more expands it), a heredoc step titled "Ran a Python
  script" with its command in mono, and a multi-line notice row that a click expands to its full text; transcript-arc
  gains a step with two wakes, the earlier closed and the latest open

### Task 8: Images and attachments in user bubbles
**Depends on:** Task 7, Task 4 (`ImageThumbs` and `splitAttachments`), Task 1 (user `images`)
**Chunk:** User bubble drops pasted images
**Chunk:** User bubble shows Arc's raw attachment list
**Chunk:** Images open in a zoom view
**Files:** `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `scripts/cdp/scenarios-transcript-media.mjs`

**What to build:** spec sections 7 (bubble half) and 8 (drawing half). The layout's user item carries the entry's
images. File chips and thumbnails use existing tokens; image paths load through `localFileUrl`
(`frontend/app/view/jarvis/localimage.ts`) and fall back to a file chip through `ImageThumbs`'s `onError`.

**Acceptance:**
- a user entry with images and text "see [Image #1]" draws "see" and one thumbnail; without images the placeholder
  text stays
- a bubble whose text ends in the attachments block draws the text without the block, a thumbnail per image path and a
  file chip (basename, full path as title) per other path
- transcript-media gains steps: a pasted-image bubble whose thumbnail opens the zoom view; an attachment bubble whose
  block lists a small PNG the scenario writes (from a base64 constant) into a temp dir it removes at teardown, a `.txt`
  file, and a `.png` path that does not exist, drawn with no "Attachments (read these files):" text, one loaded image
  thumbnail and two file chips (the missing PNG fell back)
