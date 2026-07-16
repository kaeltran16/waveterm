# Channel composer attachments (paste / attach / drag-drop) — design

**Date:** 2026-07-16
**Status:** approved (brainstorm), pending implementation plan

Let the Channels composer accept **images and files** — pasted, picked via a button, or dragged onto it —
and deliver them to the spawned/live `claude` worker. Today both composer faces are plain `<textarea>`s
with no paste/drop/attachment handling (`channelcomposers.tsx`, `composer-shell.tsx`): pasting an image
does nothing, and a pasted path is inert text.

## Goal

1. Attach one or more images/files in the Channels composer via **three sources**: clipboard paste,
   a paperclip file-picker button, and drag-drop onto the composer card.
2. Deliver them to the worker on both composer faces: **Launch** (`@run`/`@quick`/`@ask` — new worker)
   and **Talk** (message a live worker).

## Non-goals

- No new backend. Reuse the existing `WriteTempFileCommand` (`wshserver.go:378`).
- No driving of Claude's *native* interactive image-paste protocol (TUI keystroke injection) — rejected
  as fragile, CLI-version-coupled, and unusable for `@run`/`@quick` (no interactive worker yet).
- No cleanup of persisted temp files, no cross-reload persistence of pending attachments, no image
  annotation/editing, no Tauri native file-dialog plugin.
- Not wired into `ComposerShell`'s **other** callers (Runs new-run panel, inline steer) — Channels only.
- Local scope only: the temp path lives on the wavesrv (local) host. Remote/WSL worktree workers are a
  deferred edge (matches the "keep v1 local" principle).

---

## Delivery mechanism (the core decision)

Channel workers are `claude` processes; Claude reads files — **including images (PNG/JPG/…)** — with its
Read tool. So attachments reach the worker by **persist-to-disk + reference-by-path**:

1. Capture bytes (clipboard blob / picked File / dropped File).
2. base64 → `RpcApi.WriteTempFileCommand({ filename, data64 })` → returns an **absolute** temp path
   (the command `os.MkdirTemp`s a fresh dir and `os.WriteFile`s the bytes; `wshserver.go:378-400`).
3. On **Send**, append a trailing block to the composer text so the worker reads the files:

   ```
   <goal / message text>

   Attachments (read these files):
   - C:\...\shot.png
   - C:\...\error.log
   ```

This is deterministic, reuses existing code, and works identically for every face and source.

---

## Architecture

- **`composerattachments.ts`** (new) — pure helpers + the React hook:
  - Types: `Attachment { id; name; kind: "image" | "file"; status: "uploading" | "ready" | "error"; path?: string; previewUrl?: string; size: number }`.
  - Pure fns (unit-tested): `classifyKind(file) → "image" | "file"`, `appendAttachments(text, atts) → string`
    (appends only `ready` atts; returns `text` unchanged when none), `MAX_ATTACHMENT_BYTES` (default 10 MB).
  - `useComposerAttachments()` hook → `{ attachments, add(files), remove(id), retry(id), clear(), uploading }`.
    `add` runs the persist pipeline per file; revokes `previewUrl`s on `remove`/`clear`.
- **`attachmenttray.tsx`** (new) — the chip tray (thumbnails/icons + remove/retry) and the paperclip
  button (a `<label>` wrapping a hidden `<input type="file" multiple>`).
- **`composer-shell.tsx`** — add **opt-in** props so the card is the drop target and hosts the tray:
  `onPaste?`, `onDrop?`, `onDragOver?`, `onDragLeave?`, `isDragging?: boolean`, `attachments?: ReactNode`
  (rendered above the input). Callers that don't pass them are byte-for-byte unchanged. The drag overlay
  (dashed border + "Drop files to attach") renders on the card wrapper (`composer-shell.tsx:59`) when
  `isDragging`.
