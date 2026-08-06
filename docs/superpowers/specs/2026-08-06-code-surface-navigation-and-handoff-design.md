# The Code surface: navigation, search, and handoff

**Date:** 2026-08-06
**Status:** design approved, no plan written yet
**Design source:** none — no mockup exists. Composition follows the surface's own two-pane shape and the cockpit scaffold (`surfacescaffold.tsx`).
**Supersedes in part:** `docs/superpowers/specs/2026-08-03-code-browser-surface-design.md`, whose out-of-scope list this deliberately reopens for content search and for the two cockpit entry points. Its decision that the surface is read-only was already reversed by commit `1ed5bb03`.

## Why

The Code surface (`frontend/app/view/code/`, nav label "Code", `SurfaceKey` `code`) can open any file in a registered project and, since `1ed5bb03`, edit and save it. Three things stop it being usable:

**Its keyboard navigation does not work.** The tree pane derives its cursor from *the currently open file* and its `setCursor` only acts on file rows, so:

- Moving the cursor onto a directory row is a no-op, and the cursor never advances past one. With no file open the cursor starts on a directory, which means `j`/`k` do nothing at all until a file is opened with the mouse.
- `activate` (Enter) looks the cursor up by the open-file path, which can never match a directory row, so the branch its own comment describes — "Enter on a directory expands it" — is unreachable.
- Moving the cursor calls `openPath` with the default history push, so walking a folder floods the back/forward stack and makes Back useless.
- The shared list-nav bindings are gated on `!ctx.editable`. Now that the editor is writable, the caret sits in Monaco most of the time and the tree keys are dead until the user clicks out.

**It cannot find code, only filenames.** The finder ranks paths. There is no way to search file contents, which is how orientation in an unfamiliar repository actually starts.

**It is disconnected from the rest of the cockpit.** A unified diff tells you what changed but not what surrounds it; a Radar finding names files it cannot open; and reading code that needs work leaves you retyping the path into an agent by hand.

This design fixes the navigation, adds content search, and adds three connections: in from a diff, in from a Radar finding, and out to a live agent.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| The Code surface itself | `frontend/app/view/code/` (15 files, ~1,465 lines) | Shipped in `5c12d267` (read-only browser) and `1ed5bb03` (writable). Project picker, `git ls-files` index feeding both tree and finder, Monaco viewer, draft/save/conflict handling, back/forward history. |
| File index reader and command | `gitinfo.ListFiles`, `GitListFilesCommand` | Shipped. `ls-files --cached --others --exclude-standard -z`, capped at `maxListFiles = 20000`. This repository lists 1,857 files, so the cap is not a live concern. |
| The git subprocess helper | `run(ctx, cwd, args...)` in `pkg/gitinfo/gitinfo.go:39` | `exec.CommandContext` + `cmd.Output()`, so a nonzero exit yields `*exec.ExitError` while stdout is still returned. `gitTimeout = 10s` per reader. |
| Monaco wrapper with a mount hook | `CodeEditor` in `frontend/app/view/codeeditor/codeeditor.tsx` | Shipped. Its `onMount(editor, monaco)` prop already hands over the editor instance, so revealing a line and reading a selection need no change to this component. |
| Parsed unified diff carrying line numbers | `FileView` / `DiffLine.gNew` in `frontend/app/view/agents/gitdiff.ts` | Shipped. `gNew` is the new-side line number as a string, so a jump can land on the first changed line without re-parsing anything. |
| The diff pane header | `CenterPane` in `frontend/app/view/agents/filessurface.tsx:254` | Shipped. Draws the path, a "Read-only" label, and an "Open in editor ↗" button shelling out via `getApi().openExternal`. Receives `cwd`, non-null only for the working tree. |
| The Diff surface's resolved repository path | `filesStateAtom.cwd` | Shipped. |
| Radar finding detail | `RadarFindingDetail({ model, report, finding })` in `frontend/app/view/agents/radarfindingdetail.tsx` | Shipped. Already has the view model, `report.projectpath`, and `finding.files`; renders the affected files as inert `<li>` text at ~line 146. |
| Terminal keystroke injection | `ControllerInputCommand`, used by `steerWorker` in `channelactions.ts` | Shipped. Sends text plus `\r` into a live worker's PTY. |
| Live agent identity | `AgentVM.project`, `AgentVM.blockId`, `AgentVM.kind` in `agentsviewmodel.ts` | Shipped. `project` is the registry name; `blockId` is the injection target; `kind` distinguishes agents from plain terminals and detached background agents. |
| Cursor-move helper | `moveCursor(ids, current, delta)` in `frontend/app/view/agents/agentsviewmodel.ts:573` | Shipped. Clamps at both ends. The new tree keyboard module reuses it rather than reimplementing movement. |
| List-nav registry | `useSurfaceListNav` / `listNavAtom` in `frontend/app/store/keybindings/listnav.ts` | Shipped. Its own doc comment says two-focus surfaces own their keys and must not register a controller. |
| Absolute-path join | `joinRepoPath` in `frontend/util/paths.ts` | Shipped. Normalizes a join to all-backslashes for `ShellExecute`. **Not** a comparison helper. |

