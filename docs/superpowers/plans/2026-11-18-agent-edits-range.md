# Agent's edits: a Diff range of exactly what one agent changed

**Spec:** `docs/superpowers/specs/2026-11-18-agent-edits-range-design.md`
**Verify:** `node scripts/verify.mjs ./pkg/gitinfo ./pkg/wshrpc/... $(test -d pkg/agentedits && echo ./pkg/agentedits)`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit && go vet ./pkg/wshrpc/... $(test -d pkg/agentedits && echo ./pkg/agentedits)`
**Final:** `node scripts/cdp/final-verify.mjs diff-agent-edits diff-scope diff-source-row diff-comments diff-push workspace-changes surface-headers`

## Decisions beyond the spec

- **Wire contract first.** Task 1 lands only the wire types, a stub handler and the generated bindings, so the
  frontend (Task 4) does not wait for the backend. The pure reconstruction (Task 2) needs nothing and runs
  beside Task 1; the commit build and handler (Task 3) need both and run beside Task 4; the scenario (Task 5)
  needs Tasks 3 and 4.
- **The agent origin carries its runtime.** `DiffOrigin`'s agent arm gains `runtime?: string` (the AgentVM's
  `agent` field); `originKey` stays `agent:<id>`. An absent runtime means claude, the repo's convention
  (`a.agent || "claude"` in `cockpit/actions/agent.ts`, `agentsviewmodel.ts`), applied inside
  `defaultRangeFor`/`availableRanges`. The edits range exists for claude only: pi, codex and opencode keep the
  session range as default and list no edits chip ("a range that can never apply is not listed"). `agentDiffScope(agentId, label, runtime?)` gains the third parameter
  and every caller passes it.
- **The backend derives the session start itself**, from the transcript's first record with a parseable
  `timestamp` (the rule `agentsessionstart.ts` uses), because it reads the whole transcript anyway. The RPC's
  input stays `cwd` + `transcriptpath`, as the spec names it.
- **File-history location.** Backups are read from `<config>/file-history/<sessionId>/`. `FileHistoryDir`
  returns `<config>/file-history`; `Parse` joins the session id (the transcript's base name without `.jsonl`).
  `<config>` is
  the transcript's own config dir when the transcript sits at `<config>/projects/<p>/<id>.jsonl` (an agent
  launched with its own `CLAUDE_CONFIG_DIR` keeps its backups beside its transcripts), else
  `CLAUDE_CONFIG_DIR`, else `~/.claude`.
- **Paths.** A relative `trackingPath` or `file_path` resolves against the cwd the transcript records. Inside
  `pkg/agentedits` paths are repo-relative with forward slashes (case-insensitive prefix match on Windows).
  The reply's `files[].path` is cwd-relative with forward slashes, the form `GitChangesCommand` lists, so the
  frontend matches a flag to a list row by string equality.
- **Line endings.** Claude Code's Edit matches on LF-normalized text and writes the file back with its own
  endings, so replay does the same: an `old_string` is matched against the LF-normalized content and the result
  keeps the file's original line endings. Without this every Edit of a CRLF file reads as "changed outside".
- **Blobs are what `git add` would store**: each blob is hashed with its path's clean filters (autocrlf,
  `.gitattributes`), so a one-line edit of a CRLF checkout diffs as one line against the session-start commit,
  not as a whole-file rewrite. Batch where git allows it (spec); correctness over process count.
- **Deterministic synthetic commits.** B and H are made with a fixed author/committer identity passed through
  the environment (so a machine with no `user.email` still builds) and dates taken from the session start, so
  identical inputs rebuild identical shas.
- **No commit list** for the edits range: `LoadHistoryOpts` gains `noCommits?: boolean`; a history load with it
  issues no `GitHistoryCommand` and shows only the scope's own row.
- **Nothing to show.** An empty `base` keeps cwd, branch and isRepo from the normal change-list read, shows an
  empty file list (never the working tree) and puts the reply's `reason` in the summary caption.
- **Cache**: in-process, one entry per transcript path, keyed by the request cwd plus the size and mtime of
  the transcript and each subagent transcript; a changed key replaces the entry.
- **Measurement (added by the user after the spec):** the handler logs one line per call, and a Go benchmark
  covers the reconstruction step (Tasks 2 and 3).
- **Task 3 writes its own git runner** in `pkg/agentedits`: `gitinfo.run` is unexported and takes no
  environment (`GIT_INDEX_FILE`, identity) or stdin.
- **Fixture writes nothing under `~/.claude`.** The scenario's transcript lives in a temp dir and uses only
  cases that need no backup file (a created file, a file with no record, a foreign edit).
- **Existing scenarios.** Making edits the Claude-agent default changes what diff-scope, diff-source-row,
  diff-comments and workspace-changes open on. Task 5 updates their steps to keep each step's intent (picking
  the session chip explicitly where the step is about the session range).

### Task 1: The GitAgentEditsCommand wire contract
**Depends on:** none
**Files:** `pkg/wshrpc/wshrpctypes_git.go`, `pkg/wshrpc/wshserver/wshserver_agentedits.go`, `pkg/wshrpc/wshclient/wshclient.go`, `frontend/app/store/wshclientapi.ts`, `frontend/types/gotypes.d.ts`

**What to build:** the contract the frontend and the handler build on: `GitAgentEditsCommand` in `GitCommands`,
a handler in its own file that answers an empty `base` with `reason` "not built yet", and `task generate` run.

**Interfaces:**

```go
GitAgentEditsCommand(ctx context.Context, data CommandGitAgentEditsData) (*CommandGitAgentEditsRtnData, error)

