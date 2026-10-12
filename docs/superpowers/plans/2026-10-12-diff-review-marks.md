# Diff surface: mark files reviewed

**Verify:** `node scripts/verify.mjs ./pkg/util/utilfn`
**Check:** `node --stack-size=4000 node_modules/typescript/lib/tsc.js --noEmit`
**Final:** `node scripts/cdp/final-verify.mjs diff-review-marks diff-compare code-diff`
**Prototype:** C:\Users\kael02\IdeaProjects\waveterm\.waveterm\worktrees\0b6288cf-65ac-4aa6-839a-aa4bca1e0f1b\.superpowers\design\diff-reviewed-marks\project\Main.dc.html

**Goal:** In the Diff surface's changed-file list (pane 2), tick files off as reviewed, keep the marks across surface switches and restarts, and see how many of the list are reviewed. Frontend only: no Go, no wshrpc change.

**Architecture:** One new module, `frontend/app/view/agents/reviewmarks.ts`, holds the pure model (subject keys, fingerprints, mark state, next-unreviewed, storage parse/prune) and a module-level jotai store persisted to localStorage, like the other stores on this surface (the Diff surface unmounts on switch, so nothing lives in `useState`). The file list, the two panes that host it and the surface read and write it (Task 2); the `v` binding and the diff header's button act on the open file through an `activeReviewAtom` the surface publishes (Task 3); a CDP scenario drives it end to end (Task 4).

**Design source:** the canvas on the Prototype line (boards `Main`, `Rows`, `Panes` in its folder) settles the look. Copy sizes from the existing code, colours only from `@theme` tokens (DESIGN.md): no new tokens, no raw hex in components. The approved decisions beyond the canvas:

- A mark is keyed on the repo cwd, the list subject and the path. The subject is `commit:<sha>` when pane 2 shows one commit (in history or in compare), else `rangeKey(scope.range)` for the scope's own aggregate row (working tree, session, run, compare base..head+form). A compare commit row shares marks with the same commit in history.
- A mark stores the file's fingerprint `status:adds:dels` (checked on every render) and, when the marked file is the one open in the diff pane, an FNV-1a hash of its diff pair (`original` + NUL + `modified`). When the open file's pair loads with a different hash, the mark is flagged stale in storage. A file marked from its row box while another file is open is checked on its fingerprint only.
- Stale: counts as unreviewed, draws a dashed `warning` box, its title says "Changed since you reviewed it". Marking it again refreshes fingerprint and hash and clears the flag.
- Row order never changes; there is no hide-reviewed filter. In tree mode a directory's box marks every file under it (or unmarks all when all are reviewed); a partly reviewed directory shows `r/n` in place of its file count.
- The count lives in a progress line under pane 2's file-count row, in both the commit pane and the aggregate pane. The subject bar's summary line is unchanged.
- `v` and the diff header's "Mark reviewed" button toggle the open file. Marking it opens the next unreviewed file in list order (tree order in tree mode, collapsed directories included, wrapping round); unmarking stays put. Clicking a row's box moves the selection only when that row is the open file.
- Storage: one localStorage key, marks grouped per subject with a last-touched time; at most 200 subjects, the least recently touched dropped first. Unreadable storage starts empty and logs; a failed write logs and keeps the in-memory marks. "Clear" drops the current subject's marks with no confirm.

## Review Focus

Inputs no task's happy path exercises, each pinned by a test in the owning task:

