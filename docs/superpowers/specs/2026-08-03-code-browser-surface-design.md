# A Code surface: read a project's source

**Date:** 2026-08-03
**Status:** design approved, no plan written yet
**Design source:** none — no mockup exists for this surface. Composition follows the existing cockpit scaffold (`surfacescaffold.tsx`) and the Diff surface's header/picker idiom.

## Why

The cockpit can show you what an agent *changed* — the Diff surface (`filessurface.tsx`, nav label "Diff", `SurfaceKey` `files`) draws commit history, a commit's changed files, and that file's unified diff. It cannot show you what the code *is*. There is no way to open a file the agent did not touch, follow an import, or orient yourself in an unfamiliar repository without leaving the app.

This surface answers that one question and nothing else: **read any file in a registered project.** Read-only, git-scoped, deliberately disconnected from agents and runs.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| Monaco editor, read-only capable | `frontend/app/view/codeeditor/codeeditor.tsx` (`<CodeEditor readonly>`) | Shipped. Lazy-loads `monaco-react`, derives language from the filename, reads editor config overrides. **The viewer is this component — the Code surface writes no Monaco code.** |
| Monaco in the cockpit's build graph | `focus-pane.tsx` → `blockregistry` → `AiFileDiffViewModel` → `DiffViewer` → `import("@/app/monaco/monaco-react")` | Already a lazy chunk, off the boot path. `monaco-editor` resolves to `esm/vs/editor/editor.main.js`, which carries the basic-languages Monarch colorizers — Go and Rust highlight correctly; TypeScript, JSON, CSS and HTML additionally get language services from the contributions in `monaco-env.ts`. |
| Monaco theme scaffold | `loadMonaco()` in `frontend/app/monaco/monaco-env.ts` | Defines `wave-theme-dark` with a transparent editor background and `rules: []` — chrome themed, token colors stock `vs-dark`. Left as-is (decision 4). |
| Fuzzy matcher | `fuzzyScore(query, text)` in `frontend/app/cockpit/palette-match.ts` | Shipped, used by the command palette. Case-insensitive subsequence. The file finder reuses it. |
| File read and stat over RPC | `FileReadCommand`, `FileInfoCommand` (`pkg/wshrpc/wshrpctypes_file.go`) | Shipped. Read returns base64 in `Data64`; `base64ToString` in `@/util/util` decodes. Read ceiling is `MaxFileSize` = 50 MB (`wshrpctypes_const.go`). |
| Registered projects (name → path) | `projectsAtom` in `frontend/app/view/agents/projectsstore.ts`, off `fullConfigAtom` | Shipped. Same source the Diff surface's project scope uses. |
| Surface chrome | `SurfaceHeader`, `SurfaceEmptyState`, `SurfaceError` in `frontend/app/view/agents/surfacescaffold.tsx` | Shipped. Used unchanged. |
| Shared list keyboard navigation | `useSurfaceListNav` / `ListNavController` in `frontend/app/store/keybindings/listnav.ts` | Shipped. Gives the tree `j`/`k`, arrows and Enter for free. |
| Git command plumbing | `pkg/gitinfo/gitinfo.go` + thin passthroughs in `pkg/wshrpc/wshserver/wshserver_git.go` | Shipped pattern. One new reader and one new command follow it exactly. |

## Resolved decisions

**1. The surface is a reader, not a reviewer and not an editor.** No editing, no save, no "open in Code" from a diff or a transcript, no "send this file to the composer." The user's stated moment is *"just reading, no agent involved"* — general orientation in a repository. Every agent-facing affordance was considered and cut. This boundary is what keeps the surface small; adding any one of them later is a separate spec.

**2. One `git ls-files` call is the single source of truth for what files exist.** A new `GitListFilesCommand` returns a flat list of repo-relative paths; the frontend builds *both* the directory tree and the finder index from that one list. Consequences, all of them wanted:

