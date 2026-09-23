# Jarvis Brief — initiative editing layer (design)

Source design: `docs/prototype/jarvis-brief-editing.dc.html` (imported from claude.ai/design project
`84a7aa18…`, file `Jarvis Brief.dc.html`), **variant A** — inline tracker + Chunk sidebar. Variants B
(persistent split pane) and C (single `+ New ▾` menu) were declined.

## Why

The Brief already renders every region the design shows — header, Waiting on you, Initiatives with the
inline tracker, Runs, Behind you, the run sheet, Profile, + Initiative / + Run. What it cannot do is
**edit a plan in place**: a chunk's status is only settable from the note sidebar's `<select>`, and
chunk rename, reorder, stage change and removal, stage rename, initiative rename/details/pause/delete,
and note edit/delete exist only in `wsh effort` or not at all. The design adds that editing layer.
Everything outside it is unchanged by this work.

## Decisions (settled with the user)

1. Variant A.
2. Notes become editable and removable: new `editNote` / `removeNote` effort ops.
3. An initiative can be deleted from **any** status, behind an inline confirm. `EffortDeleteCommand`
   has no status guard (only the CLI does, and keeps its `--force` rule), so this is frontend-only.
4. Undo is a **deferred commit** for destructive edits; reversible edits commit at once and undo by
   inverse op.

## 1. Backend — `editNote` / `removeNote`

`pkg/wshrpc/wshrpctypes_effort.go`, `EffortOp`: add `NoteTs int64 \`json:"notets,omitempty"\``.
Both ops reuse the existing `Chunk` (chunk ref) and `At` (1-based note index within that chunk's
`Notes`) fields; `editNote` carries the new text in `Note`.

`pkg/waveobj/wtype.go`, `EffortNote`: add `Edited bool \`json:"edited,omitempty"\``.

`pkg/jarvis/effortops.go`, validation pass:
- chunk resolves (`ResolveChunkIndex`), else its existing error;
- `At` in range for that chunk's notes, else `EC-INVALID-INDEX`;
- `Notes[At-1].Ts == NoteTs`, else `EC-STALE-NOTE` (the trail moved under the caller — the index alone
  is not a safe key, one batch can stamp several notes with the same ts, so ts+index together are);
- `editNote`: `strings.TrimSpace(Note) != ""`, else `EC-EMPTY-NOTE`.

Apply pass:
- `editNote`: set the note's `Text` and `Edited = true`; bump the chunk's `UpdatedTs`. Rewrite the
  matching event — the first `effort-note` event with the same `Ts`, `Label == chunk label` and
  `Text == old text` — to the new text, so the Brief's feed (built from events, `effortfeed.ts`) and
  Behind-you digests agree with the chunk.
- `removeNote`: delete the note and the same matching `effort-note` event, if present.
- Neither op writes a trail stamp: they edit the trail itself; a stamp saying "note edited" would be
  a note about a note.

The `EffortOp.Op` doc comment gains the two op names (no new event kinds). Run `task generate`.

Tests (`pkg/jarvis/effortops_test.go`): edit rewrites note + event and sets `Edited`; remove drops
both; stale ts → `EC-STALE-NOTE` and nothing applied; out-of-range index; empty edit text; a status
stamp note (no `effort-note` event) is editable and leaves events untouched; atomicity when a batch
mixes a valid and an invalid note op.

No CLI subcommand: nothing asks for one (YAGNI).

## 2. Frontend store — `effortstore.ts`

New write-through helpers over the existing `mutateEffort` (each one batch):
`renameEffort(oref, title)`, `setEffortDetails(oref, {title, project, ticket, parent})` (only changed
fields → `rename` / `setProject` / `setTicket` / `link`), `renameChunk(oref, chunk, label)`,
`moveChunk(oref, chunk, at)`, `moveChunkToStage(oref, chunk, stage, at)` (`setChunkStage` + `moveChunk`
in one batch), `removeChunks(oref, labels[])`, `addChunkAt(oref, label, stage, at)`, `editNote(oref,
chunk, at, ts, text)`, `removeNote(oref, chunk, at, ts)`. `setChunkStage` (batch) already exists and
serves stage rename.

Errors surface where the edit was made (inline under the tracker / in the sidebar), never swallowed.
`EC-LAST-CHUNK` renders as "An initiative keeps at least one chunk."

## 3. Deferred commit + undo — `briefundo.ts` (pure) and its atom

A small queue, pure and unit-tested with fake timers:

```ts
type PendingDelete = { key: string; text: string; commit: () => Promise<void> };
schedule(p): void      // hide p.key now; commit after UNDO_WINDOW_MS (5000)
undo(key): void        // cancel: the item reappears, no RPC
flushAll(): Promise<void> // commit everything pending now
```

- `pendingDeleteKeysAtom: Set<string>` hides rows. Keys: `effort:<oref>`, `chunk:<oref>:<label>`,
  `note:<oref>:<label>:<ts>`. A stage delete schedules one entry whose commit removes the stage's
  chunks in one `removeChunks` batch and whose key set covers each chunk.
- `briefToastAtom: { text; undo?: () => void } | null` — one toast at a time; a new toast replaces the
  previous one (the previous pending delete keeps its own timer and still commits).
- Reversible edits (chunk status, archive, pause/resume, move, move-to-stage) commit immediately and
  post a toast whose undo runs the inverse op (previous status, `unarchive`, previous index/stage).