## Resolved decisions

**1. The tree gets a real cursor, and moving the cursor no longer opens a file.** A new `codeCursorAtom` holds the highlighted row's path, file or directory. `Enter` becomes the action: toggle on a directory, open on a file.

This is a deliberate break from the shared list-nav contract, whose comment states "cursor == selection: moving IS selecting". That contract is right for a session list and wrong for a file tree: every cursor move would stat-then-read a file over RPC and push a history entry. Enter-to-open is also what fixes the flooded back stack without a special case.

**2. The tree pane owns its keys and stops publishing a list-nav controller.** With no controller published for `code`, the shared `j`/`k`/arrow/`Enter` bindings no-op on this surface and pass through, because their `when` requires a controller whose surface matches.

The Code keys are still registered as `Binding`s in the "Code" group so the shortcuts cheat sheet stays honest, but they are gated on the tree pane holding focus rather than on `!ctx.editable`. That is what makes them survive the caret being in Monaco.

**Focus is tracked in an atom, not read from the DOM.** A new `codeTreeFocusedAtom` is set by the tree pane's `onFocus` and `onBlur`, and the bindings' `when` reads it. A `document.activeElement` query in `when` would be wrong twice: `store.test.ts` already asserts that the Code bindings conflict with nothing by calling every `when(ctx)` across every context, and `vitest.config.ts` declares no `environment`, so those tests run in Node where `document` is undefined and the query throws. The codebase convention also puts DOM queries in `run`, never `when` — the Diff surface's compare binding clicks `[data-range-chip="compare"]` from `run`. Moving focus with `Alt+T` and `Alt+E` does query the DOM, and correctly so, because that happens in `run`.

*Rejected: a raw `onKeyDown` on the tree pane.* Simpler, but the keys would be invisible in the cheat sheet and outside the conflict assertion.

*Rejected: extending the shared controller with a "moving does not select" flag.* One consumer, one flag, and it would put file-tree semantics into a module that deliberately knows nothing about any surface's rows.

**3. `Alt+T` focuses the tree, `Alt+E` returns to the editor.** A bare letter cannot serve: the file finder already had to move off `f` onto `Ctrl+P` for exactly this reason. Only `Alt+ArrowLeft`/`Alt+ArrowRight` (history) are bound on this surface today, so `Alt` is free. Clicking a tree row focuses the pane as a side effect of being a button.

**4. Bare `ArrowLeft`/`ArrowRight` collapse and expand the cursor's directory.** Standard tree behavior, and both keys are unbound. They do not jump to the parent directory — that is a second gesture for a problem nobody has stated.

**5. One primitive serves every jump: `openInCode(model, { projectPath, rel, line? })`.** Content-search results, the diff jump, the Radar jump, and jump-to-line are the same call with different arguments. It resolves the project, switches project only if it changed (so a jump within the current repository keeps expand state and history), expands ancestors, opens the file, sets the cursor, scrolls the row into view, and sets `surfaceAtom` to `code`.

It takes the view model because `surfaceAtom` lives on the `AgentsViewModel` instance rather than in a module. `codestore.ts` imports that type only — the same seam `bindings.ts` already uses.

**6. Path comparison needs its own helper; `joinRepoPath` is not one.** `joinRepoPath` rewrites a join to all-backslashes so `ShellExecute` resolves it; it cannot tell whether an incoming path names a registered project. A jump carries a path from git (forward slashes) or from config (backslashes), so a new `sameRepoPath(a, b)` in `frontend/util/paths.ts` compares separator-insensitively and case-insensitively (Windows-only build). This is the same class of defect as the Radar path-separator problem.

