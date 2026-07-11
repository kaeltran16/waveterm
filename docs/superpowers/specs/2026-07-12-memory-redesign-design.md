# Memory surface redesign (Wave-memory.dc.html import) — design

2026-07-12. Task: import the `Wave-memory.dc.html` design from the `wave` Claude Design project and
implement it against the existing Memory surface. The design reshapes how pending-review candidates
are presented — from a collapsed tray into a first-class inline band with a detail-rail review flow —
and refreshes the header, saved list, and graph to match.

## What exists today

The Memory surface (`frontend/app/view/agents/memorysurface.tsx` + `mem*.tsx/ts`) is a real,
backend-connected feature over `pkg/memvault`:

- **Backend**: 10 wshrpc commands (`MemoryScan/Read/Write/Create/Harvest/Delete/ReviewList/
  ReviewAccept/PruneList`). Pending candidates are agent-distilled notes queued in
  `~/.waveterm/memory-pending/` (`pkg/memvault/review.go`), accepted into the project hub or rejected.
- **Frontend**: header (count/search/Graph-List toggle/New) + grouped saved list + `CollapsibleRail`
  detail (content/meta/related, Edit/Delete) + `MemGraph` (react-force-graph-2d). Pending review is a
  collapsed `ReviewTray`; a `CleanupQueue` surfaces prune candidates.

The type→color tokens already encode the design's mental model verbatim
(`frontend/tailwindsetup.css`): `mem-project #8aa0ff /* decision-blue */`, `mem-reference #54c79a
/* fact-green */`, `mem-feedback #e6b450 /* convention-amber */`, `mem-user #a78bfa
/* preference-purple */`. No new color work.

## Gap between the design and today

| Design element | Today | Work |
|---|---|---|
| Subtitle "N saved · M pending review" | "N entries" | trivial |
| Inline **Pending review band** (amber cards, per-card Keep/Dismiss, Keep all/Dismiss all, source→scope, age, preview) | collapsed `ReviewTray` (dot + truncated body) | new `PendingBand` component; retire `ReviewTray` |
| Detail-rail **pending mode** (banner, "X of N", Keep/Dismiss, read-only scope) | detail rail only handles saved notes | extend `DetailRail` + unified selection |
| Pending card shows **title / source / age** | `MemoryPendingNote` = `{path,type,scope,body,cwd}` | enrich backend type + populate |
| Graph shows **pending nodes** (amber ring) + "Pending" legend | graph shows saved only | feed pending nodes into `MemGraph` |
| Saved list, detail saved-mode, related memory, graph | already present | reuse as-is |

## Decisions

Answered by the user before planning:

1. **Enrich the backend** for pending-card fidelity. Add `Title`, `Source`, `CapturedAt` to
   `memvault.PendingNote` and the `MemoryPendingNote` wire type; populate server-side (single source
   of truth) rather than deriving on the client.
2. **Omit scope reassignment.** The mock's scope chips reassign a pending note's scope before Keep;
   there is no backend for it (`MemoryReviewAccept` takes only a path) and it would require moving
   files across hub dirs. The pending detail shows scope **read-only** — no dead control.
3. **Keep the CleanupQueue.** The mock omits it, but it addresses a real, shipped user need
   (superseded/stale prune). It stays below the pending band.

Decided during design analysis and flagged here for review:

4. **Drop "Pin".** The mock's saved detail shows Edit/Pin/Delete. There is no `Pin` backend and no
   clear semantics for pinning a markdown memory note. Keep the existing **Edit / Delete**. (Easy to
   add later behind a real backend field.)
5. **Keep honest type labels.** The mock's legend relabels the real schema types (project→"Decision",
   reference→"Fact", feedback→"Convention", user→"Preference"). The backend emits
   `project/reference/feedback/user/learning`; relabeling would misrepresent the data. Keep the
   existing labels (`typeMeta` in `memtypes.ts`) with the already-matching colors.
6. **`groupBy` and `compactPending` are design-canvas knobs, not shipped UI.** They live in the
   mock's `<script data-props>` block — the design tool's preview controls — not as visible toggles
   in the layout. Ship the defaults: **group saved by scope** (existing `groupByScope`) and **show the
   pending preview**. No hidden settings, no new toggles.
7. **Keep the `CollapsibleRail` detail pattern.** The mock draws a fixed 360px right panel; the app's
   detail rail is the shared `CollapsibleRail` used across every cockpit surface (Radar, Sessions…).
   Render the design's detail content inside the existing rail — consistency over pixel-matching the
   panel chrome.

## Design

### Backend — enrich the pending note (single Go slice + regen)

`pkg/memvault/review.go`:
- `PendingNote` gains `Title string`, `Source string`, `CapturedAt string` (json `title`, `source`,
  `capturedat`).
- `ListPending` populates them:
  - `Title` = `firstLine(body)` (the human sentence; the distiller writes a single body blob).
  - `Source` = `filepath.Base(cwd)` when cwd set, else `"agent"` (where it was learned).
  - `CapturedAt` = RFC3339 parsed from the filename's `20060102T150405.000` stamp prefix (the stamp
    `WritePending` already writes); empty string if the name has no parseable stamp.
- New unexported helper `pendingCapturedAt(filename string) string` + test.

`pkg/wshrpc/wshrpctypes.go`: `MemoryPendingNote` gains `Title`, `Source`, `CapturedAt` (json
`title`/`source`/`capturedat`). `pkg/wshrpc/wshserver/wshserver.go` `MemoryReviewListCommand` copies
the three new fields through. Then `task generate` regenerates `wshclientapi.ts` + gotypes.

