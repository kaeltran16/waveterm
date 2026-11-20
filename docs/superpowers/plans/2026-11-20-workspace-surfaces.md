# Workspace pane: Docs and Initiative tabs, and `wsh view` into the workspace

**Spec:** `C:\Users\kael02\AppData\Local\arc-wt\acdc6432\docs\superpowers\specs\2026-11-20-workspace-surfaces-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/agentdocs/... ./pkg/wshrpc/... ./pkg/waveobj/... ./cmd/wsh/...`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs workspace-docs workspace-initiative workspace-pane workspace-file workspace-header`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\workspace-surfaces\project\Main.dc.html

Two new tabs in the Rendered view's workspace pane (`frontend/app/view/agents/workspace*.ts(x)`): **Docs** (the
Markdown files the agent wrote this session, one rendered) and **Initiative** (the agent's initiative plan,
read-only), plus `wsh view` landing in the calling agent's workspace. Boards in the canvas folder: **Main** (Docs
tab at 600px), **I1-Initiative** (Initiative tab, one chunk's notes open) and **S1-States** (both tabs at 360px, and
a gone doc / gone initiative). Match layout, type and copy through the `@theme` tokens in
`frontend/tailwindsetup.css` (no new tokens; map the prototype's greys onto the nearest existing ones). Motion
reuses `motiontokens.ts` per `docs/reference/motion-system.md`. Every CDP step below runs through
`node scripts/cdp/final-verify.mjs <scenario>`.

## Decisions beyond the design

1. **The Docs list is built server-side** by a new pure package `pkg/agentdocs`, served by a new wshrpc command
   `AgentDocsCommand` (wire `"agentdocs"`). The frontend parses only the current transcript's tail, so it cannot
   see subagents or earlier transcripts. Results are cached per transcript keyed on size+mtime (as
   `agentEditsKey` in `wshserver_agentedits.go` does), so the cockpit can call it on every click.
2. **An agent's earlier transcripts are recorded on its block**, in a new block meta key `agent:transcripts`
   (string list). Nothing records them today: `agent:transcriptpath` is overwritten on `/clear` and on resume.
   `publishEvent` in `wshserver.go` is the one path both Claude's hook reports and pi's `wsh agent-status` take, so
   it appends a status event's `TranscriptPath` when the block's list lacks it. That costs a DB write only when the
   path is new to the block (an in-memory last-path-per-block check skips the read otherwise), and the list is capped
   at 32, dropping the oldest. This records transcript lineage, not docs: the Docs list itself stays derived (spec
   decision 2).
3. **What counts as a doc write:** Claude `Write`, `Edit`, `MultiEdit` (`file_path`) and pi `write`, `edit` (`path`,
   resolved against the session cwd) on a path ending `.md` or `.markdown` (case-insensitive), whose tool result is
   not an error. Subagent transcripts come from `agentedits.SubagentTranscripts`. A file whose first record is a pi
   v3 session header is read through `pkg/pisession`; anything else is read as Claude.
4. **Doc row fields:** basename; folder relative to the agent's cwd (absolute when outside it); `written HH:MM` when
   the latest touching call was a write, `edited HH:MM` for an edit (`MM-DD` instead of `HH:MM` when not today);
   `gone` for a file that no longer exists. The list is **newest first** by latest touch, as the spec says (the Main
   board's sample data happens to be oldest first; the spec wins). It shows **6 rows**, then a "Show N more" row.
5. **The Docs tab's state** is `{ kind: "docs"; selected: string | null }`, key `"docs"`. `selected` is an absolute
   path, and null means the newest doc. **The Initiative tab's state** is
   `{ kind: "initiative"; effortId: string; open?: number | null }`, key `initiative:<effortId>`. `open` is the
   1-based chunk whose notes are open; undefined means the first active chunk, and null means none. Both kinds keep
   their sub-state in the tab (as Changes does), since a hidden tab unmounts.
6. **Opening a file beside the transcript checks the Docs list at the click**: the list is re-read (cached
   server-side) and the clicked path, resolved against the agent's cwd, is compared with `sameRepoPath`. A listed
   doc opens the Docs tab with it selected; anything else opens the File tab as today.
7. **The Docs list refreshes** when the Docs tab mounts, when the agent's state turns idle (a turn's end), and at
   every routing decision. The shown doc's text is re-read when its entry's timestamp changes.
8. **The Initiative tab refreshes through the existing `effort:update` sync** (`subscribeEffortUpdates`, mounted in
   the shell), which already refreshes every cached effort detail and drops deleted ones. The tab loads once on
   mount with a forced refetch (as `PeekEffortBody` does). A failed load, or the cached entry dropped after the tab
   showed it, is the gone state.
9. **Chunk notes:** an open chunk shows its latest 3 notes, newest first, stamped `MM-DD HH:MM`, then
   "N older notes in Hub" when there are more. A chunk with no notes is not a toggle. One chunk is open at a time.
10. **The narrow layout** is a container query on the tab body: below 420px, Docs rows drop the folder and the verb
    (time only), and Initiative rows drop the status word. The pane's minimum is 360px.
11. **`wsh view` names its caller** with a new `oref` field on `OpenFileData` (`block:<RpcContext.BlockId>`, omitted
    outside a block, as `wsh notify` does). The cockpit finds the agent whose `blockId` matches. Only `wsh view` and
    `wsh open` route to the workspace: `wsh edit` (`edit: true`) and a directory keep going to the Code surface, since
    the pane has no editor and no folder view.
12. **A push** joins through `addTab` (behind the active tab, unseen, a collapsed pane left collapsed). A pushed doc
    also becomes the Docs tab's selection even when the Docs tab is already active: the user stays on the agent, and
    the selection is what the push asks to show.
13. **The segmented progress bar is extracted** from `peekeffort.tsx` into a shared component that both the peek
    and the Initiative tab draw. The Initiative tab's header facts come from `effortPeekModel`, and its chunk rows
    from `effortChunkRows`, so nothing derives chunk state again.
14. **Initiative clicks:** the header chip (`InitiativeLink` in `agentheader.tsx`) and the initiative card's Open
    link (`wshcards-initiative.tsx`) call `openBeside(...)`, falling back to `openOrPeek` (a plain click opens Hub,
    Ctrl+click peeks). The card's Open link today calls `openTarget` and never peeks, so it gains the peek with this
    change.
15. **A Docs tab reopened with a doc takes that doc**: `openTab` on an existing Docs tab replaces `selected` when the
    incoming one is non-null and keeps it on null, as it already replaces a File tab's line. Clicks (Task 3) and
    pushes (Task 5) both rely on it.
16. **The header's "N docs" link** (spec decision 12, added in plan review) sits in the Rendered header's subline
    after the initiative chip, reading "1 doc" / "N docs" from the Docs store, and opens the Docs tab with
    `selected: null`. It is built after the Docs tab (Task 6), since it reads Task 3's store and shares
    `agentheader.tsx` with Task 4.
17. **Unit tests run through Verify**: `scripts/verify.mjs` runs `vitest related` on the TS files a merge changed, and
    each task's worker runs its own with `npx vitest run <files>`.
18. **Labels and icons:** "Docs" with lucide `FileText`; "Initiative · <title>" with lucide `Flag` ("Initiative"
    until the title loads).

### Task 1: The Docs and Initiative tab kinds in the pane
**Depends on:** none
**Files:** `frontend/app/view/agents/workspacemodel.ts`, `frontend/app/view/agents/workspacemodel.test.ts`, `frontend/app/view/agents/workspacepane.tsx`, `frontend/app/view/agents/autoopenmodel.ts`, `frontend/app/view/agents/workspacedocstab.tsx`, `frontend/app/view/agents/workspaceinitiativetab.tsx`, `scripts/cdp/scenarios-workspace-docs.mjs`, `scripts/cdp/scenarios-workspace-initiative.mjs`, `scripts/cdp/scenarios.mjs`

**What to build:** the two new `WorkspaceTab` kinds of decision 5, their keys, labels and icons (decision 15), and
the pane's dispatch to two new tab components. Each component renders an empty body for now, carrying
`data-workspace-docs` / `data-workspace-initiative={effortId}`. `autoOpenKind` excludes both kinds, so turn-end
auto-open is unchanged (spec decision 11). The tab strip names an Initiative tab by its effort's title from
`effortDetailAtom`. Create the two scenarios `workspace-docs` and `workspace-initiative` (registered in
`scenarios.mjs`) on a fixture claude agent in Rendered. Each opens its tab with `openWorkspaceTab` and checks the
tab strip; Tasks 3, 4 and 5 add their steps to these files.

**Interfaces:**
- `WorkspaceTab` gains `{ kind: "docs"; selected: string | null }` and
  `{ kind: "initiative"; effortId: string; open?: number | null }`.
- `tabKey`: `"docs"`, `` `initiative:${effortId}` ``.
- `workspacedocstab.tsx` exports `DocsTab({ model, agent, tab })`, and `workspaceinitiativetab.tsx` exports
  `InitiativeTab({ model, agent, tab })`, with `tab` the `Extract<WorkspaceTab, ...>` of its kind (the `FileTab`
  shape).

**Acceptance:**
- `tabKey` and `tabLabel` cases for both kinds join the existing tables: a second open of an initiative's tab
  activates it rather than adding one; two initiatives give two tabs; one Docs tab per agent.
- `openTab` on an existing Docs tab takes an incoming non-null `selected` and keeps the old one on null
  (decision 15); an Initiative tab reopened keeps its `open`; `updateTab` can change `selected` and `open`, but
  cannot change `effortId`.
- `npx vitest run frontend/app/view/agents/workspacemodel.test.ts` passes.
- Scenario `workspace-docs` step "docs tab in strip": the tab reads "Docs" with the file-text icon and is active.
  Scenario `workspace-initiative` step "initiative tab in strip": the tab reads "Initiative · <fixture title>" with
  the flag icon.

### Task 2: Backend: the agent's Docs list, transcript lineage, and `wsh view` naming its caller
**Depends on:** none
**Files:** `pkg/agentdocs/agentdocs.go`, `pkg/agentdocs/agentdocs_test.go`, `pkg/waveobj/wtypemeta.go`, `pkg/waveobj/metaconsts.go`, `pkg/wshrpc/wshrpctypes_agents.go`, `pkg/wshrpc/wshrpctypes_notify.go`, `pkg/wshrpc/wshserver/wshserver.go`, `pkg/wshrpc/wshserver/wshserver_agentdocs.go`, `pkg/wshrpc/wshserver/wshserver_agentdocs_test.go`, `pkg/wshrpc/wshclient/wshclient.go`, `cmd/wsh/cmd/wshcmd-view.go`, `cmd/wsh/cmd/wshcmd-view_test.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `frontend/types/waveevent.d.ts`

