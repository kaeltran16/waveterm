# Jarvis motion — Design

Date: 2026-09-11
Surface: **Jarvis tab** — the Brief (`frontend/app/view/jarvis/briefsurface.tsx`), the overlays it owns
(`briefsheet.tsx`, `briefprofileview.tsx`), and the avatar popup (`petpeek.tsx`, `petbubble.tsx`), on the
shared `frontend/app/element/motiontokens.ts`.

## Problem

Thirteen surfaces have had a motion pass: Cockpit, Sessions, Channels, Activity, Files, Memory, Settings,
Usage, the shared modals, the collapsible rail, Ctrl+P, the diff pane, the usage donut. **Jarvis never got
one.** What motion it has, it inherited by accident — wherever a shared element happened to carry it:
`ModalShell` gave `BriefPeek` a reveal, `PopoverReveal` gave the autonomy chip and the avatar popup theirs,
`GraphPeek` and `RecordBand` brought their own.

Everything else is a hard cut:

| Where | Hard cut today |
|---|---|
| All four Brief regions | rows enter and leave instantly |
| Brief header | `all clear` ↔ `N waiting` flips color and count with no transition |
| Brief body | `MoreControl` expands, initiative chunk detail, stale/error bands, skeleton → content |
| `briefsheet.tsx:307` | **no reveal at all** — a plain `absolute inset-0` with a hand-rolled scrim |
| `briefprofileview.tsx:211` | same — never adopted `ModalShell`, so it pops |
| `petpeek.tsx:494` | the "Since you looked" drawer snaps open and shut |
| Avatar popup | queue rows, the conditions block, and act → outcome resolution all cut |

The Brief is a **reading**: a snapshot of everything in flight, which you open to find out what moved.
Today it tells you *what is true* and says nothing about *what is new*, even though it already tracks the
difference.

## North star

**"What changed since you last looked."**

The Brief already keeps a server-acked visit cursor (`briefingCursorAtom` + `ackBriefingVisit()`), and the
avatar popup keeps its own launch-local pass marker (`petLastPassAtom`) behind a drawer labeled, in the
code's own words, "Since you looked". The concept is already latent in both halves of the tab; it has just
never been given a visual voice. Motion becomes the reading aid the Brief is already trying to be.

Every candidate animation faces the cockpit spec's rejection test — *does it make a state change more
legible?* If no, it does not ship.

## Locked decisions

- **Feel is inherited, not reinvented.** Fluid/calm from `motiontokens.ts`: `durMacro` 0.36s, `durMicro`
  0.14s, `durExit` 0.28s, `easeFluid` `[0.22, 1, 0.36, 1]`. No new feel, no second vocabulary.
- **Two tiers, explicitly bounded** (§1). Character motion stays; interface motion goes on tokens.
- **Mark on open, movement while watching** (§2). This is the load-bearing decision.
- **`BriefSheet` and `BriefProfileModal` migrate onto `ModalShell` wholesale**, which means extending a
  shared primitive. Accepted deliberately, with the blast radius priced into §8.
- **Framer (`motion/react`) is the default; CSS is the fallback** only for one-shot and perpetual ambient
  effects where Framer would be noise — the same split the cockpit spec drew.
- Only **two** new vocabulary items (§5). Everything else reuses existing tokens.

## 1. Two motion tiers

**Character tier — unchanged.** The hologram's own physics: `petmotion.ts`'s clocks (`ORBIT_MS` 48s,
`BREATH_MS` 4.2s, `UTTERANCE_MS` 2.2s, `RIPPLE_MS` 1.4s, `JOLT_MS` 520ms) and `petview.tsx:357`'s
drag/dock springs (`layout` 320/30, `scale` 420/26). These are deliberately springier than Fluid, and
deliberately driven by a rAF clock rather than DOM transitions, because they animate a creature and not a
control. The avatar spec (`2026-08-04-jarvis-avatar-design.md`) reasoned its way there register by
register, and it owns its own reduced-motion contract.

**This spec writes that boundary down so a later pass does not "correct" it onto Fluid.** A dragged
character that lands without a settle reads inert; a status row that overshoots reads broken. Same tab, two
right answers.

**Interface tier — on tokens.** Everything that frames the character and everything in the Brief: rows,
chips, bands, drawers, sheets, reveals, outcomes. Where the tiers touch — the peek shell and the speech
bubble — the interface tier wins, and both already do the right thing via `PopoverReveal`. `petbubble.tsx`
in particular already gets the subtle part right: it mounts `PopoverReveal` unconditionally and latches the
last utterance in state, so the exit animation actually has something to draw. Do not regress that.

## 2. North-star mechanism