No change to accept/reject: Keep = existing `MemoryReviewAccept(path)`, Dismiss = existing
`MemoryDelete(path)`.

### Frontend — types & store

`memtypes.ts`:
- `MemPending` type mirroring the enriched wire type.
- `relativeAge(iso: string): string` → "4m ago" / "1h ago" / "2d ago" / "just now" (empty on unparseable).
  Pure, unit-tested in node env.

`memstore.ts`:
- `memPendingAtom` typed `MemPending[]` (already the review atom, now carrying enriched fields).
- **Unified selection.** Add `memSelectedPendingPathAtom: string | null`. Selecting a pending card
  sets it and clears `memSelectedIdAtom`; selecting a saved note clears the pending path. The detail
  rail shows pending when the path is set, else the saved note. Pending detail needs no `MemoryRead`
  — its body is already in the atom.
- `keepPending(path)` = existing `acceptPending`, then advance selection to the next pending (mock's
  `transition`: next remaining by index, else first saved). `dismissPending(path)` = existing
  `rejectPending`, same advance.
- `keepAllPending()` / `dismissAllPending()` — sequential loop over the current pending set (accept
  or reject each), one `loadReview` + `loadMemory` refresh at the end; sets `memReflowAnimatedAtom`.

### Frontend — components

**`pendingband.tsx`** (new): the inline band, rendered at the top of the list content and only when
`pending.length > 0`. Header row: pulsing amber dot, "PENDING REVIEW" eyebrow, count pill, hint copy,
`Keep all` / `Dismiss all`. Cards: amber left border, type badge, `source → scope`, `relativeAge`,
title, 2-line preview; per-card Keep (check) / Dismiss (×) with `stopPropagation`; whole card selects
(sets pending selection). Replaces `ReviewTray` in the surface; **`reviewtray.tsx` is deleted**.

**`memorysurface.tsx`** (modify):
- Header subtitle → "What your agents remember · **N saved** · **M pending review**" (pending clause
  only when M > 0, amber).
- List content: `<PendingBand>` above the saved groups (same `max-w-[760px]` column).
- Remove `<ReviewTray/>`; keep `<CleanupQueue/>` and `<SyncStrip/>`.
- `DetailRail`/`DetailBody`: branch on selection kind. **Pending**: amber "Pending review" banner +
  "index of count", type badge, title, content (`MarkdownMessage` on body), Keep (solid green) /
  Dismiss (outline red), read-only Scope/Source/Captured meta rows. **Saved**: unchanged (Edit/Delete,
  meta, related).

**`memgraph.tsx`** (modify): accept an optional `pending: MemPending[]`. Add them as nodes carrying a
`pending` flag; `paintNode` strokes a pending node with an amber ring (`--color-mem-feedback` tint)
instead of a fill-only dot, matching the mock. Add a "Pending" entry to the legend. Pending nodes are
isolated (distiller bodies carry no `[[links]]`) — honest to real data; no synthetic edges.

## Non-goals (YAGNI)

- No scope reassignment, no `Pin`, no `groupBy`/`compactPending` UI toggles, no type relabeling
  (see Decisions 2, 4, 5, 6).
- No new RPCs. Keep/Dismiss/Keep-all/Dismiss-all all compose existing accept/reject/delete.
- No changes to the distiller hook, harvest, projection, or prune backends.

## File structure

| File | Change |
|---|---|
| `pkg/memvault/review.go` | `PendingNote` +3 fields; `ListPending` populate; `pendingCapturedAt` helper |
| `pkg/memvault/review_test.go` | cover new fields + `pendingCapturedAt` |
| `pkg/wshrpc/wshrpctypes.go` | `MemoryPendingNote` +3 fields |
| `pkg/wshrpc/wshserver/wshserver.go` | copy 3 fields in `MemoryReviewListCommand` |
| `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts` | regenerated (`task generate`) |
| `frontend/app/view/agents/memtypes.ts` | `MemPending`, `relativeAge` |
| `frontend/app/view/agents/memtypes.test.ts` | `relativeAge` cases |
| `frontend/app/view/agents/memstore.ts` | pending selection atoms, keep/dismiss(+all) helpers |
| `frontend/app/view/agents/pendingband.tsx` | new band component |
| `frontend/app/view/agents/memorysurface.tsx` | subtitle, band wiring, detail pending mode |
| `frontend/app/view/agents/memgraph.tsx` | pending nodes + legend |
| `frontend/app/view/agents/reviewtray.tsx` | **delete** (superseded by band) |

## Testing

- **Go**: `go test ./pkg/memvault/` — `ListPending` returns Title/Source/CapturedAt; `pendingCapturedAt`
  parses the stamp and tolerates a stampless name.
- **Frontend (vitest, node env)**: `relativeAge` buckets; a `memstore` test for the keep/dismiss
  selection-advance logic (pure reducer extracted so it's testable without RPC).
- **Visual (CDP)**: `node scripts/cdp-shot.mjs` against `task dev` with injected pending data — verify
  the band, detail pending mode, subtitle, and graph pending rings against the mock.

## Verification & commits

Per the repo's global rules: **no per-task commits.** Each task ends with a verify-only checkpoint
(Go test / vitest / typecheck via `node --stack-size=4000 node_modules/typescript/lib/tsc.js
--noEmit`). All changes batch into a **single commit at the very end, gated on explicit approval**.