**What to build:** decisions 1, 2, 3 and 11, server side. `pkg/agentdocs` reads a set of transcripts (each plus its
Claude subagent transcripts) and returns the Markdown files written or edited, merged across transcripts by path
(case-insensitive on Windows), with the latest touch's time and verb. `AgentDocsCommand` unions the block's
`agent:transcripts` with the given transcript path, runs the package over them with the per-transcript cache, and
stats each path for `gone`. `publishEvent` records transcript lineage on agent status events. `wsh view` / `wsh open`
stamp `oref` through a pure builder `viewDataFromArgs(absPath string, edit bool, blockId string) wshrpc.OpenFileData`
beside `viewRun` (the `notifyDataFromArgs` pattern in `wshcmd-notify.go`), and the `view` command's help text and printed line stop saying "code surface". Run `task generate`.

**Interfaces:**

```go
// wshrpctypes_agents.go
AgentDocsCommand(ctx context.Context, data CommandAgentDocsData) (*CommandAgentDocsRtnData, error)

type CommandAgentDocsData struct {
    BlockId        string `json:"blockid,omitempty"`        // its agent:transcripts are read
    TranscriptPath string `json:"transcriptpath,omitempty"` // the current transcript, read even when unrecorded
}
type AgentDoc struct {
    Path string `json:"path"`           // absolute
    Ts   int64  `json:"ts"`             // ms, the latest touching call
    Verb string `json:"verb"`           // "written" | "edited", of the latest touching call
    Gone bool   `json:"gone,omitempty"` // no file at Path now
}
type CommandAgentDocsRtnData struct {
    Docs []AgentDoc `json:"docs"` // newest first; [] when none
}

// wtypemeta.go: AgentTranscripts []string `json:"agent:transcripts,omitempty"`
// wshrpctypes_notify.go OpenFileData: ORef string `json:"oref,omitempty"` // block:<id> of the caller
```