`projectBriefing()` (`briefingmodel.ts:367`) gains a per-row **`newSinceVisit: boolean`**, comparing each
row's timestamp against `actualCursor`. Both are already in `BriefingModelInput` (`briefingmodel.ts:33`),
threaded from `briefingstore.ts:76` — so this is a derivation over data the model already receives, not new
plumbing. It also de-duplicates freshness: `ShippedRow.fresh` hand-rolls the same question at
`briefingmodel.ts:467`, so badge and motion end up reading one source.

Timestamps confirmed present on every marked row: `QueueRow.ts` (from `waitingsince`, nullable — a null
`ts` is never fresh), `EffortCardModel.updatedts`, `ActiveWorkRow.ts`.

Two treatments, and the split is the whole idea:

- **On open — a mark, not a movement.** A row new to you gets a one-shot mark on its **leading (left)
  edge**: an accent rule that appears at full strength and fades to nothing over roughly one macro beat.
  Colour and opacity only, on an element that already occupies its space — **zero layout, no wipe across
  the row's content, no transform**. The eye gets carried without the page moving while you are trying to
  read it, which is exactly what a staggered entrance cascade gets wrong — and it dissolves the cockpit
  spec's one hard prohibition ("no entrance cascade on tab open") instead of fighting it.
- **While you are watching — a real entrance.** `computeEntrances()` + `cardVariants` + `layout`, exactly
  as Channels, Files and Activity already do it. Anything that arrives live is news you watched arrive.

**The cap.** Above `FRESH_MARK_CAP` fresh rows in a region, the mark suppresses entirely and the existing
static "New" badge carries the signal alone. A week away must not light up the whole surface — at that
point every row is new, "new" stops discriminating, and the mark becomes decoration. Starting value 6,
settled against fixtures in the CDP pass.

**`behind` is excluded from the mark.** That region is *entirely* since-your-last-visit by construction
(`briefingmodel.ts:444` filters the delta back to `actualCursor`), so marking it would mark every row, and
its own region label already states the fact. The mark applies only where news sits mixed among old news:
**waiting, initiatives, sessions**.

## 3. The sixteen moments

Each passes the legibility test.

| # | Moment | Tool | Mechanic |
|---|---|---|---|
| 1 | **Fresh mark on open** | CSS | One-shot `freshMark` edge-wipe keyframe, driven by `newSinceVisit`, capped, `behind` excluded |
| 2 | **Live row enter/exit + reflow** | Framer | `computeEntrances` + `cardVariants` + `layout`, per region; survivors slide into the reflowed list |
| 3 | Waiting chip flip | Framer/CSS | Color cross-fade `success` ↔ `asking`; `RollingCount` (`view/agents/rollingcount.tsx`) for the number; the dot's generic Tailwind `animate-pulse` moves onto the cockpit's `pulseDot` vocabulary |
| 4 | `MoreControl` region expand | Framer | `paneReveal` |
| 5 | Initiative chunk detail expand | Framer | `paneReveal` |
| 6 | Stale / error band | Framer | `paneReveal` — the band pushes content down, so height belongs in the animation |
| 7 | Skeleton → content | Framer | Cross-fade replacing the cut; the `animate-pulse` skeletons themselves are unchanged |
| 8 | Composer turn + answer + "Drew on" band | Framer | Opacity-only entry, `initial={false}` so a restored conversation does not replay |
| 9 | **`BriefSheet` reveal** | Framer | `ModalShell variant="sheet"` + new `sheetPanel` slide-from-right |
| 10 | `BriefProfileModal` | Framer | Onto `ModalShell` (`variant="dialog"`); inherits `modalPanel`, deletes its hand-rolled scrim |
| 11 | **Modal stack** | — | Escape and focus reach only the topmost shell |
| 12 | Peek queue rows | Framer | Enter/exit + `layout`; `initial={false}` so opening the popup never cascades |
| 13 | Act resolution | Framer | `ActOutcome` (`petpeek.tsx:117`) fades in; a row whose act resolves it animates out. The in-place running caret on `ActButton` stays — it already solves the no-reflow problem its comment describes |
| 14 | "Since you looked" drawer | Framer | `paneReveal` at `petpeek.tsx:494` |
| 15 | Peek conditions block | Framer | Enter/leave as conditions appear and clear (`petpeek.tsx:405`) |
| 16 | Creature unread marker | CSS | Onto the shared pulse vocabulary |

## 4. The shared-primitive change

The riskiest part of the pass, so it is specified tightly.

### `ModalShell` gains one prop, not four

`variant: "dialog" | "sheet"`, defaulting to `"dialog"`, so **no existing consumer's appearance or layout
changes by construction.** `"sheet"` bundles the four differences between a centered dialog and a
right-pinned drawer:

