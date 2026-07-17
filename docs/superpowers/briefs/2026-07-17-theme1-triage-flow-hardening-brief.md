# Design brief — Theme 1: Triage-flow hardening

**Date:** 2026-07-17
**Status:** SHIPPED 2026-07-17 — all five fixes (T1, T2, T4, C1, C2) implemented; T3 declined. Plan:
`docs/superpowers/plans/2026-07-17-theme1-triage-flow-hardening.md`.
**Source:** Net-new improvement scan, `docs/deferred.md` §"Net-new improvement scan (2026-07-17)" Theme 1
**Handoff:** This brief is a resolved design-decision record, not the formal spec. A downstream agent
expands it into `docs/superpowers/specs/` + `docs/superpowers/plans/` and implements it.

## Problem

The cockpit's flagship promise is "answer agent asks in place" and triage a fleet by keyboard. Several
confirmed dead-ends and dead affordances undercut that promise in the core flow. This slice fixes five of
them in one pass; one (T3) was reviewed and deliberately declined.

## Scope (five shipping fixes)

### T1 — Second ask from the same agent can't be answered in place (highest impact)

- **Root cause:** `sentIdsAtom` (`frontend/app/view/agents/agents.tsx:83`) and the answer-draft atoms
  `answerSelAtom`/`answerTextAtom`/`answerTabAtom` (`agents.tsx:74-82`) are keyed by **agentId** and never
  cleared. `submitAnswer` early-returns when `sent.has(agentId)` (`agents.tsx:164-166`) and marks
  `sent.add(agentId)` (`:175`); `AnswerBar` renders a frozen "✓ Answered" when its `sent` prop is true
  (`answerbar.tsx:232-247`). So after the first answer, that agent's panel is dead for the session and
  submit is silently blocked — forcing a drop into the terminal TUI.
- **Identity to use:** `AgentAskData.askid` (`frontend/types/gotypes.d.ts:54`) is a stable per-ask id. Do
  **not** use `ask.oref` — that is the *block* oref (`agentaskstore.ts:8-9,33`), reused across successive
  asks from the same block, so it cannot distinguish asks.
- **Resolved design:** scope "answered" and answer-draft state to the current `askid`.
  - `submitAnswer` checks/marks `sent.has(ask.askid)` instead of `agentId`.
  - `AnswerBar`'s `sent` prop derives from `sent.has(agent.ask.askid)`.
  - Reset the agent's `answerSel`/`answerText`/`answerTab` entries when its current `askid` changes, so a
    fresh ask starts with clean drafts (also eliminates stale-draft leakage into a new ask).
- **Acceptance:** answering ask-1 does not lock ask-2 from the same agent; the new ask renders its own
  live question group (not a stale "Answered"); a re-shown identical-text ask with a new `askid` is
  answerable. Unit test the per-`askid` isolation (`agentsviewmodel.test.ts` already exercises `askid`).

### T2 — Answering doesn't advance to the next waiting ask

- **Root cause:** the Enter submit branch does no cursor move (`usecockpitkeyboard.ts:91-98`); `submitAnswer`
  does not advance (`agents.tsx:161-176`); reaching the next ask requires a separate `n` press; there is no
  mouse "jump to next ask" (header "N need you" is static text, `cockpitsurface.tsx:370-377`).
- **Resolved design:** on a *successful* submit (validation passed and the ask actually fired), auto-jump
  the cursor to the next asking agent (`nextAskId`); stay put when none. Fold the advance into
  `submitAnswer`'s success path so both the keyboard (Enter) and mouse submit paths get it.
- **Acceptance:** with N asking agents, submitting one moves the cursor to the next asking agent; the last
  one leaves the cursor in place. Pure next-ask selection is unit-testable.

### T4 — Idle reply box silently swallows messages when the agent has no live terminal block

- **Root cause:** `IdleSection` mounts `AgentComposer` with `blockId={a.blockId}` unconditionally
  (`idlesection.tsx:60`); `AgentComposer.send()` no-ops on missing `blockId` (`agentcomposer.tsx:47-56`)
  and Enter calls `send()` regardless (`:63-71`), while only the Send button is `disabled` (`:78-79`). A
  keyboard user hits a silent dead-end.
