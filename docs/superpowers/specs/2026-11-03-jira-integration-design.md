# Jira integration

Date: 2026-11-03. Design canvas: `.superpowers/design/jira-integration/project/` (gitignored; boards named
below). Every decision here was confirmed by the owner in the brainstorm.

## Intent

Ticket in, result out. A Jira ticket becomes an Arc initiative, the initiative's runs work its chunks, and Arc
posts the initiative's progress back to the ticket when the owner asks. Today the ticket key is free text on an
initiative and in run goals; moving work between Jira and Arc is copy-paste at both ends.

## Goals

- Find the Jira tickets assigned to you that have no initiative yet, on demand.
- Turn a ticket into a planned initiative in one click: an agent reads the ticket and creates the initiative,
  chunks included, in the right project.
- Show the ticket everywhere the initiative shows.
- Post the initiative's progress to the ticket, and optionally move the ticket's status, when you ask.

## Non-goals

- No background polling, and no check at launch. Arc talks to Jira only when you press a Jira action (or an
  agent runs a `wsh jira` command, which you started).
- No automatic or pre-drafted comments waiting in the cockpit.
- No Jira Server / Data Center. Jira Cloud only (`<name>.atlassian.net`).
- No import or sync of sub-tasks, child issues or epics. One ticket is one initiative.
- No ticket editing beyond a post's comment and status move.
- No Atlassian MCP server.
- No posting from a run. A run usually finishes one chunk; posting belongs to the initiative.

## Constraints

- Jira Cloud REST v3, basic auth with account email + API token. Comment bodies are Atlassian Document Format.
- The API token lives in `pkg/secretstore` (DPAPI on Windows), never in `settings.json`. Agents never see it:
  every Jira call goes through wavesrv.
- Go is the source of truth for wire types: new wshrpc commands and Effort fields are Go, then `task generate`.
- UI follows `DESIGN.md`: `@theme` tokens only, no new tokens, motion from `element/motiontokens.ts`.
- Pure logic in `foo.ts` with `foo.test.ts`; thin `.tsx`. No jsdom render tests; UI is verified with CDP scenarios.

## What exists today

- `waveobj.Effort` (`pkg/waveobj/wtype.go`) has `Title`, `Project`, `Ticket`, `Status`, `ParentOID`, ordered
  `Chunks` (label, status, stage, owner, `WorkRefs`, notes), `Notes`, `Events`, `Meta`. `wsh effort create`
  takes `--ticket` and `--chunk`; `setTicket` (`pkg/jarvis/effortops.go`) changes it.
