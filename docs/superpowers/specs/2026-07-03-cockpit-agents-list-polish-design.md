# Cockpit Agents-list polish (A + B + D) — Design

Date: 2026-07-03
Surface: **Agents list / Cockpit surface** (`frontend/app/view/agents/cockpitsurface.tsx` → `AgentRow`)

## Problem

The populated Cockpit surface (verified live over CDP with the `mixed` fixture) works but has
concrete rough edges on the asking cards:

1. **The ask question renders twice.** The pinned amber "asking band" shows
   `questions[0].question` (`agentrow.tsx:339`) and the `AnswerBar` renders `question.question`
   again above the options (`answerbar.tsx:69`). On single-question asks they land back-to-back
   (seen on `loom`, `obsidian`).
2. **The question is hard to read.** The band uses `--color-ask-question` (`#eddcb8`, pale amber,
   13px medium) while the AnswerBar copy is bold `text-primary` — two different treatments for the
   same text, and the pale band copy is the low-contrast one the user flagged.
3. **Every asking card force-mounts a full composer** (`showComposer = composerOpen || asking`),
   adding a textarea + Send + resize to all asking cards and dominating vertical space.
4. **Fixed 280px card height** regardless of content — short asks reserve the same height as rich
   ones, leaving dead space.
5. Minor: a **horizontal-scrollbar artifact** under the composer; **hardcoded brand hexes**
   inline (`bg-[#d97757]`, `bg-[#96aacd]`); a **bare empty state**.

## Goals

Polish the asking-card experience with a tight, reviewable, frontend-only diff:

- **A. Redundancy + readability** — one readable copy of the question; consistent submit hint.
- **B. Density + layout** — composer collapsed by default; content-fit card height; kill the
  horizontal-overflow artifact.
- **D. Cleanup** — tokenize brand hexes; enrich the empty state.

## Non-goals

- The **card-grid redesign** (2-column layout, hierarchy by urgency, one-screen density) — a
  separate brainstorm the user has flagged; explicitly out of scope here.
- Motion cluster (enter/leave animation, steady attention cue) beyond what content-fit height
  needs to not jank.
- Any backend / RPC / `task generate` change. This is pure frontend projection + styling.

## Locked decisions

- **Keep the pinned band as the single question source; drop `AnswerBar`'s copy in the card only.**
  The band sits above the scroll region, so the question stays visible as the feed scrolls —
  sinking it below the feed would be worse for asks.
- **Composer collapses by default on asking cards** (slim `+ message… R` row like working cards),
  expanding on `r` / click. **Reply-suggestion chips stay visible even when collapsed.**
- **Content-fit height + max cap.** Cards size to content up to a max; the feed scrolls past it; a
  manual resize still pins an explicit height.

## Design

### A. Redundancy + readability

**`AnswerBar` gets an opt-in `hideQuestion?: boolean` (default `false`).**
- Threaded into `QuestionGroup`; when set, `QuestionGroup` skips the `header` + `question.question`
  block and renders only the options.
- `agentrow.tsx` passes `hideQuestion` — the band owns the question there.
- **Channels is unchanged**: `channelssurface.tsx:187` keeps the default (`false`), so its worker
  rows still render the question (they have no band). This is the reason the dedup is a prop, not a
  deletion.

**The band becomes the single, readable question source.**
- Sync to the active question: render `questions[clamp(activeQuestion, 0, n-1)].question` instead of
  always `questions[0]`, so for multi-question asks the band matches the AnswerBar tab. `agentrow`
  already receives `activeQuestion?: number`.
- Readability: band question → **14px, semibold**; raise `--color-ask-question` contrast.

**`--color-ask-question` contrast raised in both sources of truth:**
- Static token in `frontend/tailwindsetup.css` (`#eddcb8` → a brighter warm cream, keeping the warm
  asking identity but clearly readable on `--color-lane-asking` `#14130e`).
- Runtime theme derivation in `frontend/app/view/agents/themes.ts:214`
  (`lighten(p.warning, 0.42)` → a higher factor) so the fix holds under every theme, not just the
  default Midnight no-op.

**Unified submit hint via a pure helper.**
- New `answerHint(questions, selections)` in `agentsviewmodel.ts` returns one muted hint string so a
  single consistent line always renders in the AnswerBar footer:
  - all single-select, one question → `"Press 1–9 or click to answer"` (drop `"1–9"` when the
    `numbered` prop is false, i.e. Channels).
  - single-select, multiple questions → `"N/M answered"`.
  - any multi-select → append `" · press Enter to submit"`.
