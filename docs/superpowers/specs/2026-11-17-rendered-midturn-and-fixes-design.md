# Rendered view: messages sent mid-turn, command output, and two fixes

## Intent

The chat-renderer parity initiative will make the Rendered view the default for Claude agents once its typing box
handles everyday input without a trip to the Terminal. Two gaps remain:

- A message sent while the agent works never shows. The box hands it to the arc mod, which joins it to the running
  turn as a hidden record that the Rendered view skips. That happened about 90 times in the last 14 days.
- A slash command's printed output is dropped.

This work closes both gaps. It also fixes two problems found along the way:

- A session whose first input is a `!` command takes the raw bash-input text as its title.
- The 'rendered: file peek' check fails now and then.

## Goals

- A message sent while the agent works behaves as it does in Claude Code's own box: it shows at once as queued, it
  can be taken back to edit until the agent takes it, and Esc stops the turn and sends it.
- Every message waiting on the agent shows the same way, whether it was sent from the Rendered box or typed in the
  terminal.
- Every message the agent reads mid-turn shows: your own, and Arc's.
- A slash command's output shows under the command.
- A session's title never shows raw bash-input tags.
- The file-peek check fails only when the peek is broken.

## Non-goals

- A Send now action.
- Taking back a message that the agent has already read.
- Showing the mod's queued messages in the terminal.
- Queueing Arc's own messages.

## Anti-goals

- Anything that changes how Claude Code's terminal behaves, or types into its box. A queue that needs keys pressed in
  the terminal fails this work even if it shows the right bubbles.
- Reading Claude Code's screen to learn what its box holds.
- Dropping a message the person sent without telling them.

## Constraints

- Claude Code's terminal behaviour stays as it is. Nothing in this work types into its box or changes what it does.
  Why: the person may be typing a draft there, and the mod path exists so cockpit sends never mix into that draft.
- The mod engine has no call to read, add to or take from Claude Code's own message queue. It also has no call that
  moves a running command to the background. It can join a row to the running turn, stop the turn, and submit a
  prompt that runs once the session is idle. It also sees each tool result at the moment the next request is about
  to go out.
- Claude Code writes its queue's whole life to the transcript as queue-operation records, each written as it
  happens:
  - enqueue, with the text;
  - remove, with reason absorbed_mid_turn, when the message is taken at the turn's next step;
  - dequeue, when the message is taken as the next prompt at the turn's end;
  - popAll, with the text, when ↑ pulls the queue back into the box.

## Approach

The arc mod holds the queue. A message the box sends while the agent works goes to the mod, which keeps it in its
own list instead of joining it at once. At the agent's next tool result, the moment Claude Code takes its own queued
messages, the mod joins everything it holds to the turn. Until then a message can be taken back.

The mod reports what it holds to Arc, and the Rendered view draws the Queued bubbles from that report. When the turn
ends with messages still held, the mod sends them as the next prompt, as Claude Code does with its own queue.

Why the mod: it is the only part of Arc in the engine's path at the tool-result moment. So only the mod can join a
message exactly when Claude Code would while keeping it takeable until then. Typing into Claude Code's own queue
would break the constraint. A queue held in the frontend would hear about the next tool step only after the next
request had left, so the agent would read the message a step late, and a reload would lose it.

## Decisions

### A message sent while the agent works

- **It shows at once.** It draws as your bubble at the foot of the transcript with the line "Queued · Esc to stop and
  send now" under it. Several queued messages share one line: "2 queued · Esc to stop and send now". Why: as in
  Claude Code's box, with the line naming the one way to send it early.
- **The placeholder points to take-back.** While anything is queued, the empty box's placeholder reads "Press ↑ to
  edit queued messages".
- **↑ takes the queue back.** ↑ in the empty box takes every message the mod still holds back into the box, one per
  line, in the order they were sent. Their bubbles go and the turn keeps running. Enter queues the text again. Why:
  Claude Code's own ↑ does the same.
- **Esc stops and sends.** Esc stops the turn, and the queued messages then go as the next prompt. Why: Claude Code's
  Esc with a queue does the same.