- `.gitignore` becomes the ignore policy for free — no hand-maintained skip list for `node_modules`, `target`, `dist`.
- One RPC per project instead of one per expanded directory.
- The tree and the finder cannot disagree, because they are the same array.
- Git reports forward slashes always, sidestepping the mixed-separator problem the Diff surface had to work around.

*Rejected: a lazy tree built from `FileListCommand` per directory.* Zero backend, but `FileListOpts` offers only `All` (recursive), `Offset` and `Limit` — no way to prune a subtree. A recursive walk descends into `node_modules`, and `Limit` truncates rather than skips. The finder would then index only directories already expanded, which makes it a filter over what you have seen rather than a way to find what you have not — gutting the feature.

*Rejected: a generic ignore-aware walk RPC that also handles non-git directories.* Strictly more capable, strictly more code, and it reimplements `git ls-files` to serve a case not asked for. Every project in the registry is a repository, and the Diff surface already assumes that.

**3. A project that is not a git repository is an empty state, not a case to engineer around.** `IsRepo: false` renders "Not a git repository", naming the resolved path. Same posture the Diff surface already takes.

**4. Monaco keeps its stock `vs-dark` token colors.** The Code surface will not follow the runtime theme picker. Mapping `--color-syntax-*` custom properties into Monaco theme rules means a token-scope mapping layer plus a re-theme hook on every theme change, and Monaco's scopes do not map one-to-one onto the cockpit's handful of syntax tokens. Accepted as an honest deviation from the "colors come from `@theme` tokens" rule, consistent with the markdown stack, which pins shiki to `github-dark-high-contrast`. Revisit only if it reads badly beside the rest of the cockpit.

**5. Navigation between files is a back/forward history, not open-file tabs.** One file shown at a time; the tree and the finder both push onto a stack; `Alt+Left` / `Alt+Right` walk it. This matches how reading actually goes — follow a reference, come back — and costs an array and an index. Tabs would need a strip, overflow behavior, per-tab scroll restoration and per-tab Monaco model lifecycle, and would introduce a tab metaphor the cockpit deliberately has nowhere else.

**6. `code` is appended to `SURFACE_ORDER` as the ninth entry, not inserted next to Diff.** Appending keeps every existing `Ctrl+1..8` binding pointing at the same surface it points at today; inserting after `files` would shift Memory and Usage and break muscle memory for a cosmetic grouping win.

**7. The index is refreshed manually. There is no file watcher.** `git ls-files` is a snapshot. If an agent creates a file while you browse, the tree will not know until you press `r`. A watcher means a backend subscription, debouncing, and reconciling against expand state — real cost for a reader used in short bursts. The **missing-file** state (decision 8) is the honest failure and points at the refresh.

**8. Every file open is stat-then-read.** `FileInfoCommand` for size and MIME type, then `FileReadCommand` only if the file passes the gate. Two local round-trips instead of one, so that a 40 MB minified bundle is never pulled over the wire only to be refused.

## 1. Backend

### Reader, in `pkg/gitinfo/gitinfo.go`

```go
// FileList is every path git knows about in cwd: tracked files plus untracked files that
// .gitignore does not exclude. Paths are repo-relative with forward slashes, sorted.
// Truncated reports that the repo exceeded maxListFiles and Paths is a prefix.
type FileList struct {
    Paths     []string
    IsRepo    bool
    Truncated bool
}

// ListFiles enumerates cwd via `git ls-files --cached --others --exclude-standard -z`.
// IsRepo=false when cwd is not a repository; errors on a git failure so the caller can
// distinguish "nothing to browse" from "the read failed".
func ListFiles(ctx context.Context, cwd string) (*FileList, error)
```

NUL separation (`-z`) so paths containing spaces, quotes or non-ASCII survive the split — the same reason the existing `nameStatusToStatusZ` and `stripPrefixZ` helpers in this file use it. `--cached --others` cannot produce duplicates (`--others` is untracked-only), but the combined output is not globally sorted, so sort before returning. Cap at a package constant `maxListFiles = 20000`.

### Command, in `pkg/wshrpc/wshrpctypes_git.go`