- Unit-tested in `agentsviewmodel.test.ts` (no render harness needed).

### B. Density + layout

**Composer collapsed by default on asking cards.**
- `showComposer = composerOpen` (drop the `|| asking`). Asking cards then fall through to the
  existing slim `+ message… R` affordance.
- **Extract the reply-suggestion chips** out of the `showComposer` block so they render whenever
  `asking && agent.ask?.replySuggestions?.length`, above the composer row, collapsed or not.
- A reply-suggestion click must work while collapsed: `onOpenComposer()` then
  `requestAnimationFrame(() => composerRef.current?.fill(s))` (the composer/textarea only mounts
  when expanded — mirror the `r`-key open-then-focus path).

**Content-fit card height.**
- Constants: `MIN_CARD_HEIGHT = 120`, `MAX_CARD_HEIGHT = 420`. Keep `DEFAULT_CARD_HEIGHT = 280` only
  as the resize-drag starting fallback.
- `Reorder.Item` style: when `height` is set (user resized) use `height: ${height}px` as today;
  otherwise `height: auto` + `minHeight: MIN_CARD_HEIGHT` + `maxHeight: MAX_CARD_HEIGHT`.
- The card stays `flex flex-col overflow-hidden`; the scroll body stays `flex-1 min-h-0
  overflow-y-auto`, so it grows to content up to the cap, then scrolls.
- Switch the item from `layout` to **`layout="position"`** so reorder still animates position but
  height changes from streaming transcripts don't animate (jank guard). Verify live; if position-only
  looks wrong, fall back to a reduced fixed default.

**Horizontal-overflow artifact.**
- Investigate live via CDP (`scrollWidth` vs `clientWidth` down the card subtree) and constrain the
  offending child (`min-w-0` / `overflow-x-hidden`), and confirm the feed's first line isn't clipped
  at rest. Verification-driven; no speculative change.

### D. Cleanup

**Tokenize brand hexes.**
- Add to `tailwindsetup.css` `@theme`: `--color-provider-claude: #d97757;`,
  `--color-provider-codex: #96aacd;`.
- Replace `PROVIDER_DOT` in `cockpitsurface.tsx:74` (`bg-[#d97757]` → `bg-provider-claude`,
  `bg-[#96aacd]` → `bg-provider-codex`). These are brand identity, not theme-derived, so they are
  **not** added to `themes.ts`. (grep confirms these hexes appear only in `cockpitsurface.tsx`.)

**Empty-state CTA.**
- Keep the emoji + copy; add a `+ New agent` button that opens the launcher
  (`globalStore.set(model.newAgentOpenAtom, true)`).

## Files touched

| File | Change |
|---|---|
| `frontend/app/view/agents/answerbar.tsx` | `hideQuestion` prop → `QuestionGroup`; footer hint via `answerHint` |
| `frontend/app/view/agents/agentrow.tsx` | band = single question source (active-q sync, 14px/semibold); pass `hideQuestion`; composer collapse + extracted reply chips; content-fit height + `layout="position"` |
| `frontend/app/view/agents/agentsviewmodel.ts` | new pure `answerHint()` |
| `frontend/app/view/agents/agentsviewmodel.test.ts` | `answerHint` unit tests |
| `frontend/app/view/agents/cockpitsurface.tsx` | tokenized `PROVIDER_DOT`; empty-state `+ New agent` CTA |
| `frontend/tailwindsetup.css` | brighter `--color-ask-question`; `--color-provider-claude/codex` |
| `frontend/app/view/agents/themes.ts` | higher `--color-ask-question` lighten factor |
| `frontend/app/view/agents/agentcomposer.tsx` | only if the overflow artifact traces here |

## Testing / verification

- **Unit:** `answerHint` cases (single/multi question × single/multi select × numbered on/off) in
  `agentsviewmodel.test.ts`. `npx vitest run`.
- **Typecheck:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit` (baseline clean).
- **Visual (CDP):** re-inject fixtures (`node scripts/gen-cockpit-fixtures.mjs <scenario>` +
  reload) and screenshot before/after for: `mixed` (single question shown once, readable, composer
  collapsed), `all-asking` (density), `heavy` (content-fit + max-cap scroll), `empty` (CTA). Confirm
  no horizontal scrollbar and no feed top-clip at rest.
- Clear the fixture when done: `node scripts/gen-cockpit-fixtures.mjs --clear`.

## Commit note

Per repo convention this spec + its plan fold into the feature commit, not a separate docs-only
commit, and nothing is committed without explicit approval.
