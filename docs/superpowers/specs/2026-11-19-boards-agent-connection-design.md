# Boards and the agent, connected

Mockups: canvas `boards-agent-connection`, boards `W1-Workspace` (the board tab beside the transcript) and
`W2-Expanded` (the tab expanded over the center).

This revises the 11-12 Boards design (`2026-11-12-boards-ask-to-understand-design.md`). Where the two disagree, this
one wins; what it does not mention stays as the 11-12 spec describes it.

## Intent

On the 11-12 design the board is a second conversation partner: you ask the drawer on the Boards surface and it
answers in words, apart from the agent you work with. Understanding splits across two talks, and the board feels
disconnected from the agent. The agent you work with stays the one you talk to; the board is where its explanations
get drawn.

## Goals

- The agent is the one conversation partner. The drawer (Sonnet) only draws.
- Drawing work stays on the cheaper Sonnet drawer and out of the Opus agent's context.
- Questions asked on a board reach the agent, and its answers are readable from the board.
- A board tied to an agent lives beside that agent, in its workspace.

## Non-goals and anti-goals

- The drawer never answers in words.
- No drawing work in the agent's context: no shapes, coordinates, drawing requests or drawer turns reach it (the one
  exception is a drawing request the drawer misroutes, below).
- The agent never moves you to another surface.
- Nothing draws or forwards on its own: every drawing and every forwarded question starts from something you typed,
  or from the agent's own request when you asked it to draw.
- Anti-goal: a question on a board that is drawn or dropped instead of answered.

## The drawer

- A separate, read-only Sonnet session per board, as today, so the agent's context stays clean of drawing work. It
  may read the project's code to draw what is true.
- Each turn it does one of two things: change the drawing, or flag the line as a question for the agent and draw
  nothing. It never writes a words reply. The 11-12 words reply and question-and-answer talk go.
- On each drawing turn it reads what the agent said since its last read (from the agent's transcript), so "draw what
  we just discussed" works without restating it.
- The agent can still send it a drawing request with `wsh board draw`. The first briefing keeps `--context`; later
  requests from the agent are one line.

## One ask box, routed by the drawer

- A board has one ask box and one Ask button. Everything typed there goes to the drawer, with the selected shapes as
  today.
- When the drawer flags a line as a question, Arc forwards it to the board's agent as one message: your words, the
  selected shapes' labels, and the board's name. That message is the only board text that reaches the agent.
- Each turn carries a one-click "send the other way": a drawn line can be sent to the agent instead, and a forwarded
  line can be drawn instead. The drawer's routing is a judgment, so a misroute must cost one click.
- Send the other way only redoes; it takes nothing back. A drawn turn resent to the agent keeps its shapes (Excalidraw
  undo removes them). A forwarded turn drawn instead stays with the agent, which may answer it anyway. Forwards go at
  once, with no hold: an occasional misrouted line reaching the agent is the accepted cost, and keeps every turn free
  of revert data and timers.
- The forward is typed in as your own message, not as an agent-to-agent message, so the agent answers it in its own
  transcript like any message you type. It carries a marker the transcript shows as a "from <board> · on <shapes>"
  chip above it (`W1`), so you can tell it came from the board.
- If the agent has a question or permission prompt open, the forward waits on its turn ("waiting for <agent>") and
  goes once the prompt is answered: typed text would otherwise answer the prompt.
- If the answer changes the picture, the agent may send the drawer a one-line drawing request.

## Where the answer shows

- When the agent's turn ends, wavesrv reads its reply from the transcript and stores it as the forwarded turn's reply.
- The board shows the copied reply where the transcript is not in view: the workspace tab expanded over the center,
  and the Boards surface. Each has a way to the agent (Back to the transcript in the workspace, Open agent on the
  Boards surface).
- In the workspace tab beside the transcript, the turn reads "sent to the agent · answered in the transcript", since
  the answer is right there.

## Where a board lives

- A board tied to an agent opens as a tab in that agent's workspace pane on the Agent surface (`W1`), beside the
  transcript: the canvas, the board's recent turns with Show and send-the-other-way, and the ask box. The pane's
  existing Expand gives it full width with the full turns column on the left (`W2`). The Agent surface is the one
  that stays mounted, so the board survives switching surfaces.
- The Boards surface stays: it lists every board in a project, and shows boards whose agent has no workspace.
- When the agent runs `wsh board draw`, the board joins its workspace at once (mid-turn included, without waiting for
  the turn end) as a tab behind the active one, marked unseen. Closing a board tab never stops later boards from
  arriving. The drawer's toast shows whenever you are not looking at that agent's workspace.
- Opening a board that has an agent from the palette opens it in that agent's workspace. Picking one in the Boards
  surface's switcher keeps it on the Boards surface.
- When the tied agent shows no workspace (terminal view, ended, or a runtime other than claude or pi), the board opens
  on the Boards surface instead. Arc never switches the agent's view.

## Which agent a board talks to

- A board started from an agent (its `wsh board draw`, or Ask a board about this on an agent) is tied to that agent.
- A board with no agent (New board, or about a run, an initiative or a session) asks once: the first flagged question
  shows a picker of the project's live claude and pi agents (the runtimes whose reply can be copied). Your choice
  becomes the board's agent, shown as a chip in the board's header that you can change, and the board then also opens
  in that agent's workspace.
- With no live agent to pick, or the picker dismissed, the question stays pending on its turn ("needs an agent"), with
  the picker and Start an agent. Send the other way still draws it. A question is never dropped.
- A board has one agent. Changing the chip moves its tab to the new agent's workspace; earlier forwarded turns keep
  the agent they went to; the drawer's transcript read starts from the change.
- Another agent's `wsh board draw` on a board tied to someone else is drawn as that agent's request and leaves the tie
  as it is.
- A forwarded question to an agent that is mid-turn is typed in and runs after its current turn, as a message you type
  would. If the agent's tab is closed, the turn says so and offers the picker; nothing is lost.

## What stays

The drawer's working states (answering, slow with Stop, failed with Retry); an agent's briefing with the drawer's New
board from this / Keep it here; New board from this, with a summary the drawer writes; Show on each turn; asking about
a selection; one undo step per drawing. A board's earlier words replies from the drawer stay visible as history.

## Constraints

- No new design tokens; follow `DESIGN.md` and the `@theme` tokens.
- Model sessions cost usage: the drawer stays on Sonnet and resumes its session; reading the reply is a transcript
  read, not a model call.
- The owner starts work and wants control: nothing draws or chains on its own.

## Left to the builder

- The drawer's prompt, and how it decides draw versus a question for the agent.
- The exact text of the forwarded message.
- How many turns the narrow workspace tab lists.
- Where the agent chip and picker sit.
- How the reply is found in the transcript at turn end.
- Migrating the boards CDP scenarios, and the scenario steps that show the workspace tab, a forwarded question and its
  copied reply.