**Acceptance:**
- A Claude transcript with a Write of `a.md`, an Edit of `b.MD`, a Write of `c.go` and a failed Edit of `d.md` lists
  `a.md` (written) and `b.MD` (edited) only.
- A subagent's Write of a `.md` file is listed. A pi session's `write` with a relative `path` lists the path resolved
  against the session cwd.
- Two transcripts (an earlier one recorded in `agent:transcripts`, and the current one) both contribute; a path
  touched in both appears once, with the later time and verb. The order is newest first.
- A listed path removed from disk comes back with `gone: true`.
- An agent status event whose transcript path is new to its block appends it to `agent:transcripts`. A repeat of the
  same path writes nothing. The list never exceeds 32, and the oldest entry drops first.
- `viewDataFromArgs` with a block id gives `oref: "block:<blockid>"`; with none, no oref; `edit` carries through.

### Task 3: The Docs tab, and reply links and step cards opening listed docs in it
**Depends on:** Task 1 (the `docs` tab kind and `DocsTab` shell), Task 2 (uses `AgentDocsCommand`)
**Files:** `frontend/app/view/agents/workspacedocstab.tsx`, `frontend/app/view/agents/workspacedocsmodel.ts`, `frontend/app/view/agents/workspacedocsmodel.test.ts`, `frontend/app/view/agents/workspacedocsstore.ts`, `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/tooldetailbody.tsx`, `scripts/cdp/scenarios-workspace-docs.mjs`