type CommandGitAgentEditsData struct {
    Cwd            string `json:"cwd"`
    TranscriptPath string `json:"transcriptpath"`
}
type GitAgentEditFile struct {
    Path string `json:"path"`           // cwd-relative, forward slashes
    Flag string `json:"flag,omitempty"` // "" | "approximate" | "outside"
}
type CommandGitAgentEditsRtnData struct {
    Base      string             `json:"base"` // B; "" = nothing to show, see Reason
    End       string             `json:"end"`  // H
    Files     []GitAgentEditFile `json:"files"`
    BashCalls int                `json:"bashcalls"`
    Reason    string             `json:"reason,omitempty"`
}
```

**Acceptance:**
- the generated bindings are committed and `RpcApi.GitAgentEditsCommand` exists in `wshclientapi.ts`
- calling the command returns an empty `base` with a non-empty `reason`

### Task 2: Reconstruct an agent's files from its transcript
**Depends on:** none
**Files:** `pkg/agentedits/agentedits.go`, `pkg/agentedits/agentedits_test.go`, `pkg/agentedits/agentedits_bench_test.go`, `pkg/agentedits/testdata/large.jsonl`

**What to build:** the new package `pkg/agentedits`: `Parse`, `Replay`, `FileHistoryDir` and
`SubagentTranscripts` as the spec's Reconstruction steps 1-5 describe, pure
Go over transcript lines and file contents. Parse reads both file-history record shapes (`file-history-delta`
and `file-history-snapshot`), the Edit/Write/MultiEdit `tool_use` inputs whose `tool_result` is not an error
(a call with no result yet is not counted), and the Bash calls, from the transcript and each
`SubagentTranscripts` file, ordered by timestamp. Replay takes the lowest-version backup per path as its
pre-image (`backupFileName: null` = absent), falls back to `base` and marks the file approximate when no record
exists, applies the calls with the line-ending rule above, and on a missing or ambiguous `old_string` stops
that file, takes its `worktree` content as the post-image and marks it outside. Paths outside `repoRoot` are
dropped; a file absent on both sides is dropped. A benchmark (`go test -bench`, `b.ReportAllocs`) runs Parse
plus Replay over fixture transcripts, one of them with 100+ Edit/Write calls; it costs nothing on the normal
test path.

**Interfaces (Task 3 calls these):**

```go
package agentedits

