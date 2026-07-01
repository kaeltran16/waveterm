# Cockpit card — real task list + diff stats

Replaces the two fabricated card affordances (`placeholderTasks`, `placeholderDiffStats`
in `agentsviewmodel.ts`) with real data. Closes the "Cockpit card — fabricated data"
entry in `docs/deferred.md`.

## Problem

The cockpit live-agent card (`agentrow.tsx`) renders a task chip (`done/total` + popover)
and a diff-stats button (`+adds / −dels`) from **deterministic pseudo data** seeded off the
agent id. Live agents show believable-but-fake numbers. Two documented seams in
`agentsviewmodel.ts` mark the replacement points.

## Design

Two independent data paths feed two new keyed atoms, consumed by `agentrow.tsx`. Neither
touches the card's layout or the `taskProgress` derivation (already real).

### 1. Task list — pure projection, no new RPC

The raw TodoWrite lines are already streamed into `livetranscript.ts` (it accumulates the
JSONL `lines` buffer, then projects it) — they're just discarded (TodoWrite collapses into a
generic action). We stop discarding them.

- Extend `TranscriptProjector` (`transcriptregistry.ts`) with an optional
  `extractTasks?(lines: string[]): CardTask[] | undefined`.
- New pure fn in `transcriptprojection.ts`: scan JSONL for the **last** `tool_use` block with
  `name === "TodoWrite"`; map `input.todos[]` `{content, status}` →
  `CardTask{ text: content, done: status === "completed" }`. Undefined when no TodoWrite exists.
  Registered on the **claude** projector only.
- Codex omits `extractTasks` (v1). Codex uses `update_plan`, a separate smaller follow-on —
  its cards stay task-less (chip hidden), consistent with the format-specific projector pattern.
- New atom `tasksByIdAtom: Record<string, CardTask[]>` in `livetranscript.ts`, set inside the
  **existing** stream loop from the same `lines` buffer (only when the extractor returns a list).

### 2. Diff stats — new `cardgitstore.ts`

The card grid renders every streamable agent, so real per-card git means one
`GitChangesCommand` per agent, refreshed as it works. Mirrors `railstore.ts` (which does the
same for the single focused agent).

- `diffStatsByIdAtom: Record<string, DiffStats>`.
- Pure `diffStatsFromChanges(changes: GitChanges): DiffStats` = `{ files: files.length, adds, dels }`.
- `refreshCardGit(id, transcriptPath, blockId)`: resolve cwd (`agentcwdresolve`) →
  `GitChangesCommand({cwd})` → derive `DiffStats` → set the atom. Not-a-repo / no-cwd / clean
  (`files === 0`) → **delete** the id from the map (button hides). Stale-guarded per id (latest
  load wins); skips when a load for that id is already in flight.
- Driver co-located with the transcript-stream effect in `cockpitsurface.tsx`:
  - **enter** the streamable set → one initial `refreshCardGit`.
  - `lastActivityByIdAtom[id]` **advances** → `refreshCardGit` debounced **4s** (coalescing;
    git runs only while the agent is actively narrating, idles when quiet).
  - **leave** the set → clear its debounce timer + drop the id from `diffStatsByIdAtom`.

### 3. Wire the card + delete fabrication

- `agentrow.tsx`: `diff` ← `useAtomValue(diffStatsByIdAtom)[agent.id]`;
  `tasks` ← `useAtomValue(tasksByIdAtom)[agent.id]`. Keep `taskProgress`.
- Delete `placeholderDiffStats`, `placeholderTasks`, `PLACEHOLDER_TASK_POOL`, `hashId` from
  `agentsviewmodel.ts` and their tests. Keep `DiffStats`, `CardTask`, `taskProgress`.

### Empty states

- Diff button renders only when stats exist **and** `files > 0` (a clean repo shows nothing —
  matches today's varying `hasChanges`).
- Task chip renders only when a TodoWrite list exists (`tasks?.length`).

## Testing

- Unit (`transcriptprojection.test.ts`): `extractTasks` — none → undefined; multiple TodoWrites
  → last wins; `completed` → `done:true`, other statuses → `done:false`; empty `todos` → `[]`.
- Unit (`gitstatus.test.ts` or `cardgitstore` sibling test): `diffStatsFromChanges`.
- Remove `placeholderDiffStats` / `placeholderTasks` tests from `agentsviewmodel.test.ts`.
- The driver's debounce/stale/lifecycle behavior is verified via CDP against the live dev app
  (no render harness exists — CLAUDE.md); the pure derivations carry the unit coverage.

## Implementation

1. `transcriptprojection.ts`: add pure `extractTasks(lines)`; export. TDD (tests first).
2. `transcriptregistry.ts`: add optional `extractTasks` to `TranscriptProjector`; wire it on the
   claude projector.
3. `livetranscript.ts`: add `tasksByIdAtom`; in the stream loop, after projecting entries, call
   `projectorFor(agent, path).extractTasks?.(lines)` and set the atom when defined.
4. New `cardgitstore.ts`: `diffStatsByIdAtom`, pure `diffStatsFromChanges` (TDD), `refreshCardGit`
   (cwd-resolve → RPC → derive → set/drop, stale + in-flight guarded).
5. `cockpitsurface.tsx`: add the git driver (enter → initial; activity-advance → 4s debounced;
   leave → clear timer + drop) co-located with the transcript-stream effect; teardown on unmount.
6. `agentrow.tsx`: consume the two atoms; drop the placeholder imports.
7. `agentsviewmodel.ts` + `agentsviewmodel.test.ts`: delete the placeholder fns + tests; keep
   `DiffStats`, `CardTask`, `taskProgress`.
8. Gates: `npx vitest run`, typecheck (`node --stack-size=4000 node_modules/typescript/lib/tsc.js
   --noEmit`), then CDP visual pass on the live dev app.
9. Update `docs/deferred.md`: strike the "Cockpit card — fabricated data" entry (resolved).
