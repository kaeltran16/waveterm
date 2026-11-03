# Next feature for Arc: exploration result

Date: 2026-11-03. Source: the `next-feature` brainstorm (questions skipped; every part confirmed).

## Intent

Find a feature backed by how Arc is actually used (prompts, run records), not a list read off the code.

## Decision

Build no new feature now. Collision guard, the one queued follow-up, is held on measured rarity
(recorded in `docs/deferred.md` "Collision guard for chats sharing one checkout" and mirrored in
`docs/open-issues.md`, commit `c37aa804`). If work is wanted, the one actionable backlog row is the
`final-stage` CDP scenario Part B flake (`docs/open-issues.md` §1); it is a diagnosis task, not a design.

## What the decision stands on

- **Prompts.** 1,016 human prompts in Claude Code chats on this repo since 2026-10-13, grepped for friction
  (why, can't, again, slow, wish). Almost every hit is a one-off bug or layout complaint a later commit fixed
  (shell output, resource manager layout shift, run status, review modal). Exploration prompts recur
  (10-20, 10-28, four on 10-30, 11-03) and have come back thin. The two follow-ups the owner named are
  collision guard (10-27/10-28) and cross-run awareness (10-16).
- **Collision guard, measured.** 1,424 Edit/Write calls from 177 chats in the main checkout, 2026-10-03 to
  11-03, worktree paths excluded: 31 edits hit a file another chat edited in the previous 30 minutes, from
  10 chat pairs on 5 days. 26 of the 31 were `scripts/cdp/scenarios.mjs`, since split per area by
  `085e43c8`. Since 10-20: 11 edits, 4 pairs, 2 days, 7 of them on `scenarios.mjs`.
- **Cross-run awareness.** Recorded as not pursued in `docs/orchestrator-redesign-flaws.md`: a lead cannot
  see other runs' plans, and `landConflictLine` names the land conflict at run-finished, so an overlap costs
  one resolve. Not raised again since 10-16.
- **Backlog.** `docs/open-issues.md` has one actionable row (the flake above); every held row names a
  trigger that has not fired.

## Left to the builder

Nothing: no feature was chosen.
