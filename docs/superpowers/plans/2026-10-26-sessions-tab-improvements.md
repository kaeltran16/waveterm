# Sessions tab: find a past session by what was said — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-10-26-sessions-tab-improvements-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/... ./cmd/...`
**Check:** `task check:ts && go vet ./pkg/agentsessions/ ./pkg/wshrpc/... ./cmd/server/`
**Final:** `node scripts/cdp/final-verify.mjs sessions-list sessions-search sessions-find sessions-palette`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.superpowers\design\sessions-tab\project\Main.dc.html

**Goal:** Search past sessions (30 days, no 100-session cap) by the words said in them, from a search field on the Sessions list and from Ctrl+P's Sessions scope, and open a hit at its place in the transcript with a find bar.

**Architecture:** `pkg/agentsessions` keeps a per-transcript text digest (prompts and agent text replies) beside the session it already caches by mtime+size, warmed in the background at wavesrv start. One new wshrpc command, `SearchSessionsCommand`, matches a parsed query against those digests and the session events, and returns sessions with hit snippets. The list (with paged rendering) and the palette both call it. Opening a hit sets a find target that the detail pane draws as a find bar over the rendered transcript, using CSS Custom Highlights.

**Tech Stack:** Go (wavesrv, wshrpc), React 19 + jotai + Tailwind 4, vitest, CDP scenarios.

## Global Constraints