**7. A jump to an unregistered repository still opens.** `launchAgent` creates worktrees, so a diff's `cwd` is frequently a worktree absent from the project registry. Rather than refuse, `openInCode` synthesizes a `CodeProject` named for the directory's basename: `git ls-files` needs only a path, and a worktree is a repository. The header shows the full path, so nothing is concealed. Without this, jumping from any worktree agent's diff fails silently.

Consequence, accepted: a synthesized project's name matches no registry entry, so sending a reference to a live agent (decision 12) finds no target for it and falls back to the clipboard.

**8. The store never imports Monaco.** `openInCode` publishes a `codePendingLineAtom`; `codeviewer.tsx` captures the editor through `CodeEditor`'s existing `onMount`, reveals the line once the text is in place, and clears the atom. The editor dependency stays in the one component that already renders it.

**9. Content search is `git grep`, fixed-string and case-insensitive, and it must pass `--untracked`.** Verified empirically: default `git grep` searches tracked files only and misses an untracked-but-not-ignored file, while `--untracked` finds it and still skips a `.gitignore`d file. Since the tree and finder are built from `ls-files --cached --others --exclude-standard`, omitting the flag would make search and tree disagree about which files exist — breaking the single-source-of-truth property the original design was built on.

Regex search is out. Fixed-string plus case-insensitive covers ordinary code search, and a mode flag on the command is a cheap follow-up if it ever earns one.

**10. The left column becomes two modes, Files and Search, and widens in Search mode.** The surface keeps its two-pane shape and gains no third region. A result row carries a line number and a line of source, which is unreadable at 280px, so Search mode widens the column to ~380px.

*Rejected: a bottom results panel.* A third region, a resize concern, and it competes with the editor for vertical space.

*Rejected: an overlay palette like the finder.* Search results are read repeatedly while jumping between them; an overlay that closes on each jump makes that a loop of reopening.

**11. Jump-to-line extends the finder's query rather than adding a dialog.** `path:123` opens that file at line 123; a bare `:123` jumps within the file already open. Parsing is pure and tested. No `Ctrl+G` overlay, no second palette.

**12. A handoff to an agent sends a one-line reference, never a snippet.** `ControllerInputCommand` appends `\r` and submits; a multi-line payload would submit at its first newline and dribble the remainder in as separate messages. So the payload is `frontend/app/view/code/codestore.ts:152-221` plus an optional one-line note. This sidesteps the terminal-injection problem instead of fighting it, and reading the file is what the agent is for.

**13. A handoff is not recorded anywhere.** Channel steering posts a "directive" channel message so a channel timeline stays the single source of truth, but the Code surface has no channel to post to. This is equivalent to typing into the agent's terminal by hand. Accepted asymmetry, not an oversight.

**14. The jump from a diff is allowed for a historical commit, not only the working tree.** The Code surface always shows the working-tree file — its back/forward history re-reads from disk deliberately, "as it is now rather than as it was". If the path is gone, the surface's existing "file no longer exists" state says so and offers the index refresh. Restricting the jump to the working tree would block the common case of reading around a change an agent committed.

**15. The save controls stay in the surface header.** File identity moves into a new path bar above the editor while save status, save and discard remain in `SurfaceHeader`. Splitting related information is a real cost, but relocating working controls for tidiness is churn in a file this design already edits for other reasons.

## 1. Backend

### Reader, in `pkg/gitinfo/gitinfo.go`

```go
type GrepMatch struct {
    Path string
    Line int
    Text string
}

// GrepResult is at most maxGrepMatches matches; Truncated reports that the search was cut short.
type GrepResult struct {
    Matches   []GrepMatch
    Truncated bool
}

// Grep searches file contents in cwd for a fixed, case-insensitive string across tracked and
// untracked-not-ignored files — the same set ListFiles enumerates.
func Grep(ctx context.Context, cwd, query string) (*GrepResult, error)
```

Command: `grep --untracked -n -z -I -i -F --no-color -e <query>`, via the existing `run` helper and the existing `rev-parse --is-inside-work-tree` probe for the repository check, exactly as `ListFiles` does.

Flag by flag: `--untracked` for the file-set agreement in decision 9; `-n` for line numbers; `-z` to NUL-separate the path and line fields so a path containing a space or non-ASCII byte survives; `-I` to skip binary files; `-i` and `-F` for case-insensitive fixed-string matching.

**Record format, verified by running it:** each record is `path\0line\0text`, terminated by a newline. Parse with `strings.SplitN(record, "\x00", 3)`.