type Flag string
const (
    Approximate Flag = "approximate"
    Outside     Flag = "outside"
)
type Log struct { // one transcript plus its subagent transcripts
    SessionStart int64  // unix seconds of the first timestamped record; 0 = none
    SessionCwd   string // the cwd the transcript records
    EditCalls    int    // successful Edit/Write/MultiEdit calls
    BashCalls    int
    // unexported: the ordered calls and the pre-image records
}
type File struct {
    Path       string // repo-relative, forward slashes
    Pre        []byte
    PreExists  bool
    Post       []byte
    PostExists bool
    Flag       Flag // "" when exact
}
type Reader func(repoPath string) (content []byte, ok bool, err error) // ok=false: absent there
func Parse(transcriptPath, fileHistoryDir string) (*Log, error)
func Replay(l *Log, repoRoot string, base, worktree Reader) ([]File, error) // sorted by Path
func FileHistoryDir(transcriptPath string) string
func SubagentTranscripts(transcriptPath string) ([]string, error) // <transcript minus .jsonl>/subagents/*.jsonl, sorted; none = empty
```

**Acceptance (each a unit test, no git):**
- a created file (null backup, then Write) has `PreExists` false and the written content as post-image
- an edit chain applies in order; `replace_all` replaces every occurrence; a non-unique `old_string` without
  it marks the file outside
- a path with no file-history record takes `base` content and is flagged approximate
- a foreign change between two edits (second `old_string` missing) flags the file outside with the worktree
  content as post-image
- a subagent's edit is included, its pre-image from the parent's records when present
- a path outside the repository is dropped; a relative path resolves against the transcript's cwd
- the older `file-history-snapshot` shape yields the same pre-images as the delta shape
- an errored `tool_result` drops its call; Bash calls (subagents included) are counted
- an Edit with LF `old_string` on a CRLF file applies and the post-image keeps CRLF
- `FileHistoryDir` returns `<config>/file-history` for a transcript at `<config>/projects/<p>/<id>.jsonl`
- `SubagentTranscripts` lists `subagents/*.jsonl` sorted, and none without error when the folder is absent
- `go test -run XXX -bench . ./pkg/agentedits` reports ns/op and allocs/op

### Task 3: Build B and H, cache them, and answer GitAgentEditsCommand
**Depends on:** Task 1, Task 2 (calls Parse, Replay, FileHistoryDir and SubagentTranscripts)
**Files:** `pkg/agentedits/commits.go`, `pkg/agentedits/commits_test.go`, `pkg/wshrpc/wshserver/wshserver_agentedits.go`, `pkg/wshrpc/wshserver/wshserver_agentedits_test.go`

**What to build:** `BuildCommits` in `pkg/agentedits` and the real handler. BuildCommits
(`func BuildCommits(ctx context.Context, repoRoot, parent string, sessionStart int64, files []File) (base, end string, err error)`)
uses a temporary `GIT_INDEX_FILE` (deleted
afterwards): `read-tree <parent>`, write the pre-images (remove absent paths), `write-tree`, commit B (parent:
`parent`); write the post-images, `write-tree`, commit H (parent: B), with the blob, identity and date rules
above, batching blob writes and index updates. The handler: an empty cwd or transcript path, a cwd that is not
a repository, an unborn HEAD, or no edits each return an empty `base` with a `reason` the caption can show;
otherwise it checks the cache, else `Parse(transcript, FileHistoryDir(transcript))`, anchors on
`gitinfo.CommitBefore(cwd, SessionStart)` or HEAD when that is "", `Replay`s with a base reader at the anchor
(batched, e.g. `cat-file --batch`) and a worktree reader, builds B and H, and returns cwd-relative paths with
their flags and `BashCalls`. Every call logs exactly one line to the wavesrv log:
`agentedits: transcript=<%q path> calls=<EditCalls> files=<n> cache=<hit|miss> ms=<wall ms>`, with
` err=<%q>` appended on a failure.

**Acceptance:**
- in a temporary repository, `git diff --name-only B H` lists exactly the files given, B's parent is the
  given commit and H's parent is B, and the temporary index file is gone afterwards
- an absent pre-image makes the file an addition in `B..H`; a file present before and the same after does not
  appear
- with `core.autocrlf=true` and a CRLF working tree, a one-line change diffs as one line
- a second call with an unchanged transcript is a cache hit and returns the same B and H; appending a line to
  the transcript or a subagent transcript makes the next call a miss
- the handler answers an empty `base` with a reason for a non-repository cwd and for an empty transcript path;
  an agent cwd in a subfolder of the repository gets paths relative to that cwd
- the log line is written once per call in the format above (a test captures it)

### Task 4: The "Agent's edits" range in the Diff surface
**Depends on:** Task 1 (`RpcApi.GitAgentEditsCommand` and its types)
**Files:** `frontend/app/view/agents/diffscope.ts`, `frontend/app/view/agents/diffscope.test.ts`, `frontend/app/view/agents/historyrows.ts`, `frontend/app/view/agents/historyrows.test.ts`, `frontend/app/view/agents/filesstore.ts`, `frontend/app/view/agents/filesstore.test.ts`, `frontend/app/view/agents/githistorystore.ts`, `frontend/app/view/agents/githistorystore.test.ts`, `frontend/app/view/agents/filessurface.tsx`, `frontend/app/view/agents/changedfilelist.tsx`, `frontend/app/view/agents/commitpane.tsx`, `frontend/app/view/agents/agentdiffnav.ts`, `frontend/app/view/agents/agentdiffnav.test.ts`, `frontend/app/view/agents/diffsource.ts`, `frontend/app/view/agents/diffsource.test.ts`, `frontend/app/cockpit/actions/agent.ts`, `frontend/app/view/agents/agentdetailsrail.tsx`, `frontend/app/view/agents/cockpitsurface.tsx`, `frontend/app/view/agents/renderedcomposer.tsx`, `frontend/app/view/agents/workspacechangestab.tsx`

**What to build:** the spec's Frontend section. `DiffRange` gains `{ kind: "edits"; agentId }`, key
`edits:<agentId>`, chip label "Agent's edits", the default range of a Claude agent's scope, with "Since session
start" still offered; every switch over range kinds gets its case. `filesstore` resolves the range through
`GitAgentEditsCommand` (with `HISTORY_RPC_TIMEOUT_MS`) to the bounded `{ ref: base, end }` read and re-calls it
on each poll tick; `FilesState` carries the reply's flags, Bash count and reason for this range only. The file
list marks approximate and outside rows, the summary caption gives the file count and, with `bashcalls > 0`,
that N Bash calls may have changed files not shown, and an empty `base` shows the reason over an empty list.
History for the range uses `noCommits`. Wording, marks and placement follow `DESIGN.md` with existing tokens.
State changes: a mark appearing on a row already listed (a poll found an outside change) uses moment 14
(`useChangeFlash`); the caption's counts change as text like the other summary counts.

**Interfaces (Task 5's scenario reads these):** the chip is `data-range-chip="edits"`; a flagged row carries
`data-edit-flag="approximate"` or `data-edit-flag="outside"` on its `data-changed-file-row` element or a child
of it; the caption is the existing summary element.

**Acceptance:**
- `defaultRangeFor` gives the edits range for a Claude agent origin and for one with no runtime, and the
  session range for a pi, codex or opencode agent; `availableRanges` lists the edits chip on the same rule
- `rangeKey` of the edits range is `edits:<agentId>`; review marks for it key on `<cwd>|edits:<agentId>`
- `summaryLine` for the edits range states the file count, adds the Bash sentence only when the count is above
  0, and shows the reason when `base` is empty
- a load of the edits range calls `GitAgentEditsCommand` with the agent's cwd and transcript path and then
  `GitChangesCommand` with `ref: base, end`; an empty `base` lists no files; a poll tick re-calls the command
- a history load with `noCommits` issues no `GitHistoryCommand`, and a poll tick on the edits range issues none
- every `agentDiffScope` caller passes the agent's runtime
- shown by diff-agent-edits steps 1-4 (range, list, flags, Bash caption), step 5 (no commit list on the edits
  range) and step 7 (the reason over an empty list) in Task 5

### Task 5: The diff-agent-edits scenario, and existing scenarios on the new default
**Depends on:** Task 3 (the real command the scenario reads), Task 4 (the range and marks it shows)
**Files:** `scripts/cdp/scenarios-files-edits.mjs`, `scripts/cdp/scenarios.mjs`, `scripts/cdp/scenarios-files.mjs`, `scripts/cdp/scenarios-files-scope.mjs`, `scripts/cdp/scenarios-workspace-changes.mjs`, `scripts/cdp/scenarios-cockpit.mjs`

**What to build:** a CDP scenario `diff-agent-edits`, registered in `SCENARIOS`. Arrange: a temporary
repository with committed files; a fixture transcript in a temp dir (timestamps after the seed commit) that
Writes a new file (file-history record with null backup), Edits a file with no record, Edits a file whose
second `old_string` no longer matches, and runs one Bash call; the working tree holds those results plus an
unrelated edit to a file the transcript never touches. A roster agent with no `agent` field (absent = claude)
points its `transcriptpath` at the fixture and its cwd at the repository. A second roster agent, `agent:
"claude"`, has a transcript with timestamped records but no Edit/Write calls. Teardown removes all of it. Then run each
scenario in the Final line and update the steps of diff-scope, diff-source-row, diff-comments,
workspace-changes and surface-headers that assumed an agent opens on the session range, keeping what each step
proves (pick the session chip explicitly where the step is about the session range; give the agent a fixture
transcript where the step needs the agent's own row).

**Acceptance:** `node scripts/cdp/final-verify.mjs diff-agent-edits` passes these steps, each with a screenshot:
1. picking the agent opens the Diff surface on the pressed `data-range-chip="edits"` chip, with "Since session
   start" also offered
2. the list holds the created, the approximate and the outside file, and not the unrelated edit
3. the approximate and the outside rows carry their `data-edit-flag` marks
4. the summary caption names 3 files and 1 Bash call
5. the history column on the edits chip shows only the scope's own row, no commit rows
6. picking "Since session start" lists the unrelated edit too, and the history column shows commit rows again
7. picking the second agent opens on the pressed edits chip with an empty file list (none of the working
   tree's files) and the reply's reason in the summary caption

Every other scenario in the Final line passes.
