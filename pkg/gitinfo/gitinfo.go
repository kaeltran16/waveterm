// pkg/gitinfo/gitinfo.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package gitinfo runs git queries for the Files cockpit surface and creates worktrees for the
// New Agent launcher. It shells out to the git binary (no go-git dependency) using fixed
// subcommands in a given working dir.
package gitinfo

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const gitTimeout = 10 * time.Second

type Changes struct {
	Branch  string
	StatusZ string
	Numstat string
	IsRepo  bool
}

type Diff struct {
	Diff      string
	Content   string
	Untracked bool
}

func run(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	out, err := cmd.Output()
	return string(out), err
}

func GetChanges(ctx context.Context, cwd, ref string) (*Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &Changes{IsRepo: false}, nil
	}
	branch, _ := run(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD")
	// cwd's path within the repo (e.g. "services/foo/"), empty when cwd is the repo root. When cwd is
	// a subdirectory — a microservice inside a monorepo — this scopes the surface to cwd's subtree and
	// makes every path cwd-relative, so a path fed back into GetDiff/RevertFile as a `git -C cwd`
	// pathspec resolves. Without it, `status` prints repo-root-relative paths that don't round-trip.
	prefix, _ := run(ctx, cwd, "rev-parse", "--show-prefix")
	prefix = strings.TrimSpace(prefix)
	// `-- .` scopes to cwd's subtree; status has no --relative, so we strip the prefix ourselves below.
	// `-uall` lists untracked files individually instead of collapsing a wholly-new directory into one
	// "dir/" entry — that collapsed row can't be diffed (GetDiff would os.ReadFile a directory) and
	// wedges the Files pane, so we expand it at the source. status drives untracked detection in both modes.
	statusZ, err := run(ctx, cwd, "status", "--porcelain=v1", "-z", "-uall", "--", ".")
	if err != nil {
		return nil, err
	}
	statusZ = stripPrefixZ(statusZ, prefix)
	if ref == "" {
		// live mode (unchanged): working tree vs HEAD, plus synthetic rows for untracked files.
		// --relative scopes to cwd and prints cwd-relative paths, matching the stripped status above.
		// `diff --numstat HEAD` errors on a repo with no commits yet; status is still meaningful.
		numstat, _ := run(ctx, cwd, "diff", "--numstat", "--relative", "HEAD")
		// git diff omits untracked files (nothing in HEAD/index to diff), so a new file would show +0.
		// Append synthetic numstat rows for untracked files so their added lines count in the totals.
		numstat += untrackedNumstat(cwd, statusZ)
		return &Changes{Branch: strings.TrimSpace(branch), StatusZ: statusZ, Numstat: numstat, IsRepo: true}, nil
	}
	// ref mode: tracked changes come from the base diff (committed + uncommitted); untracked files
	// are not in the base, so their ?? rows are carried over from status verbatim.
	nameStatus, _ := run(ctx, cwd, "diff", "--name-status", "-z", "--relative", ref)
	trackedZ := nameStatusToStatusZ(nameStatus)
	untrackedZ := untrackedEntriesZ(statusZ)
	numstat, _ := run(ctx, cwd, "diff", "--numstat", "--relative", ref)
	numstat += untrackedNumstat(cwd, untrackedZ)
	return &Changes{Branch: strings.TrimSpace(branch), StatusZ: trackedZ + untrackedZ, Numstat: numstat, IsRepo: true}, nil
}