**Exit codes, verified by running them:** `git grep` exits **1** when there are no matches and **128** when cwd is not a repository. Exit 1 must be treated as an empty result, not a failure — check with `errors.As(err, &ee)` on `*exec.ExitError` and `ee.ExitCode() != 1`. This is the single most likely implementation bug: without it, every no-match search reads as a broken RPC.

An empty or whitespace-only query returns an empty result without shelling out. `git grep -e ""` matches every line of every file.

Cap at a package constant `maxGrepMatches = 500`, mirroring `maxListFiles`, and set `Truncated`.

Known limitation, recorded rather than engineered around: `git grep` terminates records with a newline regardless of `-z`, so a filename containing a newline produces a bogus record. That is the limit of the output format.

### Command, in `pkg/wshrpc/wshrpctypes_git.go`

```go
GitGrepCommand(ctx context.Context, data CommandGitGrepData) (*CommandGitGrepRtnData, error)

type CommandGitGrepData struct {
    Cwd   string `json:"cwd"`
    Query string `json:"query"`
}

type CommandGitGrepRtnData struct {
    Matches   []GitGrepMatch `json:"matches"`
    Truncated bool           `json:"truncated,omitempty"`
}

type GitGrepMatch struct {
    Path string `json:"path"`
    Line int    `json:"line"`
    Text string `json:"text"`
}
```

Added to the `GitCommands` interface beside `GitListFilesCommand`, with a thin passthrough in `pkg/wshrpc/wshserver/wshserver_git.go` matching `GitListFilesCommand`'s shape. Then `task generate` to regenerate `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts`.

Two return conventions exist among the git commands: the older change-list and diff commands hand raw git output across the wire (`CommandGitCommitChangesRtnData.StatusZ`, `CommandGitCommitDiffRtnData.Diff`) and let one frontend parser serve several callers, while `CommandGitListFilesRtnData` splits in Go and returns a typed list. Grep follows `ListFiles`, its direct neighbour: the mixed NUL-and-newline record format is exactly the parsing Go already does for `ls-files`, the match cap has to be applied in Go regardless, and there is no second caller to share a TypeScript parser with.

**Two timeouts, deliberately different.** The reader self-limits at the package's `gitTimeout` of 10s. The frontend passes an explicit ~20s RPC timeout on this one call, because the RPC layer's `DefaultTimeoutMs` of 5s binds the server-side context and would kill a search the server would otherwise have finished — the same escape hatch `sendChannelMessage` uses for consults. The client ceiling sits above the server's so the server's own limit is the one that decides.

## 2. Frontend — the tree

### `codetreekeys.ts` (new, pure, tested)

The whole keyboard contract, extracted so the currently-broken directory cases are testable without a DOM:

```ts
export type TreeAction =
    | { kind: "move"; path: string }
    | { kind: "toggle"; path: string }
    | { kind: "open"; path: string }
    | { kind: "none" };

export function treeKeyAction(
    rows: readonly TreeRow[],
    cursor: string | null,
    key: "next" | "prev" | "collapse" | "expand" | "activate"
): TreeAction;
```

`next`/`prev` move over every row, directory or file, delegating to the existing `moveCursor` for the step and its clamping. `activate` toggles a directory and opens a file. `collapse` and `expand` act on a directory and otherwise do nothing.

### `codetreepane.tsx` (changed)

Reads `codeCursorAtom`, renders the cursor tint separately from the open-file tint (they are now different things), scrolls the cursor row into view on change, is focusable and reports its focus into `codeTreeFocusedAtom`, and drops its `useSurfaceListNav` registration.

### `codestore.ts` (changed)

Adds `codeCursorAtom: PrimitiveAtom<string | null>`, `codePendingLineAtom: PrimitiveAtom<number | null>` and `codeTreeFocusedAtom: PrimitiveAtom<boolean>`, the first two reset by `selectProject`.

Also adds a derived `codeRowsAtom` computing `visibleRows(buildTree(index.paths), expanded)`. The tree pane and the keyboard bindings must agree on the row list; a derived atom is cached by jotai, so both read one computed value instead of the pane memoizing it privately where a binding cannot see it.

## 3. Frontend — the jump primitive

In `codestore.ts`:

```ts
export async function openInCode(
    model: AgentsViewModel,
    target: { projectPath: string; rel: string; line?: number }
): Promise<void>;
```