| | `dialog` (today) | `sheet` |
|---|---|---|
| Backdrop layout | `flex justify-center` + `items-start pt-[11vh]` / `items-center p-10` | `items-stretch justify-end` |
| Backdrop position | `fixed inset-0 z-[70]` | `absolute inset-0 z-20` |
| Scrim | `bg-black/60 backdrop-blur-sm` | `bg-background/40`, no blur |
| Panel rounding | `rounded-[14px]` | `rounded-none` |

One named composition per shape, rather than four independent override props whose combinations nobody will
ever test. `cn` is `twMerge(clsx(...))` (`frontend/util/util.ts:446`), so consumers keep overriding width
and rounding through `className` exactly as they do today — the panel needs no new prop for that.

Two of those rows are **behavior**, not styling, and are the reason the migration is not cosmetic:
`absolute` + `z-20` keeps the sheet scoped inside the Brief's own box, so the app bar stays reachable and
surfaces stay switchable while it is open. A `fixed z-[70]` detail sheet would cover the cockpit chrome — a
regression in a keyboard-first app. `SheetShell` (`briefrunsheet.tsx:58`) keeps its `<aside>` interior; it
loses only the positioning and scrim that `ModalShell` now owns.

### `modalstack.ts` (new)

Every open `ModalShell` currently attaches its own `window` keydown listener, so **all** of them fire on
Escape. `briefpeekview.tsx:177` documents the consequence in the codebase's own words: two shells mounted
together "both claim Escape and both call takeModalFocus, so Escape would dismiss the confirm and the peek
behind it in one press." `BriefPeek` is already a `ModalShell` and the Brief deliberately stacks sheet →
record peek, so a third shell would walk straight into the failure mode someone already wrote a comment to
avoid.

A LIFO registry fixes it: `ModalShell` registers on open (`useId()`), unregisters on close, and its
Escape / `Cmd+Enter` handler early-returns unless it is topmost. The ordering logic is a pure function with
a test beside it, per repo convention; only the registry holder is module state.

**Unlike `variant`, this one does change behavior for all 13 consumers** — that is the point, since it is
the fix for a latent bug they all share. A single modal behaves identically (it is always topmost); only
stacked cases change, and they change from broken to correct. This, not the `variant` prop, is what §8's
regression pass exists to cover.

**Out of scope, deliberately:** `briefpeekview.tsx`'s existing
`open={recordId != null && pendingStatus == null}` yield-while-stacked workaround becomes unnecessary once
the stack lands, but unwinding it is unrelated refactoring. It goes in `docs/open-issues.md`, not in this
pass.

## 5. New vocabulary — two items

- **`sheetPanel`** in `motiontokens.ts`: lateral slide + fade for moment 9. `cardVariants` bans x/y because
  `Reorder.Item` owns that transform on cockpit cards; a sheet has no such owner, and a full-height drawer
  scaling from its center reads like a dialog rather than a layer arriving.
- **`freshMark`** `@keyframes` in `tailwindsetup.css` + a `@theme` period: the one-shot edge-wipe for
  moment 1. CSS because it is a fire-and-forget ambient effect on a row Framer is not otherwise driving —
  the same call the cockpit spec made for `breatheGlow` and `settle`.

Everything else reuses `cardVariants`, `paneReveal`, `popoverReveal`, `modalBackdrop`, `modalPanel`,
`composerReveal`, `computeEntrances`, `reflowProps` and `easeFluidCss`.

## 6. Edge cases

- **Reduced motion.** `ModalShell` already wraps `MotionConfig reducedMotion="user"`; the Brief and the
  peek get the same. Guard `freshMark` and the pulse with `@media (prefers-reduced-motion: reduce)`. The
  character tier keeps its own contract: no rotation, no platter spin, no breath, no surge; bloom stays.
- **No cascade, three ways.** `computeEntrances` reseeds silently when its key changes, so a whole-snapshot
  refresh cannot cascade; `initial={false}` on the peek's lists and the composer's turns; and moment 1 is
  non-layout by design, so even an uncapped mark could never jolt the page.
- **A refresh is not news.** `refreshBriefing()` (`briefingstore.ts:145`) replaces the whole snapshot but
  does **not** move the cursor — only a dwell-acked visit does (`ackBriefingVisit()`). So `newSinceVisit`
  is stable across a refresh, which is what makes the mark trustworthy rather than flickering. There is no
  background poll, so there is no strobe risk from polling either.
- **The mark fires once per row, not once per render.** Hold fired ids in a ref (the `computeEntrances`
  pattern), or the mark replays on every re-render — and the Brief re-renders on a `nowAtom` tick.
- **`layout` only on row containers**, never on streaming text; transform and opacity only.
- **Peek rows leave while the popup may close.** Moments 12–13 interact with `actLeavesPeek()`
  (`petpeek.tsx:70`): an act that closes the popup must not also try to animate its row out of a tree that
  is unmounting. Let the popup's own exit win.

## 7. Files touched

Frontend only. No `task generate`, no backend, no RPC, no SQL migration.

