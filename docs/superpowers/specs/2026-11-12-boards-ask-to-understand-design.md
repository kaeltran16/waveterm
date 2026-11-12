# Boards: a place to ask and understand

Brainstorm: `.superpowers/brainstorm/boards-ask-to-understand/brainstorm.json` (11-12). Mockups: canvas
`boards-ask`, boards `B1` to `B12` (see Mockups).

This redesigns the Boards feature that shipped in a8f0864 from
`docs/superpowers/specs/2026-11-11-tldraw-in-arc-design.md` (the "11-11 spec" below). Where the two
disagree, this one wins. What it does not mention (the Excalidraw library, the per-project board files,
the board list, new board, the empty and load-error states, Escape, zoom kept per board) stays as the
11-11 spec describes it.

## Intent

A board is a place where you ask about things and come to understand them through drawings. The shipped
design got the scribe wrong. It treats the board as a place where things from elsewhere get drawn: you
hand it an agent, run or initiative, a one-shot scribe transcribes it, and that is the end of it. What
the owner wants is to ask a board directly and keep talking to it.

The moments that call for it (a brainstorm is only one example):

- understanding a choice, with a visual;
- understanding the code, with a visual;
- understanding the app's architecture, with a visual.

## Goals

- You ask on a board and talk back and forth with it. Each follow-up gets an answer.
- Each answer is a short reply in words, plus a change to the current drawing or a new drawing beside
  it, whichever the question needs.
- A separate drawer session holds the talk and remembers it, so the agents you work with keep a clean
  context.
- One board is one conversation. Reopening a board continues it, and a new board can start from an
  earlier one with its context handed over.

## Non-goals and anti-goals

- **No transcribing scribe.** The one-shot scribe that draws a handed thing goes (below).
- **No following.** Redrawing at an agent's turn ends goes. Nothing draws unless you ask.
- **No drawing in working agents' context.** The agent you work with never draws. It may start a
  conversation for you (`wsh board draw`, below), and the drawer does the rest.
- **No sync.** Boards stay on the machine, as in the 11-11 spec.
- Anti-goal: a board that answers once and goes quiet, which is what the 11-11 build does.

## The design

### The drawer

- **A separate, read-only claude session per conversation, which remembers the talk.** It starts with
  `--session-id` and every follow-up resumes it with `--resume`, so it never re-reads the whole thread.
  The precedent is run workers: `pkg/jarvis/runexec.go` launches with `--session-id` and reopens with
  `--resume`.
- **What it reads:** the project's code (read and search tools only: no edits, no shell), plus what the
  conversation started from, if anything. That can be an agent's session, a run, an initiative, a
  session, a record, or nothing but the project. Its working directory is the project's repo.
  **Agent's call:** a brainstorm gets no entry point of its own, because it was only an example. A
  brainstorm reaches a board through the brainstorming agent's `wsh board draw` (its session is the
  context) or through that agent's row in the palette, so no `boardthings` reader for `brainstorm.json`
  is built.
- **What it answers:** each turn returns a short reply in words, plus drawing changes. It may add a new
  drawing beside the current one, or change, move or remove elements of the current one.
- **The whole board is shared.** The drawer may move, restyle or remove any shape, your own included,
  when its answer needs it. It also reads your shapes and edits as part of what you are asking. This
  reverses the 11-11 spec's "your own shapes are never touched" and its anti-goal about losing hand
  edits.

### Where you talk: the Boards surface

The talk lives on the Boards surface, laid out like Claude Design: the conversation leads on the left and
the board fills the rest (mockup `B1-Talk.dc.html`; owner's pick on 11-12 over a right-hand talk column,
the talk under the board list, a strip under the canvas, and replies pinned on the canvas).

- **The talk column** (left, 400px) holds the conversation: your messages, the drawer's replies, and an
  ask box at the bottom. Above the conversation, "About" names what the conversation started from, for
  example "the waveterm code" or "claude · waveterm".
