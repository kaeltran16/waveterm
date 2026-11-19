# File tab polish, fix round 1: an image's header path is repo-relative

Final failed on the merged result df9f4cf on one step. In the File tab, an image's header shows the absolute Windows
path (`..p\verify-workspace-file-...\linkshelf\docs\shots\stats-panel.png`, shot `workspace-file-image.png`). The
Image board draws the repo-relative `docs/shots/` (dim) + `stats-panel.png`, like the Main and Diff boards.
`headerPath` in `codepeekcard.tsx` returns the repo-relative path only for a text file in a repo, because a
non-text file's `PeekOpen` cannot tell a repo root from a plain folder.

## Decisions beyond the design

1. **`PeekOpen` records whether its root is a repository.** `loadFile` in `codepeekstore.ts` already knows
   (`inRepo`) where it builds `open`, so it sets the field there. That is the only place a `PeekOpen` is built.
2. **The header goes repo-relative for every file inside a repo, in the floating card as well as the tab.** That
   covers images, other binaries, files too large to show, and folders. The helper's own comment already says
   "repo-relative inside a repository, else the absolute path". The card's tooltip (`title`) keeps the absolute
   path. Why: one rule for the shared header, rather than a variant branch that makes the card and the tab name
   the same file differently. This narrows plan decision 9 ("the floating card is unchanged"): the card's header
   text changes for non-text files in a repo. The code-peek scenario asserts the header only for text files, which
   do not change.
3. **The header-path rule moves into the pure model** as `peekHeaderPath`, so it is unit-tested (AGENTS.md: logic
   is extracted, not rendered).

### Task 1: an image's header path is repo-relative in the File tab
**Depends on:** none
**Files:** `frontend/app/view/code/codepeekmodel.ts`, `frontend/app/view/code/codepeekmodel.test.ts`, `frontend/app/view/code/codepeekstore.ts`, `frontend/app/view/code/codepeekstore.test.ts`, `frontend/app/view/code/codepeekcard.tsx`, `scripts/cdp/scenarios-workspace-file.mjs`

**What to build:** an image cited from a repo shows its header as `docs/shots/` (dim) + `stats-panel.png` in the
File tab (board Image), matching the Main and Diff boards. Per decisions 1-3: `PeekOpen` gains `inRepo`, set in
`loadFile`. The pure `peekHeaderPath(peek)` in `codepeekmodel.ts` replaces `headerPath` in `codepeekcard.tsx` and
returns:
- `open.rel` when the file has an `open` whose `inRepo` is true;
- otherwise `abs`, or the raw path when nothing resolved.

The header's `title` stays the absolute path. No new state changes, so no motion moment.

**Interfaces:** `PeekOpen = { projectPath: string; rel: string; inRepo: boolean }`;
`peekHeaderPath(peek: { abs: string | null; raw: string; file: PeekFile }): string`. The model does not import the
store.

**Acceptance:**
- `peekHeaderPath` returns the repo-relative path for a text, binary, toolarge or folder file in a repo. It returns
  the absolute path for the same kinds outside a repo, and the raw path when `abs` is null.
- `codepeekstore.test.ts`'s expected `open` values carry `inRepo`: `true` for the repo cases and `false` for the
  plain-folder case (`C:\repo\docs`).
- In the workspace-file scenario, the image step ("An image is drawn fit to the pane… (Image board)") also asserts
  that the card's `[data-peek-path]` text is `docs/shots/stats-panel.png`, i.e. the scenario's `IMAGE_REL`, with
  the separators the header renders. Its dir part must be the dim span, as in the Main step's check. The step
  fails on today's code.
- The code-peek scenario still passes. Its header checks on `notes/peek.md` and `src/committed.ts` are unchanged.
