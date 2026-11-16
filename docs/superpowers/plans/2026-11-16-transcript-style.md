# Transcript style: Claude desktop look, adapted to Arc

**Effort:** effort:f283ad11-bcef-4053-b3f8-cda2e04998a2
**Verify:** `node scripts/verify.mjs ./cmd/wsh/cmd`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs agent-rendered narration-feed motion-agent rendered-shell transcript-base transcript-initiative transcript-dag transcript-dagactions transcript-runs transcript-agents transcript-notes transcript-arc transcript-boards`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\rendered-view-style\project

No task edits Go: the Verify package is a placeholder `verify.mjs` requires, and what Verify checks here is its
scoping by changed paths (tsc and `vitest related` at each merge, the whole vitest suite in the final stage).

> **For agentic workers:** the prototype is the spec for the look. Open the board(s) your task names (each
> `<Board>.dc.html` in the Prototype folder is plain HTML with inline styles) and match them. A task carries its
> decisions, files, interfaces and acceptance; you write the implementation.

**Goal:** every view built on `NarrationTimeline` (the Rendered view, agent rows, lead cards, subagent interiors,
the Sessions detail, ended transcripts) draws the canvas's anatomy: plain user bubble, prose without an avatar,
step rows (title, command in mono, exit chip, time, chevron) that open to a structured body, finished stretches
folded into "Worked for N", wsh change calls as standalone cards outside the fold, read-only wsh calls as step
rows that open to a structured view, Arc's own messages (wakes, briefs, brainstorm lines) as events, a working
line in the column, and the pill message box.

**Architecture:** a pure layout model (`transcriptlayout.ts`) turns `AgentEntry[]` into turns, stretches, folds,
cards and Arc events; `NarrationTimeline` renders it. A wsh call is recognised by parsing the Bash command line
(`wshcall.ts`), never wsh's human output; each family of wsh calls renders through one registry
(`wshrenderers.tsx`) whose per-family modules are filled by parallel tasks. Data a card or view needs beyond its
own argv comes from the call's own `--json` output when it has one, else from Arc's RPCs and stores through one
keyed cache (`wshdata.ts`) that the dev fixture seam can seed.

**Tech stack:** React 19, jotai, Tailwind 4 (`@theme` tokens in `frontend/tailwindsetup.css`), motion, vitest,
CDP scenarios in `scripts/cdp/`.

## Decisions beyond the design (with why)

1. **Scope of hosts.** The new look reaches every `NarrationTimeline` host. Hosts at card width (agent row, lead
   card, subagent interior) pass `compact`, which selects the boards' 380-420px variants (CompactLead,
   CompactInitiative, Compact). Why: the goal names every view on NarrationTimeline, and the compact boards exist.
2. **The Agent header is not restyled.** The boards draw it as context, but it is the Agent surface's header,
   shared with Terminal mode and not built on NarrationTimeline. The one change: in Rendered, the model and
   permission-mode chips move into the message box (as drawn), so the header hides `HeaderControls` while Rendered
   shows them. Why: the goal's scope is the transcript renderer and its message box.
3. **How a wsh call is recognised.** By tokenising the Bash command (`parseWshCalls`), with the first wsh
   invocation that has a known key deciding. A change call whose result failed (`is_error` or a nonzero exit)
   renders as a failed step, never as a card, so a refused change never reads as done; a change call still
   running renders as a running step and becomes its card when its result lands. Why: structured, deterministic,
   and a card must only claim what happened.
4. **Where read views get data.** The call's own JSON output when it ran with `--json` and exited 0 (the JSON is
   the RPC return wsh prints); otherwise the matching RPC (`EffortGetCommand`, `EffortListCommand`,
   `DagStatusCommand`, `GetChannelRunsCommand`/run objects, `GetAttentionCommand`, `AgentsListCommand`,
   `JiraShowCommand`), fetched lazily on first open. RPC-sourced data is current state, not the state at call
   time, so the view says "as of now" (`AsOfNow`). The raw output stays one click away ("Open full view" opens the
   existing tool detail modal). Why: the goal prefers structured data; history fidelity is only claimed when the
   data is historic.
5. **Where cards get data.** First from argv (ids, labels, notes, verdict, text), then enriched from Arc's stores
   by those ids through `wshdata.ts` (effort detail, run, dag digest, run events, roster, note). A missing object
   or a failed fetch still renders the card from argv alone, with the load error shown inline in muted text,
   never a blank or a crash. Why: argv is the record of what changed; stores add names and progress.
6. **One renderer cache.** `wshdata.ts` is a keyed jotai atom family with a 30 s freshness window (refetch on
   render after it, showing the old data meanwhile; one in-flight fetch per key). Each surface's own store is not
   reused, because the fixture seam would then need a seeding hook per store; the seam seeds this one cache.
   Run events are the exception: they come from `runeventstore.ts`, which is already live-updated, and the seam
   seeds that store.
7. **Every card keeps the call's facts.** Each card shows the call's duration and opens the call's raw command
   and output in the tool detail modal (a button with `aria-label="Show the command"`). Why: the goal requires
   durations, commands and exit codes to stay visible.
8. **Arc messages.** A `user` entry starting `wake:` is an engine wake; one starting `brainstorm:` is a line Arc
   typed for the brainstorm pane; the first `user` entry of a transcript whose host context says the agent is a
   run's lead, worker or stage agent (from the run lineage store, not text sniffing) is its brief. Wakes are
   classified by the engine's leading phrases (table in Task 12) with a generic "Arc woke the lead" fallback that
   shows the whole text, and are enriched from the run's event log. Why: the engine sends text, not kinds;
   changing the wake protocol is out of scope, and the fallback keeps an unknown wake readable.
9. **Open call 1, card wording:** kept exactly as drawn ("Arc woke the lead", "Run brief from Arc", "Task brief
   from Arc", "Answered for you", "Sent to"/"From", "Forwarded to you", "land held", "Chunk blocked", "Saved a
   note"). They are short, plain and say who acted.
10. **Open call 2, "picked in the brainstorm pane":** dropped. A pane pick reaches the agent as plain text by
    design (the agent must read it as the human's answer), so it renders as a normal user bubble. Marking those
    lines would change the brainstorm protocol the arc:brainstorm skill defines.
11. **Open call 3, "Waited Nm":** built. In a lead's transcript, a wake that follows the previous entry by at
    least `WAIT_FOLD_MIN_MS = 60_000` gets a "Waited <gap>" fold before it; its summary and opened list come from
    the run events in that gap (tasks landed, Final ran); with no events it reads "Waited <gap>" alone. Why:
    deterministic from timestamps and run events, and it explains a lead's silence.
12. **Message box while asking.** Send does not queue today (queued messages are chunk 9, pending), and typing
    into the pty while Claude's question picker is open would land in the picker. So while an answerable ask is
    shown, Send is disabled and the notice reads "Answer Claude's question first"; the canvas's "· Send queues your
    message" and "it waits for the turn to end" are left out until chunk 9 lands. Why: copy must be true.
13. **Stop and Send.** While working, the round button is Stop (`aria-label="Interrupt (Esc)"`) when the box is
    empty and Send (steer) when it holds text; Esc still interrupts. Why: the canvas draws only the empty state.
14. **Model chip effort.** The chip shows the model, plus the effort level only when the agent's status reports
    one. The context ring reads `usage.contextpct`, titled with tokens when `contextmax` is known.
15. **Prose colour and font.** The latest reply is `text-foreground`, older replies `text-secondary` (the boards
    draw exactly that, so `accentLatest` keeps its meaning). Replies keep `MarkdownMessage` and its
    `font-markdown` token (DESIGN.md: rendered markdown); the rest is `font-sans`/`font-mono`.
16. **Colours.** Every hex in the canvas is an existing `@theme` token: `#0c0e11` background, `#e6e9ed`
    foreground, `#cfd5db` secondary, `#9aa3ad` ink-mid, `#7f858b` muted, `#646a72` ink-faint, `#dfe4ea` ink-hi,
    `#13171d` surface-raised, `#171c22` surface-hover, `#1a222c` surface-selected, `#0b0d10` surface-code,
    `#0e1116` surface, `#12161b` lane, `#161a20` edge-faint, `#20262e` edge-mid, `#2a313a` edge-strong, `#5e9cff`
    accent, `#8da3ff` accenthover, `#aebfff` accent-soft, `#54c79a` success, `#e6b450` warning, `#e0726c` error,
    `#3fb950`/`#f85149` diff-added/diff-removed, `#d97757` provider-claude, `#c58cff`/`#dcc0ff` skill/skill-soft,
    `#8b939d`/`#cdd3da` syntax-punct/syntax-ident, `#7c95ff`/`#c9a4ff`/`#5cc8d8` graphlane-1/4/6 (the Runs token
    bar). `#3a414a` (one use) maps to edge-strong. No new tokens.