- Window: 30 days for every runtime (`IndexWindowDays = 30`). No session cap on the list.
- No new dependency, build tag or SQL migration. No SQLite FTS.
- Match rule: a session matches when every query term appears in its title, digest turns or searchable events (asked, committed, errored), as a case-insensitive substring, in any order. Double-quoted text is one term (a phrase). Results are newest first, with no relevance ranking.
- The digest keeps the title, every human prompt and every assistant text reply. It skips tool calls, tool output, thinking and subagent turns. Codex and opencode match on title and events only.
- A hit is one range of matched text in a prompt or reply (kind `turn`) or in a searchable event (kind `event`). Every term occurrence in that text is found, and occurrences that overlap merge into one range (`time timeout` against "timeout" is one hit). The Go matcher and the FE find bar both follow this rule, so a card's turn-hit count equals the find bar's total. The title counts toward matching but yields no hit row.
- "Yours" vs run agent: a session is a run agent when its run link has a `Role` that is neither empty nor `lead`. Workers, reviewers, plan reviewers and verifiers get that role from `runLinkOf` today. Arc's one-shot builder-check and brainstorm-judge runs have no `DagORef`, so `runLinkOf` does not place them. Task 3 makes it place them, by their `StageRole`. Every other session is the user's.
- The Run agents switch is component-local (`useState`), off on every visit, and the list's only. Ctrl+P never includes run agents.
- Generated files (`frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `pkg/wshrpc/wshclient/wshclient.go`) come only from `task generate`.
- Colors only from `@theme` tokens (`var(--color-…)`, `color-mix` over them). No raw hex.
- CDP scenarios: no worker has a dev app, so a task that adds a scenario proves it loads (the scenario-load command below), and Final runs it. The scenario-load command is `node -e "import('./scripts/cdp/scenarios.mjs').then(m=>console.log(m.SCENARIOS.map(s=>s.name).filter(n=>n.startsWith('sessions-'))))"`.
- Agent's calls made in this plan (not in the spec): the RPC takes no project filter, because worker sessions' `projectname` is their worktree dir, so the FE filters rows by project as today. A query shorter than 2 non-space characters does not search. The debounce is 250 ms. Search calls use a 30 s RPC timeout. Snippets show 40 runes either side of the hit. A card shows 3 hit rows, then "N more matches", which expands to every hit returned (at most 20 per session). The find bar is focused on open; Enter and Shift+Enter step inside it, and Escape in it closes it. Ctrl+P's Sessions scope with an empty query lists the archive as today.

## Review Focus

1. Non-ASCII conversation text (Vietnamese diacritics, an emoji before the hit) must match case-insensitively, and its highlight marks must cover exactly the matched characters in the FE's UTF-16 string. Pinned by `TestMatchNonASCIIMarks` (Task 2) and `findRanges keeps offsets right after an emoji and with diacritics` (Task 6).
2. ~2,400 sessions and ~8,600 events in 30 days (measured on the user's machine on 2026-10-26: 4,147 candidates, 2,446 sessions, 3 MB of JSON) must not freeze the list or the All activity feed. Both render in pages. Pinned by `pageGroups` and `pageFeed` tests (Task 4) and the `sessions-list` scenario.
3. A live session whose transcript grows must become searchable by its newest words on the next search, since the digest is re-read when mtime or size changes. Pinned by `TestIndexedRereadsGrownTranscript` (Task 2).
4. A query that is empty, whitespace, an unmatched quote, or `""` must give no results and no error. Pinned by `TestParseQueryEdgeCases` (Task 2) and `TestSearchSessionsEmptyQuery` (Task 3).
5. Arc's one-shot judge and builder-check sessions must stay out of the default search. Their runs have no dag, so a classifier that reads only dag links counts them as the user's. Pinned by `TestLinkSessionsToRunsBrainstormOneShot` (Task 3), which goes through the real linker.
6. More transcripts than the old 4,096-entry cache once wiped the cache mid-scan, and a cached second pass took 65 s against 49 s cold. A warm second pass must re-read nothing. Pinned by `TestIndexedSecondPassReadsNothing` (Task 2).

---

### Task 1: Shared interface: search wire types, view-model atoms, the open-a-hit entry, scenario seams
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_agents.go`, `pkg/wshrpc/wshserver/wshserver_agents.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`, `frontend/app/view/agents/agents.tsx`, `frontend/app/view/agents/sessionsfind.ts`, `frontend/app/view/agents/sessionsfind.test.ts`, `scripts/cdp/sessions-search-fixtures.mjs`, `scripts/cdp/scenarios-sessions.mjs`, `scripts/cdp/scenarios-sessions-find.mjs`, `scripts/cdp/scenarios-sessions-palette.mjs`, `scripts/cdp/scenarios.mjs`

**Interfaces (produces):**

Go, in `pkg/wshrpc/wshrpctypes_agents.go`:
```go
// in AgentCommands
SearchSessionsCommand(ctx context.Context, data CommandSearchSessionsData) (*CommandSearchSessionsRtnData, error) // sessions of the last 30 days whose words match a query

type CommandSearchSessionsData struct {
	Query     string `json:"query"`
	RunAgents bool   `json:"runagents,omitempty"` // include run workers, reviewers, judges and verifiers
	MaxHits   int    `json:"maxhits,omitempty"`   // hits returned per session; 0 = 20
}
type CommandSearchSessionsRtnData struct {
	Terms      []string              `json:"terms"`                // the parsed, lower-cased terms; the find bar searches these
	Results    []SessionSearchResult `json:"results"`              // newest first
	Incomplete bool                  `json:"incomplete,omitempty"` // the index is still being built
}
type SessionSearchResult struct {
	Session   SessionActivity `json:"session"`   // run-linked, as GetSessionsActivity returns it
	Hits      []SessionHit    `json:"hits"`      // turn hits in transcript order, then event hits in event order
	TurnHits  int             `json:"turnhits"`  // every turn hit, returned or not: the find bar's total
	EventHits int             `json:"eventhits"`
}
type SessionHit struct {
	Kind    string  `json:"kind"`    // "turn" | "event"
	Speaker string  `json:"speaker"` // turn: "user" | "agent"; event: asked | committed | errored
	Ord     int     `json:"ord"`     // turn: 0-based position among the session's turn hits; event: index in Session.Events
	Text    string  `json:"text"`    // the snippet around the hit
	Marks   [][]int `json:"marks"`   // [start, end) pairs, UTF-16 code units into Text, for every merged match range in it
}
```
`CommandGetSessionsActivityData` gains `All bool \`json:"all,omitempty"\``: every session in the window, and `Limit` is ignored. `CommandGetSessionsActivityRtnData` gains `Incomplete bool \`json:"incomplete,omitempty"\``. `WshServer.SearchSessionsCommand` is a stub that returns `fmt.Errorf("session search is not built yet")`. Task 3 replaces it. Run `task generate`.

Frontend, `AgentsViewModel` in `agents.tsx`:
```ts
sessionsQueryAtom = atom<string>(""); // the Sessions list's search query; opening a hit seeds it
sessionsFindAtom = atom<SessionsFind | null>(null); // the find bar of the session opened from a hit; null = none
```
`frontend/app/view/agents/sessionsfind.ts`:
```ts
export interface SessionsFind {
    sessionKey: string; // `${runtime}:${id}`
    query: string; // as typed, shown in the bar
    terms: string[]; // CommandSearchSessionsRtnData.terms
    target: { kind: "turn" | "event"; ord: number };
}
// opens a session at a hit: sessionsQueryAtom (the query, so the list shows the search it came from), selection
// (sessionSelection, so a run member opens inside its run), sessionsViewAtom ("transcript" for a turn hit,
// "activity" for an event hit), sessionsFindAtom, and the Sessions surface (landOn). hit omitted = the first hit,
// or a turn target at ord 0 when there is none.
export function openSessionHit(model: AgentsViewModel, r: SessionSearchResult, query: string, terms: string[], hit?: SessionHit): void;
```
CDP seams:
- `scripts/cdp/sessions-search-fixtures.mjs` exports `writeSessionsSearchFixtures()` → `{ dir, word, absent, solo: { id, title, transcript }, other: { id, title }, lead: { id }, worker: { id } }` and `removeSessionsSearchFixtures(fx)`. It writes four Claude transcripts into `~/.claude/projects/C--arc-verify-sessions-search/` with `cwd` set to a temp dir. `word` and `absent` are nonces unique per call, and `absent` appears in no fixture.
  - The solo session holds `word` once in its first prompt, three times across two assistant text replies, and once in a `git commit -m "… <word>"` Bash tool_use: 4 turn hits and 1 event hit. Its title does not contain `word`.
  - The other session never contains `word`.
  - The lead session holds `word` once in a reply.
  - The worker session holds `word` twice, in two replies.
  - It also exports `seedSessionsSearchRun(h, kit, fx)` → a ctx for `kit.teardownFixtureRun`. It seeds a deferred orchestrator run whose `sessionid` is the lead's id, and a child run of its dag working `t-1` whose `sessionid` is the worker's id, so `linkSessionsToRuns` places them as lead and worker. No real agent starts: use deferred runs, and seed the dag and run fields with `fstWriteRun`/`waveService` as `docs/reference/cdp-run-fixtures.md` describes, never a dag submit that dispatches a worker.
  - The module header says it writes into the real `~/.claude/projects`, and that every scenario using it removes the directory and the run in teardown.
- `scenarios-sessions.mjs`, `scenarios-sessions-find.mjs` and `scenarios-sessions-palette.mjs` each `export default function (kit) { return []; }`. They are spread into `SCENARIOS` in `scenarios.mjs` the way the `scenarios-brainstorm-*.mjs` modules are, with a `SESSIONS_KIT` of `{ arrangeSheetDagRun, teardownFixtureRun, fstWriteRun, waveService }` and any other existing helper the seeding needs.

- [ ] Write `sessionsfind.test.ts`, using a store-backed model stub:
  - `openSessionHit opens a solo turn hit on the transcript` asserts `sessionsSelAtom` = `claude:s1`, `sessionsViewAtom` = `transcript`, `sessionsFindAtom.target` = `{kind:"turn",ord:2}`, and `sessionsQueryAtom` = the query.
  - `openSessionHit opens an event hit on the activity view` asserts the view is `activity`.
  - `openSessionHit opens a run member inside its run` asserts sel = `run:<id>` and member = the task id.
  - `openSessionHit with no hits targets turn 0`.
- [ ] Run `npx vitest run frontend/app/view/agents/sessionsfind.test.ts`. Expect FAIL.
- [ ] Add the Go types and the stub, run `task generate`, and add the atoms and `sessionsfind.ts`.
- [ ] Rerun the vitest file. Expect PASS. Run `go build ./pkg/... ./cmd/...`. The scenario-load command runs without error. Calling `writeSessionsSearchFixtures()` then `removeSessionsSearchFixtures()` from a `node -e` leaves no directory behind.
- [ ] Commit: `feat(sessions): search wire types, find atoms and scenario seams`

### Task 2: Digest, query matcher and background index in pkg/agentsessions
**Depends on:** none
**Files:** `pkg/agentsessions/agentsessions.go`, `pkg/agentsessions/humanprompts.go`, `pkg/agentsessions/lastanswer.go`, `pkg/agentsessions/digest.go`, `pkg/agentsessions/digest_test.go`, `pkg/agentsessions/search.go`, `pkg/agentsessions/search_test.go`, `pkg/agentsessions/index.go`, `pkg/agentsessions/index_test.go`

**Interfaces (produces):**
```go
const IndexWindowDays = 30

type Turn struct {
	Speaker string // "user" | "agent"
	Text    string
}
// IndexedSession is a session as parseCandidates fills SessionInfo (Runtime, LastActiveTs, ResumeCommand,
// TranscriptPath, Events, Status...) plus its digest turns in transcript order.
type IndexedSession struct {
	Info  SessionInfo
	Turns []Turn
}
// Indexed lists every session in the window, newest first. It stat-walks every provider, uses cached entries
// whose mtime+size still match, and parses at most syncParseMax (100) uncached candidates, newest first.
// complete is false when it skipped any; it then starts the warm-up if it is not running.
func Indexed(windowDays int) (sessions []IndexedSession, complete bool)
// StartWarmup parses every uncached candidate of the IndexWindowDays window, newest first, on one background
// goroutine, one file at a time, yielding (runtime.Gosched) between files so it stays low priority. Idempotent
// while one runs.
func StartWarmup()

type Query struct{ Terms []string } // lower-cased; a quoted phrase is one term
func ParseQuery(q string) Query
type Hit struct {
	Kind, Speaker string
	Ord           int
	Text          string
	Marks         [][2]int // UTF-16 [start, end) into Text
}
// Match reports whether every term occurs in the title, turns or searchable events, and returns up to maxHits
// hits (turn hits in order, then event hits) with the full turn and event hit counts.
func (q Query) Match(s IndexedSession, maxHits int) (ok bool, hits []Hit, turnHits, eventHits int)
```
Decisions:
- The digest comes from the same `lines` that `scanSessionCached` already reads, in one file read. `provider.fused` also returns the turns, and `scanCacheEntry` keeps them. Claude prompts follow `HumanPrompts`' rules: no notices or tool results. Claude replies are every assistant `text` block, not `thinking` or `tool_use`. Pi prompts and replies come from the same session file walk that `piHumanPrompts` and `piLastAnswer` use. Codex and opencode keep no turns. Reuse the existing extraction helpers in `humanprompts.go` and `lastanswer.go`, refactoring them to take parsed lines where needed. Do not write a second parser.
- Cache: `scanCacheMax` rises to 65536. `Indexed`'s walk drops cache entries whose path was not among its window candidates, so the 30-day set stays bounded without the clear-all. The clear-all stays only as the overflow guard. A 14-day `ScanSessions` walk never prunes.
- `Indexed` and `ScanSessions`/`parseCandidates` build `SessionInfo` through one shared helper, not two copies.
- Searchable events are `asked`, `committed` and `errored`, never `started` or `finished`.
- Hits are the merged ranges of the Global Constraints rule: every term's occurrences in one text are found, and overlapping ones merge. `Ord` and `turnHits` count merged ranges.
- A snippet is the hit's turn or event text, 40 runes either side of the hit, with whitespace collapsed and `…` at a cut end. Marks cover every merged range inside the snippet. Lower-casing must not shift offsets: match on a folding that keeps rune positions, and compute marks against the original text.

- [ ] Write the tests:
  - `digest_test.go`:
    - `TestDigestClaudeKeepsPromptsAndReplies`: a fixture with a prompt, a text reply, a thinking block, a tool_use, a tool_result and a subagent sidechain line keeps exactly the prompt and the text reply, in order.
    - `TestDigestPiKeepsPromptsAndReplies`.
    - `TestDigestCodexHasNoTurns`.
  - `search_test.go`:
    - `TestParseQuery`: `Hook  Timeout` → `["hook","timeout"]`; `"dial timeout" warm` → `["dial timeout","warm"]`.
    - `TestParseQueryEdgeCases`: `""`, `"   "`, `"\""` and `"\"\""` give no terms; `"open` → `["open"]`.
    - `TestMatchAllTermsAnyOrder`: `timeout hook` matches turns "hook … timeout" across two turns, and `timeout zebra` does not.
    - `TestMatchPhrase`: `"dial timeout"` matches "dial timeout" but not "timeout dial".
    - `TestMatchCaseInsensitive`.
    - `TestMatchTitleCountsButYieldsNoHit`: a term only in the title matches with 0 hits.
    - `TestMatchEventHits`: a commit subject hit has `Kind:"event"`, `Speaker:"committed"`, and `Ord` = its index in `Info.Events`; a `started` event's text never matches.
    - `TestMatchHitOrderAndOrd`: turn hits take `Ord` 0..n-1 in transcript order, then events; `turnHits` counts beyond `maxHits`.
    - `TestMatchMergesOverlappingTerms`: `time timeout` against "a timeout here" is 1 hit, not 2.
    - `TestMatchSnippetWindow`: 40 runes either side, `…` at cut ends.
    - `TestMatchNonASCIIMarks`: query `lỗi` against `"🙂 Lỗi kết nối, lỗi"` gives two marks whose UTF-16 slices of `Text` equal `Lỗi` and `lỗi`.
  - `index_test.go`, against a temp home with the `readLines` seam counting reads:
    - `TestIndexedNewestFirst`.
    - `TestIndexedParsesAtMost100Uncached`: with 150 fresh candidates, 100 are read and `complete == false`.
    - `TestIndexedSecondPassReadsNothing`: after a warm-up over 150 candidates, a second `Indexed` reads 0 files and is complete.
    - `TestIndexedRereadsGrownTranscript`: an appended turn holding a new word is matched on the next call.
    - `TestIndexedPrunesDeletedTranscripts`.
    - `TestStartWarmupIsIdempotent`.
- [ ] Run `go test ./pkg/agentsessions -run 'TestDigest|TestParseQuery|TestMatch|TestIndexed|TestStartWarmup'`. Expect FAIL.
- [ ] Implement `digest.go`, `search.go` and `index.go`, and extend `fused`/`scanCacheEntry` in `agentsessions.go`.
- [ ] Rerun. Expect PASS. The package's existing scan, prompt and answer tests still pass: `go test ./pkg/agentsessions -run 'TestScan|TestHumanPrompts|TestLastAnswer|TestLastError'`.
- [ ] Commit: `feat(agentsessions): text digest, query matcher and background index`

### Task 3: SearchSessions RPC, the uncapped activity list, the one-shot run link, and the warm-up at start
**Depends on:** Task 1, Task 2 (uses Indexed, StartWarmup, ParseQuery and Match)
**Files:** `pkg/wshrpc/wshserver/wshserver_agents.go`, `pkg/wshrpc/wshserver/sessionsearch.go`, `pkg/wshrpc/wshserver/sessionsearch_test.go`, `pkg/wshrpc/wshserver/sessionruns.go`, `pkg/wshrpc/wshserver/sessionruns_test.go`, `cmd/server/main-server.go`

Decisions:
- `GetSessionsActivityCommand` with `All` calls `agentsessions.Indexed(windowDays)` (0 → 30) and sets `Incomplete = !complete`. Without `All` it behaves exactly as today.
- `SearchSessionsCommand` parses the query, and returns `Terms` with no results when there are none. It calls `Indexed(IndexWindowDays)`, matches each session, links the matched sessions to runs with `linkSessionsToRuns` (only those, not the whole set), drops run agents unless `RunAgents`, and returns newest first with `Incomplete`. Keep the matching, classification and shaping in a pure `searchResults(sessions []agentsessions.IndexedSession, q agentsessions.Query, runAgents bool, maxHits int, link func([]wshrpc.SessionActivity) error) []wshrpc.SessionSearchResult` in `sessionsearch.go`. The handler adds only `Indexed`, the real linker, and the wire. A link error is logged and the results are kept (the existing `GetSessionsActivity` precedent), never dropped.
- `isRunAgent(role string) bool` = `role != "" && role != "lead"`.
- `runLinkOf` places a run that `jarvis.IsBrainstormSession` reports, which has no dag, as `{RunId: run.OID, ChannelId: run.ChannelOID, Role: run.StageRole}`. The FE's `groupRunSessions` already keeps a `builder-check`/`brainstorm-judge` session solo, so the list does not change. Search then excludes it by default.
- `main-server.go` calls `agentsessions.StartWarmup()` once at start, beside `go wshserver.WarmRouteCatalog()`.

- [ ] In `sessionruns_test.go`, add a `TestRunLinkOf` case for a quick run with `StageRole: "brainstorm-judge"` and no `DagORef`. Add `TestLinkSessionsToRunsBrainstormOneShot`: through the real store, as `TestLinkSessionsToRunsLeadSessionIds` does, a `builder-check` run's session gets `Role` `builder-check` and `isRunAgent` is true.
- [ ] Write `sessionsearch_test.go`:
  - `TestSearchSessionsEmptyQuery`: no terms give no results and no error.
  - `TestSearchResultsDropsRunAgentsByDefault`: with a lead, a worker, a reviewer, a `builder-check` and a `brainstorm-judge` session, and an unlinked one, the default keeps the lead and the unlinked one, and `runAgents` keeps all six.
  - `TestSearchResultsShape`: hits carry kind, speaker, ord and text; `Marks` serialize as `[[s,e],…]`; `turnhits` and `eventhits` are set; the session carries its run link.
  - `TestSearchResultsNewestFirst`.
  - `TestSearchResultsKeepsResultsWhenLinkFails`.
- [ ] Run `go test ./pkg/wshrpc/wshserver -run 'TestSearchSessions|TestSearchResults|TestRunLinkOf|TestLinkSessionsToRuns'`. Expect FAIL.
- [ ] Implement, and replace Task 1's stub.
- [ ] Rerun. Expect PASS. Run `go build ./cmd/...`.
- [ ] Commit: `feat(sessions): SearchSessions RPC and uncapped activity list`

### Task 4: The Sessions list holds every session of 30 days, rendered in pages
**Depends on:** Task 1 (uses the generated all and incomplete fields)
**Files:** `frontend/app/view/agents/sessionsarchivestore.ts`, `frontend/app/view/agents/sessionsarchivestore.test.ts`, `frontend/app/view/agents/sessionssurface.tsx`, `scripts/cdp/scenarios-sessions.mjs`

Decisions:
- `loadSessionsArchive` asks `{ windowdays: 30, all: true }` with an RPC timeout of 30 s, because the first call may parse up to 100 transcripts. It sets a new exported `sessionsIncompleteAtom`. `LIMIT` goes. While the surface is mounted and the archive is incomplete, the surface reloads it every `ARCHIVE_POLL_MS = 3000` until it is complete.
- The list renders `LIST_PAGE = 60` rows, then grows by a page when a sentinel at the list's end scrolls into view (IntersectionObserver). The All activity feed pages the same way, `FEED_PAGE = 200` events. j/k navigation still walks every row: moving the cursor past the rendered rows grows the page, so the row renders and scrolls into view.
- While the archive is incomplete, a muted line at the list's end reads `Loading older sessions…`.
- Pure helpers in `sessionsarchivestore.ts`: `pageGroups<T>(groups: RecencyGroup<T>[], count: number): RecencyGroup<T>[]` (the first `count` items across groups in order, dropping emptied groups, keeping each group's full count for its header) and `pageFeed(items: MergedItem[], count: number): MergedItem[]`.

- [ ] Tests in `sessionsarchivestore.test.ts`: `pageGroups cuts across groups in order`, `pageGroups keeps a group's full count`, `pageGroups drops a group with no rendered item`, `pageFeed keeps the newest count events`.
- [ ] Run `npx vitest run frontend/app/view/agents/sessionsarchivestore.test.ts`. Expect FAIL. Implement, then rerun. Expect PASS.
- [ ] Add the `sessions-list` scenario to `scenarios-sessions.mjs`, with the viewport pinned to 1600x950. Shoot each step.
  - Step 1: set `sessionsIncompleteAtom` to true through a `/@fs` import of `sessionsarchivestore.ts` and `globalStore`. `Loading older sessions…` shows. Restore the atom.
  - Step 2: reach a complete archive (wait up to 120 s).
  - Step 3: the list renders at most 60 cards. When the archive holds more, scrolling to the end renders more.
  - Step 4: when it holds more than 60, pressing j past the last rendered card grows the page, and the cursor's card is rendered and in view.
  - Step 5: All activity renders at most 200 events and grows the same way.
  - Steps that need more sessions than a page skip, with that reason, on a machine with fewer.
- [ ] Run the scenario-load command. Expect `sessions-list` in the output.
- [ ] Commit: `feat(sessions): list every session of 30 days, rendered in pages`

### Task 5: Search on the Sessions list
**Depends on:** Task 4
**Files:** `frontend/app/view/agents/sessionssearch.ts`, `frontend/app/view/agents/sessionssearch.test.ts`, `frontend/app/view/agents/sessionssearchstore.ts`, `frontend/app/view/agents/sessionssurface.tsx`, `scripts/cdp/scenarios-sessions.mjs`

Decisions (layout and copy follow the prototype board):
- A search field sits at the top of the list, above All activity. Under it are a `Run agents` switch (`useState(false)`, `role="switch"`) and the summary `N sessions · M matches`. The field reads and writes `model.sessionsQueryAtom`. Escape in the field, with a query, clears that atom and stays on Sessions. j/k typed in the field are text. A query that matches nothing shows `No sessions match “<query>”.` in place of the cards.
- The summary counts cards (a run card is one) and every hit on them, as the board does.
- `sessionssearchstore.ts`: `useSessionsSearch(query: string, runAgents: boolean)` → `{ results, terms, incomplete, loading, error, retry }`. It debounces 250 ms, does not search below 2 non-space characters, calls with a 30 s RPC timeout, and drops a response that is older than the latest query. An RPC error shows as an inline `Search failed` line with Retry, never as an empty list.
- While a query is active, rows are the merge of the archive and the result sessions (deduped by `${runtime}:${id}`, so a hit the archive has not loaded still lists), kept only where they matched, then status- and project-filtered and recency-grouped as today.
- Cards keep their lines. Under them go snippet rows: who (`you` or `agent` on a solo; `lead`, or the member's number or role, on a run card; the event type for an event hit) and the snippet with its `marks` highlighted (`--color-accent` tint, not hex). The first 3 rows show, then `N more matches`, which expands to every returned hit. With Run agents on, worker and reviewer hits fold onto their run's card as member rows with snippets.
- Picking a card calls `openSessionHit` with no hit. Picking a snippet row calls it with that hit.
- `Results may be incomplete — still indexing` shows under the summary while `incomplete`.
- `Row` and `keepRow` move from `sessionssurface.tsx` into `sessionssearch.ts`, and the list's narrowing is the pure `composeSearchRows(rows: Row[], matches: Map<string, CardMatch>, status: SessionStatusFilter, project: string): Row[]`. It keeps matched rows, then applies the status and project filters as the list does today.
- Pure model in `sessionssearch.ts`:
  - `foldHits(results: SessionSearchResult[]): Map<string, CardMatch>`, keyed by row key (`run:<id>` for a run-linked session, else `${runtime}:${id}`), with `CardMatch = { hits: SnippetRow[]; total: number }` and `SnippetRow = { key: string; who: string; hit: SessionHit; result: SessionSearchResult }`.
  - `mergeResultSessions(base: SessionActivity[], results: SessionSearchResult[]): SessionActivity[]`.
  - `searchSummary(matches: Map<string, CardMatch>): string`.
  - `snippetParts(text: string, marks: number[][]): { text: string; mark: boolean }[]`.

- [ ] Tests in `sessionssearch.test.ts`:
  - `foldHits puts a lead hit on its run card`.
  - `foldHits folds a worker hit onto its run card under the member's number`.
  - `foldHits keys a solo by runtime and id with you/agent speakers`.
  - `foldHits names an event hit by its type`.
  - `mergeResultSessions adds a result the archive lacks and keeps one copy of a shared session`.
  - `searchSummary counts cards and every hit` (`3 sessions · 7 matches`).
  - `composeSearchRows applies the status and project filters over the matched rows`: a matched done session drops under Live, and a matched run drops under another project.
  - `snippetParts splits on marks including a mark at the start and end`.
- [ ] Run `npx vitest run frontend/app/view/agents/sessionssearch.test.ts`. Expect FAIL. Implement, then rerun. Expect PASS.
- [ ] Add the `sessions-search` scenario to `scenarios-sessions.mjs`. Arrange uses `writeSessionsSearchFixtures` and `seedSessionsSearchRun`, and teardown removes both. Shoot each step.
  - Step 1: typing the fixture `word` narrows the list to the solo card and the run card (the other fixture is gone). The summary reads `2 sessions · 6 matches`.
  - Step 2: the solo card shows 3 snippet rows with a highlighted mark and `2 more matches`, and clicking that row shows 5. The run card shows a `lead` snippet row.
  - Step 3: Run agents on: the switch reads `aria-checked="true"`, the run card gains the worker's member rows, and the summary reads `2 sessions · 8 matches`.
  - Step 4: typing `absent` shows `No sessions match “<absent>”.`
  - Step 5: stub `RpcApi.SearchSessionsCommand` (a `/@fs` import of `wshclientapi.ts`) to return `incomplete: true`; `Results may be incomplete — still indexing` shows. Then stub it to throw; `Search failed` and Retry show. Restore it and click Retry; the results return.
  - Step 6: Escape in the field clears it and the full list returns.
- [ ] Run the scenario-load command. Expect `sessions-search` in the output.
- [ ] Commit: `feat(sessions): search the Sessions list by what was said`

### Task 6: Open at a hit: the find bar and the highlighted activity event
**Depends on:** Task 1
**Files:** `frontend/app/view/agents/sessionsfind.ts`, `frontend/app/view/agents/sessionsfind.test.ts`, `frontend/app/view/agents/sessionsdetail.tsx`, `frontend/app/view/agents/narrationtimeline.tsx`, `frontend/tailwindsetup.css`, `docs/keyboard-shortcuts.md`, `scripts/cdp/scenarios-sessions-find.mjs`

Decisions:
- The find bar shows under the session header, in `SoloDetail` and in `RunDetail`'s member view, only while `sessionsFindAtom.sessionKey` is the session in view. It holds the query (a focused input, editable to refine the in-transcript find only), the position `2 of 5` (`No matches in transcript` at zero), and previous/next buttons. Enter and Shift+Enter in the input step, wrapping. Escape in it sets `sessionsFindAtom` to null. An effect in `sessionsdetail.tsx` sets it to null when the session in view is not `sessionsFindAtom.sessionKey`, so selecting another session clears it.
- In a found session, `useTranscript` reads the whole transcript (`maxlines: -1`). `NarrationTimeline` takes a `renderAll` prop that lifts `TIMELINE_RENDER_CAP`, and marks user and message items with `data-find-turn`. `SessionBody` skips its scroll-to-end and scrolls the current match to the centre instead.
- Matches are `findRanges` over the text of each `[data-find-turn]` element, in document order. They are painted with the CSS Custom Highlight API (precedent: `docreviewnotesview.tsx`), using `::highlight(sessions-find)` and a stronger `::highlight(sessions-find-current)` in `tailwindsetup.css` over `--color-accent`. The DOM is never rewrapped. Unregister both highlights on unmount.
- An event target sets the Activity view, and `ActivityList` marks the event at `ord` (`aria-current`, accent ring) and scrolls it into view.
- `docs/keyboard-shortcuts.md`, under Sessions: Enter and Shift+Enter step through the find bar's matches, Escape closes the find bar, and Escape in the list's search field clears the query.
- Pure additions to `sessionsfind.ts`: `stepFind(pos: number, total: number, dir: 1 | -1): number` and `findRanges(text: string, terms: string[]): [number, number][]` (case-insensitive, UTF-16 offsets, sorted, with overlapping occurrences merged by the Global Constraints rule, so its count per turn equals the Go matcher's).

- [ ] Tests added to `sessionsfind.test.ts`: `stepFind wraps both ways`, `stepFind with no matches stays 0`, `findRanges finds every term case-insensitively in order`, `findRanges treats a phrase as one term`, `findRanges keeps offsets right after an emoji and with diacritics`, `findRanges merges overlapping terms` (`["time","timeout"]` against "a timeout" is one range).
- [ ] Run `npx vitest run frontend/app/view/agents/sessionsfind.test.ts`. Expect FAIL. Implement, then rerun. Expect PASS.
- [ ] Add the `sessions-find` scenario to `scenarios-sessions-find.mjs`, with the fixtures and the seeded run. It calls `searchsessions` over `window.TabRpcClient` for the fixture `word` (`runagents: true`) and opens hits through `openSessionHit`, reached by a `/@fs` module import in the page, not through the list or palette (those land in parallel tasks). Shoot each step.
  - Step 1: open the solo at its second turn hit. The find bar reads `2 of 4`, the two highlight registries hold 4 and 1 ranges, and the current range is inside the scroll container's visible box.
  - Step 2: Enter moves to `3 of 4`, and Shift+Enter twice to `1 of 4`. The next and previous buttons step the same way.
  - Step 3: opening the solo's event hit shows the Activity view with the commit event marked.
  - Step 4: opening the worker's first hit shows the run's detail with the worker in view and the find bar reading `1 of 2`.
  - Step 5: `openSessionHit` with terms `[absent]` shows `No matches in transcript`.
  - Step 6: Escape in the find bar closes it.
- [ ] Run the scenario-load command. Expect `sessions-find` in the output.
- [ ] Commit: `feat(sessions): open a search hit at its place with a find bar`

### Task 7: Ctrl+P Sessions scope searches what was said
**Depends on:** Task 1 (uses openSessionHit and the generated search types)
**Files:** `frontend/app/cockpit/use-palette-sessions.ts`, `frontend/app/cockpit/palette-items.ts`, `frontend/app/cockpit/palette-items.test.ts`, `frontend/app/cockpit/palette-scopegroups.ts`, `frontend/app/cockpit/palette-scopegroups.test.ts`, `frontend/app/cockpit/command-palette.tsx`, `frontend/app/cockpit/actions/session.ts`, `scripts/cdp/scenarios-sessions-palette.mjs`

Decisions:
- `usePaletteSessions(open: boolean, inSessions: boolean, query: string)` → `{ results, terms, incomplete, error }`. It is the same debounce, minimum length, 30 s RPC timeout and stale-drop as the list. It always calls with `runagents: false` and searches only while the Sessions scope is active.
- `sessionSearchRows(results, query, terms, deps): PaletteItem[]`: key `session:${runtime}:${id}`, title the task, `sub` the first hit's snippet text, `meta` `runtime · age`, verb `Open`. Enter calls `openSessionHit(model, r, query, terms)`, which also seeds the list's query, and closes. In the Sessions scope with a query of 2 or more characters, `narrowedGroups` lists these rows in server order, unranked. An empty query lists the archive rows as today. The All scope keeps its local title rows.
- `SessionThing` gains `find?: { result: SessionSearchResult; query: string; terms: string[] }`. Search rows join `targetByKey` as `SESSION_KIND` entries carrying it, so the row's action level lists Resume (when resumable) and Open in Sessions. Open in Sessions calls `openSessionHit` when `find` is set, and otherwise behaves as today.
- An RPC error shows through the palette's existing error band.

- [ ] Tests:
  - `palette-items.test.ts`: `sessionSearchRows lists an unresumable ended session`, `sessionSearchRows puts the first snippet in sub`.
  - `palette-scopegroups.test.ts`: `sessions scope with a query keeps server order`, `sessions scope with an empty query lists the archive rows`.
- [ ] Run `npx vitest run frontend/app/cockpit/palette-items.test.ts frontend/app/cockpit/palette-scopegroups.test.ts`. Expect FAIL. Implement, then rerun. Expect PASS.
- [ ] Add the `sessions-palette` scenario to `scenarios-sessions-palette.mjs`, with the fixtures and the seeded run. Shoot each step.
  - Step 1: Ctrl+P, Tab to Sessions, type the fixture `word`. The solo and the lead are the rows (the worker is not), and each row's second line holds `word`.
  - Step 2: on the solo's row, the key that opens a row's actions lists `Open in Sessions`.
  - Step 3: Enter on the solo's row lands on Sessions, with `sessionsQueryAtom` = `word` and the solo selected. The list's field is Task 5's and is checked in Task 8.
- [ ] Run the scenario-load command. Expect `sessions-palette` in the output.
- [ ] Commit: `feat(palette): Sessions scope searches conversation text`

### Task 8: End-to-end: a snippet row opens the transcript at its hit
**Depends on:** Task 5, Task 3 (the scenarios drive its real SearchSessions RPC), Task 6 (uses the find bar it draws), Task 7 (uses the palette rows it adds)
**Files:** `scripts/cdp/scenarios-sessions.mjs`

- [ ] Extend `sessions-search` with three steps, and shoot each.
  - Step 7: after typing `word`, clicking the solo card's second snippet row opens the transcript with the find bar reading `2 of 4`, and the current highlight inside the visible scroll box.
  - Step 8: with Run agents on, clicking the run card's worker snippet row opens the run with the worker in view and the find bar at `1 of 2`.
  - Step 9: from Ctrl+P's Sessions scope, Enter on the solo's row lands on Sessions with `word` in the list's search field and the find bar at `1 of 4`.
- [ ] Run the scenario-load command. Expect `sessions-search` in the output. No worker has a dev app, so Final runs the scenarios.
- [ ] Commit: `test(sessions): search opens the transcript at its hit, end to end`