- **Resolved design (chosen: hide-when-no-block):** do not render the composer for a block-less idle
  agent. As a defense-in-depth safety, gate the Enter handler in `AgentComposer` so it never calls `send()`
  when `blockId` is null (covers any other mount site).
- **Non-goal:** no "Resume to continue" affordance (deferred — Resume-from-idle needs a session-resume path
  the Sessions surface already owns; its own slice if wanted later).
- **Acceptance:** a block-less idle agent shows no reply input; Enter in a block-less composer does nothing
  and cannot silently drop text.

### C1 — New-agent modal advertises ⌘Enter but launch is mouse-only

- **Root cause:** the Launch button renders a `⌘Enter` chord hint (`newagentmodal.tsx:630`) but has only an
  `onClick` (`:625-631`); `ModalShell` wires only Escape (`modalshell.tsx:34-41`); the Task textarea has no
  autofocus (`newagentmodal.tsx:366-371`).
- **Resolved design:** wire Cmd/Ctrl+Enter in the modal to fire the same launch action as the button, gated
  by the identical validation; autofocus the Task textarea on open.
- **Acceptance:** Cmd/Ctrl+Enter launches when the form is valid and is a no-op when invalid; the Task field
  is focused on open.

### C2 — Cockpit rail "Recent activity" rows are dead

- **Root cause:** rows are non-interactive `<div>`s (`cockpitrail.tsx:167-190`); only the section's
  "View all →" link navigates. The Sessions merged feed's equivalent rows are clickable `<button>`s that
  jump to the entity (`sessionssurface.tsx:245-249`).
- **Resolved design:** make each Recent-activity row actionable → focus/scroll to that agent, reusing the
  cockpit's existing "activate an agent from a list" behavior (match whatever `setCursorId`/scroll-to /
  `openFocus` path the grid already uses so behavior is consistent).
- **Acceptance:** clicking a Recent-activity row focuses/scrolls to the referenced agent; rows are
  keyboard-focusable buttons.

## Declined (recorded, not built)

### T3 — Mouse single-select answers inject instantly and irreversibly

Reviewed 2026-07-17. **Declined.** A single click on a single-select option immediately injects the answer
into the live agent with no confirm/undo (`answerbar.tsx:257-271`), while the keyboard path is a guarded
two-step. The misclick hazard is real, but the fix (requiring a deliberate confirm on every answer) adds
friction to the most frequent action, and a delay-with-undo mechanism adds latency + a pending-send timer
for a low-frequency error. **Decision: keep instant-click; accept the misclick risk.** Revive only if
misclicks prove to be a real, recurring problem in use.

## Non-goals (whole slice)

- No ask **encode/delivery** backend changes — that is Theme 3 (A1, `DeliverAnswer` atomicity).
- No Resume-from-idle feature.
- No broad keyboard-parity work — that is the coherence-audit Pass A (F1/F2/F7), out of scope here.

## Testing

- **T1:** unit — answered/draft state is isolated per `askid` (answer ask-1 → ask-2 still answerable; drafts
  reset on askid change).
- **T2:** unit — next-asking-agent selection from an ordered roster (advance on submit; no-op when none).
- **T4:** unit/behavioral — no composer rendered for a null-`blockId` idle agent; Enter no-ops when block-less.
- **C1/C2:** light behavioral checks (Cmd/Ctrl+Enter fires launch under valid form; row click focuses agent).
- Visual verification per repo convention: CDP against the dev app (`node scripts/cdp-shot.mjs`,
  `scripts/inject-live-agents.mjs`) for the T1/T2 in-cockpit flow.

## Files in play

`frontend/app/view/agents/agents.tsx` (atoms + `submitAnswer`), `answerbar.tsx`, `usecockpitkeyboard.ts`,
`idlesection.tsx`, `agentcomposer.tsx`, `cockpitrail.tsx`, `newagentmodal.tsx`, `modalshell.tsx`,
`agentsviewmodel.ts`/`.test.ts` (askid-aware selectors + tests).