**What to build:** the Main board, and the Docs half of S1-States. A per-agent store of the Docs list (from
`AgentDocsCommand` with the agent's `blockId` and `transcriptPath`, refreshed per decision 7, with the RPC's error
shown in the tab rather than swallowed). The tab draws the list (decision 4: listbox "Docs written this session",
6 rows and a fold); a path bar with the doc's path and "Open raw", which opens it in the File tab (line null); and the
selected doc rendered with `@/app/element/markdown`'s `Markdown`, read through `FileReadCommand`. A gone doc stays
listed, marked "gone", and selecting it shows "No such file", its path, and "It was deleted or moved after the agent
wrote it." Narrow per decision 10. A reply's file link (`useReplyFileLink`) and a Write/Edit step card's "Open full
view" (`OpenFullView`) route through `openFileBeside` (decision 6). Ctrl+click and non-Rendered keep their current
fallbacks.

**Interfaces:**
- `workspacedocsstore.ts`: `besideTabFor(agent: AgentVM, file: { path: string; line: number | null }): Promise<WorkspaceTab>`
  returns the Docs tab with `selected` set when the path is listed, else the File tab.
  `openFileBeside(model, agentId, file, event?): boolean` has `openBeside`'s synchronous guard (false off the Agent
  surface, outside Rendered, or with Ctrl), then opens what `besideTabFor` returns (an open Docs tab takes the new
  selection, decision 15).