- **`channelcomposers.tsx`** — `LaunchComposer` and `TalkComposer` stay presentational: they receive
  `attachments` + the capture handlers as props (mirroring `value`/`onChange`), render the tray +
  paperclip, and forward `onPaste`/`onDrop`/`onDragOver` + `isDragging` to `ComposerShell`. They do **not**
  own the hook.
- **`channelssurface.tsx`** — inject at the two send branches; clear attachments after a successful send.
- **`src-tauri/tauri.conf.json`** — add `"dragDropEnabled": false` to the `main` window (`:14`) so OS
  file-drops surface as DOM `drop` events with `dataTransfer.files` instead of being swallowed by Tauri's
  native handler. This governs only OS *file* drops, so the layout engine's element drag-drop is
  unaffected; the terminal's already-dead drop handler (`termwrap.ts`, relies on the stubbed
  `getPathForFile`) is not regressed.

### Where attachment state lives

The composer's `draft` and the single `send` handler already live in `channelssurface.tsx` (`:59`, `:80`).
Attachment state is owned there too (or lifted from the composers), because `send` needs it and both faces
share `draft`. The composers receive `attachments` + handlers as props (mirroring `value`/`onChange`), so
the pure hook can live in `channelssurface` and the composers stay presentational. (Exact placement — hook
in the surface vs. in each composer with a ref/callback up — is a plan-level detail; the surface must be
able to read `ready` attachments at `send` time and `clear()` after.)

---

## Capture — three sources → one `add(files: File[])`

- **Paste** (`onPaste` on the composer): if `clipboardData.files.length > 0` (clipboard image, or an
  Explorer-copied file), `preventDefault()` and `add(files)`. Otherwise do nothing — plain text paste is
  untouched. (Fall back to `clipboardData.items` filtered to `kind === "file"` where `files` is empty.)
- **Attach button**: paperclip → hidden `<input type="file" multiple>` → `add(input.files)`; reset the
  input value after so re-picking the same file fires `change`.
- **Drag-drop** (`onDragOver` sets `isDragging` + `preventDefault`; `onDrop`): `add(dataTransfer.files)`,
  clear `isDragging`. Requires the Tauri config change above.

## Persist pipeline (`add`)

Per file: reject if `file.size > MAX_ATTACHMENT_BYTES` (push an `error` chip, no RPC). Else push an
`uploading` chip (images get a `previewUrl` via `URL.createObjectURL`), read bytes (`FileReader` →
base64, strip the data-URL prefix), call `WriteTempFileCommand({ filename: file.name, data64 })`, then set
`path` + `status: "ready"`. On RPC failure → `status: "error"` (chip shows retry/remove; `retry(id)`
re-runs the tail of the pipeline).

## Delivery — inject on Send (`channelssurface.tsx`)

`appendAttachments(text, readyAttachments)` is applied to the finalized composer text before it is routed:

- **Launch face** (`:200-226`): apply to `text` *before* `parseComposerCommand` (`:205`). Appending after
  the leading `@run`/`@quick`/`@ask` token leaves command parsing intact and carries the paths into
  `cmd.body` → `launchRun(cmd.body)` / dispatch. The goal (with paths) flows into `BuildQuickPrompt` /
  `BuildPhasePrompt` (`pkg/jarvis/run.go`) unchanged.
- **Radar pending-draft branch** (`:~190-198`): same injection into the draft goal (same Launch composer).
- **Talk face** (`:178-183`): apply to `text` before `steerWorker({ … text })` (`channelactions.ts`), so
  the follow-up turn injected into the live worker carries the paths.

Only `ready` attachments are injected. Send is **blocked while any attachment is `uploading`**
(`useComposerAttachments().uploading`). Attachments `clear()` after a successful send (alongside the
existing `setDraft("")`).

## UI

