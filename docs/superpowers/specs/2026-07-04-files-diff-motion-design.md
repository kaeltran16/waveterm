# Files / Diff motion — design spec

Date: 2026-07-04
Surface: **Files / Diff** (`filessurface.tsx` + `reviewsurface.tsx`)
Tracker row: `docs/superpowers/animation-revamp-tracker.md` → "Files / Diff"

## Goal

Bring the Files/Diff surface onto the shared motion layer. Both modes are in scope:
**Browse** (changed-file list → diff pane) and **Review** (staged accept/reject of hunks).
Every moment maps to the existing 8-moment vocabulary and the shared token source
(`frontend/app/element/motiontokens.ts` + `tailwindsetup.css`) — **no new durations,
eases, or keyframes**. Functional-first: each animation makes a git or review state
change more legible; nothing is decorative-only.

## Reused foundation (no new primitives)

| Primitive | Source | Used for |
|---|---|---|
| `cardVariants` (opacity+scale) | `motiontokens.ts` | file-row entrance/exit (m1), applied-screen reveal |
| `AnimatePresence mode="popLayout"` + `layout` + `initial={false}` | Framer | file-list reflow (m2) |
| no-cascade guard (`computeEntrances`) | **extracted to `motiontokens.ts`** (see below) | silent source-switch, animate only later arrivals |
| `settle` one-shot + `useSettle(done)` | `tailwindsetup.css` / channels pattern | hunk + file decision settle (m4) |
| `MOTION.durMicro` opacity fade | `motiontokens.ts` | diff/hunk pane crossfade on file switch (m6-as-reveal) |
| `MotionConfig reducedMotion="user"` | Framer | reduced-motion compliance |

## Moment map

### Browse mode (`filessurface.tsx`)

1. **File-list entrance / exit / reflow (m1 + m2).** Wrap the `changes.files` map in
   `<AnimatePresence mode="popLayout" initial={false}>`; each `FileRow` becomes a
   `motion.div` with `layout`, `variants={cardVariants}`, `animate="animate"`,
   `exit="exit"`, and `initial={entranceIds.has(path) ? "initial" : false}`. As the
   focused agent edits its worktree, changed files appear / vanish / reorder and animate.
2. **No-cascade guard keyed on source identity.** Key = the `FilesSource` identity string
   (`agent:<id>` or `project:<name>`). Switching source swaps the whole list and must
   present it silently; only file paths that arrive *after* the list has settled on the
   current source animate in. Held in a `useRef<EntranceState>` recomputed each render,
   exactly like `channelssurface.tsx`.
3. **Diff-pane crossfade on file switch (m6-as-reveal).** The `CenterPane` content is
   wrapped in a keyed `motion.div` (`key={selected}`), opacity-only, `MOTION.durMicro`.
   Whole-container fade — **never per-line** (per-line would strobe and violates the
   "layout only on containers; transform/opacity only" perf rule).
4. **FileRow selection micro.** Add `transition-colors` so the `bg-surface-selected` swap
   is a smooth micro instead of a hard flip.

### Review mode (`reviewsurface.tsx`)

5. **Hunk decision settle (m4).** When a hunk transitions pending→decided, play the
   `settle` one-shot on its `HunkBlock` via the shared `useSettle` hook keyed on the
   decision going non-null. Smooth the left-rail color and the reject-dim (opacity 0.5)
   with `transition` instead of an instant swap.
6. **File-verdict completion settle (m4).** When a file becomes fully accept/reject,
   `settle` the `FileHeader` as its verdict flips to "✓ File kept" / "✕ File discarded".
7. **Progress-bar width (m7 micro).** Add CSS `transition-[width]` (`MOTION.durMacro`,
   `easeFluid`) to the accept/reject fill segments so the bar grows as decisions
   accumulate — functional progress feedback.
8. **Hunk-pane crossfade on file switch.** Reuse moment 3's keyed opacity fade for the
   selected file's hunk list (`key={sel.path}`).
9. **"Review applied" reveal (m1).** The applied summary screen mounts with the
   `cardVariants` fade+scale signature.