17. **Fold rules.** A stretch is a maximal run of consecutive tool steps, broken by prose, user entries, events
    and change cards. In a finished turn, a stretch of `CollapseRunThreshold` (3) or more steps folds into
    "Worked for N · <phrase> +a −d [✗ k failed]"; a shorter stretch renders as an open step box. While the agent
    is working, every stretch of the current turn stays open. In the Rendered view a stretch holding an image,
    test or git-diff card starts open (today's `hasCard` rule). N runs from the time of the entry before the
    stretch to the time of the entry after it (else the last step's end); without timestamps (Codex, pi,
    opencode) the line reads "Worked" with no time. The phrase replaces the now band's "done · 3m 05s · 2 tools".
18. **Line numbers in edit diffs** come from the Edit/Write result's `toolUseResult.structuredPatch`
    (`oldStart`/`newStart`); without it the diff has no number gutter. Git diff cards number lines from their
    `@@` headers.
19. **Links on cards** go through the router (`openTarget`/`openAddress` in
    `frontend/app/view/jarvis/openref.ts`) with the `AgentsViewModel` the host passes in `TranscriptContext`; a
    card with no model or no route for its target draws no link.
20. **Chunks.** This run is chunk 6 (Decide: visual direction vs DESIGN.md), recorded in DESIGN.md by Task 13. It
    also finishes chunk 5 (running tool with elapsed, Task 2), 7 (Worked for N, Task 2), 13 (pinned prompt bar,
    Task 4) and 15 (working line with turn time and output tokens, Task 4).

## Global constraints

- Colours and type from DESIGN.md and the `@theme` tokens only (decision 16); no raw hex, no new tokens.
- Keep these exports of `narrationtimeline.tsx` with their current signatures, since other files import them:
  `VERB`, `StatusSquare`, `ToolDetailBody` (brainstormui, nowlineview, permissionband, tooldetailmodal,
  toolrenderers), and `NarrationTimeline`.
- Keep these attributes, which scenarios and keybindings read: `data-find-turn` (user bubble and prose),
  `data-rendered-ask` (the Rendered ask card root; `bindings.ts` routes 1-9 by it), `data-rendered-scroll`,
  `data-rendered-column`, `data-rendered-empty`, `data-narration-fixture`, `data-permission-mark`,
  `data-composer-send`, `data-composer-interrupt`, and `ToolOutputRenderer`'s `data-card-view` and
  `data-raw-toggle` (motion-agent mounts it directly).
- Nothing the renderer shows today disappears: durations, commands, exit codes, diff counts, permission marks,
  compaction stats and summary, subagent results, insight callouts, Show more, charts, images, test and diff
  cards, "Open full view", the copy context menu.
- Permission UI (the band and its requests) is out of scope; only the "You allowed …" mark row is restyled.
- Unit tests assert structure and inserted values (keys, ids, counts, rounds, picked options, durations), never
  fixed UI wording; scenario steps may look for the drawn labels.
- Every new view, visual state and interaction is shown by a named scenario step; nothing is left to a manual
  check.

## Review focus

1. **Compound and quoted commands.** `cd C:/x && wsh effort chunk status "$E" 3 done --note "a && b"`, `FOO=1
   wsh …`, `wsh.exe`, a path to wsh, and `echo "wsh runs start"` (not a call) must classify right. Pinned by
   Task 1's parser tests.
2. **A change call that failed or is still running** must not render as a done card. Pinned by Task 2's layout
   tests.
3. **A card whose object is gone or whose fetch fails** must still render from argv with the error shown.
   Pinned by each card task's model test and one scenario step per family.
4. **Many cards for one object** must not fetch it N times. Pinned by Task 1's `wshdata` in-flight dedupe test.
5. **Transcripts without timestamps or commands** (Codex, pi, opencode projections) must still fold and render
   steps ("Worked" with no time, the verb and target as title). Pinned by Task 2's layout tests.

---

### Task 1: Interfaces: wsh call parser, renderer registry, data cache, fixture harness
**Depends on:** none
**Files:** `frontend/app/view/agents/wshcall.ts`, `frontend/app/view/agents/wshcall.test.ts`, `frontend/app/view/agents/transcriptcontext.ts`, `frontend/app/view/agents/transcriptcontext.test.ts`, `frontend/app/view/agents/wshdata.ts`, `frontend/app/view/agents/wshdata.test.ts`, `frontend/app/view/agents/wshrenderers.tsx`, `frontend/app/view/agents/wshcards-initiative.tsx`, `frontend/app/view/agents/wshcards-dag.tsx`, `frontend/app/view/agents/wshcards-dagactions.tsx`, `frontend/app/view/agents/wshcards-runs.tsx`, `frontend/app/view/agents/wshcards-agents.tsx`, `frontend/app/view/agents/wshcards-notes.tsx`, `frontend/app/view/agents/arcmessage.ts`, `frontend/app/view/agents/arcmessage.test.ts`, `frontend/app/view/agents/arcmessagerow.tsx`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/narrationfeedfixture.tsx`, `frontend/app/view/agents/runeventstore.ts`, `frontend/app/view/agents/runeventstore.test.ts`, `frontend/app/view/agents/renderregistry.ts`, `scripts/cdp/transcript-fixture.mjs`, `scripts/cdp/scenarios.mjs`
**Files:** `scripts/cdp/scenarios-transcript-base.mjs`, `scripts/cdp/scenarios-transcript-initiative.mjs`, `scripts/cdp/scenarios-transcript-dag.mjs`, `scripts/cdp/scenarios-transcript-dagactions.mjs`, `scripts/cdp/scenarios-transcript-runs.mjs`, `scripts/cdp/scenarios-transcript-agents.mjs`, `scripts/cdp/scenarios-transcript-notes.mjs`, `scripts/cdp/scenarios-transcript-arc.mjs`, `scripts/cdp/scenarios-transcript-boards.mjs`, `scripts/cdp/scenarios-rendered-shell.mjs`

Lands every seam the other tasks build on, so Task 2 and Task 4 run beside each other and Tasks 6-12 each fill
one file of their own.

**Interfaces produced** (exact names; later tasks rely on them):

- `wshcall.ts`:
  - `interface WshCall { path: string[]; args: string[]; flags: Record<string, string | true> }` — `path` is the
    subcommand chain (`["effort","chunk","status"]`, `["jarvis","dag","submit"]`, `["runs","show"]`), `args` the
    positionals after it, `flags` long flags (`--note x`, `--note=x`). Boolean flags never take the next word;
    the set is every `Bool` flag the wsh commands define today: `--all --archived --autonomous --continue --force
    --force-land --hold-land --inject --json --others --reviewer-picks --round --start --tasks --wait --yes`
    (`WSH_BOOL_FLAGS`, one exported constant).
  - `parseWshCalls(command: string): WshCall[]` — shell-word tokenising (single/double quotes, backslash escapes,
    `&&`, `||`, `;`, `|`, newlines), skipping leading `VAR=value` assignments; a wsh invocation is a command word
    whose basename is `wsh` or `wsh.exe` (any path) in command position, never inside a quoted string.
  - `type WshViewKey = "effort-show" | "effort-list" | "dag-status" | "runs-show" | "runs-attention" |
    "agents-list" | "jira-show"`.
  - `type WshCardKey = "effort-create" | "chunk-status" | "effort-advance" | "chunk-add" | "chunk-note" |
    "runs-start" | "runs-answer" | "dag-submit" | "dag-planreview" | "dag-review" | "dag-final" |
    "jarvis-complete" | "dag-answer" | "dag-tell" | "dag-amend" | "dag-retry" | "dag-forward" | "dag-escalate" |
    "dag-merge" | "dag-skip" | "dag-sendback" | "agents-send" | "agents-read" | "note-add" | "brainstorm-judge" |
    "ui-reveal" | "other-change"`; `type WshKey = WshViewKey | WshCardKey`.
  - `wshKey(call: WshCall): WshKey | null` — the table: `effort show|list` → views; `effort create`, `effort
    advance`, `effort chunk status|add|note` → their keys; `runs show|attention` → views; `runs start|answer` →
    cards; `jarvis dag status` → view; `jarvis dag submit|planreview|review|final|answer|tell|amend|retry|
    forward|escalate|merge|skip|sendback` → `dag-*`; `jarvis complete` → `jarvis-complete`; `agents list` → view;
    `agents send|read` → cards; `note add` → `note-add`; `jira show` → view; `brainstorm judge` →
    `brainstorm-judge`; `ui reveal` → `ui-reveal`. These other changing verbs → `other-change`: effort
    `rename|project|ticket|status|unarchive|link|unlink|delete|reopen` (`wsh effort reopen <effort> <chunk>` is
    effort-level, not under chunk), effort chunk `rename|move|remove|stage|owner|attach|detach`, runs `cancel|end-final|rerun-final|land|ack`, jarvis dag
    `cancel|goalpost`, `note delete`, `brainstorm check`, `ui do`. Anything else → `null` (a plain step).
  - `isCardKey(key: WshKey): key is WshCardKey`.
  - `firstWshCall(command: string | undefined): { call: WshCall; key: WshKey } | null` — the first call with a
    non-null key.
  - `wshJsonOutput<T>(command: string | undefined, output: string | undefined, exit: number | undefined): T |
    null` — the parsed output when the call carried `--json`, exited 0 and parses; else null.
- `transcriptcontext.ts`: `interface TranscriptContext { model?: AgentsViewModel; agentId?: string; role?: RunRole;
  channelId?: string; effortId?: string; brainstormFile?: string }` (`RunRole` from `runlineage.ts`) and
  `transcriptContextFor(input: { model?: AgentsViewModel; agent?: AgentVM; role?: RunRole; channelId?: string }):
  TranscriptContext`, which copies `agent.id`, `agent.effortId` and `agent.brainstormFile` (both `AgentVM`
  fields) along with the given model, role and channel.
- `wshdata.ts`: `type WshDataState<T> = { status: "idle" | "loading" | "ready" | "error"; data?: T; error?:
  string }`; `WSH_DATA_TTL_MS = 30_000`; `wshDataAtom(key: string)`; `useWshData<T>(key: string | null, fetch: ()
  => Promise<T>): WshDataState<T>` (null key = disabled; one in-flight fetch per key; refetch after the TTL while
  keeping the old data; a rejected fetch sets `error` with its message, logged once with the key); `seedWshData(seed:
  Record<string, unknown>): void` (seeded keys never expire).
- `wshrenderers.tsx`: `interface WshRendererProps { call: WshCall; wshKey: WshKey; action: AgentActionEntry; ctx:
  TranscriptContext; compact: boolean }`; `type WshRenderers = Partial<Record<WshKey,
  ComponentType<WshRendererProps>>>`; `WSH_RENDERERS` merging `INITIATIVE_RENDERERS` (wshcards-initiative),
  `DAG_RENDERERS` (wshcards-dag), `DAG_ACTION_RENDERERS` (wshcards-dagactions), `RUNS_RENDERERS` (wshcards-runs),
  `AGENTS_RENDERERS` (wshcards-agents), `NOTES_RENDERERS` (wshcards-notes); `wshRendererFor(key: WshKey)`; and
  `AsOfNow` (a muted "as of now" marker for RPC-sourced views, decision 4). Each family module is created here
  exporting its empty map. A view key's component renders the opened body of its step; a card key's component
  renders the whole standalone card. `renderregistry.ts`'s header comment, which calls itself "the one place a
  renderer is registered", is updated to name `wshrenderers.tsx` as the registry for wsh calls.
- `wshcards-dag.tsx` also exports `FinalVerdictCard(props: { passed: boolean; round?: number; total?: number;
  sha?: string; text?: string; runId?: string; ctx: TranscriptContext; compact: boolean })` as a stub (draws
  "Final passed|failed" and the text plainly); Task 7 fills it and keeps the signature, and Task 12 uses it.
- `arcmessage.ts`: `type ArcMessage = { kind: "wake"; text: string } | { kind: "brief"; role: RunRole["kind"];
  text: string } | { kind: "brainstorm"; text: string }`; `arcMessageOf(entry: AgentEntry, isFirstUser: boolean,
  ctx?: TranscriptContext): ArcMessage | null` (decision 8: `wake:` and `brainstorm:` prefixes after trimming;
  brief only for the first `user` entry when `ctx.role` is set).
- `arcmessagerow.tsx`: `interface ArcMessageRowProps { message: ArcMessage; ts?: number; idleMs?: number; ctx:
  TranscriptContext; compact: boolean }` and `ArcMessageRow`, a stub that draws the message's text as a muted line
  so nothing is lost before Task 12.
- `NarrationTimeline` gains props `ctx?: TranscriptContext`, `compact?: boolean` and `tail?: React.ReactNode`;
  this task only accepts them and renders `tail` after the last item. The user bubble's root gains
  `data-user-bubble` (Task 4's pinned bar reads it).
- `runeventstore.ts`: `seedRunEvents(runId: string, events: RunEvent[]): void` (sets the run's atom and marks it
  loaded, so `ensureRunEvents` does not overwrite it).
- Fixture seam: `window.__narrationFeedFixture.show(entries, width, opts?: { ctx?: Omit<TranscriptContext,
  "model">; compact?: boolean; active?: boolean; renderers?: boolean; seed?: Record<string, unknown>; runEvents?:
  Record<string, RunEvent[]> })` seeds `wshdata` and run events, and passes `ctx` with the live
  `AgentsViewModel`, read from the cockpit route as `scripts/cdp/scenarios-motion-agent.mjs` already does
  (`DefaultRouter.routeMap.get("cockpit")?.model`; decision 19).
- `scripts/cdp/transcript-fixture.mjs`: `waitSeam(h)`, `showTranscript(h, { entries, width, ...opts })`,
  `clearTranscript(h)`, `ROOT` (the `[data-narration-fixture]` selector), and entry builders `user(text, ts)`,
  `prose(text, ts)`, `bash({ description, command, output, exit, ts, durationMs, pending })`, `tool(verb, target,
  extra)`. Each `scripts/cdp/scenarios-transcript-*.mjs` and `scenarios-rendered-shell.mjs` is a stub scenario
  object (`name`, `surface: "cockpit"`, `arrange`, `assert` with one "dev fixture seam present" step, `teardown`),
  registered in `scripts/cdp/scenarios.mjs` under the names on the Final line. Each family scenario module also
  exports `fixtures`, an object of named `{ entries, seed?, runEvents?, ctx? }` that Task 13 composes into
  boards.

**Acceptance:**
- [ ] `wshcall.test.ts`: every key in the table from a minimal command; quoted args with spaces; `--note=x` and
  `--note x`; `cd x && wsh …`, `A=1 wsh …`, `C:/bin/wsh.exe …`, `./wsh …`; each boolean flag before a positional leaves
  the positional in `args` (`wsh jarvis complete --hold-land report.md`, `wsh agents send --wait <tab> "hi"`, `wsh
  jarvis dag merge --continue t-3`, `wsh runs cancel --yes <id>`); `wsh effort reopen <e> 3` is `other-change`;
  two calls joined by `&&` return two
  `WshCall`s and `firstWshCall` takes the first keyed one; `echo "wsh runs start"`, `grep wsh file` and a heredoc
  body give no call; an unknown verb gives `null`; `wshJsonOutput` returns null for no `--json`, a nonzero exit, or
  bad JSON.
- [ ] `wshdata.test.ts`: two `useWshData` readers of one key cause one fetch; a seeded key never fetches; a rejected
  fetch yields `status: "error"` with the message; after `WSH_DATA_TTL_MS` a render refetches and keeps the old
  data until it lands.
- [ ] `arcmessage.test.ts`: `wake:` and `brainstorm:` entries classify; a non-first user entry with a role is not a
  brief; the first user entry without a role is not a brief.
- [ ] `transcriptcontext.test.ts` and `runeventstore.test.ts` (seed then `ensureRunEvents` keeps the seed).
- [ ] `npx vitest run frontend/app/view/agents/wshcall.test.ts frontend/app/view/agents/wshdata.test.ts
  frontend/app/view/agents/arcmessage.test.ts frontend/app/view/agents/transcriptcontext.test.ts
  frontend/app/view/agents/runeventstore.test.ts` passes, Check passes, and `ARC_FINAL_OUT=<tmp> node
  scripts/cdp/final-verify.mjs narration-feed transcript-base` passes (the existing feed is unchanged and the
  stub reaches the seam).

### Task 2: Layout model and placement: steps, Worked-for fold, cards outside the fold, running steps
**Depends on:** Task 1
**Chunk:** Fold finished tool stretches into Worked for N
**Chunk:** Running tool shows running with elapsed time
**Files:** `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/transcriptlayout.ts`, `frontend/app/view/agents/transcriptlayout.test.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/agentsviewmodel.test.ts`, `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/permissionmodel.ts`, `frontend/app/view/agents/permissionmodel.test.ts`, `frontend/app/view/agents/wshchangerow.tsx`, `frontend/app/view/agents/sessionsdetail.tsx`, `scripts/cdp/narrationfeed.mjs`, `scripts/cdp/scenarios-transcript-base.mjs`

The small task the card families wait on: the layout model and where each item goes, with the new step row and
fold line. Step bodies, events, bubbles and diffs are Task 3's, which runs beside the card tasks.

**Decisions:** decisions 3, 7 and 17 above, plus:
- Step row title, from the action: Bash → its `description` as the title and the command in mono beside it
  (command alone when there is no description); Read → "Read <file>" + path; Edit/Write → "Edited|Wrote <file>"
  + `+a −d`; Grep/Glob → "Searched" + pattern + "N matches"; AskUserQuestion → "Asked <question>" with the picked
  answer under it (check icon) or the typed one; Task → "Spawned <description>"; other tools → the verb and
  target as today. Right side: exit chip only for a failed command (`exit N`, error tint), duration, chevron.
  Stretches of fewer than 3 steps draw as a bordered step box; 3 or more in a finished turn as the fold line.
- Step status: ok, fail, running (no result yet: a spinner icon and the live elapsed from `startedTs`, ticking
  each second inside the row so the memoised timeline does not re-render), stopped (no result and an
  `interrupted` entry follows: "stopped" in place of the time, as in Events).
- Dispatch: a step whose `firstWshCall` is a view key opens to `wshRendererFor(key)` above a "Raw output · Open
  full view" footer; a successful change call (decision 3) is a `card` item drawn by `wshRendererFor(key)`, or by
  `WshChangeRow` (`wshchangerow.tsx`: icon, "wsh <path>" and its args, duration, the Show-the-command button)
  when its family has no renderer; `other-change` always uses `WshChangeRow`. An `arc` item draws
  `ArcMessageRow`. Other opened bodies keep today's `ToolDetailBody` until Task 3 restyles them.
- `AgentEntry`'s action gains `ts?: number` (tool_use time) and `command?: string` (the raw Bash command at
  tool_use, so a running call is recognised). `groupTimeline`, `TimelineItem`, `burstRenderMode`,
  `aggregateEditBurst`, `isEditAction` and `foldLabel` are replaced by the layout model: delete each one no
  longer referenced (grep tests and `scripts/` first), move `placeMarks` onto `LayoutItem[]`, and count
  `layoutTranscript` items where `sessionsdetail.tsx` counted `groupTimeline` items against
  `TIMELINE_RENDER_CAP`. `summarizeActions` stays (the details rail uses it). The Sessions detail also passes a
  `ctx` (`transcriptContextFor` with what it has: no role, the model when present).

**Interfaces produced** (`transcriptlayout.ts`):
- `interface Step { index: number; action: AgentActionEntry; wsh: { call: WshCall; key: WshKey } | null; status:
  "ok" | "fail" | "running" | "stopped" }`
- `interface FoldSummary { durationMs?: number; phrase: string; adds: number; dels: number; failed: number }` —
  `phrase` like "ran 2 commands, read retry.js, edited retry.js" (one file names it, more count it; kinds in
  first-appearance order).
- `type LayoutItem` = pass-through items for `message` (with `latest: boolean`), `user`, `command`,
  `compaction`, `notification`, `interrupted`, each with `index`; `{ kind: "arc"; index; message: ArcMessage; ts?;
  idleMs? }` (`idleMs` = time since the previous entry with a time); `{ kind: "steps"; startIndex; steps: Step[];
  fold: FoldSummary | null }`; `{ kind: "card"; index; step: Step }`.
- `layoutTranscript(entries: AgentEntry[], opts: { active: boolean; ctx?: TranscriptContext; threshold?: number
  }): LayoutItem[]` and `stepTitle(action: AgentActionEntry): { title: string; mono?: string }`.

**Acceptance:**
- [ ] `transcriptlayout.test.ts`: a finished turn of 4 steps folds with the duration from the prompt's time to the
  reply's; 2 steps stay a box; the live turn's stretches stay open while `active` and fold once it is not; a
  successful `wsh effort chunk status … done` splits the stretch into steps, card, steps; the same call with
  `exit 1` stays a failed step and a pending one a running step; a pending action followed by `interrupted` is
  `stopped`; a `wake:` user entry becomes an `arc` item with `idleMs`; entries with no `ts` or `command` (a Codex
  projection) fold with `durationMs` undefined; the phrase and +/− totals for a mixed stretch.
- [ ] `transcriptprojection.test.ts` (action `ts` and `command`, including a pending Bash);
  `agentsviewmodel.test.ts` and `permissionmodel.test.ts` updated for the removed and moved functions.
- [ ] `npx vitest run` on those four test files passes; Check passes.
- [ ] `transcript-base` scenario (fixture, 736 px and 380 px), steps with screenshots: "fold: a finished
  four-step stretch reads Worked for N with its phrase and +/−, opens on a click and folds again"; "box: a
  two-step stretch draws as a step box"; "running: a pending Bash shows the spinner and its elapsed ticking";
  "change call: a successful `wsh effort rename …` draws a WshChangeRow outside the fold, the failed one a failed
  step". `narration-feed` is updated to the new fold line and step rows and passes; `motion-agent` passes
  unedited (it mounts `ToolOutputRenderer` and the Sessions detail).

### Task 3: Step bodies, events, bubbles and diffs
**Depends on:** Task 2
**Files:** `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/app/view/agents/tooldetail.ts`, `frontend/app/view/agents/tooldetail.test.ts`, `frontend/app/view/agents/unifieddiff.ts`, `frontend/app/view/agents/unifieddiff.test.ts`, `frontend/app/view/agents/agentsviewmodel.ts`, `frontend/app/view/agents/transcriptprojection.ts`, `frontend/app/view/agents/transcriptprojection.test.ts`, `frontend/app/view/agents/toolrenderers.tsx`, `frontend/app/view/agents/tooldetailmodal.tsx`, `scripts/cdp/narrationfeed.mjs`, `scripts/cdp/scenarios-transcript-base.mjs`

Boards: Main, StepsOpen, Events, Compact (timeline part), and the bubbles in Working and Composing.

**Decisions:** decisions 15 and 18 above, plus:
- Opened step bodies, as StepsOpen and Main draw them: grep matches as `file:line  code` rows; a command as `$
  cmd`, output, and an `exit N` chip; a test card (counts, failure rows, "Raw output, N lines" + "Open full
  view"); an edit as a diff card with the file header and line-number gutter; a read snippet; an ask's options.
  Bodies past `DETAIL_INLINE_MAX` still open the modal.
- `DiffLine` gains `oldNo?: number; newNo?: number`, filled from `toolUseResult.structuredPatch` in the
  projection and from `@@` headers in `unifieddiff.ts`.
- Events per the Events board: "Context compacted · pre → post tokens · trigger" (opens the summary); a typed
  slash command as a right-aligned chip; a model-invoked skill as a ✦ chip; "Subagent finished · <summary> ·
  <status>" (opens the result); "You allowed <mark text>" for permission marks; "You interrupted" divider.
- User bubble: plain `surface-hover` bubble, right-aligned, no "You" label, keeping the measured Show more clamp,
  `data-find-turn` and `data-user-bubble`. Prose: no avatar (decision 15).

**Acceptance:**
- [ ] `tooldetail.test.ts`, `unifieddiff.test.ts`, `transcriptprojection.test.ts`: line numbers from
  `structuredPatch` and from `@@` headers; none without either.
- [ ] `npx vitest run` on those three files passes; Check passes.
- [ ] `transcript-base` scenario, one step per board, each with a screenshot: "Main: Worked for fold opened, steps
  with commands and times, edit diff with line numbers, answered question, reply"; "StepsOpen: grep matches, test
  card with Raw output and Open full view, command output with exit 0, the fold line's 1 failed"; "Events:
  compaction, slash command chip, skill chip, subagent finished, You allowed, stopped step, You interrupted";
  "Compact: the same turn at 380 px with a running step". `narration-feed` asserts the open step body with "Open
  full view" and wrapping at 360 px, and passes; `motion-agent` passes unedited.

### Task 4: Rendered shell: pinned prompt, working line in the column, empty and loading, hosts
**Depends on:** Task 1 (uses `TranscriptContext`, `transcriptContextFor`, the timeline's `ctx`/`compact`/`tail` props and `data-user-bubble`)
**Chunk:** Pinned prompt bar once scrolled past it
**Chunk:** Working line: turn time and output tokens
**Files:** `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/nowline.ts`, `frontend/app/view/agents/nowline.test.ts`, `frontend/app/view/agents/nowlineview.tsx`, `frontend/app/view/agents/spinnerrow.ts`, `frontend/app/view/agents/spinnerrow.test.ts`, `frontend/app/view/agents/pinnedprompt.ts`, `frontend/app/view/agents/pinnedprompt.test.ts`, `frontend/app/view/agents/transcriptskeleton.tsx`, `frontend/app/view/agents/sticktobottom.tsx`, `frontend/app/view/agents/agentrow.tsx`, `frontend/app/view/agents/leadcard.tsx`, `frontend/app/view/agents/endedtranscript.tsx`, `frontend/app/view/agents/subagentinterior.tsx`, `frontend/app/view/agents/narrationfeedfixture.tsx`, `scripts/cdp/scenarios-rendered-shell.mjs`, `scripts/cdp/scenarios-motion-agent.mjs`

Boards: Working, Empty, Loading, Compact (working line), and Composing's Latest pill.

**Decisions:**
- The now band goes. Its facts move: "done · duration · tools" into Task 2's fold line; the working state into a
  working line drawn as the timeline's `tail`, right after the last item: spinner glyph and verb (provider-claude
  colour), turn elapsed, output tokens, tool count ("✻ Cogitating… 24s · ↓ 1.8k tokens · 4 tools"). Without a
  spinner row on screen it reads "Working · 24s · 4 tools". The running call's verb and target are no longer on
  this line: Task 2's running step row carries them with their own elapsed. Hidden while asking or a permission
  request is docked, as today. The compact hosts (agent row, lead card) draw it too, without the tool count (the
  Compact board).
- `nowline.ts` keeps `nowLineState` and gains the output tokens, parsed by `spinnerrow.ts` from the spinner
  detail's "↓ 4.5k tokens"; the view becomes `WorkingLine({ line, compact })`, a pure view of a `NowLine`.
- Pinned prompt bar (Working board): once the last user bubble (`[data-user-bubble]`) has scrolled above the
  scroll area's top, a bar pinned at the top of the scroll area shows that prompt on one truncated line; a click
  scrolls the bubble into view (`aria-label="Jump to your last message"`). `pinnedprompt.ts` holds the pure
  decision (which entry, whether shown) from the bubble's and the scroller's rects.
- Latest pill restyled as drawn (Composing: "↓ Latest", `title="Jump to latest"`); Empty: the centred line
  "No transcript for this session yet." on the background; Loading: the skeleton as drawn, `role="status"
  aria-label="Loading the transcript"`.
- Hosts (all but the Sessions detail, which is Task 2's) build `ctx` with `transcriptContextFor` from the agent
  and the run lineage (role, channel), pass
  `compact` for agent row, lead card and subagent interior, and pass the working line as `tail` in the Rendered
  view, agent row and lead card.
- The fixture seam gains `opts.nowLine?: NowLine`, drawn as `tail` through `WorkingLine`.

**Acceptance:**
- [ ] `nowline.test.ts` (tokens carried, call no longer on the line, hidden while docked), `spinnerrow.test.ts`
  (tokens parsed from the detail, absent when not shown), `pinnedprompt.test.ts` (shown only when the last
  bubble is above the top; none without a user entry).
- [ ] `npx vitest run` on those three files passes; Check passes.
- [ ] `rendered-shell` scenario (live Rendered view on a fixture tab with a transcript, as `agent-rendered`
  builds them with `agent-page-fixtures.mjs`), each step with a screenshot: "Working: scrolled past the prompt,
  the pinned bar shows it and a click brings the bubble back; the working line sits under the running step with
  the spinner, elapsed, tokens and tool count"; "Empty: a tab with no transcript shows the centred line";
  "Loading: a tab whose transcript has not loaded shows the skeleton with role=status"; "Latest: scrolled up,
  the Latest pill shows and a click returns to the bottom"; "Compact: the fixture at 380 px with a `nowLine`
  draws the working line without the tool count"; "Composing: a long prompt is clamped with Show more, and a
  click on Show more opens it whole". `motion-agent` is updated from `data-now-line` to the working
  line and passes. `scenarios-agent-rendered.mjs` steps this breaks are Task 5's to update.

### Task 5: Message box and the ask card
**Depends on:** Task 3 (its agent-rendered steps assert the new step bodies and events), Task 4
**Files:** `frontend/app/view/agents/renderedcomposer.tsx`, `frontend/app/view/agents/headercontrols.tsx`, `frontend/app/view/agents/agentheader.tsx`, `frontend/app/view/agents/answerbar.tsx`, `frontend/app/view/agents/attachmenttray.tsx`, `frontend/app/view/agents/renderedview.tsx`, `frontend/app/view/agents/renderedmode.ts`, `frontend/app/view/agents/renderedmode.test.ts`, `scripts/cdp/scenarios-agent-rendered.mjs`

Boards: Asking, MultiQuestion, Composing (the box), and the box in Main and Working.

**Decisions:** decisions 2, 12, 13 and 14 above, plus:
- The box as drawn: one rounded `surface-raised` pill, the placeholder as its first line ("Reply to <agent
  name>, @ to mention, / for commands" idle; "Steer the agent; it reads this before its next step" working;
  "Message <name>, @ to mention, / for commands" for a new agent), then a row: attach (+), the model chip
  (opens the model menu, as the header chip did), the permission-mode chip (opens the mode menu), a spacer, the
  context ring with its percent, and the round Send/Stop. The key-hint footer goes. Attachments sit above the
  text as drawn in Composing (chip, preview, "upload failed" + Retry).
- `HeaderControls` splits so its two chips render in the box; `agentheader.tsx` hides them while Rendered shows.
- The ask card moves from the dock into the scroll column, after the last item: a "Needs your input" label, then
  the warning-tinted card with the header, question, numbered options (1-9), "or type your own answer…", and the
  key hint; with several questions, tabs at the top, and a multi-select question's options as checkboxes with
  "k/n answered · press Enter to submit" (MultiQuestion). Its root keeps `data-rendered-ask`, and `askDocked`
  keeps its meaning (`agentsurface.tsx` reads it for the rail). The cockpit's other
  `AnswerBar` hosts (agent row, lead card, child ask card, channels) keep their current look.

**Acceptance:**
- [ ] `renderedmode.test.ts` covers the box's state from agent state and ask (idle, working, asking → Send
  disabled with the notice); Check passes.
- [ ] `agent-rendered` scenario: every step Task 2, 3 or 4 broke is updated to the new markup (band, composer,
  header controls, now line, card bursts, test and diff cards), and new steps with screenshots: "Asking: the
  card sits in the column under Needs your input; 2 answers it; Send is disabled with the notice"; "MultiQuestion:
  two tabs, the second multi-select with two picked, 1/2 answered"; "Composing: two attachments above the text,
  one failed with Retry"; "box idle: model chip, mode chip and context ring in the box, none in the header;
  working: the Stop button interrupts". The whole scenario passes, and `motion-agent` passes (it mounts
  `AnswerBar`).

### Task 6: Initiative cards and views
**Depends on:** Task 2 (renders through its layout and registry wiring)
**Files:** `frontend/app/view/agents/wshcards-initiative.tsx`, `frontend/app/view/agents/initiativecards.ts`, `frontend/app/view/agents/initiativecards.test.ts`, `scripts/cdp/scenarios-transcript-initiative.mjs`

Boards: Initiative, EffortList, Jira (initiative created, noted on chunk, chunk blocked), CompactInitiative
(chunk done, chunk blocked). Keys: `effort-show`, `effort-list`, `effort-create`, `chunk-status`,
`effort-advance`, `chunk-add`, `chunk-note`.

**Decisions:**
- Data: `EffortGetCommand`/`EffortListCommand` (or the call's `--json` output) through `wshdata` keyed
  `effort:<oid>` and `efforts`; chunk numbers in argv are 1-based as in `wsh effort show`.
- `effort-show` view: header (title, project · status, "k of n done", Open), the first 5 chunks with number,
  status dot, label and note count, then "N more chunks" expanding the rest. `effort-list` view: a progress table
  (title, ticket, bar, done/total, current chunk) of the first 7, then "N more initiatives".
- Cards: `chunk-status done` and `effort-advance` → "Chunk done" (number. label, the `--note` text, progress
  bar "k of n done", Open); `chunk-status blocked` → "Chunk blocked" with "needs: <note>" and "Shows in the
  briefing's attention banner until it moves"; other statuses → a one-line "Chunk <n> <status>" row;
  `chunk-add` → "Added chunk" (n. label · initiative); `chunk-note` → "Noted on chunk <n>" + note; `effort-create`
  → "Initiative created" (title, ticket, Open, its chunks and "0 of n done"). Compact variants per
  CompactInitiative.

**Acceptance:**
- [ ] `initiativecards.test.ts`: the card model for each key from argv alone and with an effort record (label,
  progress, note); an advance resolves its chunk from the record; a missing effort yields the argv-only model with
  the error; status words map to the right card kind.
- [ ] `npx vitest run frontend/app/view/agents/initiativecards.test.ts` passes; Check passes.
- [ ] `transcript-initiative` scenario (fixture with seeded effort data), screenshots each: "effort show opened
  as a chunk list with 13 more"; "effort list as a progress table"; "Chunk done card outside the fold with
  progress"; "Added chunk and Noted on chunk rows"; "Initiative created with its chunks"; "Chunk blocked with
  needs"; "compact Chunk done and Chunk blocked at 380 px"; "an unknown effort id still draws the Chunk done card
  with the load error". It exports `fixtures` for Task 13.

### Task 7: Run cards: plan, verdicts, completion, dag status
**Depends on:** Task 2 (renders through its layout and registry wiring)
**Files:** `frontend/app/view/agents/wshcards-dag.tsx`, `frontend/app/view/agents/dagcards.ts`, `frontend/app/view/agents/dagcards.test.ts`, `scripts/cdp/scenarios-transcript-dag.mjs`

Boards: RunLeadPlan (Plan submitted), RunLeadBuild (dag status opened, Run complete), Worker (Task complete,
Task review passed / sent back), FinalFail (Fix round submitted, Run complete with the land held), CompactLead
(dag status, run complete). Keys: `dag-submit`, `dag-planreview`, `dag-review`, `dag-final`, `jarvis-complete`,
`dag-status`.

**Decisions:**
- Data: `DagStatusCommand` for the agent's run (`ctx.role`'s run id and `ctx.channelId`) through `wshdata`
  keyed `dag:<runId>`; the run object keyed `run:<runId>`.
- `dag-submit` → "Plan submitted" (tasks · lanes · longest chain, a Plan link, the lane grid of task ids and
  labels with "after t-n" for dependencies, and the plan review status line); with `--round` → "Fix round
  submitted" (round n, "k tasks · the last round" when it is the last, the task list).
- `dag-review pass|fail` (a task reviewer) → "Task review · t-n · passed|sent back", round when known, the note
  as body. `dag-planreview` → "Plan review · passed|failed|accepted" with its text. `dag-final pass|fail` (the
  verifier) → "Final · passed|failed", round, merged-result sha, Shots link, its text.
- `jarvis-complete`: a worker (`ctx.role.kind === "worker"`) → "Task complete · t-n · commit <sha> · Report"
  and "The engine takes it from here: review, then merge."; a lead → "Run complete · landed <sha> on main ·
  Report" with tasks, failures, elapsed, commits, questions to you; when the land is held → "Run complete · land
  held · <why>" with the branch and the `wsh runs land <id> --force` line, as FinalFail draws.
- `dag-status` view: header (status, k of n done, parallelism), one row per task (id, state pill, label, commit
  sha or elapsed or idle); compact rows per CompactLead.

**Interfaces:** fills Task 1's `FinalVerdictCard` stub in `wshcards-dag.tsx` with the "Final · passed|failed"
card drawn in RunLeadBuild, keeping its signature exactly (`{ passed; round?; total?; sha?; text?; runId?; ctx;
compact }`): it is used for `dag-final` here and by Task 12 under a "Run finished" wake.

**Acceptance:**
- [ ] `dagcards.test.ts`: lanes and "after" edges from a task group; review and final verdict models from argv;
  worker vs lead complete from `ctx.role`; land held from the run's state; argv-only models when the run is
  missing.
- [ ] `npx vitest run frontend/app/view/agents/dagcards.test.ts` passes; Check passes.
- [ ] `transcript-dag` scenario (fixture with seeded dag and run data), screenshots each: "Plan submitted with the
  lane grid and review status"; "Fix round submitted, the last round"; "dag status opened with four task states";
  "Task complete in a worker's transcript"; "Task review passed and sent back"; "Final passed with Shots"; "Run
  complete landed with its stats"; "Run complete with the land held"; "compact dag status and Run complete at 380
  px". It exports `fixtures` for Task 13.

### Task 8: Lead action cards: answer, tell, amend, retry, forward, escalate, merge, skip, sendback
**Depends on:** Task 2 (renders through its layout and registry wiring)
**Files:** `frontend/app/view/agents/wshcards-dagactions.tsx`, `frontend/app/view/agents/dagactioncards.ts`, `frontend/app/view/agents/dagactioncards.test.ts`, `scripts/cdp/scenarios-transcript-dagactions.mjs`

Boards: RunLeadPlan (Amended), RunLeadBuild (the worker question the lead answered, Told), LeadRecovery
(Retried, Asked Arc to merge, Forwarded to you, Escalated), CompactLead (Amended). Keys: `dag-answer`,
`dag-tell`, `dag-amend`, `dag-retry`, `dag-forward`, `dag-escalate`, `dag-merge`, `dag-skip`, `dag-sendback`.

**Decisions:**
- One-line action rows (icon, verb, task id, text) for `Told` (quoted text), `Amended` (note), `Retried` ("a
  fresh worker starts when a slot is free"), `Escalated` (the model it re-queued on, from the run's events when
  known), `Asked Arc to merge`, `Skipped`, `Sent back` (guidance).
- `dag-forward` → "Forwarded to you · t-n · waits on you · Answer in the run" with the note as body.
- `dag-answer` → the worker's question card as drawn in RunLeadBuild: task id, label, header, question, the
  options with the picked one checked, and "The lead answered · delivered to t-n". The question and options come
  from the run's `child-ask` event for that task (run events); argv's answers JSON picks the option.

**Acceptance:**
- [ ] `dagactioncards.test.ts`: each key's row model from argv; the answer card matches its `child-ask` event and
  marks the picked option; with no event it shows the answers alone.
- [ ] `npx vitest run frontend/app/view/agents/dagactioncards.test.ts` passes; Check passes.
- [ ] `transcript-dagactions` scenario (fixture with seeded run events), screenshots each: "worker question
  answered by the lead"; "Told and Amended rows"; "Retried, Asked Arc to merge and Escalated rows"; "Forwarded to
  you with its note"; "compact Amended at 380 px". It exports `fixtures` for Task 13.

### Task 9: Runs views and cards
**Depends on:** Task 2 (renders through its layout and registry wiring)
**Files:** `frontend/app/view/agents/wshcards-runs.tsx`, `frontend/app/view/agents/runscards.ts`, `frontend/app/view/agents/runscards.test.ts`, `scripts/cdp/scenarios-transcript-runs.mjs`

Boards: Runs, Initiative (Run started), CompactInitiative (Run started). Keys: `runs-show`, `runs-attention`,
`runs-start`, `runs-answer`.

**Decisions:**
- Data: `runs show --json` output (`{ channel, channelid, run, dag, asks }`) or the run and its dag digest by
  id; `runs attention --json` (the items) or `GetAttentionCommand`; `RunUsageCommand` for tokens by role.
- `runs-show` view: title, landed sha pill, Open; stat tiles (tasks, elapsed, plan review, Final); tokens total
  with mode/model and the by-role bar with legend (graphlane tokens); the first 4 tasks with sha or "no commit",
  then "N more tasks"; unverified notes.
- `runs-attention` view: "nothing waiting" in the step row's summary when empty; else one row per item.
- `runs-start` → "Run started · <title> · <status pill> · Open run" with mode · runtime model, run id, and "for
  chunks a, b of <initiative>" when the run is linked to chunks; the run id comes from `--json` output or the run
  whose goal matches, created at the call's time.
- `runs-answer` → "Answered for you · <question> · run <id> · Open run" with the chosen answer(s) checked.

**Acceptance:**
- [ ] `runscards.test.ts`: the show view model from `--json` output and from a run + digest; attention empty vs
  items; run started's chunk line; answered card from argv answers.
- [ ] `npx vitest run frontend/app/view/agents/runscards.test.ts` passes; Check passes.
- [ ] `transcript-runs` scenario (fixture with seeded run data), screenshots each: "runs show opened as a run
  summary with the token bar"; "runs attention with nothing waiting"; "Answered for you"; "Run started with its
  chunks"; "compact Run started at 380 px". It exports `fixtures` for Task 13.

### Task 10: Agent-to-agent cards and views
**Depends on:** Task 2 (renders through its layout and registry wiring)
**Files:** `frontend/app/view/agents/wshcards-agents.tsx`, `frontend/app/view/agents/agentscards.ts`, `frontend/app/view/agents/agentscards.test.ts`, `scripts/cdp/scenarios-transcript-agents.mjs`

Boards: Agents, CompactInitiative (Sent to). Keys: `agents-list`, `agents-send`, `agents-read`, `ui-reveal`.

**Decisions:**
- Data: `agents list --json` rows or `AgentsListCommand`; the tab id in argv resolves to the agent's name through
  the roster (`AgentsListCommand` keyed `agents`), else the id is shown.
- `agents-list` view: one row per agent (state dot, name, run or project or state, short id). `agents-send` →
  "Sent to <name>" with the sent text as body ("joined its running turn" when the target was working, from the
  call's output only if it ran with `--json`, else omitted). `agents-read` → "From <name> · Open agent" with the
  answer text from `--json` output or the call's output body. `ui-reveal` → "Showed in Arc <name>" for an agent
  address, "Opened in Arc <path>" for a file.

**Acceptance:**
- [ ] `agentscards.test.ts`: names resolved from the roster and falling back to ids; send and read models; reveal
  wording chosen by address kind.
- [ ] `npx vitest run frontend/app/view/agents/agentscards.test.ts` passes; Check passes.
- [ ] `transcript-agents` scenario (fixture with seeded roster), screenshots each: "agents list opened"; "Sent to
  with its text"; "From with Open agent"; "Showed in Arc and Opened in Arc rows"; "compact Sent to at 380 px". It
  exports `fixtures` for Task 13.

### Task 11: Notes, Jira and the brainstorm judge
**Depends on:** Task 2 (renders through its layout and registry wiring)
**Files:** `frontend/app/view/agents/wshcards-notes.tsx`, `frontend/app/view/agents/notescards.ts`, `frontend/app/view/agents/notescards.test.ts`, `scripts/cdp/scenarios-transcript-notes.mjs`

Boards: EffortList (Saved a note), Jira (jira show), Brainstorm (Judge started), CompactInitiative (note saved).
Keys: `note-add`, `jira-show`, `brainstorm-judge`.

**Decisions:**
- `note-add` → "Saved a note · <title> · Open note" with the note's first bullets as body, read from the note
  (`NoteListCommand`/the vault note) through `wshdata`, else the title alone.
- `jira-show` view: the ticket card (key, summary, type · status, Open in Jira, description clamped with "Show the
  full description", attachments as tiles, the newest comment line, the Arc project) from `--json` output or
  `JiraShowCommand`.
- `brainstorm-judge` → "Judge started · question n · k approaches · weighing <elapsed>" while the agent's judge
  record (`ctx.brainstormFile`, the brainstorm store) says it is reading, "done" after; the approach question's
  text as body.

**Acceptance:**
- [ ] `notescards.test.ts`: note card from argv and from a note record; the ticket model from `JiraShowCommand`'s
  shape with the description clamp flag; judge state from the judge record.
- [ ] `npx vitest run frontend/app/view/agents/notescards.test.ts` passes; Check passes.
- [ ] `transcript-notes` scenario (fixture with seeded note, ticket and brainstorm data), screenshots each: "Saved
  a note with its bullets"; "jira show opened as a ticket card"; "Judge started, weighing"; "compact Saved a note
  at 380 px". It exports `fixtures` for Task 13.

### Task 12: Arc messages: wakes, briefs, brainstorm lines, Waited
**Depends on:** Task 2 (its layout produces the `arc` items this renders)
**Files:** `frontend/app/view/agents/arcmessagerow.tsx`, `frontend/app/view/agents/arcmessagemodel.ts`, `frontend/app/view/agents/arcmessagemodel.test.ts`, `scripts/cdp/scenarios-transcript-arc.mjs`

Boards: RunLeadPlan (brief, plan review failed and passed wakes), RunLeadBuild (task asks, run finished, Final
passed), Worker (Task brief), LeadRecovery (never started, merge conflict, may be stuck, failed), FinalFail
(final failed wakes, Waited), Brainstorm (judge result, pane actions, builder check), CompactLead (wakes).

**Decisions:** decisions 8, 10 and 11 above, plus:
- Wake classification by leading phrase (from `pkg/orchestrate/queue.go`, `wake.go` and `basecheck.go`, and the
  approvals wakes `AutonomousOnWake`/`AutonomousOffWake` in `pkg/jarvis/leadprompt.go`), each giving the
  headline and its parts: "plan review failed in round n[, the last]" → "Plan review failed · round n · k
  findings" (findings split on their `n)` numbering, opened by default); "the plan reviewer did not finish";
  "task t-n never started" → "t-n never started · no worker process Nm after spawn"; "merge conflict landing
  lane ending at task t-n[ in <files>]" → "Merge conflict · landing the lane ending at t-n" with the files;
  "task t-n may be stuck: <reason>"; "task t-n failed (<kind>)[, retry spent]" → "t-n failed · <kind> · retry
  spent" with the failure lines; "task t-n hung", "…'s worker ended its turn…", "…'s worker exited…"; "the final
  stage failed on the merged result in round n[, the last]" → "Final failed · round n of m · on the merged
  result <sha> · k defects · Shots" with the defects; "a step of the final stage was killed"; "run finished" →
  "Run finished · all n tasks landed" plus Task 7's `FinalVerdictCard` from the run's `final-ended` event when
  it passed; "n question(s) waiting" → "t-n asks a question · deadline in <time>" from the `child-ask` event; "Verify
  failed after merging task t-n"; "review failed for task t-n"; "task t-n passed review with a note…"; "the engine
  is stuck"; approvals autonomous/back to Ask me. Anything else → "Arc woke the lead" with the text. A wake
  holding several lines (`composeWake`) draws one row per line under one "Arc woke the lead" header.
- Plan review passed is not a wake text today; it shows from the run's plan-review event in the gap before the
  next lead entry ("Plan review passed · round n · k tasks dispatched").
- Briefs: folded "Run brief from Arc" (the run's goal line; plan skill · autonomous from the run), "Task brief
  from Arc" (t-n: the task label), "Brief from Arc" for a stage agent; opened, the brief's full text as markdown.
- Brainstorm lines: `brainstorm: judged <path>` → "The judge weighed question n · picks <name> · dropped k" with
  the kept and dropped approaches and reasons, from the question's judge record in the brainstorm file (the
  brainstorm store); `brainstorm: judge failed: <reason>`; `brainstorm: builder questions <path>` → "Builder check
  · k questions back · Spec" with the answered / minor / for-you counts; pane actions (`confirm every guess`,
  `keep every change`, `guess`, `skip questions`, `check`, `approved`, `keep talking`, `settle …`, `edit <part>:`,
  `builder answer:`, `builder decide`, `run <id>`) → "In the brainstorm pane, you <phrase>" with its count when it
  has one. The pane's line builder (`brainstormLine` in `brainstormmodel.ts`) and `pkg/brainstormcheck` line
  heads are the source of these prefixes; the model test imports `brainstormLine` to build its inputs, so a
  renamed line breaks the test, not the screen.
- Waited: decision 11, rendered before the wake row.

**Acceptance:**
- [ ] `arcmessagemodel.test.ts`: each wake phrase above to its headline parts (inputs built from the Go format
  strings' shapes, asserting the extracted task ids, rounds, counts and files, not wording); an unknown wake falls
  back; a multi-line wake yields one part per line; the brief model by role; every `brainstormLine` action's line
  classifies except `answer` (plain text, which stays a user bubble, decision 10) and `settle` (which returns
  null: its line is built with `settleLine` from `brainstormmodel.ts`, and that line classifies); Waited only at or above `WAIT_FOLD_MIN_MS` and its summary from run events in the gap.
- [ ] `npx vitest run frontend/app/view/agents/arcmessagemodel.test.ts` passes; Check passes.
- [ ] `transcript-arc` scenario (fixture with seeded run events and a brainstorm record), screenshots each: "Run
  brief folded and opened"; "Task brief"; "plan review failed with two findings, then passed"; "t-4 asks a
  question"; "never started, merge conflict with its file, may be stuck, failed with its test lines"; "Final
  failed round 1 of 2 and the last round"; "Waited 38m opened to its events"; "Run finished with Final passed";
  "judge result with kept and dropped approaches"; "pane actions and the builder check"; "a pane pick is a plain
  user bubble"; "an unknown wake reads Arc woke the lead with its text"; "compact wakes at 380 px". It exports
  `fixtures` for Task 13.

### Task 13: The wsh boards end to end, and the transcript look in DESIGN.md
**Depends on:** Task 3 (the boards show its step bodies and events), Task 6 (composes their fixtures), Task 7 (composes their fixtures), Task 8 (composes their fixtures), Task 9 (composes their fixtures), Task 10 (composes their fixtures), Task 11 (composes their fixtures), Task 12 (composes their fixtures)
**Chunk:** Decide: visual direction vs DESIGN.md
**Files:** `scripts/cdp/scenarios-transcript-boards.mjs`, `DESIGN.md`

**Decisions:**
- One step per wsh board, rebuilding the board's whole transcript from the families' exported `fixtures` plus
  the board's prose and user entries, at the board's width (1000 px boards in a 736 px column; CompactLead and
  CompactInitiative at 380 px with `compact`): Initiative, RunLeadPlan, RunLeadBuild, Worker, Agents, Runs,
  LeadRecovery, FinalFail, Brainstorm, Jira, EffortList, CompactLead, CompactInitiative. Each step screenshots
  the board and asserts placement: change cards stand outside any fold, read-only calls are step rows inside
  their box or fold and open to their view, wakes are events (never a user bubble), briefs are folded rows.
- DESIGN.md gains a short "Transcript" section recording the direction this run decided (chunk 6): plain user
  bubble, prose without avatar, step rows and the Worked-for fold, change cards outside the fold, Arc events, the
  pill message box; and the rule for wsh calls (change → card, read → step that opens to a view).

**Acceptance:**
- [ ] `transcript-boards` scenario: the 13 steps above pass, each with its screenshot named after the board.
- [ ] DESIGN.md's section names the anatomy and the wsh rule in a few lines; no token or colour is added.
- [ ] The whole Final line passes on the merged result.
