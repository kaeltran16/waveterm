# Leftovers review fixes (F1-F21)

Fixes the 21 findings of the 2026-11-06 leftovers review: Jarvis graph peek, principles editors, pet acts,
palette notes, toasts and the terminal block (report: `cdp-shots/review/leftovers/report.md` in the main
checkout, gitignored; its screenshots sit beside it). Every cause was checked against the code at `cd0e8917b`.
The report's line numbers are approximate (several point past a file's end); the causes themselves hold. The
report's "Checked, no defect" and "Tooling gaps" sections are out of scope.

Run 0432111d (run view fixes) may land beside this and also edits `petview.tsx` (the pet sprite hidden under
modals) and `wshserver_jarvis.go`. Keep that behavior; this spec changes only a comment in `petview.tsx`.

## Graph peek

**F3, bloom slow and silent.** Confirmed. `ResolveDossierEdgesCommand` loads every Run, and `EdgesFor`
(through `gatherLookups`) loads every Run again, every task record (`taskDossiers`) and builds the claims map,
per call. The packaged store holds 3,238 runs, 60 MB of JSON, so each call decodes it twice. The client
(`jarvisgraphstore.ts`) gives it 5 s, swallows the failure, and builds `next` from a map read before the await,
so two overlapping blooms overwrite each other.
- Server: one run load per request. `EdgesFor` returns the runs it loaded beside the edges, and the handler
  builds its run index from them (both callers updated). Then measure each stage (runs load, dossiers, claims,
  git ranges) with a timing probe in the existing `liveprobe` harness (`pkg/jarvisattrib/liveprobe_test.go`,
  build tag `liveprobe`, against a `VACUUM INTO` copy of the packaged profile), and fix the stage that still
  dominates with the least machinery. If a cache is the fix, its key must change on every write it depends on
  (for runs, `count(*)` and `sum(version)` of `db_run` is cheap and exact), never a TTL. Target: a warm call
  on the real-profile copy under 1 s; the worker reports before/after numbers.
- Client: the bloom timeout rises to 15 s (`BLOOM_RPC_TIMEOUT_MS`); the vault graph keeps 5 s. Each dossier's
  bloom has a status (`loading` / `failed`) beside the cache; the Edges section says `Loading edges…` while
  loading and `Couldn't load edges` with a Retry button on failure, and says `No edge reaches this node` only
  for a bloom that landed empty. The setter reads the latest map (`globalStore.set(atom, prev => …)`), so
  overlapping blooms both land. Why: a wrong "no edges" claim is worse than a visible wait.

**F4, 387 unlabeled dots.** Confirmed. Decision: the canvas draws only nodes with at least one link in the
merged graph, plus the selected node, so a focused record with its bloomed runs is what shows. Isolated nodes
stay findable through the Find box, and picking one draws it. The header reads `<shown> of <total> nodes`
when some are hidden. The legend lists only kinds present among the drawn nodes. With nothing linked and
nothing selected, the canvas says `No links between records yet` with `Find a record above, or open the map
from a record.` The whole-vault entry (Shift+G) stays: it now opens on the linked structure, which is the
only part of the vault map that carries information; removing it is a product call the data does not force.

**F7, duplicate and stale edge rows.** Confirmed. `mergeGraph` dedupes wikilinks by unordered pair (A→B and
B→A are one edge), so the canvas and the panel both draw one; attribution links keep their directed key.
Edge rows are keyed by `linkKey(l)`.

**F13, Shift+G keeps the record focus.** Confirmed. `jarvisstore.ts` owns `closeGraphPeek()` (clears
`graphPeekOpenAtom` and `briefGraphRecordAtom`) and `toggleGraphPeek()` (closes through `closeGraphPeek`
when open, else opens). The binding calls the toggle, the Brief's Esc/Close call the close. One close path.