### Cross-cutting

- `<MotionConfig reducedMotion="user">` wraps both surfaces; existing CSS loops keep
  `motion-reduce:animate-none`.
- The Review-mode **file list** (`reviewsurface.tsx` left column) loads once per worktree
  (`loadReview`), so it presents with `initial={false}` — selection micro only, no
  entrance cascade. Its rows do not stream in.

## Architectural change: extract the no-cascade guard

`computeEntrances` / `initialEntranceState` currently live in `channelsmotion.ts` keyed on
`channelId`. This surface is the **third** consumer (Channels shipped, Files here,
Activity slated in the tracker). Per single-source-of-truth and the north star ("if a
surface needs a new primitive, add it to the token module first"):

- **Generalize** into `motiontokens.ts`: `computeEntrances(prev, key, ids)` and
  `initialEntranceState()`, where `EntranceState` uses a generic `key: string | undefined`
  field (renamed from `channelId`).
- **Refactor** `channelsmotion.ts` to re-export the shared helper, keeping
  `channelssurface.tsx` untouched at the call site (it still imports from
  `./channelsmotion`).
- The full guard behavior gets coverage in `motiontokens.test.ts` (keyed on `.key`).
  `channelsmotion.test.ts` stays as a regression test on the re-export path, but its two
  `state.channelId` assertions (lines 12, 20) must be updated to `state.key` — the field
  rename is the one non-mechanical edit to shipped Channels code.

## Files touched

| File | Change |
|---|---|
| `frontend/app/element/motiontokens.ts` | Add generic `computeEntrances` + `initialEntranceState` + `EntranceState`. |
| `frontend/app/element/motiontokens.test.ts` | Cover the generic guard (first-mount silent, key-switch silent, later-arrival animates). |
| `frontend/app/view/agents/channelsmotion.ts` | Re-export the shared guard from `motiontokens.ts`. |
| `frontend/app/view/agents/channelsmotion.test.ts` | Update two `state.channelId` assertions (lines 12, 20) to `state.key`. |
| `frontend/app/view/agents/filesmotion.ts` (new) | The `FilesSource` → guard-key string derivation (`agent:<id>` / `project:<name>`). Files has no instant-search case, so no `reflowProps` helper is needed — rows spread `cardVariants` directly. |
| `frontend/app/view/agents/filesmotion.test.ts` (new) | Cover the source→key derivation (agent, project, null). |
| `frontend/app/view/agents/filessurface.tsx` | Browse list AnimatePresence + no-cascade guard, diff crossfade, FileRow micro, `MotionConfig`. |
| `frontend/app/view/agents/reviewsurface.tsx` | Hunk/file settle, progress-bar transition, hunk-pane crossfade, applied-screen reveal, `MotionConfig`. |

## Testing

- **Unit (vitest):** the extracted guard in `motiontokens.test.ts`; the `filesmotion.ts`
  source→key derivation in `filesmotion.test.ts`; `channelsmotion.test.ts` stays green
  (regression guard on the refactor).
- **No render harness** for the cockpit — visual verification via the live dev app over
  CDP (`node scripts/cdp-shot.mjs`), injecting a populated worktree if needed. Confirm:
  source switch does **not** cascade; a new changed file fades in; fast file-clicking does
  not feel laggy; reduced-motion disables entrances and settles.

## Out of scope

- Browse-mode `+adds/−dels` header count rolling (not a state-legibility win — YAGNI).
- Mode-switch (Browse↔Review) full-pane transition beyond the keyed content crossfade.
- Any change to diff parsing, git status, or review apply logic.
- The force-graph / Memory / Usage / Activity surfaces (separate tracker rows).

## References

- Tracker: `docs/superpowers/animation-revamp-tracker.md`
- Cockpit motion system: `docs/superpowers/specs/2026-07-03-cockpit-motion-system-design.md`
- Channels motion (source of the no-cascade + settle patterns): `docs/superpowers/specs/2026-07-04-channels-motion-design.md`
- Sessions motion (list reflow reference): `docs/superpowers/specs/2026-07-03-sessions-motion-design.md`