- `agentDocsAtom(agentId)` holds the agent's last read list (`AgentDoc[]`, empty before the first read), and
  `loadAgentDocs(agent: AgentVM): Promise<void>` refreshes it; Task 6 reads both.

**Acceptance:**
- Pure model (table-driven): rows newest first; the folder is cwd-relative, absolute outside the cwd; the
  `written`/`edited` verb, and `MM-DD` when not today; `gone`; the fold at 6 with "Show N more"; `selected` null
  resolves to the newest doc.
- `besideTabFor` gives a Docs tab for a listed doc cited by a cwd-relative path, and a File tab (with the line kept)
  for a Markdown file the agent did not write, and for a `.go` file.
- Scenario `workspace-docs`, on a fixture transcript that writes two `.md` files and a `.go` file. Step "docs list
  and rendered doc": at 600px, both docs listed newest first with folder and verb, the newest rendered with an `h1`.
  Step "pick a doc": clicking the other row renders it. Step "reply link opens docs": a reply link to a listed doc
  activates the Docs tab with that doc selected. Step "step card opens docs": the Write step card's Open full view
  does the same. Step "non-doc opens file": a link to the `.go` file opens a File tab. Step "open raw": Open raw opens
  a File tab on the doc. Step "docs narrow": at a 360px pane, no folder and no verb shown. Step "doc gone": after
  deleting a listed doc and re-reading, its row reads "gone" and selecting it shows "No such file" with its path.
- `npx vitest run frontend/app/view/agents/workspacedocsmodel.test.ts` passes, plus any test the worker adds for
  `besideTabFor`.