1. Resolve the project: match `target.projectPath` against `projectsAtom` with `sameRepoPath`; on no match, synthesize `{ name: basename(projectPath), path: projectPath }` (decision 7).
2. If it differs from `codeProjectAtom` by `sameRepoPath`, `selectProject` it; otherwise leave the session intact.
3. `revealPath(target.rel)`, then `openPath(target.rel)` (history pushes, as a jump is a move).
4. Set `codeCursorAtom` to `target.rel` and `codePendingLineAtom` to `target.line ?? null`.
5. Set `model.surfaceAtom` to `"code"`.

`codeviewer.tsx` honors the pending line through `CodeEditor`'s `onMount` and clears it (decision 8). Monaco is keyed by file path, so the mount fires per file.

## 4. Frontend — reader affordances

**`codepathbar.tsx` (new).** A thin bar above the editor: the open file's repo-relative path, a copy-absolute-path button (`joinRepoPath`), the unsaved-edits dot, and the send-to-agent control from section 6.

**`codefinder.ts` (changed).** A pure `parseFinderQuery(q): { text: string; line?: number }` implementing decision 11. `codefinderpalette.tsx` routes a parsed line through `openInCode`; a bare `:123` targets the open file.

## 5. Frontend — content search

**`codesearch.ts` (new, pure, tested).** Groups flat matches by file, preserving git's order, and formats the count summary.

**`codesearchstore.ts` (new).** Query atom plus a state union, and a loader with a guard token like every other loader in this surface:

```ts
export type SearchState =
    | { kind: "idle" }
    | { kind: "searching"; query: string }
    | { kind: "done"; query: string; matches: GitGrepMatch[]; truncated: boolean }
    | { kind: "error"; query: string; message: string };
```

Its own module rather than growing `codestore.ts` past its current 325 lines; it imports `codeProjectAtom` one-directionally.

**`codesearchpane.tsx` (new).** The Search mode of the left column: query input, grouped results, a match row showing line number and source text, truncation notice, and empty and error states. A match click is `openInCode` with its line.

**`codesurface.tsx` (changed).** A two-tab header on the left column switching Files and Search, and the column width by mode (decision 10).

## 6. Frontend — the connections

**`codehandoff.ts` (new, pure, tested).**

```ts
export function handoffLine(a: { rel: string; startLine?: number; endLine?: number; note?: string }): string;
export function liveAgentsForProject(agents: readonly AgentVM[], projectName: string): AgentVM[];
```

`handoffLine` produces the single line of decision 12. `liveAgentsForProject` keeps agents with a `blockId` whose `project` matches and whose `kind` is neither `"terminal"` nor `"background"`.

The control in the path bar: one candidate sends immediately, labeled with the agent's name; several show a short list; none copies the reference to the clipboard and says so. The line range comes from Monaco's current selection through the instance `codeviewer.tsx` already holds; with no selection the reference is the path alone. Send is `ControllerInputCommand` with the composed line plus `\r`; an RPC failure surfaces rather than being swallowed.

**`gitdiff.ts` (changed).** A pure `firstChangedLine(view: FileView): number | undefined` returning the first added line's `gNew` as a number, falling back to the first hunk's new-side start for a deletion-only hunk.

**`filessurface.tsx` (changed).** `CenterPane`'s existing `cwd` prop is renamed `editorCwd` (the external-editor gate, working tree only) and a new `repoCwd` is added (the repository, always), so two paths with different rules stop sharing one name. An "Open in Code" button beside "Open in editor ↗" calls `openInCode` with `repoCwd`, the selected path, and `firstChangedLine`.

This file is over 700 lines and this working tree is edited from parallel sessions: the implementation must re-check `git status` and stage only its own files.

**`radarfindingdetail.tsx` (changed).** Each affected-file `<li>` becomes a button calling `openInCode(model, { projectPath: report.projectpath, rel: f })`. Findings carry no line numbers, so these land at the top of the file.

## 7. Wiring — the files not named in sections 1 to 6

| File | Change |
|---|---|
| `frontend/app/store/keybindings/bindings.ts` | Tree keys (`j`/`k`, `ArrowUp`/`ArrowDown`, `ArrowLeft`/`ArrowRight`, `Enter`) in group "Code", gated on tree focus; `Alt:t` and `Alt:e` for focus; `Ctrl:Shift:f` for search, ungated on `editable` like `Ctrl:p` and `Ctrl:s` already are. |
| `frontend/util/paths.ts` | `sameRepoPath(a, b)`. |
| `scripts/cdp/scenarios.mjs` | A `code-search` scenario. |