// GetRangeChanges computes the per-file changes introduced by the commit range base..end — the commits
// reachable from end but not base — as name-status + numstat. Unlike GetChanges it never consults the
// working tree or untracked files, so a run's evidence reflects exactly the commits it produced, immune
// to whatever else landed on the shared working tree (the delegator fan-out over-attribution). Paths are
// cwd-relative (--relative), matching GetChanges. Returns IsRepo=false when cwd is not a repo; errors on
// a git failure (e.g. an unresolvable end SHA) so the caller can fall back.
func GetRangeChanges(ctx context.Context, cwd, base, end string) (*Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &Changes{IsRepo: false}, nil
	}
	rangeSpec := base + ".." + end
	nameStatus, err := run(ctx, cwd, "diff", "--name-status", "-z", "--relative", rangeSpec)
	if err != nil {
		return nil, err
	}
	numstat, err := run(ctx, cwd, "diff", "--numstat", "--relative", rangeSpec)
	if err != nil {
		return nil, err
	}
	return &Changes{StatusZ: nameStatusToStatusZ(nameStatus), Numstat: numstat, IsRepo: true}, nil
}

// nameStatusToStatusZ converts `git diff --name-status -z` output into the porcelain -z entries
// ("X  path\0") that parseStatusZ (TS) and parseNumstatStatus (Go) already consume. Rename/copy
// (R/C) collapse to "M" on the new path, so no extra source-path field is emitted (the parsers only
// consume a source field when the status letter is R/C).
func nameStatusToStatusZ(nameStatus string) string {
	toks := strings.Split(nameStatus, "\x00")
	var b strings.Builder
	for i := 0; i < len(toks); i++ {
		st := toks[i]
		if st == "" {
			continue
		}
		letter := st[0]
		var path string
		if letter == 'R' || letter == 'C' {
			if i+2 >= len(toks) { // Rxxx \0 old \0 new
				break
			}
			path = toks[i+2]
			i += 2
			letter = 'M'
		} else {
			if i+1 >= len(toks) {
				break
			}
			path = toks[i+1]
			i++
		}
		if path != "" {
			fmt.Fprintf(&b, "%c  %s\x00", letter, path)
		}
	}
	return b.String()
}

// untrackedEntriesZ keeps only the "??" rows of a porcelain -z blob (each re-terminated with NUL).
func untrackedEntriesZ(statusZ string) string {
	var b strings.Builder
	parts := strings.Split(statusZ, "\x00")
	for i := 0; i < len(parts); i++ {
		entry := parts[i]
		if len(entry) < 3 {
			continue
		}
		if entry[0] == 'R' || entry[0] == 'C' {
			i++ // skip the rename/copy source path
			continue
		}
		if entry[:2] == "??" {
			b.WriteString(entry)
			b.WriteByte(0)
		}
	}
	return b.String()
}