- `flushAll` runs from the Brief's unmount cleanup and from a `beforeunload` listener, so leaving the
  surface or closing the app never strands a delete the user did not undo.
- A commit failure posts an error toast and clears the key, so the row reappears (the server kept it).

The toast renders inside the Brief (bottom-centre, per the design), not through the cockpit's
`notificationstore` — that store has no action button and is global.

## 4. Tracker editing — `trackeredit.ts` (pure) + `inlinetrackerview.tsx`

`trackeredit.ts` owns the index math, unit-tested:
- `moveTarget(chunks, label, dir)` → 1-based `at` for up/down **within the chunk's stage run**, or
  `null` at the run's edge (the menu item and the key are then inert).
- `stageMoveTarget(chunks, label, stage)` → `at` = just after the last chunk of the first run with that
  stage (or the end, for a stage with no run yet).
- `stageRunLabels(chunks, at)` → labels of the position-keyed run (same key as `stageRowId`), used by
  stage rename and stage delete.
- `appendInStageAt(chunks, runAt)` → `at` for "+ Add chunk" at the end of a run.

View changes, matching the design's variant A markup (tokens from `tailwindsetup.css`, no raw colours):
- **Chunk row:** status pill button (glyph + status + ▾) opens a menu: the six statuses; Rename; Move
  up / Move down (shortcut hint `alt ↑` / `alt ↓`); "Move to stage" list (other stages + unstaged);
  Delete chunk. Double-click the row = rename in place (Enter commits, Escape cancels, blur commits).
  Click keeps opening the Chunk sidebar.
- **Stage header:** caret, label (double-click = rename), 48px progress bar, fraction, `⋯` menu
  (Rename stage, Delete stage).
- **After each stage run:** "+ Add chunk" → inline input (Enter adds with that stage, Escape cancels).
- **End of plan:** "+ New stage" → input for the name → Enter moves focus to a first-chunk input; the
  stage exists only once that chunk is added (a stage is a label on chunks, not a container).
- **Footer:** id (copy), count, then `rename · details · pause|resume · archive · delete`. Delete swaps
  the footer for the inline confirm "Delete this initiative, its N chunks and their notes?" →
  deferred delete. Archived initiatives show `unarchive` in place of `pause`/`archive`.
- **Initiative row title** renames in place when `rename` is chosen (same input rules).
- Menus close on outside click and Escape; only one menu is open at a time.

Keybindings (`bindings.ts`, Brief builder; `docs/keyboard-shortcuts.md` updated): `Alt:ArrowUp` /
`Alt:ArrowDown` move the chunk under the Brief cursor.

## 5. Chunk sidebar — restyle `NoteSidebar`

Replaces the 360px preview / 560px reader split with the design's single 460px panel (same container
query overlay rule below the breakpoint):
- Header: `CHUNK`, position `n/N` within the initiative, ↑ / ↓ buttons (step the Brief cursor to the
  previous/next chunk of the same initiative — the Brief keeps one cursor), `j / k` hint, Close.
- Breadcrumb `initiative / stage`, chunk label, CLI handle (copy), "initiative activity ↗" kept.
- Status: a six-cell radiogroup (glyph + label), replacing the `<select>`.
- Notes: cards, newest first, clamped; click expands. An expanded card shows `edit` / `delete`.
  Edit = textarea (Ctrl+Enter save, Escape cancel), marks "· edited" after. Delete = deferred delete.
  Only `effort-note` entries the feed locates to a chunk note are editable: `FeedEntry` gains
  `noteAt?: number` (the 1-based index of the note `effortFeed` already resolves via `locate`).
  Status entries ("marked done · …") and unlocated entries render read-only — their text is a suffix
  of a generated stamp, so editing it in place would mean rewriting the stamp.
- Footer composer: textarea, Ctrl+Enter or "Add note".
- Not built: the design's note author (`who`) and "open agent session ↗" — `EffortNote` records
  neither, and inventing them would be fabricated data.

## 6. Initiative forms — `effortcreateform.tsx`

- `parseChunkLines` learns `Stage: chunk`: a line containing `": "` splits on the first one; the left
  side is the stage. The preview groups ticked rows under stage headers, so a label that merely
  contains `": "` is visible before creating. Stages are applied in the same follow-up
  `EffortMutateCommand` batch as the done-ticks (`CommandEffortChunkSeed` has no stage field).
- Edit mode (`mode: "edit"`, opened by the footer's `details`): title, project, ticket, parent
  prefilled; the chunk textarea is replaced by "Chunks are edited in the plan: double-click to rename,
  the status pill to change status."; saves through `setEffortDetails`.

## Testing

- Go: §1 cases.
- Vitest: `trackeredit.test.ts`, `briefundo.test.ts` (fake timers: commit after window, undo cancels,
  flushAll commits, failure restores), `parseChunkLines` stage cases, `effortfeed` `noteAt`.
- CDP: extend `brief-inline-tracker` in `scripts/cdp/scenarios.mjs` — status pill menu opens with six
  statuses; double-click shows the rename input; delete hides the row and shows the Undo toast; Undo
  restores it with no RPC; the footer confirm appears on delete. Fixture data only; no commit path.
- Gates: `task check:ts` baseline clean, `go vet`, and the existing suites.

## Out of scope

Variants B and C; header, Waiting, Runs, Behind you, run sheet, Profile, New run (already shipped);
a `wsh effort` note edit/remove subcommand; note authorship.

Parity work on the rest of the design: `docs/superpowers/plans/2026-09-23-jarvis-brief-design-parity.md`.
