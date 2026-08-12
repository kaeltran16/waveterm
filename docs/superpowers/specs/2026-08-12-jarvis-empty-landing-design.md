# Jarvis empty-landing: first channel + new-run composer instead of the empty Stage

Date: 2026-08-12
Status: approved (brainstorm)

## Problem

Navigating to the Jarvis surface (the "Channels" tab) with no subject selected shows the
empty Stage ("Point me at some work."). This happens at boot when nothing is persisted in
`jarvis.subject.last`, or when the stored subject no longer exists (deleted / pruned).

The user wants: land on the first channel with the empty-run (Launch) composer ready, so
typing a command dispatches a run — instead of `click channel → ＋ New run → type`.

## Behavior

When the Jarvis surface would otherwise show the empty Stage (no subject selected) and
channels exist:

1. Auto-select the first visible channel — the top row of the Subjects column (newest
   active channel in the current Space scope, archived excluded).
2. Force the Stage into its "Start a run" state (`composingRun[channel.oid] = true`), so
   the Launch composer shows even if the channel has a live worker (with the existing
   "New run — this starts a second one" banner in that case).
3. The Launch textarea's existing `autoFocus` puts the cursor in the box; typing + Enter
   creates a run. No new focus plumbing.

Properties:

- **One-shot landing, not a mode.** The forced launch face applies only on the
  empty→first-landing path. After a dispatch (composing clears on send) and on later
  boots, normal restore behavior returns — the persisted last subject comes back as left.
- **Same path as a click.** Auto-landing goes through `selectSubject`, so it stamps the
  channel read, loads its run/message streams, and persists the channel as the last
  subject.
- **No channels → unchanged.** If the channel list is empty (or every channel is archived
  / scoped out), the current empty Stage with its "start a channel" guidance stays.

## Implementation

### 1. `frontend/app/view/jarvis/subjects.ts` — pure helper

```ts
export function firstVisibleChannel(
    channels: Channel[] | null,
    scope: SpaceScope | null,
    revealed: boolean
): Channel | null {
    const scoped = filterChannelsBySpace(channels, scope, revealed);
    if (scoped == null || scoped.length === 0) {
        return null;
    }
    return partitionChannels(scoped).active[0] ?? null;
}
```

Reuses `filterChannelsBySpace` + `partitionChannels` (already imported in the module), so
"first visible" is exactly the column's first channel row — scoped by the active Space,
archived excluded, in the snapshot's newest-first order.

### 2. `frontend/app/view/jarvis/subjectscolumn.tsx` — restore effect fallback

In the boot-restore effect, when `restoreDecision` returns "clear" (nothing stored, or
stored subject gone):

- If `channels` is still null (not loaded), wait — do not latch — and decide when the
  list lands. (Today the effect latches "clear" immediately even before the channel list
  arrives, so the empty Stage would stick even though channels then load.)
- Else pick `firstVisibleChannel(channels, spaceScope, revealed)`; if non-null, run
  `selectSubject({ kind: "channel", id: first.oid })` + `setComposingRun(first.oid, true)`.
- Else (list loaded, nothing visible) keep today's behavior: `setStored(null)`, empty Stage.

Add `spaceScope` and `revealed` to the effect's dependency array (both already read in the
component).

## Edge cases

| Case | Outcome |
| --- | --- |
| Channels still loading at surface entry | Effect waits; lands when the list arrives. |
| Channel list load failed | `channelsAtom` stays null → empty Stage (same as today). |
| No channels | Empty Stage with "start a channel" guidance (unchanged). |
| All channels archived / scoped out | Empty Stage (never lands on a hidden channel). |
| First channel has a live run | Launch face forced, "New run" banner shown (same state as a manual ＋ New run). |
| Radar draft pending | The draft already forces the Launch face; composing flag adds nothing, banner suppressed — no conflict. |
| Stored subject valid | Restore unchanged — normal behavior wins over the fallback. |

## Testing

- Unit tests for `firstVisibleChannel` in `subjects.test.ts`: null channels, empty list,
  archived-only, picks first non-archived in order, Space scope filters, revealed passes
  everything.
- `npx vitest run frontend/app/view/jarvis/` + `node --stack-size=4000
  node_modules/typescript/lib/tsc.js --noEmit`.
- CDP verify on the dev app: clear `localStorage["jarvis.subject.last"]`, reload, open
  Jarvis → first channel selected, Launch composer focused. (The `jarvis-ask` scenario is
  known-stale — Ctrl+P vs Ctrl+Shift+P — discount it.)
