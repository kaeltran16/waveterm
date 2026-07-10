# Channels tab: finishing the deferred backlog

Date: 2026-07-10
Scope: feature batch (four independent deferred usability items on the mature Channels surface). Spec only — hands off to writing-plans.
Related: `docs/agents/channels-improvements.md` (the backlog this closes out), `docs/superpowers/plans/2026-07-09-channels-realworld-report-fixes.md` (the prior batch that deferred these four), `docs/agents/channels-flows.md`.

## Problem

The Channels tab has been through ten specs and ~30 commits; the real-world-report fix batch (2026-07-09) shipped almost the whole backlog but explicitly deferred four items, each for a concrete reason (needs a cross-surface aggregate, needs persistence, needs an external-CLI change, or was unconfirmed). This spec finishes those four as one coherent batch. None are correctness bugs in the classic sense — they are legibility/hygiene/consistency gaps that grow with fleet size.

The four (from `channels-improvements.md` + the prior plan's "Deferred" section), confirmed feasible by a code scan on 2026-07-10:

- **A — Ambient "needs you" attention + Cockpit dedup** (backlog #8, report §G22). Today the per-channel rail dot and "Needs you · N" panel dedupe via `pendingAsks`, but the **Cockpit header's "N need you" counter uses raw `state === "asking"` and never dedupes** — so it over-counts asks Jarvis already auto-answered, and the three surfaces can disagree. There is also no ambient, always-visible signal of "which of my workers is waiting on me?" outside the Channels tab.
- **B — Channel archive** (backlog #3 remainder). Delete + rename shipped; there is no archive, so channels you want to keep-but-hide still clutter the rail.
- **C — Per-worker fleet dismiss** (backlog #9 remainder). The "Done · N" collapse shipped, but a finished ("gone") worker can't be dismissed; the list only grows.
- **D — Consult inherits operator's global CLAUDE.md** (report §C10). One-shot consults shell out to `claude -p` / `codex` / `agy` with `cmd.Dir = projectPath`. `claude` therefore discovers `~/.claude/CLAUDE.md` natively; `codex`/`antigravity` do not, so consults on those runtimes ignore the operator's global principles.

## Decisions (locked via brainstorming, 2026-07-10)

- **All four items in scope**, in-app only for A (no OS/taskbar badge). The Tauri v2 shell exposes no badge command today and Windows supports only an overlay *icon* (a dot, not a number) — a net-new native primitive with cross-platform caveats and marginal payoff over an in-app badge. Deferred.
- **A is driven by one number.** A single pure helper `pendingAskCount(channels, agents)` is the sole source of truth for both the nav-rail badge and the Cockpit counter, so they can never disagree, and it dedupes against Jarvis-answered asks (fixing §G22 as a side effect).
- **B archives via a `Channel.Meta` flag**, mirroring the shipped `SetChannelTierCommand`/`RenameChannelCommand`. `GetChannels` keeps returning everything; the rail partitions client-side into active + an "Archived · N" disclosure, reusing the exact pattern already shipped for gone workers ("Done · N"). Archive is reversible (unarchive).
- **C persists via a `dismiss` message kind**, not a new backend command. Reuses the existing `PostChannelMessageCommand`; `buildFleetSnapshot` interprets it. This fits the surface's "the timeline is the single source of truth" convention (every action posts a message) and means a later re-dispatch of the same worker naturally un-dismisses it (dispatch-ts beats dismiss-ts).
- **D injects a full, uncapped "Operator principles" preamble for non-claude runtimes only.** `claude` is left untouched (it already inherits the file via cwd; explicit injection would double it). The preamble is not subjected to the 4000-char channel-history cap — truncating a principles document mid-sentence would mislead the consulted agent, so it is prepended whole. Absence of `~/.claude/CLAUDE.md` is normal, not an error.

## Non-goals

- OS/taskbar/dock badge (deferred — see above).
- Sessions "Needs attention" reconciliation: it is a *different* data source (sessions archive, live-or-ended status), not the channel ask model, so it is out of scope for the ask-dedup work.
- Bulk archive / archive-all / auto-archive-stale. Single-channel archive + unarchive only (YAGNI).
- Changing what "gone" means, or a dismiss-all. Per-worker dismiss only.

---

## Item A — Ambient attention + Cockpit dedup (FE-only)

### Architecture / data flow

One new pure helper is the whole design:

```ts
// jarvisderive.ts
// Fleet-wide count of workers genuinely blocked on the human: asking, minus any ask Jarvis has already
// auto-answered (a jarvis-answered card exists for that ask oref) across ALL channels. Single source of
// truth for the nav-rail badge and the Cockpit "need you" counter, so they cannot disagree.
export function pendingAskCount(channels: Channel[], agents: AgentVM[]): number {
    const answered = new Set<string>();
    for (const ch of channels) {
        for (const o of answeredAskORefs(ch.messages ?? [])) {
            answered.add(o);
        }
    }
    return agents.filter((a) => a.state === "asking" && !(a.ask?.oref && answered.has(a.ask.oref))).length;
}
```

- `answeredAskORefs` already exists in `jarviscards.ts` (shipped in the prior batch). `jarvisderive.ts` already imports `agentsviewmodel` (for `AgentVM`) and can import from `jarviscards` with no cycle (`jarviscards` → `channelmessages` only).
- **Data source:** `channelsAtom` (the rail snapshot; carries each channel's `messages`) + `model.agentsAtom` (the live roster). This is the same snapshot the rail dot already reads, so the badge stays consistent with the per-row dots. Snapshot staleness for non-active channels is a pre-existing, accepted limitation (documented in `channelsstore.ts`); the badge inherits it rather than introducing a new inconsistency.

### Components

- **Nav-rail badge** (`navrail.tsx`): `NavRail` currently takes only `model`. Add `useAtomValue(channelsAtom)` + `useAtomValue(model.agentsAtom)`, compute `pendingAskCount`, and render a small count badge on the `channels` item when > 0. `renderItem` gains an optional `badge?: number`; the button is already `position: relative`, so the badge is a positioned `<span>` with no structural change.
- **Cockpit counter** (`cockpitsurface.tsx:787`): replace `<RollingCount value={asking.length}/>` with `<RollingCount value={needsYou}/>` where `const needsYou = pendingAskCount(channels, agents)`. `asking` (from `groupAgents`) stays for layout/grouping — only the displayed count changes. Add the `channelsAtom` read.

### Testing

- Unit (vitest, `jarvisderive.test.ts`): `pendingAskCount` — counts an unanswered asking worker; drops one whose ask oref has a `jarvis-answered` card; counts a *new* ask oref from a worker whose *previous* ask was answered; ignores non-asking; sums across multiple channels; 0 for empty.
- Visual (CDP, best-effort): badge appears on the Channels nav item when a worker is asking and clears when answered; Cockpit counter matches the badge. Reproducing a live answered-but-asking state may be impractical over CDP — rely on unit tests and mark unverified with that reason if so.

---

## Item B — Channel archive (backend + regen + FE)

### Backend

- New `ArchiveChannelCommand(ctx, CommandArchiveChannelData{ChannelId, Archived bool})` in `wshrpctypes.go` + `wshserver.go`, mirroring `SetChannelTierCommand` exactly: validate id, `DBUpdateFn` to set `ch.Meta[MetaKey_Archived] = data.Archived`, `SendWaveObjUpdate`.
- `MetaKey_Archived = "archived"` constant next to `MetaKey_ReadTs` in `wstore_channel.go`.
- `task generate` regenerates `wshclient.go` + `wshclientapi.ts` (do not hand-edit). `task build:backend` to compile.
- `GetChannels` is unchanged — it still returns archived channels; the rail filters.

### Frontend

- Store: `archiveChannel(channelId, archived)` in `channelsstore.ts` — RPC then `loadChannels()` (identical pattern to `setChannelTier`/`renameChannel`).
- Rail (`channelrail.tsx`): partition `filtered` into `active` (no `archived` meta) and `archived`. Render active rows as today; render archived rows under an "Archived · N" disclosure (collapsed by default), reusing the visual pattern of the fleet panel's "Done · N" toggle. Add "Archive channel" / "Unarchive channel" to the row context menu (the menu that already holds Rename/Delete). An archived row's menu offers Unarchive; a search query still searches both partitions.
- Surface (`channelssurface.tsx`): pass an `onArchiveChannel` prop to `<ChannelRail>` wired to `archiveChannel`.

### Testing

- Unit (`channelderive.test.ts`): a pure `partitionChannels(channels)` (or extend `filterChannels` consumers) → `{active, archived}` split by the meta flag. Tested for: no-archived (all active), some archived, archived+search interplay.
- Visual (CDP): archive a channel → it leaves the active list and appears under "Archived · N"; unarchive returns it; archive persists across a nav-tab cycle (proves the meta write + snapshot refresh).

---

## Item C — Per-worker fleet dismiss (backend-free + FE)

### Data flow

- A dismiss is a channel message: `kind: "dismiss"`, `reforef: "tab:<agentId>"`, posted via the existing `PostChannelMessageCommand` (no new backend command).
- `buildFleetSnapshot` (`jarvisderive.ts`) already walks messages by `kind` collecting `tab:` orefs for dispatch/directive. Extend it to also record, per oref, the latest dismiss-ts and the latest dispatch/directive-ts. A worker is hidden from the fleet snapshot when it is **gone** AND its latest dismiss-ts > its latest dispatch/directive-ts. A live (non-gone) worker is never hidden. A re-dispatch (newer dispatch/directive message for that oref) makes dispatch-ts win again, so the worker reappears — no explicit un-dismiss needed.
- Only **gone** workers are dismissable (dismissing a live worker would be a footgun and is a non-goal); the menu item only appears for gone rows.

### Components

- Action: `dismissWorker(channelId, workerORef)` in `channelactions.ts` — posts the dismiss message (fire-and-forget; WOS update re-renders the panel).
- `WorkerRow` (`channelsprimitives.tsx`): add a "Dismiss" context-menu item, shown only when `w.state === "gone"`. Needs `channelId` + the dismiss callback threaded down from `ContextPanel` (`channelssurface.tsx`) — `ContextPanel` already has the active channel.

### Testing

- Unit (`jarvisderive.test.ts`): `buildFleetSnapshot` hides a gone worker with a dismiss message newer than its dispatch; keeps a gone worker whose dispatch is newer than its dismiss (re-dispatched); never hides a live worker even with a dismiss message; a dismiss for an unknown oref is a no-op.
- Visual (CDP): dismiss a gone worker under "Done · N" → it disappears and stays gone across reload (proves persistence); re-dispatching that worker brings it back.

---

## Item D — Consult inherits operator's global CLAUDE.md (backend-only)

### Data flow

- New pure helper `consult.OperatorPrinciples() (string, error)`: read `filepath.Join(wavebase.GetHomeDir(), ".claude", "CLAUDE.md")`. Missing file → `("", nil)` (normal). Read error other than not-exist → propagate. (`wavebase.GetHomeDir()` is the established primitive, already used for `~/.claude` paths elsewhere.)
- `BuildPrompt(history, userPrompt, principles string)` gains a third param. When `principles != ""`, prepend:
  `"Operator principles (follow these):\n" + principles + "\n\n"` before the existing "Recent channel conversation …" / "Request: …" body. The preamble is **not** subject to `maxContextChars` (that cap governs channel history only) — it is prepended whole.
- Consult server (`wshserver.go` `ConsultCommand`, and the parallel Jarvis path if it shares `BuildPrompt`): compute `principles` = `""` when `runtime == "claude"`, else `OperatorPrinciples()`, and pass it to `BuildPrompt`. A read error is logged and treated as empty (a consult must not fail because the operator has no global config) — errors handled at this boundary, not swallowed silently deeper down.

### Testing

- Unit (`consult` package Go test): `BuildPrompt` with empty principles is byte-identical to today's output (regression guard); with a principles string, the preamble appears before the context/request body and is not truncated by the history cap; principles + empty history still yields the preamble + request.
- Behavior note (not automated): claude consults are unchanged by construction (principles always ""); codex/agy consults now carry the preamble. This is stated in the plan's verification, not asserted by a running external CLI.

---

## File touch map (for plan sequencing)

**Backend (Go):**
- `pkg/wshrpc/wshrpctypes.go` — B (`ArchiveChannelCommand` + data struct).
- `pkg/wshrpc/wshserver/wshserver.go` — B (impl), D (consult call site: runtime-gated principles).
- `pkg/wstore/wstore_channel.go` — B (`MetaKey_Archived`).
- `pkg/consult/consult.go` — D (`OperatorPrinciples`, `BuildPrompt` param).
- Generated (via `task generate`, do not hand-edit): `wshclient.go`, `wshclientapi.ts`.

**Frontend (TS/TSX):**
- `jarvisderive.ts` — A (`pendingAskCount`), C (`buildFleetSnapshot` dismiss logic). **A and C both edit this file → same task or sequenced.**
- `navrail.tsx` — A (badge).
- `cockpitsurface.tsx` — A (counter).
- `channelsstore.ts` — B (`archiveChannel`).
- `channelrail.tsx` — B (partition + affordance).
- `channelderive.ts` — B (`partitionChannels`).
- `channelactions.ts` — C (`dismissWorker`).
- `channelsprimitives.tsx` — C (`WorkerRow` menu).
- `channelssurface.tsx` — B (rail prop), C (thread dismiss callback). **B and C both edit this file → sequenced.**

**Conflict summary:** `jarvisderive.ts` (A+C) and `channelssurface.tsx` (B+C) are shared. Backend `wshserver.go` (B+D). The plan must sequence tasks that share a file (one subagent per task, review between); file-disjoint tasks may parallelize. Task B's FE work depends on B's regenerated `RpcApi.ArchiveChannelCommand`.

## Verification conventions (all items)

- Typecheck: `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean, exit 0; `npx tsc` stack-overflows here).
- FE unit: `npx vitest run frontend/app/view/agents/<file>.test.ts`.
- Go unit: `go test ./pkg/consult/` (D).
- Backend build: `task build:backend`; regen: `task generate` (B).
- Visual: `tail -f /dev/null | task dev` running, capture via `node scripts/cdp-shot.mjs`; never `Page.reload`. If the dev app is not running, mark the visual step unverified rather than claiming it passed.
- Do not commit; the user batches commits and approves them.
