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
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const gitTimeout = 10 * time.Second

type Changes struct {
	Branch  string
	StatusZ string
	Numstat string
	IsRepo  bool
	// The commit HEAD points at, or "" in a repository with no commits yet. Carried here rather than
	// asked for separately because the Diff surface polls this read on a timer: a commit landing under
	// the open surface has to be noticeable, and comparing one sha is what lets the surface re-read the
	// log only when the log has actually changed.
	Head string
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
	// A repository with no commits has no HEAD, which is not a failure of this read — every file there
	// is untracked and the change list is still the answer. The error has to be checked rather than
	// discarded: rev-parse echoes the unresolved argument ("HEAD") on stdout before exiting non-zero,
	// so ignoring it stores the literal string as if it were a sha.
	head := ""
	if out, herr := run(ctx, cwd, "rev-parse", "HEAD"); herr == nil {
		head = strings.TrimSpace(out)
	}
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
		return &Changes{Branch: strings.TrimSpace(branch), StatusZ: statusZ, Numstat: numstat, IsRepo: true, Head: head}, nil
	}
	// ref mode: tracked changes come from the base diff (committed + uncommitted); untracked files
	// are not in the base, so their ?? rows are carried over from status verbatim.
	nameStatus, _ := run(ctx, cwd, "diff", "--name-status", "-z", "--relative", ref)
	trackedZ := nameStatusToStatusZ(nameStatus)
	untrackedZ := untrackedEntriesZ(statusZ)
	numstat, _ := run(ctx, cwd, "diff", "--numstat", "--relative", ref)
	numstat += untrackedNumstat(cwd, untrackedZ)
	return &Changes{Branch: strings.TrimSpace(branch), StatusZ: trackedZ + untrackedZ, Numstat: numstat, IsRepo: true, Head: head}, nil
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

// RangeCommit is one commit in a base..end range: its SHA, author time (UnixMilli), and subject line.
type RangeCommit struct {
	Hash    string
	Ts      int64
	Subject string
}