```go
GitListFilesCommand(ctx context.Context, data CommandGitListFilesData) (*CommandGitListFilesRtnData, error)

type CommandGitListFilesData struct {
    Cwd string `json:"cwd"`
}

type CommandGitListFilesRtnData struct {
    Files     []string `json:"files"`
    IsRepo    bool     `json:"isrepo"`
    Truncated bool     `json:"truncated,omitempty"`
}
```

Thin passthrough in `pkg/wshrpc/wshserver/wshserver_git.go`, matching `GitHistoryCommand`'s shape. Then `task generate` to regenerate `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts`.

Timing: `git ls-files` on a repository of this size is well inside the 5-second default RPC budget (`DefaultTimeoutMs`), which binds the server-side context.

## 2. Frontend

New directory `frontend/app/view/code/`, following the precedent `frontend/app/view/jarvis/` set, rather than growing `frontend/app/view/agents/` (already ~240 files).

### Pure modules — each has a `.test.ts` beside it

**`codetree.ts`** — flat path list to render rows.

```ts
export interface TreeNode { name: string; path: string; isDir: boolean; children: TreeNode[] }
export interface TreeRow  { kind: "dir" | "file"; path: string; name: string; depth: number; expanded: boolean }

export function buildTree(paths: string[]): TreeNode[]
export function visibleRows(tree: TreeNode[], expanded: ReadonlySet<string>): TreeRow[]
export function ancestorsOf(path: string): string[]   // directories to expand to reveal `path`
```

Directories sort before files, both alphabetically. `ancestorsOf` exists so the finder can jump to a file inside a collapsed subtree and leave the tree showing where you landed.

**`codefinder.ts`** — ranked matches for the open box.

```ts
export interface FinderMatch { path: string; score: number }
export function rankPaths(query: string, paths: readonly string[], limit: number): FinderMatch[]
```

Scores with `fuzzyScore` from `frontend/app/cockpit/palette-match.ts`. That function returns a number or `null` and reports *no span*, so the basename preference cannot be a bonus applied to a matched region — it is scored separately and the better of the two wins:

```ts
score = max(
    fuzzyScore(query, basename(path)) + BASENAME_BONUS,   // when non-null
    fuzzyScore(query, path)                               // when non-null
)
```

so typing `agentrow` ranks `.../agentrow.tsx` above a path that merely contains those letters scattered across directory names. `null` from both means no match and the path is dropped. Empty query returns the first `limit` paths unranked.

**`codehistory.ts`** — the back/forward stack.

```ts
export interface History { stack: string[]; idx: number }
export function push(h: History, path: string): History      // truncates the forward tail
export function back(h: History): History                    // clamps at 0
export function forward(h: History): History                 // clamps at stack.length - 1
export function canBack(h: History): boolean
export function canForward(h: History): boolean
```

### State — `codestore.ts`

Every atom is module-scoped, because non-Agent surfaces unmount on nav switch and surface-local `useState` is lost — the same reason `filesstore.ts` does it.

```ts
export interface CodeProject { name: string; path: string }
export interface CodeIndex   { paths: string[]; isRepo: boolean; truncated: boolean }

export type CodeFile =
    | { kind: "none" }
    | { kind: "loading";  path: string }
    | { kind: "text";     path: string; text: string }
    | { kind: "binary";   path: string; size: number }
    | { kind: "toolarge"; path: string; size: number }
    | { kind: "missing";  path: string }
    | { kind: "error";    path: string; message: string };

export const codeProjectAtom:  PrimitiveAtom<CodeProject | null>
export const codeIndexAtom:    PrimitiveAtom<CodeIndex | null>
export const codeIndexErrorAtom: PrimitiveAtom<string | null>
export const codeExpandedAtom: PrimitiveAtom<Set<string>>
export const codeFileAtom:     PrimitiveAtom<CodeFile>
export const codeHistoryAtom:  PrimitiveAtom<History>
export const codeFinderOpenAtom: PrimitiveAtom<boolean>
```

One discriminated union for the opened file, so the viewer renders an exhaustive switch rather than juggling `loading` / `error` / `tooLarge` booleans that can contradict each other.

