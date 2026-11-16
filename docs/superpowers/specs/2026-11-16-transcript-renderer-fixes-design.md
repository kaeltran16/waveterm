# Transcript renderer fixes (initiative 2bd27b27)

The twelve pending chunks of initiative `effort:2bd27b27-0403-43cd-a540-ff66edce3b3c` ("Transcript renderer: replay real
sessions, find what to improve"). Evidence per chunk (session ids, file:line, screenshots under
`C:/Users/kael02/scratch/replay/shots`) is in `wsh effort show 2bd27b27-0403-43cd-a540-ff66edce3b3c`. Four of the
decisions below were the user's (marked **user**); the rest were made for this autonomous run, each with its reason.

Scope: the Claude projection (`transcriptprojection.ts`), the layout model (`transcriptlayout.ts`), the feed
(`narrationtimeline.tsx`) and its hosts (Rendered view, Sessions detail, cockpit cards, which all share the feed).
Pi, Codex and opencode projections are untouched. UI follows `DESIGN.md` and `docs/reference/motion-system.md`: existing
`@theme` tokens only, existing motion moments only.

## 1. Data: what the Claude projection adds

`AgentEntry` (`agentsviewmodel.ts`) gains optional fields only, so every other projector and consumer is unaffected:

- `user` gets `images?: ToolImage[]` (the pasted images of that user record) and `queued?: true` (typed while the agent
  worked).
- `notification` gets `notice?: true` (a background-task notice rather than a finished subagent).

Projection rules:

- **Pasted images.** A user record's `image` blocks (base64 source, `image/*` media type; reuse `toolResultImages`'s
  validation from `tooldetail.ts`) attach to that record's user entry. A record with images and no text yields a user
  entry with empty text and the images. Why: the image is in the transcript (816234f8's first record is
  `[text '...[Image #1]', image]`); only the projection drops it.
- **Queued messages** (**user**: draw both kinds). A `type:"attachment"` record whose `attachment.type` is
  `"queued_command"`:
  - `commandMode:"prompt"` → a `user` entry, `queued: true`, text = `attachment.prompt` (unwrapped like a typed prompt),
    ts = the attachment's timestamp (else the record's). Claude Code writes no `type:"user"` record for these (checked on
    6c8e6517 lines 713-742: only `queue-operation` and `api-request-blob` records besides), so there is no double draw.
  - `commandMode:"task-notification"` → a `notification` entry with `notice: true`. A structured prompt
    (`<task-id>`, `<summary>`, `<status>`) reuses `parseTaskNotification`; a free-text one (493 of 532 in the last 400
    transcripts, e.g. "arc-skim: its prompt.compose hook was skipped") takes the text inside `<task-notification>` as its
    summary. No such prompt also appears as a user record (0 of 532), so no double draw.
  - any other `commandMode` is skipped.
- `pkg/remotemode/web/static/projectors.js` is generated from these sources (`task sync:remoteweb`, i.e.
  `node scripts/sync-remote-web.mjs`); it is regenerated, never hand-edited.

## 2. One fold per finished turn (**user**)

A turn starts at a `user` entry that is not `queued`, or at a `command` entry (Arc's own messages are user entries, so a
wake or brief starts a turn and is never folded). A finished turn (not the live one while `active`) draws as: its
prompt, one "Worked for N · phrase" line, then its final reply. The fold holds everything the agent did in between:
interim prose messages, thoughts, step stretches, successful wsh change cards and subagent/background notifications.
The final reply is the turn's last `message`; a turn with no message after its last step folds everything.

Decisions beyond the user's:

- **What stays outside the fold and splits it:** human-originated rows and turn-boundary events — a queued user bubble,
  an interrupt divider, a compaction divider, a permission mark. A turn they interrupt gets one fold per side. Why: a
  message the human typed, or the point where context was lost or the human stopped the agent, must not hide behind
  "Worked for"; the agent's own work all folds, as in Claude Code.