- **There is no Send now.** Why: the mod can only stop the turn, not move the running command to the background as
  Claude Code's Send now does. A stopping Send now would only repeat Esc.
- **Taken messages stay in place.** When the agent takes the messages, at its next step or as the next prompt at the
  turn's end, the Queued line goes and the bubbles stay where they were sent. The record of a joined message, which
  today is skipped, draws as your bubble. The mod's notice line for the join ("read mid-turn") does not draw.
- **A joined message can't come back.** Once the mod has joined a message to the turn, it can no longer be taken
  back. ↑ then works on whatever is still held.
- **↑ with nothing queued recalls history.** With nothing queued, ↑ in the empty box recalls this session's own typed
  prompts, whether typed in the box or the terminal, newest first, and ↓ steps forward. Past the newest, the box is
  empty again. Why: Claude Code's box does the same, and the session's prompts are the ones worth sending again.
- **A slash command queues too.** A slash command sent from a box while the agent works shows as its command row with
  the Queued line, and ↑ takes it back like a message. When the turn ends it runs as a command, never joined to the
  turn as text, in the order it was sent among the queued prompts. Why: joined as text, the model would read the
  command instead of it running.
- **No message is read twice.** Each message is read by the agent exactly once. A message held until a turn ends goes
  as the next prompt, never also joined. Today a message joined after the turn's last tool result can be read twice.

### Messages typed in the terminal

A message typed into Claude Code's own box while the agent works goes through Claude Code's own queue, unchanged. The
Rendered view draws it as a Queued bubble from the transcript's enqueue record. When a record shows the message was
taken (absorbed mid-turn, or dequeued at the turn's end), the Queued line goes and the bubble stays. When the
terminal's ↑ pulls the queue back (popAll), the bubbles go, as they do for the mod's ↑: the agent never got those
messages. ↑ in the Rendered box takes back only the mod's queue; Claude Code's own queue is taken back in the terminal. Why: one look
for every message waiting on the agent, with nothing typed into the terminal.

### Other messages sent mid-turn

Arc's own messages to a working agent, such as a run's wakes or a message from another agent, are never queued:
they never show as Queued and can't be taken back. Only messages typed into an agent's box, whether the Rendered box
or an agent card's box, go to the mod's queue. The mod still holds an Arc message until the agent's next step and
joins it there, or sends it as its own prompt at the turn's end, exactly as it does a queued one. Why: nobody takes
an Arc message back, and the agent reads a joined row only when its next request goes out, so joining at once would
be read at that same step; joining at the step itself is what keeps a message from being read twice.

Their joined records, which are hidden today, draw as the Arc events they are, at the step where the agent read them:
a wake as a wake, another agent's message as an agent message. Agent-to-agent messages are not an Arc event kind yet,
so they get one. Why: a message the agent has read should never be invisible.

### Slash command output

Output that a slash command prints shows under that command's row, aligned with it, in mono and muted ink, with
colour codes stripped. It needs no clamp: in 14 days of transcripts there were 46 outputs, 38 from /compact and the
rest one to three lines. /compact keeps its own divider and gets no output block. A command that printed nothing
draws its row alone. Output with no command row before it draws nothing.

### Title of a session that starts with !

A `!` command counts as a shell run, not a prompt, everywhere Arc takes a session's title or last prompt from: the
header, the agent tree, the Cockpit card, the events feed and the box placeholder. The first typed prompt names the
session. Until there is one, the title reads "! <command>", never the raw tags.

### File-peek check flake

The 'rendered: file peek' check failed once in run af7381fb and passed when the same tree was rerun: the editor drew
no lines, though the peek opened and closed. Reproduce it by running the scenario back to back under CPU stress, and
fix the cause, whether it lies in the check's wait or in the peek. If it never reproduces, the run says so and leaves
the check as it is.

## Left to the builder

- How the mod reports what it holds to Arc, and how Arc pairs a joined message's record with its Queued bubble.
- The control messages for take-back.
- What happens to held messages when the agent's session ends or reloads. Put them back in the box with a note; never
  drop them silently.
- Where the title fix lives, once its source is found.
- The verify scenarios for the Queued bubble, ↑ take-back and command output.
- The flake's cause, once reproduced.