Loaders:

```ts
selectProject(p: CodeProject | null): Promise<void>  // resets expand/history/file, then loads the index
refreshIndex(): Promise<void>                        // drops the cache entry, reloads
openPath(rel: string, opts?: { pushHistory?: boolean }): Promise<void>
goBack(): Promise<void>
goForward(): Promise<void>
```

A module-level `Map<string, CodeIndex>` keyed by project path caches the index so returning to a project is instant; `refreshIndex` drops the entry. Loads carry a guard token set before the first `await`, like `filesstore.ts`'s `current.token`, so a slow load cannot overwrite a newer one.

`openPath` implements decision 8: `FileInfoCommand` on the joined absolute path, then branch on the result.

- `NotFound` → `missing`.
- `Size` over `MAX_VIEW_BYTES` (2 MB) → `toolarge`.
- MIME type not viewable → `binary`. Viewable means `text/*`, or a member of a named constant `TEXTISH_MIME` covering the `application/*` types that are really text — `application/json`, `application/javascript`, `application/xml`, `application/x-sh`, `application/x-yaml` — or an empty MIME type, which the backend returns for extensions it does not recognize and which would otherwise hide Go and Rust files.
- Otherwise `FileReadCommand`, `base64ToString`, then a NUL-byte scan of the first 8 KB as a backstop for a wrong or absent MIME type → `binary` or `text`.

`goBack` and `goForward` move the index in `codeHistoryAtom` and then call `openPath(pathAtIndex, { pushHistory: false })`, so they re-read from disk rather than replaying cached content — simpler, and it shows the file as it is now. Reads are local disk.

### Components

**`codesurface.tsx`** — `SurfaceHeader` titled "Code", subtitle showing the selected project's name and path, actions holding the project picker chip (a `PopoverReveal` over the sorted `projectsAtom` entries, matching the Diff surface's idiom), a refresh control, and back/forward buttons disabled by `canBack` / `canForward`. Body is a fixed 280px tree pane beside the viewer. Renders `SurfaceEmptyState` when no project is selected, when no projects are registered, or when `isRepo` is false; `SurfaceError` with retry when the listing RPC failed.

```
┌ Code    my-repo · C:\...\waveterm     [project ▾] [↻] [← →] ┐
├──────────────┬──────────────────────────────────────────────┤
│ tree, 280px  │  <CodeEditor readonly>                       │
└──────────────┴──────────────────────────────────────────────┘
```

**`codetreepane.tsx`** — rows from `visibleRows`, indented by depth, chevrons on directories, wired to `useSurfaceListNav` so the shared `j`/`k`/arrow/Enter bindings drive it.

**`codefinderpalette.tsx`** — an overlay input over the ranked list from `rankPaths`. Enter opens the selection, expands its ancestors, and closes. Escape closes without opening.

**The viewer** is `<CodeEditor blockId={model.blockId} readonly text={...} fileName={relPath} />`. Monaco infers the language from the model URI's extension, so no language map is written. *Risk to verify during implementation:* `CodeEditor` calls `useOverrideConfigAtom(blockId, …)` for minimap, sticky scroll, word wrap and font size; this needs confirming against the cockpit's block id rather than a real editor block.

### Wiring

| File | Change |
|---|---|
| `frontend/app/view/agents/agents.tsx` | `"code"` added to the `SurfaceKey` union and appended to `SURFACE_ORDER` (ninth entry, decision 6). |
| `frontend/app/view/agents/cockpitshell.tsx` | A `surface === "code"` branch rendering `<CodeSurface model={model} />`. Unmounts on switch like every surface except Agent. |
| `frontend/app/view/agents/navrail.tsx` | `ICON.code` (lucide `FileCode2`) and `{ key: "code", label: "Code" }` in `ITEMS`. |
| `frontend/app/store/keybindings/bindings.ts` | `SURFACE_ORDER.slice(0, 8)` → `slice(0, 9)` so `Ctrl+9` binds; `{ letter: "b", surface: "code", label: "Code (browse source)" }` in `GO_TARGETS` (`g c` is Jarvis, `g f` is Diff); `"code"` added to `ESC_HOME_SURFACES`; the go-home binding's guard gains a `!globalStore.get(codeFinderOpenAtom)` clause; new `buildCodeBindings()`. |