- A run attaches to a chunk with `Run.EffortRef` (`wsh runs start --effort/--chunk`, or Work on from the Brief).
- Where an initiative and its ticket appear: the Brief's Initiatives row (`briefrows.ts` `initiativeLine`, meta
  `ticket · project`), the open plan (`inlinetrackerview.tsx`), the activity view (`effortdetailview.tsx`), the
  chunk sidebar (`chunksidebar.tsx`), the run sheet's initiative line (`runsheet.tsx`, no ticket today),
  New/Edit initiative (`effortcreateform.tsx`, free-text Ticket), the command palette (`briefpalette.ts`),
  records (`taskdetail.tsx`, from `jarviscapture`'s goal regex), and `wsh effort show/list`.
- Work on (`initiativework.ts`) starts an agent with a "where are we" prompt; that agent reads the initiative
  through `wsh effort show`.
- `pkg/jarviscapture` takes the first ticket-shaped key in a run's goal for its record; `pkg/jarvisattrib`
  links runs to records by ticket key.
- Arc projects are a name-to-path map in `projects.json`.

## Design

### Connecting to Jira (board `Settings.dc.html`)

A Jira section in Settings, in the Data group beside Vault and Headless AI, laid out like the other sections
(setting rows: title, description, control on the right):

- **Site**: `https://<name>.atlassian.net`.
- **Account email**: the Atlassian account the token belongs to.
- **API token**: shows Saved with Replace token and a link to create one at id.atlassian.com. Stored in
  `pkg/secretstore`.
- **Connection**: "Connected as <name>", Test again, and when it was last checked.

Every Jira action, in the UI and in `wsh jira`, fails with a message pointing to this section when any of the
three is missing, and shows Jira's own error on a 401 or 404.

### Check Jira (boards `Main.dc.html`, `CheckJiraStates.dc.html`)

- **Check Jira** sits in the Brief's toolbar beside New initiative (`brieftoolbar.tsx`). The command palette
  gets a "Check Jira for my tickets" action. `wsh jira check` prints the same list.
- Pressing it runs one Jira search for your open tickets (`assignee = currentUser() AND statusCategory !=
  Done`) and drops every ticket whose key is already on an initiative.
- It opens a dialog, "Your Jira tickets", with a subtitle counting the tickets without an initiative, the site
  and when it was checked, Check again, and Close. Each row: key (opens Jira), summary, type · status ·
  updated, the inferred project with its evidence (or "Agent will ask" in amber when unsure), Make initiative,
  and an Open in Jira icon. The footer counts assigned tickets that already have an initiative.
- States: loading (the list's layout with bars where text will land; Check again reads "Checking…"), nothing
  new, not connected (Connect Jira opens Settings), and Jira refused (Jira's status and message, Replace token).
- The list is not kept between checks.

### Making an initiative from a ticket

- **Make initiative** on a row starts an agent. The row switches in place to "Building in Agent", the same size,
  linking to that agent.
- The agent follows the initiatives skill: it runs `wsh jira show <KEY>`, asks you when the project is unsure,
  then `wsh effort create` with the ticket's title, `--ticket <KEY>`, `--project`, and chunks planned from the
  description and acceptance criteria. It leaves a first note, "Made from <KEY>", saying how it planned them.
- Chunks are Arc's own phases, planned as today. Jira sub-tasks and child issues are not imported or synced.

**Which project.** Arc infers it from history: which Arc project your past initiatives with tickets from the
same Jira project belong to, and which registered projects have commit subjects tagged with that Jira project's
keys. A clear winner is used. With no history or a tie, the agent guesses from the ticket against your projects
and asks you to confirm before creating anything. `wsh jira show` prints the inferred project and its evidence.

### The ticket on the initiative (board `Initiative.dc.html`)

- **Brief row** (`InitiativeRow`): the meta column keeps `PAY-318 · payments-api`, with the key drawn as a link
  that opens the ticket in Jira; the rest of the row still opens the plan.
- **Open plan** (`inlinetrackerview.tsx`): a one-line ticket bar above the stages, compact by default: a
  chevron, the key (opens Jira), issue type, the Jira status chip, the description's first line truncated,
  "seen 2h ago" (hover says when and why Arc last saw it) and a refresh icon. The chevron, or clicking the first
  line, expands it to the full description and the acceptance criteria; the chevron folds it.
- Chunks reported in a post carry a quiet "posted to Jira".
- The footer gains **post to Jira** beside rename, details and activity, and, once posted, "Posted <when>,
  moved to <status>" linking to the comment.
- An initiative with no ticket looks as it does today.

### The ticket in the chunk sidebar (board `ChunkSidebar.dc.html`)

- The breadcrumb ends with the key as a link (`BUILD / DONE / PAY-318 ↗`).
- Each chunk a post reports as done gets a note "In a post to <KEY> · you · <time>" linking to the comment;
  that note is what marks the chunk "posted to Jira" in the plan, and how Arc knows what it already reported.
- The post itself is recorded on the initiative (its activity feed) with the comment link and the move.

### Post progress to Jira (boards `PostToJira.dc.html`, `RunSheetPosted.dc.html`)

- Only from the open plan's footer of an initiative with a ticket. Nothing reaches Jira unless you press it.
- The dialog, "Post progress to <KEY>": the ticket's current Jira status and when it was last posted, an
  editable comment, and a row of the moves the ticket's workflow allows from its current status (fetched when
  the dialog opens; Leave as is first). The footer says in words what will happen ("Posts the comment, then
  moves To Do to In Progress"); the button reads Post comment or Post and move. ctrl+⏎ posts.
- **The comment reports only what changed since the last post.** The first post covers everything done so far.
  Sections: Done (each chunk finished since the last post, with the summary and merge commit of the run that
  finished it), In progress, Next. Drafted from the plan and those runs' reports; editable before posting.
- **Who drafts the Done summaries (builder question 1):** Headless AI, falling back to code. Each Done summary
  is written by the Headless AI runtime from the report (`Run.Report`) of the run that finished the chunk, or
  from the chunk's notes when no run did (a Work on session, or a chunk ticked by hand). While it drafts, the
  comment box shows the code draft greyed with "Drafting summaries…". If Headless AI is not set up or the call
  fails, the draft keeps the code version (the report's first paragraph, or the chunk's latest note) and one
  line under the box says the summaries were not rewritten. Post never waits on the model.
- Post sends the comment, then the move. If the move fails after the comment posted, the dialog says so with
  Jira's own message and the ticket's real status, and offers Move it in Jira.
- The run sheet has no Post to Jira. Its initiative line leads with the key
  (`↳ PAY-318 · <initiative> · <stage> · <chunk>`) and opens the chunk.

### The Ticket field in initiative details (board `EditInitiative.dc.html`)

In New initiative and Edit initiative (`effortcreateform.tsx`), the Ticket field is looked up in Jira when it
loses focus. Typing a key by hand counts as asking, so this is the one lookup without a button.

- Looking up: "Looking up <KEY> in Jira…".
- Found: a line under the fields with a check, the summary, and type · status.
- Not found: "Jira has no <KEY>, or your account can't see it. Saving keeps it as text." with the field in error.
- Not connected: "Saved as text; Arc can't check it until Jira is connected." with Connect Jira.

### Palette and command line (board `Elsewhere.dc.html`)

- The palette already searches an initiative's ticket key; it also lists "Check Jira for my tickets".
- `wsh effort show` and `wsh effort list` print the ticket with its Jira type and status as last seen; `show`
  adds `read it: wsh jira show <KEY>`, so an agent started with Work on finds the ticket text unprompted.
- `wsh jira check` lists your open tickets without an initiative. `wsh jira show <KEY>` prints summary,
  description, status and acceptance criteria as plain text, plus the inferred project and its evidence. Both go
  through wavesrv.

### What Arc keeps from Jira

An initiative keeps its key (`Effort.Ticket`, as today) and a last-seen copy of the ticket: summary, type,
status, description and acceptance criteria, with the time Arc saw them. Arc updates the copy whenever it talks
to Jira about that ticket (make, post, refresh, Check Jira, the details lookup, `wsh jira show`), so the ticket
bar draws without a Jira call when the plan opens. Everything from the copy is labelled with when it was seen.

### Records and attribution

For a run attached to an initiative with a ticket, `pkg/jarviscapture` uses the initiative's key for the record
instead of the first key in the goal, so the record, the initiative and the posts agree on one ticket.

### Motion

Every state change this feature adds animates, from `element/motiontokens.ts` with `motion/react` and
`MotionConfig reducedMotion="user"` (DESIGN.md: motion only where it makes a change legible; entrances animate
opacity and scale, never x/y; no entrance cascades).

1. The ticket bar expands and folds with the same height+opacity reveal the plan uses (`paneReveal`,
   `durMacro`); its chevron rotates on `durMicro`.
2. The Check Jira dialog enters and leaves with `ModalShell`'s motion; Check again crossfades from the loading
   bars to the rows without anything shifting.
3. Make initiative crossfades in place to Building in Agent at the same size. When the agent creates the
   initiative, its row leaves the list and the others close the gap (`AnimatePresence` `popLayout`, with a
   `motion.div` as the direct child), and the new initiative enters the Brief with the existing fresh mark.
4. In Post progress, the drafted summaries crossfade over the greyed code draft when they arrive; Post keeps its width as "Posting…", the result lines fade in, and afterwards the footer's
   "Posted <when>" and each reported chunk's "posted to Jira" fade in.
5. The status chip's colour transitions on `durMicro` when a refresh changes it.
6. The Ticket field's lookup line fades in under the field.

## Left to the builder

- Jira Cloud REST v3 endpoints and paging (search returns a handful of tickets; one page is fine).
- Building the comment as Atlassian Document Format from plain paragraphs and lists.
- Reading acceptance criteria: a custom field that differs per site; fall back to the description.
- The threshold for a clear winner in project inference.
- Which harness and starting directory the Make initiative agent gets, above all when the project is unsure.
- The wshrpc command shapes, and where the last-seen copy and post records live on the Effort (fields, `Meta`
  or events; a new registered waveobj type needs a migration).
- Exact motion values within `motiontokens`.
- A CDP scenario step for each board's view and state (`scripts/cdp/scenarios-<area>.mjs`), with fixtures that
  stand in for Jira.
