# Agent surface Rendered mode: know what it is doing now — design

Date: 2026-11-10
Status: design
Scope: the Agent surface's Rendered mode (`frontend/app/view/agents/renderedview.tsx` and what it mounts),
`transcriptprojection.ts`, `agentcomposer.tsx`, `markdownmessage.tsx`, `scripts/cdp/scenarios-agent-rendered.mjs`
Builds on: `docs/superpowers/specs/2026-11-09-agent-rendered-view-design.md` (shipped 2026-11-10)
Prototype: `.superpowers/design/rendered-view-better/project/` — chosen boards `NowLine.dc.html`,
`NowLineStates.dc.html`, `WidthFill.dc.html`, `GapRoomy.dc.html`, `ComposerWriting.dc.html`. The other boards in
that folder are rejected options and are not built.

## Intent

Rendered mode shipped as a faithful log of the transcript, but you still flip back to the terminal to know what the
agent is doing right now and what this turn has done. Better means you can stay in Rendered for a whole session.

This round makes Rendered answer "what is it doing right now, and what has this turn done" at a glance, and fixes
three layout problems found along the way: the 920px column, the newest text crowding the composer, and a composer
too small to write a prompt in.

## Goals

- **A now line** between the timeline and the composer, always in view whatever the scroll position.
- **The timeline fills the center**, with only prose kept at a reading measure.
- **Room above the composer**, so the newest text never sits against it.
- **A writing composer** sized for prompts, with attach and an explicit Steer while the agent works.

## Non-goals

- Thinking blocks, subagent internals, plan-mode plans (the hidden-work gap).
- New tool-output renderers.
- Streaming text or closing the lag behind the terminal.
- Folding past turns, a pinned plan, plan sections, an outline gutter, a live tail card, status in the agent header
  (all weighed for the now line and dropped).
- Changing the composer in the cockpit's agent rows or the lead card.
- Moving the model and permission controls out of the agent header (the Rendered spec placed them there).

## Anti-goals

- The now line must never claim a state it cannot back: no frozen spinner verb after the turn ends.
- The prose cap must not change how `EndedTranscript` or the Sessions detail look, unless that is a deliberate,
  separate choice.

## The now line

See `NowLine.dc.html` and `NowLineStates.dc.html`.

One fixed line in a band about 40px tall at the bottom of the timeline area, above the composer. It hides while
`AskDock` or `PermissionBand` holds that slot (both show only while the agent waits on you, which is when nothing
runs). Its states:

| State | Reads |
|---|---|
| Working, between calls | the mirrored spinner, e.g. `✻ Undulating… (58s · ↓ 4.5k tokens · thinking with high effort)`, with the plan step and this turn's tool count on the right |
| Working, a call running | the mirrored spinner on the left, then the running call (verb, target), its elapsed time, the plan step and this turn's tool count on the right, e.g. `bash go test ./pkg/jarvis · 42s · plan 2/4 · 3 tools`. The line has no turn time of its own: the spinner's counts the turn |
| Turn ended | muted `done · 3m 10s · 12 tools` until you send the next prompt |
| Working, no spinner on screen | **Agent's call:** `working · <elapsed since the turn started>` (before the spinner's first frame, or when the parse fails) |

**Where the spinner text comes from:** read Claude Code's spinner row off the mounted terminal's xterm buffer and
show it as is. The terminal block stays mounted while Rendered shows (`renderedview.tsx`), and `termwrap.ts` already
reads `buffer.active`. The verb, the streamed token count and the effort exist only on Claude Code's screen: the
transcript gets `message.usage` per finished message, and the arc mod's events (`register.ts`) carry none of them;
the judge found the mod API's spinner props carry the verb and mode but not elapsed, tokens or effort. Accepted
cost: the parse tracks Claude Code's spinner layout, as `pkg/agentask/deliver.go` already tracks its prompts.

**Data the line uses that exists today:** a call with no result has `pending` and `startedTs` (`AgentEntry`,
`agentsviewmodel.ts`); the timeline never shows that elapsed time today. `extractTasks` (`transcriptprojection.ts`)
reads the latest TodoWrite list but folds `in_progress` into not-done, so it must keep `in_progress` apart to name
the current step. With no TodoWrite the plan step is left out. The tool count is this turn's actions, from the turn's
You entry to now.

At narrow widths the running call's target truncates first, then the plan step; the spinner never truncates.

## Width

See `WidthFill.dc.html`.

