# Sessions tab: find a past session by what was said

**Prototype:** `.superpowers/design/sessions-tab/project/Main.dc.html`

## Intent

The Sessions tab should make finding a past session fast. Today the only way is to scroll a recency
list, and that list holds only the newest 100 sessions. The user remembers a past session by words
from the conversation (something they or the agent said: a topic, an error, a decision), so search has
to reach inside transcript text, not only titles, project or branch.

## Context

- **The tab today** (`frontend/app/view/agents/sessionssurface.tsx`, `sessionsdetail.tsx`): a 380px
  left list with a pinned "All activity" entry, then recency groups. An orchestrator run is one
  `RunCard` with a row per member that needs you; every other session is a `SoloCard`. Toolbar: status
  filter All / Live / Needs you / Done, a live-agent count; the global project filter also applies.
  No search box. Detail: `SoloDetail` or `RunDetail`, reading a transcript or activity, with Jump
  (live) or Resume (ended). j/k list nav, Enter runs the primary action.
- **Volume**: `loadSessionsArchive` (`sessionsarchivestore.ts`) asks `GetSessionsActivity` for
  `windowdays: 30, limit: 100`. On the user's machine `~/.claude/projects` holds ~4,000 top-level
  transcripts from the last 30 days (~1,250 from the last 7), 3.2 GB without subagent files, plus ~500
  pi sessions. About 60% of the last 30 days' Claude sessions are run agents (workers, reviewers,
  judges, verifiers), by a rough heuristic over `~/.claude/history.jsonl`.
- **Cost of reading text**: a plain `grep -l` for one word over all transcripts took 5.6 s warm.
  Prompt and assistant-reply text is 1.6–2.1% of transcript bytes (samples of 300 and 401
  transcripts), about 55–70 MB for the 30-day set. `pkg/agentsessions` already has `HumanPrompts`,
  `LastAnswer`, and a scan cache keyed on mtime+size (`scanSessionCached`, bounded by
  `scanCacheMax = 4096`). Nothing in the repo uses SQLite full-text search; go-sqlite3 v1.14.40
  compiles FTS3/4 in, and FTS5 would need the `sqlite_fts5` build tag.
- **Search UI already in the app**: Ctrl+P (`frontend/app/cockpit/command-palette.tsx`) has a Sessions
  scope; its rows come from `SESSION_KIND.entries` (`frontend/app/cockpit/actions/session.ts`), which
  keeps only resumable sessions. "Open in Sessions" writes `sessionsSelAtom` (Sessions has no
  `openTarget` router target). `SessionBody` always scrolls the transcript to the end;
  `useTranscript` reads only the last 2,000 lines of a Claude transcript (pi in full). There is no
  find-in-transcript today.

## Design

### How search reaches the text

wavesrv keeps a per-session text digest in memory: the title, every prompt, every assistant text
reply, and the asks, commit subjects and errors the session events already carry. It skips tool calls,
tool output, thinking and subagent turns. It is built by the existing scan path and cached by
mtime+size like `scanSessionCached`, so only grown transcripts are re-read; `scanCacheMax` grows past
the 30-day set, or the digest keeps its own map.

After a wavesrv start the digest is rebuilt in the background by reading every transcript once;
until it finishes, search results say they are incomplete. No new dependency, build tag or migration.
Words that appear only in tool output (a raw stack trace the agent never quoted) are not found.