// RangeLog returns the commits reachable from end but not base, newest first, for identifier matching
// (layer 2). Unlike GetRangeChanges it yields commit subjects/SHAs, which git diff cannot. Uses a unit
// separator (\x1f) between fields so subjects containing spaces parse cleanly. Empty range → empty slice.
func RangeLog(ctx context.Context, cwd, base, end string) ([]RangeCommit, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	out, err := run(ctx, cwd, "log", "--pretty=format:%H%x1f%ct%x1f%s", base+".."+end)
	if err != nil {
		return nil, err
	}
	out = strings.TrimSpace(out)
	if out == "" {
		return nil, nil
	}
	var commits []RangeCommit
	for _, line := range strings.Split(out, "\n") {
		parts := strings.SplitN(line, "\x1f", 3)
		if len(parts) != 3 {
			continue
		}
		secs, _ := strconv.ParseInt(parts[1], 10, 64)
		commits = append(commits, RangeCommit{Hash: parts[0], Ts: secs * 1000, Subject: parts[2]})
	}
	return commits, nil
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

// defaultHistoryLimit bounds an unpaginated history read. A cockpit-sized page, not a whole repo:
// the surface pages as the user scrolls, and an unbounded log on a large repo blocks the RPC.
const defaultHistoryLimit = 200

// fieldSep / recordSep are git's own unit and record separators (%x1f / %x1e). Using an explicit
// record separator rather than relying on newlines keeps parsing correct even when a field's own
// content contains a newline.
const (
	fieldSep  = "\x1f"
	recordSep = "\x1e"
)

// HistoryCommit is one commit in a history walk. Parents are full SHAs in git's own order, so
// Parents[0] is the first parent — the lane a graph continues down. Refs are decoration entries as
// git prints them ("HEAD -> main", "origin/main", "tag: v0.9.4"), left unparsed for the frontend.
type HistoryCommit struct {
	Hash    string   `json:"hash"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	Email   string   `json:"email"`
	Ts      int64    `json:"ts"`
	Subject string   `json:"subject"`
	Refs    []string `json:"refs,omitempty"`
}

// HistoryOpts scopes a history walk. Zero value = the default-limit walk from HEAD across all refs.
type HistoryOpts struct {
	Ref    string // revision or range ("main", a SHA, "base..head"); "" = all refs
	Skip   int
	Limit  int // 0 => defaultHistoryLimit
	Author string
	Grep   string
	Path   string
}

// History is a page of commits plus the current HEAD, which the surface needs to anchor a synthetic
// working-tree row to the commit it sits on top of. Failure is set when the directory is a work tree
// but the log read failed: IsRepo:false and Failure:non-nil are deliberately different answers.
type History struct {
	Commits []HistoryCommit `json:"commits"`
	Head    string          `json:"head"`
	IsRepo  bool            `json:"isrepo"`
	Failure *GitFailure     `json:"failure,omitempty"`
}

// HistoryLog walks commit history newest-first with parent links and ref decoration. Unlike RangeLog
// (which answers "what commits are in this bounded base..end range") this is the paginated,
// filterable walk a history view scrolls through. --date-order keeps sibling branches interleaved by
// time rather than collapsing one branch at a time, which is what makes a lane graph readable.
func HistoryLog(ctx context.Context, cwd string, opts HistoryOpts) (*History, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &History{IsRepo: false}, nil
	}
	limit := opts.Limit
	if limit <= 0 {
		limit = defaultHistoryLimit
	}
	// --decorate=full, not short: short prints a local branch "feature/x" and a remote branch
	// "origin/main" identically, so nothing downstream can tell a slashed local branch from a remote.
	// Full form carries the refs/heads/ | refs/remotes/ | refs/tags/ namespace, which classifyRef
	// (frontend historyrows.ts) keys off. Labels are stripped back to the short name there.
	args := []string{"log", "--date-order", "--no-color", "--decorate=full",
		"--pretty=format:%H" + fieldSep + "%P" + fieldSep + "%an" + fieldSep + "%ae" +
			fieldSep + "%ct" + fieldSep + "%D" + fieldSep + "%s" + recordSep,
		"--max-count=" + strconv.Itoa(limit)}
	if opts.Skip > 0 {
		args = append(args, "--skip="+strconv.Itoa(opts.Skip))
	}
	if opts.Author != "" {
		args = append(args, "--author="+opts.Author)
	}
	if opts.Grep != "" {
		args = append(args, "--grep="+opts.Grep, "--regexp-ignore-case")
	}
	if opts.Ref != "" {
		args = append(args, opts.Ref)
	} else {
		args = append(args, "--all")
	}
	// a pathspec must come last, after the revision
	if opts.Path != "" {
		args = append(args, "--", opts.Path)
	}
	out, err := run(ctx, cwd, args...)
	if err != nil {
		// A repo with no commits yet is empty history, not a failed read — git log exits 128 there.
		// rev-parse --verify --quiet exits 1 for "no such ref" and 128 for a fatal error, so the exit
		// code discriminates an unborn branch without matching git's wording, which changes between
		// versions.
		if _, verr := run(ctx, cwd, "rev-parse", "--verify", "--quiet", "HEAD"); verr != nil && exitCodeOf(verr) == 1 {
			return &History{IsRepo: true}, nil
		}
		return &History{IsRepo: true, Failure: failureOf(args, err)}, nil
	}
	head, _ := run(ctx, cwd, "rev-parse", "HEAD")
	return &History{Commits: parseHistory(out), Head: strings.TrimSpace(head), IsRepo: true}, nil
}

func parseHistory(out string) []HistoryCommit {
	var commits []HistoryCommit
	for _, rec := range strings.Split(out, recordSep) {
		rec = strings.TrimLeft(rec, "\r\n")
		if strings.TrimSpace(rec) == "" {
			continue
		}
		f := strings.Split(rec, fieldSep)
		if len(f) < 7 {
			continue
		}
		secs, _ := strconv.ParseInt(strings.TrimSpace(f[4]), 10, 64)
		commits = append(commits, HistoryCommit{
			Hash:    f[0],
			Parents: strings.Fields(f[1]),
			Author:  f[2],
			Email:   f[3],
			Ts:      secs * 1000,
			Refs:    parseDecoration(f[5]),
			Subject: f[6],
		})
	}
	return commits
}

// parseDecoration splits git's %D decoration ("HEAD -> refs/heads/main, refs/remotes/origin/main,
// tag: refs/tags/v0.9.4") into its entries, left otherwise verbatim — including the refs/ namespace,
// which is what lets the frontend tell a remote branch from a slashed local one.
func parseDecoration(d string) []string {
	d = strings.TrimSpace(d)
	if d == "" {
		return nil
	}
	parts := strings.Split(d, ",")
	refs := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			refs = append(refs, p)
		}
	}
	return refs
}

// Divergence is the two-sided answer to "how do these refs differ": the commits reachable from head
// but not base, the reverse, and the commit they share. Ahead/Behind are named from head's point of
// view. Commit lists are newest-first, matching HistoryLog.
type Divergence struct {
	Ahead     []HistoryCommit `json:"ahead"`
	Behind    []HistoryCommit `json:"behind"`
	MergeBase string          `json:"mergebase"`
	IsRepo    bool            `json:"isrepo"`
}

// GetDivergence compares two refs. The per-side commit lists come from HistoryLog over the symmetric
// ranges, so each commit carries an author — the compare view shows one per row.
func GetDivergence(ctx context.Context, cwd, base, head string) (*Divergence, error) {
	ahead, err := HistoryLog(ctx, cwd, HistoryOpts{Ref: base + ".." + head})
	if err != nil {
		return nil, err
	}
	if !ahead.IsRepo {
		return &Divergence{IsRepo: false}, nil
	}
	behind, err := HistoryLog(ctx, cwd, HistoryOpts{Ref: head + ".." + base})
	if err != nil {
		return nil, err
	}
	mbCtx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	mb, err := run(mbCtx, cwd, "merge-base", base, head)
	if err != nil {
		return nil, err
	}
	return &Divergence{
		Ahead:     ahead.Commits,
		Behind:    behind.Commits,
		MergeBase: strings.TrimSpace(mb),
		IsRepo:    true,
	}, nil
}

// git's well-known empty-tree object. Diffing a root commit against it is how you get "everything
// this commit introduced" when there is no parent to measure against.
const emptyTreeHash = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// commitBase returns the ref a commit's own change should be measured against: its first parent, or
// the empty tree for a root commit. Merge commits deliberately use the first parent — "what did this
// merge bring in" is the conventional presentation, and a combined diff is unreadable in a file list.
func commitBase(ctx context.Context, cwd, hash string) (string, error) {
	out, err := run(ctx, cwd, "rev-list", "--parents", "-n", "1", hash)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(strings.TrimSpace(out))
	if len(fields) < 2 {
		return emptyTreeHash, nil
	}
	return fields[1], nil
}

// CommitChanges lists the per-file changes one commit introduced, as name-status + numstat in the
// same shape GetChanges and GetRangeChanges produce. Unlike GetChanges it never consults the working
// tree, so selecting a commit in the history shows that commit and not "everything since it".
// Paths are cwd-relative (--relative), matching the rest of the package.
func CommitChanges(ctx context.Context, cwd, hash string) (*Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &Changes{IsRepo: false}, nil
	}
	base, err := commitBase(ctx, cwd, hash)
	if err != nil {
		return nil, err
	}
	nameStatus, err := run(ctx, cwd, "diff", "--name-status", "-z", "--relative", base, hash)
	if err != nil {
		return nil, err
	}
	numstat, err := run(ctx, cwd, "diff", "--numstat", "--relative", base, hash)
	if err != nil {
		return nil, err
	}
	return &Changes{StatusZ: nameStatusToStatusZ(nameStatus), Numstat: numstat, IsRepo: true}, nil
}

// CommitDiff returns one file's unified diff as introduced by one commit. The Diff shape is shared
// with GetDiff so the frontend parses both the same way; Untracked is never set here, because a
// committed file is by definition tracked.
func CommitDiff(ctx context.Context, cwd, hash, path string) (*Diff, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	base, err := commitBase(ctx, cwd, hash)
	if err != nil {
		return nil, err
	}
	diff, err := pathDiff(ctx, cwd, path, base, hash)
	if err != nil {
		return nil, err
	}
	return &Diff{Diff: diff}, nil
}

// renameSource returns the path a rename moved from, or "" when this path is a genuine addition. It
// asks the same whole-diff question the change list asks — deliberately with the same flags, so the
// two reads cannot disagree about whether a file was renamed.
func renameSource(ctx context.Context, cwd, path string, revs ...string) string {
	args := append([]string{"diff", "--name-status", "-z", "--relative"}, revs...)
	out, err := run(ctx, cwd, args...)
	if err != nil {
		return ""
	}
	toks := strings.Split(out, "\x00")
	for i := 0; i < len(toks); i++ {
		st := toks[i]
		if st == "" {
			continue
		}
		if st[0] == 'R' || st[0] == 'C' { // Rxxx \0 old \0 new
			if i+2 >= len(toks) {
				break
			}
			if toks[i+2] == path {
				return toks[i+1]
			}
			i += 2
			continue
		}
		if i+1 >= len(toks) {
			break
		}
		i++
	}
	return ""
}

// pathDiff reads one path's diff over a rev spec. A rename comes back as a whole new file when only
// the new path is in the pathspec — git has no deletion in view to pair it with — so an addition is
// re-read with the source path alongside it. Without that, the change list (which reads the whole
// diff, and does pair them) called a file a rename while this read called it every line added.
func pathDiff(ctx context.Context, cwd, path string, revs ...string) (string, error) {
	diffArgs := func(paths ...string) []string {
		args := append([]string{"diff"}, revs...)
		return append(append(args, "--"), paths...)
	}
	out, err := run(ctx, cwd, diffArgs(path)...)
	if err != nil {
		return "", err
	}
	if !strings.Contains(out, "\nnew file mode ") {
		return out, nil
	}
	src := renameSource(ctx, cwd, path, revs...)
	if src == "" {
		return out, nil
	}
	paired, err := run(ctx, cwd, diffArgs(src, path)...)
	if err != nil {
		return out, nil // the first read already answered; a failed second one is not worth surfacing
	}
	return paired, nil
}

// CompareChanges returns the per-file changes head introduces relative to base, anchored at their
// merge base (three-dot). The two-dot form would fold in the base side's own commits inverted — their
// additions appearing as deletions — so the file list would match neither side of the compare column.
// Never consults the working tree. Paths are cwd-relative (--relative), matching the rest of the
// package, so parseGitChanges on the frontend handles this shape unchanged. IsRepo=false when cwd is
// not a repo; a git failure errors so the caller can name the ref that did not resolve.
func CompareChanges(ctx context.Context, cwd, base, head string) (*Changes, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &Changes{IsRepo: false}, nil
	}
	spec := base + "..." + head
	nameStatus, err := run(ctx, cwd, "diff", "--name-status", "-z", "--relative", spec)
	if err != nil {
		return nil, err
	}
	numstat, err := run(ctx, cwd, "diff", "--numstat", "--relative", spec)
	if err != nil {
		return nil, err
	}
	return &Changes{StatusZ: nameStatusToStatusZ(nameStatus), Numstat: numstat, IsRepo: true}, nil
}

// CompareDiff returns one file's unified diff between base and head, anchored at their merge base so
// it agrees with CompareChanges. The Diff shape is shared with GetDiff and CommitDiff so the frontend
// parses all three the same way; Untracked is never set, because a two-ref diff has no working tree.
func CompareDiff(ctx context.Context, cwd, base, head, path string) (*Diff, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	diff, err := pathDiff(ctx, cwd, path, base+"..."+head)
	if err != nil {
		return nil, err
	}
	return &Diff{Diff: diff}, nil
}

// FileContent is one file's content at one ref. Binary, Missing and TooLarge are states a caller
// draws rather than errors, because each is a normal thing to find at a ref: a blob that is not
// text, a file added since that ref, a file too big to be worth mounting an editor on.
type FileContent struct {
	Content  string `json:"content"`
	Binary   bool   `json:"binary"`
	Missing  bool   `json:"missing"`
	TooLarge bool   `json:"toolarge"`
	Size     int64  `json:"size"`
	IsRepo   bool   `json:"isrepo"`
}

// FileAtRef returns one file's full content at a ref. The path is cwd-relative like every other
// reader here, so the rev spec uses the "./" form: `<ref>:./<path>` resolves relative to cwd, while
// `<ref>:<path>` resolves from the repo root and silently misses in a subdirectory checkout.
// maxBytes caps the transport (0 = no cap) and the size is read from the blob header first, so an
// oversized file is refused without ever being read.
func FileAtRef(ctx context.Context, cwd, ref, path string, maxBytes int64) (*FileContent, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &FileContent{IsRepo: false}, nil
	}
	spec := ref + ":./" + path
	sizeOut, err := run(ctx, cwd, "cat-file", "-s", spec)
	if err != nil {
		// the blob does not exist at this ref: an add on one side, a delete on the other
		return &FileContent{IsRepo: true, Missing: true}, nil
	}
	size, err := strconv.ParseInt(strings.TrimSpace(sizeOut), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("git cat-file -s %s: unparsable size %q", spec, strings.TrimSpace(sizeOut))
	}
	if maxBytes > 0 && size > maxBytes {
		return &FileContent{IsRepo: true, TooLarge: true, Size: size}, nil
	}
	out, err := run(ctx, cwd, "show", spec)
	if err != nil {
		return nil, err
	}
	if !utf8.ValidString(out) {
		return &FileContent{IsRepo: true, Binary: true, Size: size}, nil
	}
	return &FileContent{IsRepo: true, Content: out, Size: size}, nil
}

// DefaultBranch resolves the repo's default branch as a *local* branch name: origin/HEAD when the
// remote publishes it, else a probe of main then master. Returns "" (not an error) when none resolve,
// so the compare ref picker opens with an empty base field instead of an error the user cannot act on
// — the same degrade-quietly contract ListBranches uses for a non-repo.
//
// Local-name-only is deliberate: the picker's suggestions come from ListBranches, which reads
// refs/heads, so returning "origin/main" would offer a base the suggestion list cannot show. The cost
// is that a stale local main overstates divergence; the deferred Fetch control is the answer to that.
func DefaultBranch(ctx context.Context, cwd string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	if out, err := run(ctx, cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); err == nil {
		if name := strings.TrimSpace(out); name != "" {
			return strings.TrimPrefix(name, "origin/"), nil
		}
	}
	for _, probe := range []string{"main", "master"} {
		if _, err := run(ctx, cwd, "rev-parse", "--verify", "--quiet", probe); err == nil {
			return probe, nil
		}
	}
	return "", nil
}

// GitFailure describes a git invocation that failed, in the shape the Diff surface's failure panel
// renders: the command as run, its exit code, and stderr verbatim. It exists so a failed read can be
// reported as data rather than as an RPC error — "this is not a repository" and "the read failed"
// are different screens, and an error string cannot carry the fields the second one shows.
type GitFailure struct {
	Command  string `json:"command"`
	ExitCode int    `json:"exitcode"`
	Stderr   string `json:"stderr"`
}

// exitCodeOf reports git's own exit status, or -1 when the failure was not an exit status at all
// (git missing from PATH, a context deadline). Callers discriminate on it: git uses 1 for "no such
// ref" and 128 for a fatal error, which is how HistoryLog tells an unborn branch from a real fault.
func exitCodeOf(err error) int {
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}

// failureOf turns the error run() already returns into a GitFailure. cmd.Output() populates
// ExitError.Stderr, so both the code and git's message are available without changing how git is
// invoked — and without CombinedOutput, which would fold stderr into the stdout callers parse.
func failureOf(args []string, err error) *GitFailure {
	f := &GitFailure{Command: "git " + strings.Join(args, " "), ExitCode: exitCodeOf(err)}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		f.Stderr = strings.TrimSpace(string(ee.Stderr))
	}
	if f.Stderr == "" && err != nil {
		f.Stderr = err.Error() // no stderr to show (git absent, deadline): the Go error is the evidence
	}
	return f
}

// maxListFiles caps the enumeration so a pathological repo cannot hand the frontend a
// multi-megabyte path array. Truncated tells the caller it happened, because a silently
// partial index reads as a complete one.
const maxListFiles = 20000

// FileList is every path git knows about in cwd: tracked files plus untracked files that
// .gitignore does not exclude. Paths are repo-relative with forward slashes, sorted.
type FileList struct {
	Paths     []string `json:"paths"`
	IsRepo    bool     `json:"isrepo"`
	Truncated bool     `json:"truncated"`
}

// ListFiles enumerates cwd for the Code surface's tree and file finder. IsRepo=false when cwd is
// not a repository (not an error — it is an empty state); a git failure IS an error so the caller
// can tell "nothing to browse" from "the read failed".
func ListFiles(ctx context.Context, cwd string) (*FileList, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	inside, err := run(ctx, cwd, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		return &FileList{IsRepo: false}, nil
	}
	// -z: NUL-separated, so a path containing a space or non-ASCII byte survives unquoted.
	out, err := run(ctx, cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, err
	}
	paths := []string{}
	for _, p := range strings.Split(out, "\x00") {
		if p != "" {
			paths = append(paths, p)
		}
	}
	// --cached and --others cannot overlap (others is untracked-only) but the concatenation is
	// not globally ordered, so sort for a stable tree.
	sort.Strings(paths)
	truncated := false
	if len(paths) > maxListFiles {
		paths = paths[:maxListFiles]
		truncated = true
	}
	return &FileList{Paths: paths, IsRepo: true, Truncated: truncated}, nil
}

const maxGrepMatches = 500

type GrepMatch struct {
	Path string
	Line int
	Text string
}

// GrepResult holds at most maxGrepMatches matches; Truncated reports that the scan stopped early.
type GrepResult struct {
	Matches   []GrepMatch
	Truncated bool
}

// Grep searches file contents in cwd for a fixed, case-insensitive string.
//
// --untracked is not optional: the Code surface builds its tree and its file finder from
// ls-files --cached --others --exclude-standard, and without the flag git grep would search only
// tracked files — so a newly created file would appear in the tree and never in search results.
// .gitignore is still honored either way.
//
// git grep exits 1 when nothing matched, which is not a failure. Exit 128 (not a repository) and
// everything else are.
func Grep(ctx context.Context, cwd, query string) (*GrepResult, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return &GrepResult{}, nil // `git grep -e ""` matches every line of every file
	}
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	out, err := run(ctx, cwd, "grep", "--untracked", "-n", "-z", "-I", "-i", "-F", "--no-color", "-e", q)
	if err != nil {
		var ee *exec.ExitError
		if !errors.As(err, &ee) || ee.ExitCode() != 1 {
			return nil, err
		}
	}
	matches := []GrepMatch{}
	truncated := false
	// -n -z prints "path\0line\0text"; the record itself still ends at a newline, so a path
	// containing a newline is not representable — the limit of git grep's output format.
	for _, rec := range strings.Split(out, "\n") {
		if rec == "" {
			continue
		}
		parts := strings.SplitN(rec, "\x00", 3)
		if len(parts) < 3 {
			continue
		}
		n, convErr := strconv.Atoi(parts[1])
		if convErr != nil {
			continue
		}
		if len(matches) >= maxGrepMatches {
			truncated = true
			break
		}
		matches = append(matches, GrepMatch{
			Path: parts[0],
			Line: n,
			Text: strings.TrimSuffix(parts[2], "\r"), // Windows checkout: real files are CRLF
		})
	}
	return &GrepResult{Matches: matches, Truncated: truncated}, nil
}