**F14, filter hides the selection.** Confirmed. A pick from the match list selects the node and switches the
panel to the selected-node view; the query is kept, and a `Back to N matches` control returns to the list.
Matching runs on a node's title line (the label's first line, cut as the canvas cuts it, `truncateTitle`),
which is what the list shows, so every match visibly contains the query.

**F15, internal labels and dead ends.** Confirmed. Go labels a decision node by its `summary` frontmatter
(then `title`, then id). A run node is labelled `<run title> · <short id>` where the run title is the one
`storagereport` already computes (dag title, else the goal's first line); `runTitle` is exported from
`pkg/storagereport` as `RunTitle` and reused, not copied. The panel shows the `Open` section only when it
has an action. Edge rows are buttons that select the other node.

## Principles editors (Profile modal)

**F1, blank principle saves silently fail.** Confirmed. A pure `blankPrinciples(...)` in `profilemodel.ts`
finds blank rows in both drafts (project additions, project replacements, global principles), numbered as
the editor shows them. A blank row gets the error edge and `Empty: write it or delete it`; Save is disabled
and the footer names the first one (`Principle 3 is empty`). Save errors render in the footer, not at the top
of the scrolled body, without the `Error: ` prefix.

**F2, unsaved edits dropped.** Confirmed, and wider than reported: a project-chip switch also re-seeds the
global draft. Decisions:
- Dirty is per scope, and the footer counts both: `Unsaved changes · Project`, `· Global`, or
  `· Project and Global`.
- Save writes every dirty scope, global first (the project resolves against it), then closes with one toast.
  A failure leaves the failed scope dirty and shows its error in the footer.
- Cancel, Esc, the backdrop, and a project-chip switch with unsaved changes they would lose do not act at once:
  the footer turns into `Discard unsaved changes to <scopes>?` with `Keep editing` and `Discard`; Discard
  performs the held action. A chip switch loses only the project draft, so it asks only when that is dirty.
- Switching project keeps the global draft (the global profile is the same for every project).
- `error` clears on any edit and on scope change.
Why a confirm rather than a draft per project: one draft per scope matches what the footer can name, and the
armed confirm is the pattern palette notes already use.

**F11, Customize with no edit pins the global wording.** Confirmed. A pure
`normalizePrinciplePatch(patch, global)` drops replacements whose text equals the global text. Dirty, the
Principles summary and the saved patch all use it, so Customize alone is not a change. The editor still shows
the row in edit mode until saved (dropping it in the reducer would close the textarea on click).
`principleNote` also ignores a stored replacement equal to the global text, so existing overrides stop
reporting "uses its own wording".

**F12, global delete gives no warning; stale row misleads.** Confirmed. Global scope lists, under the
principles editor, each principle deleted in the draft that some project disables or rewords:
`Removed "<text cut to one line>" · disabled in X` / `· X uses its own wording`. The project's stale row is
worded by diagnostic: missing-disabled → `This project disabled a principle that was removed from the global
set.`; missing-replacement → `This project reworded a principle that was removed: "<its text>"`. No raw id.

## Pet

**F6, Decide on a workflow scan opens the scan's run.** Confirmed. `actsForAttention` targets `item.oref` for
`workflow-scan` when it is set, as `needsTarget` (`palette-needs.ts`) does; one shared predicate, not a copy.

**F9, "Nothing waiting on you" beside the Brief's "10 things are waiting on you".** Confirmed: they count
different things. The pet names what it counts: quiet `No runs or questions waiting`, busy
`<N> runs or questions waiting` (`1 run or question waiting`). The Brief keeps its wording.

**F10, raw kind ids.** Confirmed. `ROW_KIND_LABEL` gains `workflow-scan: "Workflow scan"` and
`run-unverified: "Unverified"`; `ROW_DOT` gains `workflow-scan: bg-accent`, `run-unverified: bg-warning`.

**F20, avatar over the Agent tree.** Confirmed. Moving the left corner past the tree would put the avatar
on the terminal's prompt line, which is worse. Decision: follow the existing pattern
(`AVATAR_SURFACE_REACH_PX` bottom room in Brief, Usage, Workflow lists): the Agent tree's scroll list gets that
bottom room while the pet sits bottom-left, so its last rows scroll clear. The corner comment in `petview.tsx`
is corrected to say bottom-left covers the bottom of the Agent tree and why the list makes room.

## Toasts

**F8, bubble over the toast stack.** Confirmed. The bubble publishes its rendered height (a petstore atom,
null when no bubble). While a bubble shows and the pet is bottom-right, the stack's bottom rises to clear it:
`toastStackBottom(corner, bubbleHeight)` = avatar reach + bubble offset (10) + bubble height + gap (12), pure
and unit-tested. Why not the other corner: bottom-left on Agent is the tree, the same overlap problem.

**F17, Brief error by color alone, no width limit.** Confirmed. The level styling (icon, accessible name,
edge) is exported from `notificationtoasts.tsx` and used by the Brief toast too, one source. The Brief toast
gets `max-w-[min(560px,90%)]` and wraps. Error toasts in both systems live `ERROR_TOAST_TTL_MS` = 12 s
(info/warn stay 6 s global, 5 s Brief); a click still dismisses a global toast.

**F19, a second Brief toast strands a pending delete's Undo.** Confirmed. While any delete is pending, every
Brief toast carries an Undo for the pending deletes: `Undo` for one, `Undo 2` for two, cancelling all of them;
a toast with its own undo (a reversible edit) shows both. The toast stays up until the last pending delete
commits or is undone. Logic in `createUndoQueue`, unit-tested.

## Terminal block

**F5, a wrapped path becomes two wrong links.** Confirmed. The provider joins a row with its wrapped rows
(back while the row `isWrapped`, forward while the next is) into one logical line, matches on that, and maps
each match back to a multi-row range, as xterm's web-links addon does. The joining and mapping are pure in
`termfilelinks.ts` (rows of text in, ranges out); wide characters map by cell, not by string index.

**F16, prompts, routes and folders become links.** Confirmed.
- A shell prompt's cwd is skipped: PowerShell `PS <path>>` and POSIX `<user>@<host>:<path>$`/`#` at a row's
  start.
- A rooted path with no extension is skipped on a row that reads as an HTTP log (an HTTP method or a 3-digit
  status beside it).
- The peek detects a folder (`FileInfo.isdir`): a `folder` card state reading `Folder` with
  `Open folder in Code`. Bare `word.ext` names stay links: they are usually real files, and the peek's
  missing state covers the rest.

**F18, two hint grammars.** Confirmed. One hint content (`<Kbd>Ctrl</Kbd> + click to <verb>`) for both: URL
`open link`, file `peek`. The file hint also shows on plain hover after the URL hint's delay (600 ms).

## Palette notes

**F21, blind note overwrite.** Confirmed. `UserNote` gains `rev` (a short hash of the note file's bytes, set by
`List` and `Add`); `CommandNoteUpdateData` gains `baserev`. `notestore.Update` refuses with `ErrNoteConflict`
(`note <id> changed since it was opened`) when `baserev` is set and differs from the file's current rev. The
editor keeps the rev it opened with; on a conflict it keeps the draft and says `Changed elsewhere since you
opened it · Ctrl+Enter again to overwrite`; the second Ctrl+Enter saves without `baserev`. Same armed-press
pattern as Esc and del. Why a content hash: mtime is unreliable after a checkout, and a hash needs one field.

## Verification

Go tests beside each Go change, vitest beside each extracted model. UI through existing scenarios at the
width each finding was seen: brief-contextual-map (graph), brief-profile (Profile), jarvis-peek (pet),
notification-toasts (both toast systems, 1000 and 1600), code-peek and term-link-tooltip (terminal),
agent-tree-rail (avatar over the tree), palette-notes (conflict), plus brief-act and surface-smoke as
regression guards.