Rejected: SQLite full-text (a migration and a second copy of rebuildable data, before the rebuild time
is measured), grep per search (5.6 s each time, and hits on tool output), prompts only from
`history.jsonl` (misses the agent's words), loading every session into the browser, asking a model,
embeddings.

### How a query matches

A query matches a session when every word appears in its digest, in any order, case-insensitively.
Text in double quotes matches as a phrase. Results are newest first; there is no relevance ranking.

### Which sessions search covers

By default, search covers sessions the user talked in, plus run leads. A "Run agents" switch on the
Sessions list widens the list's search to every run worker, reviewer, judge and verifier. The switch is
local to the list, not remembered across visits, and does not apply to Ctrl+P.

### How far back

Search and the list cover the last 30 days for every runtime. Claude's transcripts go after 30 days
anyway (Claude Code's cleanup); pi, codex and opencode use the same 30-day window although their
sessions stay on disk longer (Agent's call). The 100-session cap on the list goes. Arc keeps nothing older.

### Where search lives

Two places, fed by one wavesrv search: a search box on the Sessions list, and the Ctrl+P palette's
Sessions scope, which matches conversation text instead of titles only.

### The Sessions list while searching (prototype: Main.dc.html)

- A search field sits at the top of the Sessions list, above the All activity entry, with a small
  "Run agents" switch and a summary (`3 sessions · 7 matches`) under it.
- While the field holds a query, the list shows only matching sessions, newest first, still grouped by
  recency.
- Each card keeps its usual lines and lists its matching passages under them as snippet rows: who said
  it (`you`, `agent`, or for run members their number or role), then the text around the hit with the
  matched words highlighted. The first three rows show, then an "N more matches" row, the way the Code
  surface lists content-search hits per file (`codesearchpane.tsx`).
- Picking a card opens its transcript at the first hit; picking a snippet row opens it at that hit.
- A hit in a run's lead shows on its run card. With Run agents on, worker and reviewer hits fold into
  their run's card as member rows with snippets.
- The status filter and the project filter still apply on top of the query.
- A snippet row from an event (an ask, a commit subject, an error) opens the Activity view at that
  event (Agent's call).
- Escape clears the query.
- While the digest is still being built after a restart, the list says the results are incomplete.

### What opening a hit shows (prototype: Main.dc.html)

Opening a session from a search hit scrolls its transcript to that match and highlights every match,
the current one stronger. A find bar under the session header shows the query, the position
(`2 of 5`), and previous/next buttons, with Enter and Shift+Enter as keys. The bar shows only when the
session was opened from a search.

Agent's call: the find bar is a find over the transcript as drawn, searching only the user's prompts
and the agent's text replies (the text the digest keeps from turns), so its total matches the card's
count of transcript hits. Tool rows are not searched. A hit in the title, an ask, a commit subject or an
error is a session event, not a turn: the find bar does not count it, and its snippet row opens the
Activity view with that event highlighted. Digest hits therefore carry their kind (turn or event), and
only an ordinal position; they need not map to a transcript line.

### Ctrl+P Sessions scope

The scope sends the query to the same search, always over the user's sessions and run leads (the
Run agents switch is the list's only), and lists matching sessions with a snippet line. Enter
runs Open in Sessions with the query carried along, so the Sessions surface opens with the query in
its search field and the transcript scrolled to the hit. Resume stays a palette action on the row. The
scope takes its rows from the search results rather than from `SESSION_KIND.entries` (resumable only),
which would also drop ended sessions that cannot be resumed.

## Left to the builder

- Which sessions are the user's: a session is a run agent when it is linked to a run with a role other
  than lead, or is one of Arc's one-shot sessions (brainstorm judge, builder check, plan reviewer);
  every other session is the user's.
- Runtimes: the digest covers claude and pi (`HumanPrompts` and `LastAnswer` already read both); codex
  and opencode match on title and events only.
- The startup rebuild runs in the background at low priority, newest first, so recent sessions are
  searchable soonest.
- One new wshrpc command (query, include run agents, project, window) returning matching sessions with
  up to N hit snippets each (speaker, text around the hit, position). The list and the Ctrl+P scope
  both call it, debounced as the user types. Run `task generate` after adding it.
- With the 100-session cap gone, the list renders lazily (windowed or paged as it scrolls) so ~4,000
  sessions stay fast.
- Loading a transcript at an early hit: fetch around the hit, or the whole transcript for a searched
  session, instead of the last 2,000 lines.
- Snippet length and how many hit rows a card shows before "N more".

## Testing

- Go: the digest builder (what it keeps and skips per runtime), the matcher (all words, any order,
  case-insensitive, quoted phrase), the yours-vs-run-agent classification, and the RPC's result shape.
- Frontend: pure model tests for snippet-row grouping onto run and solo cards, the filter-on-query
  composition, and the find bar's position stepping, beside their `.ts` files.
- CDP: a scenario that types a query on Sessions, checks cards narrow with snippet rows, opens a hit,
  and checks the find bar and the scroll position.
