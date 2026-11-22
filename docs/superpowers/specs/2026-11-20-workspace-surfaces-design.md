# Workspace pane: Docs and Initiative tabs

Mockups: canvas `workspace-surfaces`, boards `Main` (Docs tab), `I1-Initiative` (Initiative tab) and `S1-States`
(both at the pane's 360px minimum, and when what they show is gone).

## Intent

The Workspace pane beside the Rendered transcript worked: what an agent's turn references opens beside it instead
of taking the user to another surface. This extends it with the two things agents produce or work against that
still leave the agent: the docs they write, and the initiative they work on. What the agent pushes with
`wsh view` lands in the same pane.

## Goals

- A Docs tab: the Markdown files the agent wrote this session, one rendered.
- An Initiative tab: the agent's initiative plan, read-only.
- `wsh view` opens the file in the calling agent's workspace while that agent shows it.

## Non-goals

- Cut-down Sessions, Cockpit or Usage tabs: beside one agent they add nothing (Cockpit repeats the agent tree's
  badges, Usage the composer ring popover).
- Tabs for screenshots or background output: the transcript already shows images as step-card thumbnails, and a
  background shell or monitor opens its live output in a peek from its tree row.
- Checks, Jira, agent and note tabs; agent, note, record and channel links keep today's behavior.
- A new push command for agents.

## Anti-goals

- A full surface squeezed into the pane. Every tab is a compact, peek-sized view; the rest stays one click away
  on its surface.
- Tabs that open by themselves. Turn-end auto-open keeps its four kinds unchanged.
- A second place to edit an initiative.

## Decisions

1. **One Docs tab per agent.** It lists the Markdown files the agent wrote or edited this session, newest first,
   with the selected one rendered below and "Open raw" to its plain text in the File tab. Why: one tab with a list,
   like Changes, keeps a session that writes a spec and a plan from piling up tabs in a narrow strip.
2. **The Docs list comes from the agent's transcripts**: every Markdown file a file-write or edit tool call
   touched, for Claude and pi alike, including the agent's subagents and its earlier transcript files under the
   same agent (after a /clear or a resume). Writes by other means (shell redirects, wsh) do not count. The list is
   derived, never stored. A spec written before a /clear still shows while the plan is written after it. Why: git status cannot tell this session's files from others', and
   misses gitignored docs such as brainstorm and design scratch files.
3. **Docs render with the app's existing Markdown renderer.**
4. **A Markdown file in the Docs list opens in the Docs tab** from a reply's link and from a Write or Edit step
   card on it; every other file, Markdown the agent did not write included, opens in the File tab as today.
   Why: the list stays one derived source, and the step card is the most visible way into a new spec.
5. **A listed doc deleted or moved since stays in the list, marked gone**; selecting it says "No such file" with
   its path.
6. **The Initiative tab shows the plan, read-only**: title and status, project, "N of M chunks done" with the
   segmented progress bar, the chunks in plan order with a status dot and word, and a chunk opening its latest
   notes in place, with a count of older notes. "Open in Hub" leads to the rest. Why: where the work stands is what
   you check beside the agent; changes go through the agent or Hub.
7. **The Initiative tab opens on a plain click** of the header's initiative chip or an initiative card in the
   transcript, one tab per initiative; Ctrl+click keeps today's peek. Where the agent shows no workspace, the click
   opens Hub as today. Why: every workspace link already follows this convention.
8. **An initiative deleted since** shows "This initiative is gone" with a way to close the tab.
9. **At the pane's 360px minimum**, Docs rows drop the folder and Initiative rows drop the status word; the dot
   keeps statuses apart. Every chunk still shows.
10. **`wsh view` routes to the calling agent's workspace**: a file in its Docs list to its Docs tab, any other
    file to its File tab, whenever that agent shows Rendered, wherever the user is; the user is never moved. The file joins behind the active tab with
    the new-since-you-looked dot, as a drawn board does, and a collapsed pane stays collapsed.
    Otherwise it goes to the Code surface as today. Why: it is the
    one push agents use, and it takes the user off the agent today.
11. **Neither new tab opens by itself** at a turn's end; both open only on a click or a push.
12. **The Docs tab has its own opener**: an "N docs" link in the Rendered header's subline, beside the initiative
    chip, shown while the agent's Docs list holds at least one doc. A click opens the Docs tab on the newest doc.
    Why: without it, an agent whose replies cite no doc never shows its Docs list; the header already holds the
    agent's other workspace links.

## Left to the builder

- Tab labels and icons (the mockups use "Docs" with a file icon and "Initiative · <title>" with a flag).
- How many docs the list shows before folding.
- How the Initiative tab refreshes when the agent updates the initiative mid-session.
- How `wsh view` identifies the calling agent so its file lands in that agent's workspace.
- The CDP scenario steps that show each new tab and the states on `S1-States`.