The `Escape` guard already excludes an open finder; the search pane is a column mode rather than an overlay, so it adds no `Escape` claimant.

## 8. Failure modes

| Situation | What the user sees |
|---|---|
| Search matches nothing | Empty state in the search pane, query preserved |
| Search RPC failed | Error row with retry, distinct from "no matches" |
| Search exceeded 500 matches | Truncation notice, same idiom as the finder's truncated-index notice |
| Search on a project that is not a repository | The surface never reaches search — the existing "Not a git repository" empty state holds |
| Jump to a path not in the working tree | The existing "file no longer exists" state, offering the index refresh |
| Jump to an unregistered repository | Opens under a synthesized project; the header shows the full path |
| Jump to a path that is not a repository | The existing "Not a git repository" empty state, naming the path |
| Handoff with no live agent for this project | The reference is copied to the clipboard, and the control says so |
| Handoff whose target terminal block is gone | The RPC error surfaces |
| Tree focused with no rows | Keys no-op |

## 9. Testing

**Vitest, beside each pure module.**

- `codetreekeys.test.ts` — moving onto a directory row moves the cursor; `activate` toggles a directory; `activate` opens a file; moving never opens; collapse and expand no-op on a file; both ends clamp. These fail against today's code, which is the point.
- `codefinder.test.ts` (extended) — `path:123`, bare `:123`, a query with no line, and a path whose own text contains digits.
- `codesearch.test.ts` — grouping preserves git's order; multiple matches in one file group once; the summary counts files and matches.
- `codehandoff.test.ts` — a selection produces a range, no selection produces the path alone, a note is trimmed and appended, and the result is always one line; `liveAgentsForProject` excludes terminals, background agents, and agents with no block, and matches on project name.
- `gitdiff.test.ts` (extended) — `firstChangedLine` on an added line, on a deletion-only hunk, and on an empty view.
- `paths.test.ts` — `sameRepoPath` across separator and case differences, and rejecting genuinely different paths.

**Go, in `pkg/gitinfo/gitinfo_test.go`,** on the existing temp-repository harness: a match returns path, line and text; **no matches returns an empty result and no error** (the exit-1 trap); an untracked-not-ignored file is searched and a `.gitignore`d file is not (the `--untracked` decision); a binary file is skipped; matching is case-insensitive; the 500-match cap sets `Truncated`; an empty query returns empty without running git.

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/gitinfo/...
```

**No jsdom render tests** — settled posture for cockpit surfaces. "Does it render" is the existing CDP `surface-smoke` scenario, which already covers `code`. One new `code-search` scenario in `scripts/cdp/scenarios.mjs` drives the search pane end to end.

**Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`; bare `npx tsc` stack-overflows on this repository, so `task check:ts` is unusable. The baseline is clean, so any error reported belongs to this work.

**The new RPC needs `task build:backend`** before the dev app can call it, and a backend built inside a worktree writes that worktree's `dist/bin` — main's `wavesrv` stays stale until rebuilt there.

**Never run `prettier --write` on `scripts/cdp/scenarios.mjs`.** `.editorconfig` omits `.mjs`, so Prettier reindents the whole file to two spaces and a small scenario addition becomes a whole-file diff. Hand-format the added lines to the file's existing four-space style.

## 10. Suggested phasing

This touches 6 new source files, 14 changed source files, 3 new test files and 4 extended ones, plus 2 generated files — a large single plan. Phase it so each stage is independently verifiable:

1. The grep reader, the RPC command, and `task generate`. Verified by Go tests and a backend build.
2. `sameRepoPath`, the tree keyboard contract and cursor, and the jump primitive with line reveal. Verified by Vitest and by keyboard use in the dev app.
3. Search: the pure grouping module, the store, the pane, and the two-mode column. Verified by the CDP search scenario.
4. The connections: the path bar, the handoff, the diff jump, and the Radar jump.

## 11. Explicitly out of scope

Regex or whole-word search. Search-and-replace. A file watcher. Open-file tabs. Go-to-definition or any symbol index. Following the runtime theme picker in Monaco (decision 4 of the 2026-08-03 design still holds). Browsing non-git directories, or remote and SSH connections. Recording a handoff in a channel timeline. Watching a file change live while an agent edits it — considered and cut; the manual index refresh and the conflict guard already cover the cases that bite.
