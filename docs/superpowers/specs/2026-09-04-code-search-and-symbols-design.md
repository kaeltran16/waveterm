# Code surface: real search, and symbols without an index

**Date:** 2026-09-04
**Status:** design approved, no plan written yet
**Design source:** none — no mockup. Follows the surface's column-mode idiom and the existing finder
palette.
**Predecessors:** `2026-08-06-code-surface-navigation-and-handoff-design.md` (which added content
search and the finder's `:line` and `>` grammar this extends).
**Reopens:** the 08-06 out-of-scope line "Regex or whole-word search" and "Go-to-definition or any
symbol index".
**Second of three.** Siblings, same date: `2026-09-04-code-git-aware-mutable-tree-design.md` (spec 1),
`2026-09-04-code-scope-beyond-registry-design.md` (spec 3). Order is 1 → 2 → 3.

## Why

Search on this surface is a single fixed, case-insensitive string across the whole repository. That is
enough to find a rare identifier and nothing more:

- **No regex, no whole-word.** Searching `id` returns every `uuid`, `width`, `hidden` and `valid` in
  the tree. There is no way to say "this word, exactly".
- **No path scoping.** A search for `openPath` cannot be limited to `frontend/`, so results from
  `dist/`, fixtures and generated files sit alongside the ones you wanted. `.gitignore` is the only
  filter, and it is not a search filter.
- **No structure.** You can open a 400-line file and you cannot see what is *in* it without reading
  it. Monaco supplies a symbol outline for TypeScript, JavaScript, JSON, CSS and HTML — and nothing
  for Go, Rust, Python, shell or anything else, which is most of what this repository is.
- **No way to follow a name.** Reading `openPath(rel)` at a call site, the only route to its
  definition is to guess the filename, open the finder, and scan. The surface knows the whole file
  list and can grep it, and still cannot answer "where is this defined".

This spec closes all four without building a symbol index, without an external binary, and without an
LSP client.

## What already exists — do not rebuild it

| Piece | Where | State |
|---|---|---|
| Content search reader | `gitinfo.Grep(ctx, cwd, query)` (`gitinfo.go:883`) | Shipped. Runs `git grep --untracked -n -z -I -i -F --no-color -e <q>`, parses `path\0line\0text`, caps at `maxGrepMatches = 500`, treats exit 1 (no match) as success. Gains options; the parse is untouched. |
| Search command | `GitGrepCommand` / `CommandGitGrepData` (`wshrpctypes_git.go:23`) | Shipped. Gains fields. |
| Search state and pane | `codesearchstore.ts` (`SearchState` union, `runSearch`, guard token, 20s RPC ceiling above git's own 10s), `codesearchpane.tsx`, `codesearch.ts` (`groupMatches`, `summarize`) | Shipped. Extended, not replaced. |
| Finder palette and its grammar | `codefinderpalette.tsx`, `parseFinderQuery` in `codefinder.ts` | Shipped. Already parses a trailing `:123` as a line and hands a leading `>` to the command palette. A leading `@` joins that grammar. |
| Fuzzy matcher | `fuzzyScore` in `frontend/app/cockpit/palette-match.ts` | Shipped. Ranks symbol names exactly as it ranks paths. |
| Jump primitive | `openInCode(model, { projectPath, rel, line })` in `codestore.ts` | Shipped. Every navigation in this spec goes through it — no second path-opening route. |
| Line reveal | `codePendingLineAtom` + `applyPendingLine` in `codeviewer.tsx` | Shipped. The only module that touches Monaco; symbol jumps reuse it unchanged. |
| History stack | `codehistory.ts` + `Alt+ArrowLeft` / `Alt+ArrowRight` | Shipped. A go-to-definition jump pushes onto it, so "back from a definition" needs no new mechanism. |
| Column-mode idiom | `codeSearchModeAtom` + the tab strip in `CodePanes` | Shipped. Spec 1 widens it to three; this widens it to four. |
| The open file's text | `codeFileAtom` `text` variant, and the draft overlay | Shipped. The outline parses the buffer in memory — no read, no RPC. |

## Resolved decisions

**1. Search options are flags on the existing reader, not a second search path.** `gitinfo.Grep` grows
a `GrepOpts` argument; the command grows matching fields; the parse, the cap and the exit-1 handling
are untouched. Everything the search pane already does — grouping, truncation reporting, the guard
token, the 20s ceiling — keeps working because the result shape does not change.

**2. Path scoping is expressed as git pathspecs, not as a filter applied to results.** Include and
exclude are passed to git as `-- ':(glob)<include>' ':(exclude,glob)<exclude>'` so git never reads the
excluded files. Filtering 500 returned matches client-side would be filtering *after* the cap, which
means an exclude could silently empty a result set that was truncated before the filter ever ran.

**3. Patterns use `-E` (POSIX extended) and never rely on `\b`; whole-word is git's own `-w`.** Git's
regex engine is a build-time choice and `\b` support is not guaranteed across platforms, while `-w` is
a documented git grep flag. Every pattern this spec constructs is therefore anchored with `^` and
delimited by literal characters or by `-w`, never by an escape whose availability we cannot assert.
**Verify during implementation** that `-w` combined with `-E` behaves as expected on the Git-for-
Windows build this repo ships against, with a Go test that asserts it.

**4. The outline is a per-language regex pass over the buffer already in memory — not Monaco's symbol
provider, not ctags, not an LSP.** Monaco's `DocumentSymbolProvider` covers TS/JS/JSON/CSS/HTML only,
which is a minority of this repository and would make the pane appear and disappear by file type with
no explanation. ctags is an external binary that may not be installed and needs re-indexing on every
write. An LSP client is a per-language server lifecycle and a protocol implementation — a subsystem,
not a feature.

The regex pass is honest about being a heuristic: it recognizes the declaration forms of eight
language families and returns **empty** for anything else, rather than guessing. An empty outline for
an unrecognized language reads as "not supported here", which is true; a wrong outline would read as a
fact.

*Rejected: Monaco's provider where it exists, regex elsewhere.* Two implementations, two result
shapes, and a pane whose accuracy silently depends on the file extension.

**5. Go-to-definition is a shaped grep, and it says so.** For the word under the cursor, the surface
builds an ERE of that language's *definition* forms (`^func NAME`, `^type NAME`, `^(export )?class
NAME`, `^\s*(pub )?fn NAME`, …), greps with it, restricted by pathspec to the same extension family,
and ranks the hits. One hit jumps straight there; several open the search pane with the candidates.

This is roughly right, not exactly right — it will miss a method on a receiver whose declaration
wraps across lines, and it cannot distinguish two same-named symbols in different packages. Both are
acceptable for a code *browser*: the failure mode is landing in a list instead of on the answer, never
landing somewhere wrong silently. The pane is labeled "Definitions of `<name>`", so a list of
candidates reads as the tool's answer rather than as a broken jump.

*Rejected: a repo-wide symbol index built from the outline parser.* It would need building on project
select, invalidating on every save and every agent write, and persisting to stay fast — an indexing
subsystem to make an already-fast grep marginally more accurate.

**6. Find-references is a plain whole-word search, routed into the existing pane.** It is literally the
existing search with `wholeWord: true`, `caseSensitive: true` and the query pre-filled. No new result
shape, no new pane, nothing to maintain — and it is what "find references" honestly is without a type
system.

**7. Symbols get a fourth column tab, not a split inside the column.** The column is already a mode
switcher with three tabs after spec 1; a fourth is the same idiom and costs nothing new.

*Rejected: a resizable vertical split so tree and outline show together.* That introduces a new layout
primitive — a draggable divider, a persisted ratio, a minimum height for each half — inside a 280px
column, for one consumer. *Rejected: an outline strip under the path bar.* An outline is a vertical
list; a horizontal strip either truncates it or scrolls it sideways.

**8. `@` in the finder is the fast path, and it needs no new chord.** `parseFinderQuery` already turns
`>` into "hand off to the command palette" and a trailing `:123` into a line. A leading `@` means "rank
symbols in the open file instead of paths", following the same convention VS Code established. One
chord, `Ctrl+Shift+O`, opens the finder pre-seeded with `@` for people who reach for it directly.

**9. Function keys for navigation, not punctuation chords.** `F12` (go to definition) and `Shift+F12`
(find references) are the conventional bindings and are unambiguous in the matcher. Punctuation keys
are avoided deliberately: this codebase already has a recorded case of a punctuation binding
(`Shift:?`) failing to match. `Alt+ArrowLeft` already walks the history stack, so "back from a
definition" is a binding that already exists.

## 1. Backend

### Reader options, in `pkg/gitinfo/gitinfo.go`

```go
// GrepOpts are the flags the Code surface's search filters map onto. The zero value reproduces the
// original behaviour exactly: a fixed, case-insensitive substring across the whole repository.
type GrepOpts struct {
    Regex         bool     // -E instead of -F
    WholeWord     bool     // -w
    CaseSensitive bool     // drop -i
    Include       []string // pathspecs, applied as ':(glob)<p>'
    Exclude       []string // pathspecs, applied as ':(exclude,glob)<p>'
}

func Grep(ctx context.Context, cwd, query string, opts GrepOpts) (*GrepResult, error)
```

Argument construction, in order: `grep --untracked -n -z -I --no-color`, then `-i` unless
`CaseSensitive`, then `-E` or `-F`, then `-w` if `WholeWord`, then `-e <query>`, then `--` and the
pathspecs. The existing `-z` parse, the `maxGrepMatches` cap and the exit-1-means-no-match rule are
unchanged.

**One new failure to distinguish:** an invalid regex makes git grep exit 128 with a message on stderr.
That is a *user* error, not a broken read, so it returns a sentinel the frontend renders as "Invalid
pattern" beside the input rather than as a red failure banner.

The only caller is `wshserver_git.go`, updated in the same change.

### Command, in `pkg/wshrpc/wshrpctypes_git.go`

`CommandGitGrepData` gains `regex`, `wholeword`, `casesensitive`, `include`, `exclude`;
`CommandGitGrepRtnData` gains `invalidpattern bool`. Adding fields to an existing command is safe for
`task generate` — the codegen bootstrap problem only bites when commands or types are *removed*.
Regenerate `frontend/app/store/wshclientapi.ts` and `frontend/types/gotypes.d.ts` with `task generate`
and never hand-edit them.

No other backend work. The outline and the definition-pattern construction are entirely frontend.

## 2. Frontend

### Pure modules — each with a `.test.ts` beside it

**`codelang.ts`** — the one place a file extension becomes a language.

```ts
export type Lang = "go" | "ts" | "rust" | "python" | "java" | "shell" | "css" | "markdown" | "unknown";

export function langOf(rel: string): Lang;
// the pathspec globs that scope a search to this language's files, for definition lookups
export function langGlobs(lang: Lang): string[];
```

Extracted rather than inlined so the outline and the definition query cannot disagree about what a
`.mjs` file is.

**`codeoutline.ts`** — declarations from text, per language (decision 4).

```ts
export type SymbolKind = "func" | "type" | "class" | "const" | "var" | "heading";
export interface OutlineSymbol {
    name: string;
    kind: SymbolKind;
    line: number;   // 1-based, matches codePendingLineAtom
    depth: number;  // 0 for top-level; 1 for a member of an enclosing block
}

export function outlineOf(text: string, lang: Lang): OutlineSymbol[];
```

Recognized forms, deliberately limited to declaration lines:

| Lang | Forms |
|---|---|
| go | `func`, `func (recv)`, `type`, top-level `const` / `var`, and the members of a `const (` / `var (` block at depth 1 |
| ts | `function`, `class`, `interface`, `type`, `enum`, top-level `const` / `let` / `var`, each with an optional `export` and `async`; class methods at depth 1 |
| rust | `fn`, `struct`, `enum`, `trait`, `type`, `const`, `static`, each with an optional `pub`; `impl` blocks, with their `fn`s at depth 1 |
| python | `def`, `async def`, `class`; nesting by indentation |
| java | `class`, `interface`, `enum`, `record` |
| shell | `name() {` and `function name` |
| css | selectors at the top level of a rule |
| markdown | ATX headings, depth from the `#` count |

`unknown` returns `[]`. Fenced code blocks are skipped in markdown; string and comment contents are
*not* excluded in the code languages — an anchored `^` pattern makes a false positive rare, and a real
tokenizer per language is the cost this decision exists to avoid.

**`codesymbolquery.ts`** — the shaped grep and its ranking (decision 5).

```ts
// the ERE of this language's definition forms for `name`, built to work under -E without \b
export function definitionPattern(name: string, lang: Lang): string;

// the word under a caret, for the F12 gesture
export function wordAt(lineText: string, column: number): string | null;

export interface RankedHit { path: string; line: number; text: string; score: number }

// definition-shaped hits first, then same-directory, then everything, with test files last
export function rankDefinitions(
    hits: readonly GitGrepMatch[],
    name: string,
    lang: Lang,
    fromPath: string
): RankedHit[];
```

`definitionPattern` escapes the symbol name for ERE before embedding it, so a symbol containing regex
metacharacters cannot construct a pattern.

**`codesearchopts.ts`** — the filter row's state shape and its translation to the wire.

```ts
export interface SearchOpts {
    regex: boolean;
    wholeWord: boolean;
    caseSensitive: boolean;
    include: string;   // comma-separated, as typed
    exclude: string;
}
export const DEFAULT_SEARCH_OPTS: SearchOpts;
// splits, trims and drops empties — the boundary between what is typed and what git receives
export function toPathspecs(raw: string): string[];
```

### State

New in `codesearchstore.ts`:

```ts
export const codeSearchOptsAtom: PrimitiveAtom<SearchOpts>;      // reset by resetSearch
export const codeSearchTitleAtom: PrimitiveAtom<string | null>;  // "Definitions of openPath", "References to openPath"
```

`runSearch` takes the options and passes them through. `resetSearch` clears both new atoms along with
the ones it already clears, so a project switch cannot leave a stale "Definitions of …" heading over
results from another repository.

New in `codestore.ts`:

```ts
export const codeOutlineAtom: Atom<OutlineSymbol[]>;  // derived from codeFileAtom + drafts
goToDefinition(model: AgentsViewModel, name: string): Promise<void>;
findReferences(name: string): Promise<void>;
```

`codeOutlineAtom` is **derived**, not loaded: it reads the open file's text (draft overlaid) and its
language and calls `outlineOf`. So the outline follows your typing with no invalidation logic, and a
file that is binary, too large or missing simply has no symbols.

`codeSearchModeAtom` widens again, to `"files" | "search" | "changed" | "symbols"`.

### Components

**`codesearchpane.tsx`** — a filter row under the input: three toggle chips (`Aa` case, `\b` whole
word, `.*` regex) and two optional glob inputs revealed by a "Filter paths" disclosure, so the common
case stays a single box. Above the results, `codeSearchTitleAtom` renders as a heading when set. An
invalid regex paints the input's border with `--color-error` and shows "Invalid pattern" — never the
failure banner.

**`codesymbolspane.tsx`** (new) — the fourth column mode. The outline as an indented list: kind glyph,
name, and the line number right-aligned. Clicking sets `codePendingLineAtom`; the file is already
open, so no read happens. A filter box at the top narrows by `fuzzyScore`. Empty states are specific:
"No file open", "No symbols found in this file", and for `unknown`, "Outline is not available for this
file type" naming the extension.

**`codefinderpalette.tsx`** — `parseFinderQuery` gains a leading `@`. With it set, the palette ranks
`codeOutlineAtom` by `fuzzyScore` on the symbol name instead of ranking paths, and Enter sets the
pending line rather than opening a file. The placeholder updates to mention `@`. Nothing else about the
palette changes.

**Go-to-definition** is invoked from the editor. `codeviewer.tsx` is already the only module that
touches Monaco and already exports `codeEditorSelection()`; it gains a sibling `codeEditorWordAtCursor()`
returning the identifier and the current language, built on `editor.getModel().getWordAtPosition()`.
`goToDefinition` then greps, and either jumps via `openInCode` (single hit) or fills the search pane
and switches the column to Search (several).

### Keybindings — `buildCodeBindings()` in `bindings.ts`

| Key | Predicate | Action |
|---|---|---|
| `F12` | `surface === "code"` | Go to definition of the word at the caret |
| `Shift:F12` | `surface === "code"` | Find references to the word at the caret |
| `Ctrl:Shift:o` | `surface === "code"` | Open the finder seeded with `@` |

All three must work while the caret is in Monaco, so they are gated on the surface rather than on the
`!editable` predicate — the same reasoning the 08-06 spec applied to `Alt+T` / `Alt+E`. `store.test.ts`
already asserts every Code binding conflicts with nothing across every context, which covers these.

## 3. Failure modes

| Situation | What the user sees |
|---|---|
| Invalid regex | "Invalid pattern" beside the input; previous results stay on screen |
| Include glob matches nothing | A normal empty result, with the active filters shown above it so the cause is visible |
| Search truncated at 500 with filters active | The existing truncation line, which is honest because the filters ran inside git, not after the cap (decision 2) |
| Go-to-definition with no word at the caret | Nothing happens; no error. The gesture is meaningless there |
| Go-to-definition finds nothing | The search pane opens with the "Definitions of `<name>`" heading and an empty result, so the user can loosen it by hand |
| Go-to-definition finds many | The candidate list, ranked. This is a normal outcome, not a degraded one |
| Outline on an unrecognized extension | "Outline is not available for this file type (`.foo`)" |
| Outline on a file with no declarations | "No symbols found in this file" |
| Outline while the file has unsaved edits | The outline follows the draft, because it is derived from the buffer |
| Not a git repository | Search is unreachable, as today. Spec 3 changes this |

## 4. Testing

**Vitest**, beside each pure module:

- `codelang.test.ts` — extension mapping including the ambiguous ones (`.mjs`, `.cjs`, `.mts`, `.h`),
  and `langGlobs` for each language.
- `codeoutline.test.ts` — one fixture per language family, asserting names, kinds, 1-based lines and
  depth; a Go `const (` block yields depth-1 members; Rust `impl` methods sit under their `impl`;
  Python nesting comes from indentation; markdown skips fenced blocks; `unknown` returns `[]`. A
  regression case per language for a form the parser deliberately does *not* claim, asserting it is
  absent rather than wrong.
- `codesymbolquery.test.ts` — `definitionPattern` escapes metacharacters and contains no `\b`;
  `wordAt` handles caret at either edge of an identifier, on whitespace, and inside a string;
  `rankDefinitions` puts a definition-shaped hit above a bare mention, same-directory above distant,
  and test files last.
- `codesearchopts.test.ts` — `toPathspecs` splits, trims and drops empties.

**Go**, in `pkg/gitinfo/gitinfo_test.go`, on the existing temp-repo harness: the zero `GrepOpts`
reproduces today's results exactly; `CaseSensitive` excludes a differently-cased hit; `WholeWord`
excludes a substring hit; `Regex` accepts an ERE and an invalid one reports the invalid-pattern
sentinel rather than an error; `Include` and `Exclude` scope the search; and — per decision 3 — `-w`
combined with `-E` behaves as expected on this platform's git.

```powershell
$env:CGO_CFLAGS = "-O2 -g -I$((Get-Location).Path -replace '\\','/')/pkg/jarvisembed/csrc"
go test ./pkg/gitinfo/...
```

**CDP**, in `scripts/cdp/scenarios.mjs` (hand-formatted to its four-space style; never Prettier'd):

- `code-search-filters` — search a common substring, note the count, enable whole-word, assert the
  count drops; add an exclude glob, assert it drops again.
- `code-symbols` — open a Go file, switch to the Symbols tab, assert rows exist, click one, assert the
  editor's caret moved to that line.

**Typecheck** with `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`.

## 5. Suggested phasing

1. `GrepOpts` + command fields + `task generate`, then the filter row. Verified by the Go tests and
   `code-search-filters`.
2. `codelang.ts` + `codeoutline.ts` + tests, then `codeOutlineAtom` and the Symbols tab. Verified by
   Vitest and `code-symbols`.
3. `@` in the finder plus `Ctrl+Shift+O`.
4. `codesymbolquery.ts` + tests, `codeEditorWordAtCursor`, `goToDefinition` and `findReferences`.

Phase 1 is the only one that touches Go, so phases 2–4 need no backend rebuild.

## 6. Explicitly out of scope

**Search-and-replace.** It is a multi-file destructive write, and spec 1 is introducing this surface's
first destructive operations; replace should follow once those are proven, with its own spec covering
preview, per-hunk opt-out and undo.

Also out: a persistent symbol index; ctags or any external indexer; an LSP client; find-implementations,
call hierarchy, type hierarchy or rename-symbol; cross-language definition lookup (a definition search
is scoped to the caller's language family); search history; saved searches; multi-line search patterns
(git grep is line-oriented); and searching a ref other than the working tree. Everything out of scope
in the 08-03, 08-06 and 08-15 specs stands.