The go-home guard change is not optional. Two bindings match `Escape` while the finder is open — the finder's own close and the surface's go-home — and the dispatcher would otherwise run both, closing the finder *and* leaving for the Cockpit. This is exactly the collision the Diff surface already solved: its go-home guard checks `compareOnAtom` for the same reason (`bindings.ts:174-178`), and `codeFinderOpenAtom` joins that guard alongside it.

`buildCodeBindings()`, gated on `ctx.surface === "code" && !ctx.editable && !ctx.modalOpen`, in group "Code" so the shortcuts cheat sheet picks it up automatically:

| Key | Action |
|---|---|
| `f` | Open the file finder (`Ctrl+P` belongs to the command palette) |
| `Alt+Left` / `Alt+Right` | Back / forward through file history |
| `r` | Refresh the index |
| `Escape` | Closes the finder if open; otherwise falls through to the go-home binding |

### One duplication to resolve

`filessurface.tsx:78` already carries a `joinPath(cwd, rel)` that normalizes the mixed separators produced by joining a forward-slash git path onto a backslash Windows root. Lift it into a shared helper both surfaces import. **Caveat:** `filessurface.tsx` is 634 lines and this working tree is edited from parallel sessions — if it is dirty when the plan reaches this step, leave it alone and take the duplication rather than risk a conflicting edit.

## 3. Failure modes

| Situation | What the user sees |
|---|---|
| No projects registered | `SurfaceEmptyState` explaining that projects come from the registry |
| No project selected yet | `SurfaceEmptyState` whose action opens the project picker |
| Selected path is not a git repository | `SurfaceEmptyState` "Not a git repository", naming the resolved path |
| Listing RPC failed | `SurfaceError` with retry — distinct from "not a repo", which the Diff surface once conflated |
| Repository exceeds 20,000 files | Tree and finder work; the finder states that the index is truncated |
| File over 2 MB | **too-large** state: size plus a copy-path action. Never handed to Monaco |
| Binary file | **binary** state: size only |
| File in the index no longer on disk | **missing** state, offering the refresh — the visible consequence of decision 7 |
| Read failed for any other reason | **error** state carrying the message |

## 4. Testing

**Vitest, beside each pure module.** `codetree.test.ts`: nesting, files at the repository root, deep single-child chains, directories sorting before files. `codefinder.test.ts`: the basename bonus outranks a scattered path match, case-insensitivity, empty query, the limit holds. `codehistory.test.ts`: pushing after going back truncates the forward tail, both walks clamp at their ends.

**Go, in `pkg/gitinfo/gitinfo_test.go`,** on the existing temp-repository harness (`t.TempDir()` plus the `git(t, dir, …)` helper): tracked files and untracked-not-ignored files are both returned, a `.gitignore`d file is not, a non-repository directory returns `IsRepo: false` without an error, and a path containing a space survives the NUL split. Run it with the Windows-path CGO flag the repo requires:

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/gitinfo/...
```

**No jsdom render test** — that posture is settled for cockpit surfaces. "Does it render" is `code` added to `SMOKE_SURFACES` and `SURFACE_LABEL` in `scripts/cdp/scenarios.mjs`, verified against the live dev app with `task verify:ui -- surface-smoke`.

**Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`; bare `npx tsc` stack-overflows on this repository, so `task check:ts` is not usable. The baseline is clean, so any reported error belongs to this work.

## 5. Explicitly out of scope

Editing or saving. Content search across the repository (grep) — the finder matches paths only. Browsing non-git directories. Browsing remote or SSH connections. Jumping into this surface from the Diff surface or a transcript. Sending a file or path to an agent composer. A file watcher. Open-file tabs. Following the runtime theme picker. Each is a separate spec if it ever earns one.
