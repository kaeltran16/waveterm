# Cursor-row inline composer (Agents tab)

Date: 2026-06-23
Scope: trivial (3 tightly-coupled files, reuses existing `AgentComposer`; no new component or data flow)

## Problem

The list+focus redesign (`6645a679`) made the Agents list a triage surface and removed
the per-agent inline composer. Free-form replies to a working agent now require opening
the focus view (`r` / `Enter` / double-click). For a keyboard-driven user firing quick
interjections at a working agent, that round-trip is friction.

## Decision

Render a single `AgentComposer` on the **cursor row only**, not on every row. One mounted
composer keeps the list scannable and avoids N textareas competing for focus, while making
a free-form reply reachable without a focus-view trip.

## Behavior

- The cursor row renders an `AgentComposer` below its narration, indented to align with the
  row body (`ml-[26px]`, matching `AnswerBar`).
- **Focus in:** press `r` (repurposed) or click the textarea. `r` focuses the inline composer
  on the cursor row instead of opening the focus view + reply.
- **Focus out:** `Esc` returns keyboard control to the list so `j`/`k`/`n` work again.
- **Send:** `Enter` sends, `Shift+Enter` newline — unchanged `AgentComposer` behavior. Text is
  sent to the agent's terminal block via `ControllerInputCommand`.
- **Focus view still reachable:** `Enter` on a non-asking row and double-click both still open
  it. Only the `r` shortcut changes destination.

### Why the composer can't auto-focus on cursor-landing

The container `onKeyDown` (`agents.tsx`) bails out when `e.target` is a `TEXTAREA`, so the
moment a textarea holds focus, `j`/`k`/`n`/`1-9` stop driving navigation and become typed
characters. If the composer auto-focused every time the cursor moved, the first `j` would
move the cursor and focus the new row's textarea; the next `j` would type "j" instead of
moving. Focus must therefore be handed over by a deliberate action (`r` or click) and handed
back by `Esc`.

## Defaulted decisions

1. **Hidden while the row is asking.** The composer shows for **working** and **recently-idle**
   cursor rows only. When the cursor row is mid-question, only the amber `AnswerBar` shows.
   Rationale: the composer sends raw PTY text via `ControllerInputCommand`, bypassing the
   structured ask-answer RPC; offering it beside the answer options invites a reply that does
   not satisfy the ask. The focus view keeps its always-on composer (unchanged).

2. **Draft is transient.** Only the cursor row's composer is mounted, so its draft is lost when
   the cursor moves away. Preserving per-agent drafts would require lifting `text` state out of
   `AgentComposer` keyed by agent id — disproportionate for a quick-interjection feature. YAGNI;
   revisit if it bites.

## Implementation

Three files. Build on the current working-tree state (these files already have uncommitted
edits from prior agents work — do not touch unrelated changes).

### 1. `frontend/app/view/agents/agentcomposer.tsx`

- Add optional prop `onEscape?: () => void`.
- In the textarea `onKeyDown`, add an `Escape` branch gated on `onEscape` being present:
  when set, `preventDefault()` and call `onEscape()`. Leaving it gated means the focus view and
  idle-section composers (no `onEscape`) keep their current behavior — `Escape` is a no-op there,
  not a scope-creeping change.

### 2. `frontend/app/view/agents/agentrow.tsx`

- Import `AgentComposer`.
- Add prop `onComposerEscape?: () => void`.
- After the `asking && hasQuestions` `AnswerBar` block, render when `isCursor && !asking`:
  - Wrapper `div` with `mt-2 ml-[26px]` that stops `onClick` and `onDoubleClick` propagation
    (so selecting text by double-click does not bubble to the row's `onDoubleClick` → open focus
    view, and clicking does not re-trigger row handlers).
  - `<AgentComposer blockId={agent.blockId} placeholder={`message ${agent.name}…`} onEscape={onComposerEscape} />`.
  - Pass a className to strip the default bottom-bar look (`border-t`, full padding) so it sits
    inline cleanly; finalize exact classes during implementation.

### 3. `frontend/app/view/agents/agents.tsx`

- Repurpose the `r` handler: instead of `openFocus(cursorId, true)`, focus the cursor row's
  textarea — only when the cursor row is not asking. Reuse the existing `data-agent-id` hook
  (the same attribute `scrollToPulse` already queries):
  `document.querySelector(`[data-agent-id="${cursorId}"] textarea`)?.focus()`.
- Pass `onComposerEscape={() => containerRef.current?.focus()}` to `AgentRow`. Refocusing the
  container (not just blurring the textarea) is required: a bare blur drops focus to `<body>`,
  where the container's div-level `onKeyDown` never fires, leaving `j`/`k` dead until a click.

## Edge cases

- Cursor row is asking → no composer; `r` is a no-op (or leave `r` doing nothing while asking).
- Cursor row is recently-idle → composer shows (consistent with focus view / idle section, which
  already allow messaging a finished agent).
- Empty cursor (no rows) → nothing renders; `r` no-ops on the existing `if (!cur) return` paths.
- Draft text in the composer when the user `Esc`s out then navigates away → lost (transient, by
  decision 2).

## Testing

- Manual / CDP: with a working agent at the cursor, press `r` → textarea focuses; type + `Enter`
  → message reaches the agent terminal; `Esc` → `j`/`k` navigation resumes.
- Confirm an asking cursor row shows the `AnswerBar` and no composer.
- Confirm `Enter` (non-asking) and double-click still open the focus view.
- No new unit tests warranted: behavior is DOM-focus/keyboard wiring, covered by manual
  verification; `AgentComposer` send logic is unchanged.