1. The working-tree poll re-reads the open file's pair every few seconds: an unchanged hash must neither flag the mark stale nor write localStorage (Task 1, `noteOpenPair` no-op test).
2. localStorage missing (vitest's node env), holding junk, or throwing on write (quota): marks still work in memory, the failure is logged, nothing throws into React (Task 1).
3. A mark for a path that is no longer in the list (renamed, reverted) must not count towards `done` or `total` (Task 1, `reviewProgress`).
4. A compare range whose branch tip moved keeps the same subject key; the fingerprint is what turns the mark stale (Task 1, `markState`).
5. `v` with no file open, or while typing in the history filter, must decline and let the key pass (Task 3, `bindings.test.ts` case).

Not covered live: no scenario opens a run scope, so the `run:<id>:<base>` subject (canvas `Main` is drawn on a run range) is proven by Task 1's subject-key tests only; the row, progress and header UI it draws is identical to the working-tree range the scenario drives.

---

### Task 1: Review-mark model and store

**Depends on:** none
**Files:** `frontend/app/view/agents/reviewmarks.ts`, `frontend/app/view/agents/reviewmarks.test.ts`

The single source of truth for review marks. Pure functions plus a module-level store; no React in this file. Follow the house shape of `frontend/app/view/agents/ratelimitstore.ts` / `frontend/app/view/code/codestore.ts` for localStorage (guard `globalThis.localStorage`, try/catch at the boundary, log with context; never swallow silently). Reuse `rangeKey` from `diffscope.ts`, `buildFileTree` from `filetree.ts`, `diffPairAtom` from `diffcontentstore.ts`, `treeModeAtom` from `filetree.ts`, `GitChange` from `gitstatus.ts`.

Interface the other tasks rely on (exact names and types):

- `export type ReviewSubject = string`: `${cwd}|${key}`.
- `export type ReviewState = "none" | "ok" | "stale"`.
- `export interface StoredMark { fp: string; h?: string; stale?: boolean }`, `export interface SubjectMarks { at: number; files: Record<string, StoredMark> }`, `export type ReviewStore = Record<ReviewSubject, SubjectMarks>`.
- `export const REVIEW_STORAGE_KEY = "diff.review.marks"` and `export const MAX_REVIEW_SUBJECTS = 200`.
- `export function reviewSubjectFor(cwd: string | null | undefined, range: DiffRange | null | undefined, commit: string | null): ReviewSubject | null`: null when cwd or range is missing; `commit:<sha>` when commit is non-null, else `rangeKey(range)`.
- `export function fingerprint(c: GitChange): string`: `${status}:${adds}:${dels}`.
- `export function pairHash(original: string, modified: string): string`: FNV-1a 32-bit over `original + "\0" + modified`, hex.
- `export function markState(marks: SubjectMarks | undefined, c: GitChange): ReviewState`.
- `export function reviewProgress(marks: SubjectMarks | undefined, files: GitChange[]): { done: number; total: number }`: counts listed files only.
- `export function reviewOrder(files: GitChange[], tree: boolean): string[]`: tree mode is the file rows of `buildFileTree(files, new Set())` in order; flat mode is `files` order.
- `export function nextUnreviewed(order: string[], from: string, reviewed: (path: string) => boolean): string | null`: the first unreviewed path after `from`, wrapping round, never `from` itself; null when none.
- `export function parseStoredReviews(raw: string | null): ReviewStore` (junk or wrong shape gives `{}`) and `export function pruneSubjects(store: ReviewStore, max: number): ReviewStore` (keeps the `max` most recent by `at`).
- `export const reviewMarksAtom: PrimitiveAtom<ReviewStore>`: seeded from localStorage at module load.
- `export interface ActiveReview { subject: ReviewSubject; files: GitChange[]; open: string | null; select: (path: string) => void }` and `export const activeReviewAtom: PrimitiveAtom<ActiveReview | null>`. The surface publishes it (Task 2).
- `export function setReviewed(subject: ReviewSubject, changes: GitChange[], on: boolean): void`: on stores `{fp}` per change, plus `h` from `diffPairAtom` when the pair's `path` is that change's path; off deletes. Touches `at`, prunes, persists.
- `export function toggleReviewed(subject: ReviewSubject, change: GitChange): void`: `ok` turns off; `none`/`stale` turns on. When it turns on and `activeReviewAtom` has this subject with `open === change.path`, it calls `select(nextUnreviewed(reviewOrder(files, tree), path, ...))` if that is non-null.
- `export function toggleOpenFile(): boolean`: toggles the active review's open file; returns false (so a binding declines the key) when there is no active review, no open file, or the open file is not in `files`.
- `export function clearReviewed(subject: ReviewSubject): void`.
- `export function noteOpenPair(subject: ReviewSubject, path: string, hash: string): void`: flags the mark stale only when one exists with an `h` that differs; otherwise does nothing and does not write storage.

Acceptance, all in `reviewmarks.test.ts`, run with `npx vitest run frontend/app/view/agents/reviewmarks.test.ts`:

- subject keys: a commit, and each range kind (working, session, run, compare with each form) produce distinct keys; a missing cwd or range gives null.
- `markState`: no mark is `none`; a matching fingerprint is `ok`; a changed status, adds or dels is `stale`; a stored `stale: true` is `stale`.
- `reviewProgress` ignores marks for paths not in `files` (Review Focus 3).
- `setReviewed` stores `h` only for the change whose path matches the loaded pair; re-marking a stale file clears `stale` and refreshes `fp`/`h`.
- `noteOpenPair`: a different hash flags stale; the same hash, a mark without `h`, and no mark are all no-ops that leave the stored object identity and localStorage untouched (Review Focus 1).
- `nextUnreviewed`: skips reviewed paths, wraps, returns null when everything else is reviewed, and handles a `from` that is not in the order.
- `reviewOrder` in tree mode matches `buildFileTree`'s file order for a nested fixture; flat mode keeps input order.
- `toggleReviewed` advances the selection only for the open file of the active subject, never on unmark; `toggleOpenFile` returns false with no active review or no open file.
- `pruneSubjects` keeps the newest 200 by `at`; `parseStoredReviews` returns `{}` for null, `"{"`, `"[]"` and an object with malformed entries.
- persistence: a write that throws (stub `localStorage.setItem` to throw) leaves the atom updated and logs (Review Focus 2); with no `localStorage` at all, the store still works.

### Task 2: Review marks in the file list and the panes

**Depends on:** Task 1
**Files:** `frontend/app/view/agents/changedfilelist.tsx`, `frontend/app/view/agents/commitpane.tsx`, `frontend/app/view/agents/aggregatepane.tsx`, `frontend/app/view/agents/filessurface.tsx`

Draws the canvas's rows and progress line (boards `Main`, `Rows`, `Panes`) and publishes the active review.

- `ChangedFileList` takes a new prop `review: ReviewSubject | null` and reads `reviewMarksAtom`. A row becomes a flex container holding the existing select `<button>` and, as its sibling (a button cannot nest inside a button), a 16px check `<button>` at the row's right end, after `−N`. With `review` null, no check is drawn. The row `<button>` keeps `data-changed-file-row={path}` (existing scenarios click it) and gains `data-review-state="none|ok|stale"` and `aria-current="true"` when selected. The check button carries `data-review-toggle={path}`, `aria-pressed`, and an `aria-label`/`title` of "Mark <name> reviewed", "Unmark <name>", or "Changed since you reviewed it. Mark <name> reviewed"; it calls `toggleReviewed`.
- Row look (canvas `Rows`): empty box `border-edge-strong`, hover lifts it to `border-muted`; reviewed box `border-accent/30 bg-accentbg` with a lucide `Check` in `text-accent`; stale box dashed `border-warning`. A reviewed row drops its status letter, path and counts to `text-muted`, with the counts at `text-ink-faint` (the selected path one step up, `text-ink-mid`). Order unchanged.
- Directory rows in tree mode get the same check button with `data-review-toggle-dir={row.id}`; the dir row itself gains `data-changed-dir-row={row.id}`. Members are the listed files whose path starts with `row.id + "/"`. All reviewed: check plus muted label and counts, and a click unmarks all of them (`setReviewed(..., false)`). Otherwise a click marks all of them. Partly reviewed: `r/n` in `text-ink-mid` in place of the file count.
- Export `ReviewProgress({ review, changes })` from `changedfilelist.tsx` (beside `TreeModeToggle`, one reader for both panes): a row under the pane's file-count row with a 4px `bg-edge-faint` track and an `bg-accent` fill at `done/total`, then `N/M reviewed` (`text-ink-mid`, mono 10.5px), or a `Check` and `all M reviewed` in `text-accent-soft` when done equals total, then a "Clear" text button (`data-review-clear`, only when done > 0) that calls `clearReviewed`. The element carries `data-files-reviewed`, `data-done` and `data-total`. The track is drawn at 0 too, so the first mark does not shift the list. Hidden when `review` is null or the list is empty or loading.
- `CommitPane` and `AggregatePane` take `review: ReviewSubject | null`, pass it to `ChangedFileList`, and render `ReviewProgress` under their file-count row (canvas `Panes`).
- `FilesSurface`: hoist the "which commit is pane 2 showing" expression already inlined in the `summaryLine` call (null for the working-tree row and compare's aggregate row) into one const and use it for both. Derive `review = reviewSubjectFor(state?.cwd, scope?.range, thatCommit)` and pass it to whichever pane renders. Publish `activeReviewAtom` from an effect: `{ subject: review, files: shownChanges.files, open: shownPath, select }`, where `select` is `selectCompareFile` in compare mode, else `selectCommitFile(selectedCommit, path)`; null when `review` or `shownChanges` is null, and null on unmount.

Acceptance: the tree view of canvas `Main` and the states of `Rows` and `Panes` render in the live app. Proven by `diff-review-marks` steps 1–4 and 7–9 (Task 4) and their shots: `diff-review-marks-empty.png` (progress line at 0, empty boxes), `diff-review-marks-partial.png`, `diff-review-marks-dir-partial.png` (directory row at `1/2`), `diff-review-marks-all.png`, `diff-review-marks-commit.png`, `diff-review-marks-compare.png`: rows start `none` at `0/N`; a row box marks only that file and leaves the selection alone; a directory box marks all its files and the dir row shows `r/n` when partly reviewed; a commit's marks are separate from the working tree's; Clear empties the subject. `diff-compare` and `code-diff` still pass (the row is still clickable via `data-changed-file-row`). Check passes.

### Task 3: The `v` binding and the diff header button

**Depends on:** Task 1
**Files:** `frontend/app/store/keybindings/bindings.ts`, `frontend/app/store/keybindings/bindings.test.ts`, `frontend/app/view/agents/diffpane.tsx`, `docs/keyboard-shortcuts.md`

- `buildFilesBindings()`: add `files:toggle-reviewed`, keys `"v"`, group `"Diff"`, label `"Mark file reviewed"`, `when: on` (so it is off while typing and under a modal), `run: () => (toggleOpenFile() ? undefined : false)` so the key passes when there is nothing to toggle (Review Focus 5). `v` is unbound everywhere today; the existing conflict assertion in `bindings.test.ts` must still pass.
- `DiffPane` header: a toggle button before "Open in Code", `data-review-open`, reading `activeReviewAtom` + `reviewMarksAtom` for the open file. Unpressed it shows `Check` and "Mark reviewed" (label only when `layout.labelled`, like its neighbours) with a `v` key hint in `text-ink-faint`; pressed it shows "Reviewed" with the same `border-accent/30 bg-accentbg text-ink-hi` treatment the whitespace toggle uses, and `aria-pressed`. Title and aria-label are "Mark reviewed and open the next file (v)" or "Unmark this file (v)". Click calls `toggleOpenFile()`. Hidden when there is no active review or the open path is not in its files.
- `DiffPane`: an effect on `pair`. When `pair` is non-null, `activeReviewAtom` is non-null and `pair.path === active.open`, call `noteOpenPair(active.subject, pair.path, pairHash(pair.original, pair.modified))`. This is what turns an equal-count re-edit stale; the working-tree poll's refresh re-reads the pair, so it also runs live.
- `docs/keyboard-shortcuts.md`, Diff table: add the row "`v` | Mark the open file reviewed (or unmark it) and open the next unreviewed file".

Acceptance: a new case in `frontend/app/store/keybindings/bindings.test.ts` pins Review Focus 5: with `activeReviewAtom` null, `files:toggle-reviewed`'s `run()` returns `false`; its `when` is false for a files-surface context with `editable: true` (and with `modalOpen: true`) and true for a plain files-surface context. `npx vitest run frontend/app/store/keybindings/bindings.test.ts` passes, including the existing conflict assertion. In the live app (`diff-review-marks` steps 2, 5 and 6, Task 4): `v` marks the open file and opens the next unreviewed one; the header button reads "Reviewed" pressed for a reviewed open file and unmarks it without moving the selection; an on-disk edit turns a marked file stale. Check passes.

### Task 4: CDP scenario `diff-review-marks`

**Depends on:** Task 2, Task 3
**Files:** `scripts/cdp/scenarios.mjs`

A new scenario, registered beside `diff-compare` and modelled on it: a temp repo, `createproject`, a reload for deterministic module state, a teardown that leaves compare and an explicit collapse behind it, deletes the project and removes the directory. Scope every query to `data-*` attributes (document-wide button queries hit the app bar). Pin the viewport to 1600x950. Wait for elements rather than relying on fixed sleeps. Before the steps, clear `localStorage[REVIEW_STORAGE_KEY]` (`"diff.review.marks"`) through `h.ev`.

Arrange: `main` holds a seed commit (`README.md`, `src/retry/policy.go`). Branch `feature` holds one commit touching two files (`src/retry/policy.go` modified, `src/retry/submit.go` added) and leaves three working-tree edits (`README.md`, `src/retry/policy.go`, `src/retry/backoff.go` new, tracked with `git add -N` so it has counts).

DOM contract from Tasks 2 and 3: file row `[data-changed-file-row="<path>"]` with `data-review-state` and `aria-current`; file box `[data-review-toggle="<path>"]`; dir row `[data-changed-dir-row="<id>"]`; dir box `[data-review-toggle-dir="<id>"]`; progress `[data-files-reviewed]` with `data-done`/`data-total`; Clear `[data-review-clear]`; header button `[data-review-open]` with `aria-pressed`.

Steps, each recorded with `rec(...)`:

1. Pick the project. The working-tree list shows 3 rows, all `data-review-state="none"`, and the progress line reads `data-done="0" data-total="3"`. Shot `cdp-shots/diff-review-marks-empty.png` (canvas `Rows`, progress at 0 and empty boxes).
2. Open `README.md`, press `v` (CDP key event, as `diff-compare` presses `c`). `README.md` is `ok`, `data-done="1"`, and the open row moved to `src/retry/backoff.go` (tree order lists directories before root files, so the next unreviewed file wraps round to it). Shot `cdp-shots/diff-review-marks-partial.png` (canvas `Main`).
3. Click the box on `src/retry/policy.go` while `src/retry/backoff.go` is open. It turns `ok`, and the open row stays `src/retry/backoff.go`.
4. Tree mode: the `src/retry` dir row shows `1/2`. Shot `cdp-shots/diff-review-marks-dir-partial.png` (canvas `Rows`, partly reviewed directory) before clicking. Click its box: both files `ok`, `data-done="3"`, and the progress line reads "all 3 reviewed". Shot `cdp-shots/diff-review-marks-all.png` (canvas `Rows`).
5. Append a line to `src/retry/policy.go` on disk, press `r` (or wait for the poll). Its row reads `stale`, `data-done="2"`. Shot `cdp-shots/diff-review-marks-stale.png` (canvas `Main`/`Rows` stale state).
6. Open `README.md` (still `ok`): `[data-review-open]` has `aria-pressed="true"`. Click it: `README.md` turns `none`, and the open file stays `README.md`.
7. Persistence: `location.reload()`, re-pick the project. `src/retry/backoff.go` is still `ok` and `src/retry/policy.go` still `stale`.
8. Select the feature commit's history row. Its 2 files start `none`, separate from the working tree. Mark both via their boxes: "all 2 reviewed" (canvas `Panes`, left). Shot `cdp-shots/diff-review-marks-commit.png`.
9. Compare: press `c`, wait for the aggregate's rows, and mark one file. The progress line reads `1/N` (canvas `Panes`, right). Shot `cdp-shots/diff-review-marks-compare.png`. Then Clear: `data-done="0"`.

Acceptance: this task runs after Tasks 2 and 3 have merged, so its worker runs the scenario against the real feature: `node scripts/cdp/final-verify.mjs diff-review-marks` must exit 0 with every step passing and all seven shots written. A step that fails because of a Task 2 or Task 3 DOM-contract mismatch is fixed here only in the scenario; a product bug is reported, not patched in another task's files. The scenario must report a failing step when the feature is absent (e.g. step 1 fails with no `[data-files-reviewed]`), not pass vacuously. `node --check scripts/cdp/scenarios.mjs` passes. Do not run prettier on `scripts/*.mjs`.