- **Each reply** is a few words plus a card naming what it drew or changed ("wavesrv, opened up · added
  5 shapes · 15:20"). The card's **Show** outlines those shapes on the board.
- **Asking about a selection.** Shapes you have selected on the board go to the drawer with your
  question, so "Open this up." needs no description. The ask box shows "Selected wavesrv" before you ask,
  and your message shows "on wavesrv" after. With nothing selected the box reads "Select shapes to ask
  about them".
- **The canvas** (right) is plain Excalidraw, as built.
- **The header** reads "Boards / <board> ▾" with the board's facts ("2 questions · 14 shapes · answered
  15:20") and **New board from this** on the right. The board name is the switcher (`B2-Switcher`): it
  lists the project's boards, newest first, each with its question count, what it is about, and a mark
  when the drawer is answering (green), asks you (amber) or failed (red), and **Ask something new** at
  the top. This replaces the left board list of the 11-11 build.
- **Ask something new** (`B3-AskNew`) puts a form in the talk column: a name, the first question, and
  About the project's code; Ctrl Enter asks, Esc cancels. The canvas waits empty.
- **Ask a board about this…** from the palette (`B9-FromPalette`) opens the same form with the thing as
  its About (an agent shows its runtime dot) and the first question focused.
- **New board from this** (`B8-Handoff`) opens the same form, titled "New board from <board>", with
  "It starts with": a summary of the board's questions written by its drawer, and its drawing copied
  (the count of shapes), and a line that the earlier board and its talk stay as they are. The copied
  drawing shows on the canvas while you type.
- **The drawer at work** (the talk column's states):
  - answering (`B4-Answering`): a green "Answering" with the seconds since you asked, under your
    message; Ask is disabled until the answer lands ("You can ask once this answer lands");
  - slow (`B5-Slow`): past the usual time, "Still answering" with the time, a line that it is taking
    longer than most, and **Stop**, which ends the turn and leaves the board unchanged;
  - failed (`B6-Failed`): an error box under your message, "Couldn't answer" with what happened and that
    nothing on the board changed, and **Retry**, which asks the same question again.
- **New information** (`B7-NewInfo`): an agent's briefing shows in the talk as its own item (the agent,
  "sent a briefing", the time, the briefing, and its ask). When the drawer judges it belongs elsewhere,
  its reply asks so, with **New board from this** and **Keep it here**. **Agent's call:** here New board
  from this starts the new board from the briefing alone, without this board's drawing.
- **Toasts** (`B10-Toast`): after an agent's `wsh board draw`, the shipped toast says "The drawer
  answered on <board>" or "The drawer asks you on <board>", with **Open**.
- **Empty** (`B11-EmptyBoard`): a board with nothing asked and nothing drawn says so in both halves, and
  the ask box works as on any board. **No boards** (`B12-NoBoards`): the surface's empty state holds the
  first ask itself (question, name, About, Ask), with the palette route as the hint.
- Asking from anywhere else takes you to this surface.

### Boards and conversations

- **One board per conversation.** Asking something new makes a new board. Reopening a board shows its
  talk and continues the same drawer session.
- **Handoff.** From any board you can start a new board from it. The new board's drawer starts fresh,
  with a written summary of the earlier conversation, and the new canvas starts with the earlier drawing
  copied onto it (fresh element ids), free to change. A follow-up topic then needn't repeat what you
  built, and the earlier board and its session stay as they were. A fork of the earlier session
  (`--fork-session`) was weighed and not chosen: the summary keeps the new conversation small and cheap. The handoff is a "New board from this" button in the surface header. Like **Ask
  something new**, it asks for a name and the first question.

### What happens to the shipped scribe

The scribe as a role is removed: the one-shot transcriber of a handed thing, following an agent, the
per-source groups (the `arcSource` tags and source rows in the board tree), and the pending-redraw frame
with Keep and Drop. The follow chips on the Agent tree's rows and the "Following" header chip go with
them.

The drawer is built from the scribe's plumbing:

- `pkg/boardscribe`'s headless read-only claude runner and its tool guard (`runner.go`: `--tools
  Read,Grep,Glob`, `--strict-mcp-config`, and the init-event guard that fails closed), now started with
  `--session-id` and resumed;
- its reply check, and the frontend's skeleton-to-Excalidraw conversion (`boardconvert.ts`) and the board
  inbox and applier (`boardapplier.ts`);
- `pkg/boardthings`, which reads an agent, run, initiative, session or record as text. That text is now
  the context a conversation starts from;
- `pkg/boardstore` and the Boards surface.

The entry points change:

- **Draw on a board…** in the palette becomes **Ask a board about this…** on an agent, run, initiative,
  session or record. It opens the Boards surface with a new board whose drawer starts on that thing; you
  type the first question there.
- **`wsh board draw --board <name> --context "<briefing>" [--ask "<question>"]`**: the agent hands the
  drawer a briefing. The agent writes what the drawer needs to know (what you asked, the facts, the
  files) as the briefing, and the drawer starts from that instead of reading the agent's transcript. On
  11-12 a transcript read missed text written in the same message as the tool call. The command returns
  at once, so the agent never waits, and you carry on the talk on Boards.
  - No board with that name: a new board starts, with the briefing as its context and the ask (if any)
    as the first question.
  - A board with that name: the briefing and ask are added to that board's conversation as new
    information. With it, the drawer judges whether it still belongs on this board. If not, it asks you
    in the talk column whether to start a new board for it. That is a reply with **New board from this**
    and **Keep it here**, and the drawer goes on as you choose.
  - **Agent's call:** it does not switch your surface (an agent should not move you). A toast says the
    drawer answered on the board, with an Open. The `arc:cockpit` skill line stays: use it only when the
    user asks, and write the briefing.

## Constraints

- No new design tokens; follow `DESIGN.md` and the `@theme` tokens.
- Model sessions cost usage. Resuming a session is how a follow-up avoids re-reading the thread.
- The owner starts work and wants control: nothing draws or chains on its own.

## Left to the builder

- The drawer's model, prompt and reply format: words plus a skeleton that adds, changes or removes
  elements. Reuse `pkg/boardscribe`'s tool guard and reply check.
- How a board stores its conversation and its drawer session id (the board file's `arc` record is the
  obvious place), and resumes the session with `--resume`.
- What the drawer is handed when a conversation starts from a thing, reusing `pkg/boardthings`.
- Undo: since the drawer may change your shapes, each answer's changes should be one step that
  Excalidraw's undo can take back.
- Who writes the handoff's summary (the earlier drawer, asked one last time, is the obvious choice) and
  what it keeps.
- The order of removing following, the transcribing scribe, source groups and Keep/Drop, and the tests
  and CDP scenarios that go with them (`scripts/cdp/scenarios-boards-*.mjs`).
- When an answer counts as slow (`B5-Slow`), and how the drawer is handed the selected shapes.

## Mockups

Canvas `boards-ask`:

| Board | Shows |
|---|---|
| `B1-Talk.dc.html` | A board open: the talk on the left, the board on the right. Ask sends a follow-up about the selected `wavesrv` and the drawer adds a drawing under the first; Show outlines what each reply drew. |
| `B2-Switcher.dc.html` | The header's board switcher open: Ask something new and the project's boards with their marks. |
| `B3-AskNew.dc.html` | Ask something new: a name, the first question, About the project's code. |
| `B9-FromPalette.dc.html` | Ask a board about this… arriving from the palette on an agent. |
| `B8-Handoff.dc.html` | New board from this: a name, the first question, what it starts with, the copied drawing. |
| `B4-Answering.dc.html` | The talk column while the drawer answers. |
| `B5-Slow.dc.html` | The talk column when the drawer is slow, with Stop. |
| `B6-Failed.dc.html` | The talk column when the drawer failed, with Retry. |
| `B7-NewInfo.dc.html` | An agent's briefing arrives and the drawer asks: New board from this or Keep it here. |
| `B10-Toast.dc.html` | The toasts after an agent's `wsh board draw`: answered, or asks you. |
| `B11-EmptyBoard.dc.html` | A board with nothing asked and nothing drawn. |
| `B12-NoBoards.dc.html` | A project with no boards: the first ask in the empty state. |

Shantell Sans stands in for Excalidraw's hand-drawn font, and the Excalidraw toolbar and zoom controls
are stand-ins. The options not chosen (the talk column on the right, the talk under the board list, a
strip under the canvas, replies pinned on the canvas, a home page of board cards, and the side sheet) are
in the canvas's `unchosen/` folder.

## Background

- The 11-11 live check (board `Scribe check`): one-shot drawing worked (16 shapes in about 16 s), and
  nothing continued after it.
- Before this, the brainstorm pane only showed `arc:design` screen mockups. Nothing drew a diagram of a
  choice, the code or the architecture.