- **wsh change cards fold with the work.** Today they stand outside the fold. Why: the user asked that only the final
  reply stay visible; the cards are still one click away and their effects show on their own surfaces.
- **A turn folds only when it holds at least one step or card.** A turn of prose only (or thoughts and prose) draws as
  today. `CollapseRunThreshold` no longer gates history: a single-step turn folds too (the complaint was single-step
  stretches drawn as open boxes between folds).
- **N** runs from the prompt to the final reply (else to the last step's end): `foldDuration` over the turn's edges.
- **The phrase** counts the turn's steps as today; cards count with their verb.
- **A turn holding a tool output card starts open in the Rendered view** (`renderers`), as a stretch does today (**user**
  decision on chunk 9: card-bearing stretches stay open, images become thumbnails). A tool output card is one
  `toolRendererKey` names (image, test, git diff); a wsh change card is not one, so a turn holding only wsh cards starts
  closed. Its open body is the turn's items in order, each stretch an open step box.
- **The live turn** keeps today's drawing (open stretches, no fold); when it finishes it folds under the new line
  (existing FoldLine + `PaneReveal`, moment 6b).
- **Find.** NarrationTimeline gets `unfold?: boolean`: every turn draws open, so a find hit is never inside a closed
  fold. Sessions detail passes it while a find is active. `renderAll` only lifts the item cap; `unfold` also drops the
  bubble and thought clamp, since a find is the one thing that must never land in hidden text.
- `permissionmodel.placeMarks` places a mark whose entry falls inside a folded turn after that turn's row.
- **Skill in the phrase:** a Skill call reads "used a skill" / "used N skills", like the other counted families
  (chunk 15).

## 3. Thoughts (**user**: merge consecutive thoughts)

Thoughts with no step, message or other row between them merge into one thought (texts joined by a blank line), both
inside a step box and standing alone. The merged block draws muted, clamped to 3 lines, with a measured "Show more" /
"Show less" toggle (the `UserBubbleText` clamp, extracted into one shared clamped-text component for both, kept in `narrationtimeline.tsx`). Why measured:
the toggle shows only when text is really hidden.

## 4. Command-only steps (chunk 11)

A Bash call with no description gets a short derived title; the command stays beside it in mono. A pure
`commandTitle(command): string | undefined` (new `commandtitle.ts`):

- leading `NAME=value` assignments and a leading `cd <dir> &&` are skipped; the first simple command decides;
- a heredoc or `-c`/`-` script fed to an interpreter → "Ran a Python script" / "Ran a Node script" / "Ran a shell
  script" (python/python3/py, node, bash/sh/zsh/pwsh/powershell);
- `cat > f <<EOF`, `cat <<EOF > f`, `tee f <<EOF` → "Wrote <basename of f>";
- otherwise "Ran <program>" plus the first non-flag word for tools whose meaning is their subcommand (git, npm, npx,
  go, cargo, task, wsh, docker, gh, kubectl, pnpm, yarn), and a script basename for `node x.mjs` / `python x.py`.

The title applies only when the command is hard to read in one line: multi-line, starting with an assignment, or longer
than one named length constant. A short one-liner keeps today's bare mono row (a title would repeat it). `stepTitle`
uses it, so the tool detail modal's title follows. The shell-word splitting may reuse `wshcall.ts`'s tokenizer
(exported), never a second shell parser.

## 5. Past wake cards (chunk 14)

Only the latest wake in the feed draws its sections open; earlier wakes draw every section closed (their heads still
show the headline and facts). The layout marks the latest `arc` item of kind wake (`latest: true`); `ArcMessageRow`
seeds `WakePartRow`'s open state from it. Why the layout: it already knows every item, as it does for the latest
message.

## 6. Queued bubbles and notices (chunk 17, rendering)

- A `queued` user entry draws as the normal user bubble at its place in the turn; it does not start a turn and splits
  the fold (section 2).
- A `notice` notification draws as a muted one-line row (icon, "Background task" or "Notice" label, the summary
  truncated, the status when present), opening to the full text when it has more than one line or a result. Not the
  bordered "Subagent finished" box. It folds with the turn's work.

## 7. Images: thumbnails and zoom (chunks 10, 16; **user**: thumbnails that open the zoom view)

- One `ImageThumbs` component (new `frontend/app/view/agents/imagethumbs.tsx`): a wrapping row of small thumbnails
  (bounded height, `object-contain`, the existing card border/radius tokens), each a button that opens the existing
  `ImageZoom` (`frontend/app/element/imagezoom.tsx`) on that image. It owns the zoom state. No new viewer.
- Step cards: `ImageCard` (`toolrenderers.tsx`) draws `ImageThumbs` instead of ~500px images.
- User bubbles: pasted images draw as `ImageThumbs` under the text. A `[Image #N]` placeholder line is removed from the
  text when the entry carries images (the thumbnail replaces it); it stays when no image came with it.

## 8. Arc attachment list (chunk 6)

`composerattachments.ts` owns both directions: the header string becomes one exported constant used by
`appendAttachments` and by a new pure `splitAttachments(text): { text: string; paths: string[] }`, which strips a
trailing "Attachments (read these files):" block of `- <path>` lines. The bubble draws the remaining text, then the
attachments: image paths (by `classifyKind`) as `ImageThumbs` thumbnails loaded through
`/wave/stream-local-file` (`localFileUrl`, `frontend/app/view/jarvis/localimage.ts`), every other path as a file chip
(basename, the full path as its title). An image that fails to load falls back to its file chip (`ImageThumbs` reports
the failed index through `onError`). Why parse on read: the
text is what Claude received and what the transcript holds; the composer's chips are gone by then.

## 9. Rendered view: Show earlier (chunk 4)

The live stream tails 300 lines (`STREAM_TAIL_LINES`) and keeps up to 4,000. When the first chunk came back full
(at least the tail size; Pi always reads the whole file), the Rendered view shows a "Show earlier" control at the top of
the feed, matching Sessions detail's. Activating it reads the whole file once (`GetAgentTranscriptCommand`, maxlines -1;
the 12 MB ef251dcf read in 300 ms in the replay), replaces that stream's retained records with it, keeps appending
streamed chunks (records already in the full read, by `uuid`, are not added twice), stops capping that id's
retention, and lifts the feed's item cap (`renderAll`, as Sessions detail does). The reader's place is kept: the
content that was at the top of the viewport stays there, and the prepended rows get no entrance fade: the Rendered view
remounts its NarrationTimeline (a new `key`) when the full read lands, so the feed's `initial={false}` applies, rather
than changing the feed's motion rules. The state lives in `livetranscriptatoms.ts` per agent id, so
it survives the Agent surface's off-screen mount.

## 10. wsh cards with a shell variable id (chunk 18)

`parseWshCalls` expands `$NAME` and `${NAME}` in a wsh call's words when `NAME=value` was assigned earlier in the same
command (a bare assignment, an assignment prefix, or `export NAME=value`). A call whose words still hold `$` or a
backtick after that is unresolved: a card key resolves to the generic `"other-change"` row (its argv, timing and raw
output, no fetch, no error), and a view key draws as a plain step. One rule in `wshcall.ts`, so no card family needs
its own check.

## Verification

Each UI change has a CDP scenario step: transcript-base (turn fold, skill phrase, merged thoughts, command titles,
queued bubble, notice row), sessions-find (a hit inside a finished turn opens its fold), the card scenarios that
asserted cards outside the fold (transcript-initiative, -agents, -dag, -dagactions, -notes, -boards, -runs,
narration-feed), transcript-arc (past wakes closed, latest open), transcript-initiative (`$E` resolved and
unresolved), transcript-media (new: thumbnails in step cards and bubbles, attachment chips, zoom open/close), and
agent-rendered (Show earlier on a transcript longer than the tail).
