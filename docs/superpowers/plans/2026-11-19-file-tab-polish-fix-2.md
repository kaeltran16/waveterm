# File tab polish, fix round 2: a literal path finds its own file

Final passed on the merged result 11e042f. t-1's reviewer noted a gap: the glob test for `GetPatch`'s one-path
narrowing only checks that `*.txt`, `[ab].txt` and `u?.txt` match nothing. It never checks the positive half, that a
file actually named `[ab].txt` is found by its own name. Without the `:(literal)` magic, git would read that name
as a glob for `a.txt` / `b.txt`, and the File tab's Diff for such a file would show the wrong file's hunks or none.

Since round 1, main was merged into this tree (d03738631). Main's agent-edits fix gave `GetPatch` an `end`
parameter (`ref..end`), and the merge combines it with this run's `path`. The resulting signature is
`GetPatch(ctx, cwd, ref, end, path string, ignoreWs bool)`.

## Decisions beyond the design

1. **The test also covers `end` with `path`.** Main's range and this run's pathspec meet in one git call, and only
   the merge put them together. Why: the merge resolution is otherwise checked only by the existing tests of each
   half.

### Task 1: GetPatch's literal path finds a file named like a glob, and narrows a range
**Depends on:** none
**Files:** `pkg/gitinfo/patch_test.go`

**What to build:** tests only, through `GetPatch` on real temp repos, beside the existing path-narrowing tests. If
a test fails, fix `pkg/gitinfo/patch.go` and add it to this task's changes.

**Acceptance:**
- In a repo where tracked files `[ab].txt`, `a.txt` and `b.txt` are all modified, `path` `[ab].txt` returns exactly
  one file entry, `[ab].txt`'s, with its hunk. A file entry is a `diff --git` header.
- An untracked file named `[ab].txt` beside an untracked `a.txt` is likewise the only entry for that path.
- With `ref` and `end` set to two commits that both change `x.go` and `y.go`, `path` `x.go` returns only `x.go`'s
  entry, and with `path` `""` both entries are returned.