### Task 4: The Initiative tab, opened from the header chip and the initiative card
**Depends on:** Task 1 (the `initiative` tab kind and `InitiativeTab` shell)
**Files:** `frontend/app/view/agents/workspaceinitiativetab.tsx`, `frontend/app/view/agents/workspaceinitiativemodel.ts`, `frontend/app/view/agents/workspaceinitiativemodel.test.ts`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/wshcards-initiative.tsx`, `frontend/app/view/jarvis/peek/peekeffort.tsx`, `frontend/app/view/jarvis/peek/chunksegments.tsx`, `scripts/cdp/scenarios-workspace-initiative.mjs`

**What to build:** the I1-Initiative board, and the Initiative half of S1-States. The tab shows: title and status
pill; "N of M chunks done" with the project; the segmented bar (decision 13); the chunks in plan order as a list
"Chunks", each with its number, a tone dot, the label, and the status word (dropped narrow, decision 10); a chunk
toggling its notes in place per decision 9, with the open chunk kept in the tab's `open`; and a footer "Read-only. Ask
the agent to change it." with "Open in Hub" (`openTarget` to the effort). Gone state (decision 8): "This initiative is
gone", "It was deleted after the agent linked it." and a "Close tab" button that closes the tab. Wire the header chip
and the card's Open link per decision 14.

**Acceptance:**
- Pure model (table-driven): chunk rows in plan order with tone and status; the default open chunk is the first
  active one; a chunk's latest 3 notes newest first, and the older count; a chunk with no notes is not openable.
- Scenario `workspace-initiative` on a fixture agent tagged with a real effort of 9 chunks (done, active and pending
  among them, the active one with 5 notes). Step "initiative from header chip": a plain click on the header's
  initiative chip opens the Initiative tab beside the transcript, with "N of 9 chunks done", 9 segments and 9 chunk
  rows, and the active chunk's 3 latest notes open with "2 older notes in Hub". Step "toggle chunk": clicking another
  chunk with notes opens it and closes the first. Step "initiative from card": a plain click on an initiative card's
  Open link activates the same tab (no second tab). Step "ctrl peeks": Ctrl+click on the header chip opens the peek
  and no tab. Step "initiative refresh": a chunk status change made through `wsh effort` shows in the open tab without
  a reload. Step "initiative narrow": at a 360px pane, no status words, every chunk row shown. Step "initiative gone":
  after the effort is deleted, the tab shows "This initiative is gone", and Close tab removes it.
- `npx vitest run frontend/app/view/agents/workspaceinitiativemodel.test.ts frontend/app/view/jarvis/peek/peekeffortmodel.test.ts`
  passes.

### Task 5: `wsh view` lands in the calling agent's workspace
**Depends on:** Task 2 (uses `OpenFileData.oref`), Task 3 (uses `besideTabFor`; shares the docs scenario)
**Files:** `frontend/app/cockpit/openfilestore.ts`, `frontend/app/cockpit/openfileroute.ts`, `frontend/app/cockpit/openfileroute.test.ts`, `frontend/app/view/agents/workspacestore.ts`, `frontend/app/view/agents/workspacestore.test.ts`, `scripts/cdp/scenarios-workspace-docs.mjs`

**What to build:** spec decision 10 with decisions 11 and 12. The `openfile` handler reads `oref`. When it names the
block of an agent that `rendersNow` (wherever the user is, any surface), the file goes to that agent's workspace:
a listed doc to its Docs tab (selected), any other file to its File tab. It joins through a new
`pushWorkspaceTab`, and the surface does not change. Otherwise, and always for `edit` or a directory, it goes to the
Code surface as today. Keep the routing decision pure in `openfileroute.ts`.

**Interfaces:** `workspacestore.ts`: `pushWorkspaceTab(agentId: string, tab: WorkspaceTab): void` is `addTab`, plus,
for an existing Docs tab, `selected` set to the pushed path (via `updateTab`) even when that tab is active.

**Acceptance:**
- Pure routing (table-driven): no oref, an oref matching no agent, or an agent not in Rendered goes to Code; `edit`
  goes to Code; a directory goes to Code; otherwise it goes to the workspace.
- `pushWorkspaceTab` on a pane with another tab active adds the tab behind it, marked unseen; on a collapsed pane, the
  pane stays collapsed; on an existing Docs tab, it updates `selected`.
- Scenario `workspace-docs` step "wsh view pushes a doc": with the Changes tab active and the Code surface showing,
  an `openfile` event carrying the fixture agent's block oref and a listed doc leaves the surface on Code; back on
  the agent, the Docs tab sits behind Changes with the unseen dot and that doc selected. Step "wsh view pushes a
  file": the same with the `.go` file adds a File tab behind. Step "wsh view, collapsed": on a collapsed pane, the
  pane stays a strip and its unseen dot shows.
- `npx vitest run frontend/app/cockpit/openfileroute.test.ts frontend/app/view/agents/workspacestore.test.ts` passes.

### Task 6: The header's "N docs" link opens the Docs tab
**Depends on:** Task 3 (reads `agentDocsAtom` and `loadAgentDocs`), Task 4
**Files:** `frontend/app/view/agents/agentheader.tsx`, `scripts/cdp/scenarios-workspace-header.mjs`

**What to build:** spec decision 12 with plan decision 16. In the Rendered header's subline, after the initiative
chip, a link reading "1 doc" / "N docs" while the agent's Docs list is non-empty, absent when it is empty. The header
loads the list when it mounts in Rendered and at the agent's turn ends (the Docs store's refresh). A click opens the
Docs tab beside the transcript with `selected: null` (the newest doc), through `openBeside`.

**Acceptance:**
- Scenario `workspace-header` step "docs link": on a fixture agent whose transcript writes two `.md` files, the
  header's subline shows "2 docs"; clicking it opens the Docs tab with the newest doc rendered. Step "no docs link":
  on a fixture agent that wrote no Markdown, the subline has no docs link.