- **Chip tray** above the textarea (inside each composer's `inputRegion`): image chip = thumbnail
  (`previewUrl`) + truncated name + ×; file chip = file icon + name + size + ×; `uploading` = spinner /
  reduced opacity; `error` = red border + retry affordance.
- **Paperclip button** in `footerLeft` (both faces), left of the existing footer text.
- **Send-enabled**: the `sendDisabled` condition changes from `!value.trim()` to
  **`(!value.trim() && readyCount === 0) || uploading`** — enabled when there is text **or** ≥1 ready
  attachment, and always disabled while any attachment is still uploading.
- **Drag overlay** on the card while `isDragging`.

## Edge cases / bounds

- **Text paste** is never intercepted (only when `files.length > 0`).
- **Temp files are not cleaned up** in v1 (worker may read them after send). Documented; a lifecycle-tracked
  cleanup is deferred to `docs/deferred.md`.
- **Size cap** (`MAX_ATTACHMENT_BYTES`, 10 MB default): base64 inflates ~33%, so this bounds the RPC
  payload; oversize files are rejected with an `error` chip, no RPC.
- **Remote/WSL workers** can't see the local temp path — deferred (local scope).
- Non-image files are fully supported (referenced by path); only images get a thumbnail.

## Testing

Per CLAUDE.md: pure logic → vitest; cockpit React → CDP (no jsdom render harness).

- **vitest (`composerattachments.test.ts`)**:
  - `appendAttachments`: text + ready atts → correct trailing block; **skips non-`ready`** atts; returns
    input unchanged when there are none; preserves the leading `@`-command token.
  - `classifyKind`: image mime/extension → `"image"`, else `"file"`.
  - size-guard boundary (at / over `MAX_ATTACHMENT_BYTES`).
- **CDP (`scripts/cdp-shot.mjs`)** against the live dev app (inject a channel scenario if needed):
  1. Paste an image into the Launch composer → thumbnail chip appears → `@run …` → confirm the temp path
     appears in the created run's goal.
  2. Paperclip → pick a file → chip → send → path present.
  3. Drag a file onto the composer → overlay → chip → send → path present (validates
     `dragDropEnabled:false`).
  4. Talk face: paste an image while a worker is live → send → path injected into the follow-up turn.

## Rollout / verification checklist

1. `tauri.conf.json` `dragDropEnabled:false` on `main`; dev rebuild picks it up (Tauri watches `src-tauri/`).
2. `RpcApi.WriteTempFileCommand` already exists in the generated client — **no `task generate` needed**
   (no wshrpc type change). Verify: `grep -c WriteTempFileCommand frontend/app/store/wshclientapi.ts` ≥ 1.
3. `npx vitest run frontend/app/view/agents/composerattachments.test.ts` → green.
4. `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` → exit 0.
5. CDP passes for all four flows above.
6. Add a `docs/deferred.md` entry for temp-file cleanup + remote-worker paths.

## File touch list

- **New:** `frontend/app/view/agents/composerattachments.ts`, `attachmenttray.tsx`,
  `composerattachments.test.ts`.
- **Modify:** `frontend/app/view/agents/composer-shell.tsx` (opt-in drop/paste/tray props),
  `channelcomposers.tsx` (tray + paperclip + handler forwarding, both faces),
  `channelssurface.tsx` (own attachment state; inject at the two/three send branches; clear on send),
  `src-tauri/tauri.conf.json` (`dragDropEnabled:false`), `docs/deferred.md` (deferred notes).

## Related code

- Composer: `channelcomposers.tsx`, `composer-shell.tsx`; send handler `channelssurface.tsx:178-226`.
- Persist primitive: `WriteTempFileCommand` (`pkg/wshrpc/wshserver/wshserver.go:378`, client
  `wshclient.go:1260`).
- Worker prompt builders (goal carries the paths): `pkg/jarvis/run.go` (`BuildQuickPrompt`,
  `BuildPhasePrompt`); Talk injection: `steerWorker` (`channelactions.ts`).
- Tauri window: `src-tauri/tauri.conf.json:14`.