| File | Change |
|---|---|
| `frontend/app/element/motiontokens.ts` | Add `sheetPanel`. |
| `frontend/tailwindsetup.css` | Add `freshMark` `@keyframes` + its `@theme` period. |
| `frontend/app/modals/modalshell.tsx` | `variant` prop; register with the modal stack; gate Escape / `Cmd+Enter` on topmost. |
| `frontend/app/modals/modalstack.ts` + `.test.ts` | **New.** LIFO registry; pure ordering logic. |
| `frontend/app/view/jarvis/briefingmodel.ts` + `.test.ts` | Derive `newSinceVisit` (cap, `behind` exclusion, null `ts`); fold `ShippedRow.fresh` onto it. |
| `frontend/app/view/jarvis/briefsurface.tsx` | Moments 1–8. |
| `frontend/app/view/jarvis/briefsheet.tsx` | Moment 9: onto `ModalShell variant="sheet"`; drop the hand-rolled scrim. |
| `frontend/app/view/jarvis/briefrunsheet.tsx` | `SheetShell` loses its positioning + scrim to `ModalShell`; interior unchanged. |
| `frontend/app/view/jarvis/briefprofileview.tsx` | Moment 10: onto `ModalShell variant="dialog"`. |
| `frontend/app/view/jarvis/petpeek.tsx` | Moments 12–15. |
| `frontend/app/view/jarvis/petpeekmodel.ts` + `.test.ts` | Row identity for the peek's enter/exit, if the current shape does not already give stable keys. |
| `frontend/app/view/jarvis/petview.tsx` | Moment 16 only. Character motion untouched. |

### Sequencing

Twelve files and sixteen moments is too much for one landing. The plan phases it in three, each
independently verifiable and revertible:

1. **The primitive.** `modalstack.ts` + the `variant` prop + `sheetPanel`, then moments 9–11 (`BriefSheet`,
   `BriefProfileModal`) and the 13-consumer regression pass. This phase carries all the shared-code risk,
   so it lands and is verified before anything else is touched.
2. **The Brief.** `newSinceVisit` in the model with its tests, then moments 1–8.
3. **The avatar popup.** Moments 12–16.

Phase 1 first specifically because it is the only phase that can break surfaces outside Jarvis; bundling it
with cosmetic row motion would make a regression there expensive to bisect.

## 8. Verification

- **Unit (`npx vitest run`):** the `newSinceVisit` derivation — cap boundary, `behind` exclusion, null `ts`,
  and stability across a refresh that does not move the cursor; the modal-stack ordering (push/pop/topmost,
  out-of-order unregister).
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`. `npx tsc`
  stack-overflows on this repo, so `task check:ts` is not the check. Baseline is clean; any error is ours.
- **CDP (`task verify:ui`):** a new `jarvis-motion` scenario driving each moment against injected fixtures,
  plus `prefers-reduced-motion` emulation confirming transforms drop while opacity survives.
- **The migration's real cost — a regression pass over all 13 `ModalShell` consumers**, because that is what
  extending a shared primitive buys: `command-palette`, `shortcuts-cheatsheet`, `confirmdialog`,
  `userinputmodal`, `newagentmodal`, `newmemorymodal`, `newprojectmodal`, `routepicker`, `tooldetailmodal`,
  `codefinderpalette`, `briefpeekview`, `effortcreateform`, `newruncontrol`. Each still opens, closes on
  Escape, submits on `Cmd+Enter`, and hands focus back. Stacked cases (confirm over peek) verified
  explicitly — that is the bug the stack is meant to fix.

## 9. Non-goals

- Re-feeling the character tier onto Fluid. §1 is a boundary, not a deferral.
- Unwinding `briefpeekview.tsx`'s yield-while-stacked workaround (§4).
- New motion in `GraphPeek`, `RecordBand`, `BriefPeek`, `DagModal` or the autonomy chip — already on
  tokens, deliberately untouched.
- Decorative motion. The rejection test governs.
- Any change to what the Brief *shows*, its cursor semantics, or the ack dwell.

## 10. Open questions (resolve in the plan, not blocking)

- **`FRESH_MARK_CAP`** starts at 6; settle it against real fixture data in the CDP pass.
- **Does the avatar popup get a fresh mark of its own**, driven by `petLastPassAtom`? Default no: the drawer
  is already explicitly the "since you looked" container, so a mark inside it repeats the fact the label
  states. Revisit only if the popup's queue proves to mix new and old the way the Brief's does.
- **Peek row keys.** If `petpeekmodel.ts`'s rows lack stable identity across polls, moments 12–13 need a key
  derivation before they can animate; check before implementing.

## Commit note

Per repo convention this spec and its plan fold into the feature commit, not a separate docs-only commit.
Nothing is committed without explicit approval.