Drop the three `max-w-[920px]` in `renderedview.tsx` (the timeline column, `AskDock`, the composer row) so the
timeline, the docks, the now line and the composer span the center as the terminal does. Text blocks (paragraphs,
lists, headings) keep a reading measure of about 75ch; code blocks, tool panels, diffs, cards and charts use the
full width. This follows DESIGN.md's Layout rule: fixed widths belong to rails and sidebars; content is fluid.

The cap goes where `markdownmessage.tsx` renders text blocks. `NarrationTimeline` is shared with `EndedTranscript`
and the Sessions detail, so the cap applies in Rendered only (for example through a prop or a wrapper class), unless
the builder finds the other two benefit and says so.

**Agent's call:** You bubbles keep their max 90% of the now wider column and the 8-line clamp.

## Space above the composer

See `GapRoomy.dc.html`.

Today the last line ends 18px above the composer's border (the scroll area's `py-[18px]`, then the composer row's
`border-t` and `pt-2`), and stick-to-bottom keeps it there. The timeline instead ends in the now line's band, about
40px tall, then the composer. Stick-to-bottom pins the timeline's end above that band, not under it.

## The composer

See `ComposerWriting.dc.html` (idle, typing with an attachment, working).

Rendered reuses `AgentComposer` as built for the cockpit rows and the lead card: 32px tall, 12px text, growing to
160px (`ComposerMinH`, `ComposerMaxH` in `agentcomposer.tsx`). In Rendered it becomes a writing card:

- A card with a 12px radius (`rounded-lg`) on `surface-raised`, border `edge-strong`, accent border while focused or
  while there is text.
- Text at 13.5px, the timeline's size. About 94px tall when empty: two lines of text over a footer. Grows as you type
  to about 40% of the view, then scrolls.
- An attached file shows as a chip 16px below the text, above the footer.
- Footer: attach (paperclip), key hints (`/` commands, `⇧↵` new line), and on the right a labelled **Send** (with an
  up arrow; disabled while empty).
- While the agent works: the placeholder reads "Steer the agent; it reads this before its next step", and the right
  side shows **Interrupt** with its `Esc` key chip and **Steer** in place of Send. A mid-turn send already reaches the
  running turn (`CommandAgentsSendRtnData.midturn`, the arc mod's `steerTurn`).
- The cockpit rows and the lead card (`agentrow.tsx`, `leadcard.tsx`) keep today's box: this is a Rendered-only
  variant or wrapper, and the min and max heights become per use.
- **Agent's call:** the separate hint line under the composer goes; its hints move into the footer, Esc moves to the
  Interrupt button, and "pickers open the terminal" stays as a footer hint so no information is lost.

**Attach:** reuse `AttachButton` and `AttachmentTray` (`attachmenttray.tsx`, `composerattachments.ts`), as the New
run goal does (`newruncontrol.tsx`). `CommandAgentPromptData` carries only `blockid` and `text`
(`wshrpctypes_agents.go`), so how an attached file reaches the agent is open; a path in the prompt text, as the New
run goal does, is the likely route.

## Constraints

- Colors from the `@theme` tokens in `frontend/tailwindsetup.css`; no new tokens. Tailwind over new SCSS.
- Logic extracted to pure `.ts` with tests beside it: the spinner-row parse, the now line's state from entries and
  the parse, `extractTasks` keeping `in_progress`, the turn's tool count.
- `tsconfig.json` is `strict: false`: narrow ok-unions with `"reason" in result`.

## Left to the builder

- Finding the spinner row in the xterm buffer, parsing it, and how often to re-read it.
- Where the now line's model lives (a per-agent jotai atom fits: only the Agent surface stays mounted).
- How the prose cap reaches `markdownmessage.tsx` in Rendered only.
- The attachment route to the agent.
- A CDP scenario step in `scripts/cdp/scenarios-agent-rendered.mjs` for each now line state, the full-width
  timeline with a capped paragraph beside a full-width card, the band above the composer, and the composer idle,
  typing with an attachment, and working (Steer and Interrupt).
- Check both in the live dev app at a narrow (about 900px center) and a wide (1400px+) window.

## Evidence and background

- What Rendered is today, what the timeline leaves out, and where the spinner data lives: the recon notes above, from
  `transcriptprojection.ts`, `narrationtimeline.tsx`, `renderedview.tsx`, `register.ts`.
- Prior art (from memory, not re-checked): chat apps centre one column and push big output to a side panel; editor
  agent panels and Warp fill their pane; docs keep a measure with wide breakouts or a full-width switch; Claude
  desktop, ChatGPT and Cursor draw the composer as a card at message text size with its controls inside.