// HeadCommit returns the trimmed SHA of HEAD in cwd. Errors when cwd is not a repo or has no commits
// yet — callers treat that as "no baseline" and degrade gracefully.
func HeadCommit(ctx context.Context, cwd string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	out, err := run(ctx, cwd, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// CommitBefore resolves the commit that was HEAD at the given time — the newest first-parent commit
// on HEAD's history with committer-date at or before beforeUnixSec. It anchors an agent's live diff
// to its session start, so the diff reflects only that session's work (commits since start +
// uncommitted), not the branch's whole divergence. Returns "" (no error) when cwd is not a repo,
// HEAD is unborn, or no commit precedes the time (a brand-new session) — every caller treats "" as
// "fall back to the live working-tree-vs-HEAD diff".
func CommitBefore(ctx context.Context, cwd string, beforeUnixSec int64) (string, error) {
	if beforeUnixSec <= 0 {
		return "", nil
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	before := time.Unix(beforeUnixSec, 0).UTC().Format(time.RFC3339)
	out, err := run(ctx, cwd, "rev-list", "-1", "--first-parent", "--before="+before, "HEAD")
	if err != nil {
		return "", nil // not a repo / unborn HEAD — no anchor
	}
	return strings.TrimSpace(out), nil
}

// stripPrefixZ rewrites a `status --porcelain -z` blob so its paths are relative to prefix (cwd's
// path within the repo, e.g. "services/foo/") to match `diff --relative` output. Entries are
// "XY <path>"; rename/copy entries carry an extra NUL-separated bare source path. A blank prefix
// (cwd is the repo root) returns the blob unchanged.
func stripPrefixZ(statusZ, prefix string) string {
	if prefix == "" {
		return statusZ
	}
	parts := strings.Split(statusZ, "\x00")
	for i := 0; i < len(parts); i++ {
		entry := parts[i]
		if len(entry) < 3 {
			continue
		}
		parts[i] = entry[:3] + strings.TrimPrefix(entry[3:], prefix)
		if entry[0] == 'R' || entry[0] == 'C' {
			i++ // the next field is the bare rename/copy source path
			if i < len(parts) {
				parts[i] = strings.TrimPrefix(parts[i], prefix)
			}
		}
	}
	return strings.Join(parts, "\x00")
}

const maxUntrackedScan = 5 << 20 // 5 MiB; beyond this, report "-" instead of scanning the whole file

// untrackedNumstat produces numstat-format rows ("<adds>\t0\t<path>\n") for the untracked files in a
// `git status --porcelain=v1 -z` listing, so brand-new files contribute their added lines to the
// Files-surface totals. Binary/oversized/unreadable files report "-" (git's convention); wholly
// untracked directories (porcelain collapses these to a trailing "/") are skipped — no file to count.
func untrackedNumstat(cwd, statusZ string) string {
	var b strings.Builder
	parts := strings.Split(statusZ, "\x00")
	for i := 0; i < len(parts); i++ {
		entry := parts[i]
		if len(entry) < 3 {
			continue
		}
		// rename/copy entries carry an extra NUL-separated source path — consume it to stay aligned
		if entry[0] == 'R' || entry[0] == 'C' {
			i++
			continue
		}
		if entry[:2] != "??" {
			continue
		}
		path := entry[3:]
		if path == "" || strings.HasSuffix(path, "/") {
			continue
		}
		fmt.Fprintf(&b, "%s\t0\t%s\n", untrackedAdds(filepath.Join(cwd, path)), path)
	}
	return b.String()
}

// untrackedAdds returns a numstat added-lines field for a new file: its line count for text, or "-"
// (git's binary marker) for binary, oversized, or unreadable files.
func untrackedAdds(full string) string {
	info, err := os.Stat(full)
	if err != nil || info.IsDir() || info.Size() > maxUntrackedScan {
		return "-"
	}
	content, err := os.ReadFile(full)
	if err != nil {
		return "-"
	}
	if len(content) == 0 {
		return "0"
	}
	if bytes.IndexByte(content, 0) >= 0 {
		return "-" // NUL byte -> binary, like git
	}
	lines := bytes.Count(content, []byte{'\n'})
	if !bytes.HasSuffix(content, []byte{'\n'}) {
		lines++ // a final line without a trailing newline still counts
	}
	return strconv.Itoa(lines)
}

func GetDiff(ctx context.Context, cwd, path, ref string) (*Diff, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	st, _ := run(ctx, cwd, "status", "--porcelain=v1", "--", path)
	if strings.HasPrefix(strings.TrimSpace(st), "??") {
		content, err := os.ReadFile(filepath.Join(cwd, path))
		if err != nil {
			return nil, err
		}
		return &Diff{Content: string(content), Untracked: true}, nil
	}
	base := ref
	if base == "" {
		base = "HEAD"
	}
	diff, err := run(ctx, cwd, "diff", base, "--", path)
	if err != nil {
		return nil, err
	}
	return &Diff{Diff: diff}, nil
}

type BranchInfo struct {
	Name string
	Age  string // relative committer date, e.g. "2 hours ago"
}

// ListBranches returns the local branches of the repo at repoPath, most-recently-committed first.
// It returns an empty slice (no error) when repoPath is not a git repository, so the caller can
// degrade to free-text input without surfacing an error.
func ListBranches(ctx context.Context, repoPath string) ([]BranchInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, repoPath, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return nil, nil
	}
	out, err := run(ctx, repoPath, "for-each-ref", "--sort=-committerdate",
		"--format=%(refname:short)\t%(committerdate:relative)", "refs/heads")
	if err != nil {
		return nil, err
	}
	var branches []BranchInfo
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		name, age, _ := strings.Cut(line, "\t")
		branches = append(branches, BranchInfo{Name: name, Age: age})
	}
	return branches, nil
}

// runErr is like run but captures stderr into the error (for write operations where the cause matters).
func runErr(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// runStdin runs git with data piped to stdin (for `apply`). Captures stderr into the error.
func runStdin(ctx context.Context, cwd, stdin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", cwd}, args...)...)
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// RevertFile discards a file's uncommitted changes based on its porcelain status:
// untracked ("?") -> git clean; newly-added/staged ("A") -> git rm; otherwise restore from HEAD.
func RevertFile(ctx context.Context, cwd, path, status string) error {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	s := strings.TrimSpace(status)
	switch {
	case strings.Contains(status, "?"):
		_, err := runErr(ctx, cwd, "clean", "-f", "--", path)
		return err
	case strings.HasPrefix(s, "A"):
		_, err := runErr(ctx, cwd, "rm", "-f", "--", path)
		return err
	default:
		_, err := runErr(ctx, cwd, "checkout", "HEAD", "--", path)
		return err
	}
}

// repoRoot returns the working-tree top-level for cwd, falling back to cwd when it can't be resolved
// (not a repo / git error). `git apply` resolves patch paths relative to this top-level regardless of
// the process cwd, so RevertHunk must anchor there.
func repoRoot(ctx context.Context, cwd string) string {
	top, err := run(ctx, cwd, "rev-parse", "--show-toplevel")
	if err != nil || strings.TrimSpace(top) == "" {
		return cwd
	}
	return strings.TrimSpace(top)
}

// RevertHunk reverse-applies a unified-diff patch (one or more hunks for a single file) to the
// working tree, discarding exactly those changes. Fails (does not silently no-op) if the patch
// no longer applies — the caller surfaces that so the user can reload a stale diff.
func RevertHunk(ctx context.Context, cwd, path, patch string) error {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	// git apply resolves the patch's (repo-root-relative) paths against the working-tree top-level, not
	// cwd — so a subdirectory (microservice) cwd would silently apply nothing. Anchor at the root.
	_, err := runStdin(ctx, repoRoot(ctx, cwd), patch, "apply", "--reverse", "-")
	return err
}

// flattenBranch makes a git ref safe for a filesystem path segment (feat/x -> feat-x).
func flattenBranch(branch string) string {
	return strings.ReplaceAll(branch, "/", "-")
}

// WorktreePath is the sibling-dir location for a worktree of branch off the repo at repoPath:
//
//	<parent>/<basename>-worktrees/<flattened-branch>
func WorktreePath(repoPath, branch string) string {
	return filepath.Join(filepath.Dir(repoPath), filepath.Base(repoPath)+"-worktrees", flattenBranch(branch))
}

// CreateWorktree creates (or reuses) a git worktree for branch off repoPath's current HEAD, in a
// sibling dir. If the worktree dir already exists it is reused; if the branch exists it is checked
// out, otherwise a new branch is created off HEAD. Returns the worktree path.
func CreateWorktree(ctx context.Context, repoPath, branch string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, repoPath, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return "", fmt.Errorf("not a git repository: %s", repoPath)
	}
	wt := WorktreePath(repoPath, branch)
	if _, statErr := os.Stat(wt); statErr == nil {
		return wt, nil // reuse existing worktree dir
	}
	if err := os.MkdirAll(filepath.Dir(wt), 0o755); err != nil {
		return "", err
	}
	_, brErr := run(ctx, repoPath, "rev-parse", "--verify", "refs/heads/"+branch)
	if brErr == nil {
		if _, err := runErr(ctx, repoPath, "worktree", "add", wt, branch); err != nil {
			return "", err
		}
	} else {
		if _, err := runErr(ctx, repoPath, "worktree", "add", wt, "-b", branch); err != nil {
			return "", err
		}
	}
	return wt, nil
}
