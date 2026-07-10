// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// collectGit emits one signal per commit in the evidence window, recording its changed files with
// add/delete counts and whether any test file changed alongside. It makes no risk judgment.
func collectGit(ctx context.Context, in collectInput) ([]waveobj.RadarSignal, error) {
	logArgs := []string{"log", "--no-color", "--pretty=format:%H%x1f%ct%x1f%s", "--numstat", "-z"}
	if in.sinceTs > 0 {
		logArgs = append(logArgs, "--since", strconv.FormatInt(in.sinceTs/1000, 10))
	} else {
		logArgs = append(logArgs, "--since", "30 days ago")
	}
	out, err := git(ctx, in.projectPath, logArgs...)
	if err != nil {
		return nil, fmt.Errorf("git log: %w", err)
	}
	commits := parseGitLog(out)
	var sigs []waveobj.RadarSignal
	for _, c := range commits {
		paths := make([]string, 0, len(c.files))
		testChanged := false
		for _, f := range c.files {
			paths = append(paths, f.path)
			if isTestPath(f.path) {
				testChanged = true
			}
		}
		facts := map[string]any{
			"subject":     Redact(c.subject),
			"testchanged": testChanged,
			"files":       c.files,
		}
		summary := fmt.Sprintf("commit %s touched %d file(s)%s", c.hash[:7], len(c.files), testSuffix(testChanged))
		sigs = append(sigs, newSignal(CollectorGit, "commit:"+c.hash, c.ts*1000, paths, summary, facts, ""))
	}
	return sigs, nil
}

type gitFile struct {
	path string
	adds int
	dels int
}

type gitCommit struct {
	hash    string
	ts      int64
	subject string
	files   []gitFile
}

// parseGitLog parses `git log --pretty=format:%H\x1f%ct\x1f%s --numstat -z`. Records are separated by
// the NUL that -z appends after each commit's numstat block; within a record, the header line is
// %H\x1f%ct\x1f%s then numstat rows "adds\tdels\tpath".
func parseGitLog(out string) []gitCommit {
	var commits []gitCommit
	blocks := strings.Split(out, "\x00")
	var cur *gitCommit
	flush := func() {
		if cur != nil {
			commits = append(commits, *cur)
			cur = nil
		}
	}
	for _, block := range blocks {
		block = strings.Trim(block, "\n")
		if block == "" {
			continue
		}
		lines := strings.Split(block, "\n")
		for _, line := range lines {
			if strings.Contains(line, "\x1f") {
				flush()
				parts := strings.SplitN(line, "\x1f", 3)
				ts, _ := strconv.ParseInt(parts[1], 10, 64)
				cur = &gitCommit{hash: parts[0], ts: ts, subject: parts[2]}
				continue
			}
			cols := strings.Split(line, "\t")
			if len(cols) == 3 && cur != nil {
				adds, _ := strconv.Atoi(cols[0]) // "-" (binary) -> 0
				dels, _ := strconv.Atoi(cols[1])
				cur.files = append(cur.files, gitFile{path: cols[2], adds: adds, dels: dels})
			}
		}
	}
	flush()
	return commits
}

func isTestPath(p string) bool {
	p = strings.ToLower(p)
	return strings.Contains(p, "_test.") || strings.Contains(p, ".test.") ||
		strings.Contains(p, ".spec.") || strings.Contains(p, "/tests/") || strings.Contains(p, "/test/")
}

func testSuffix(b bool) string {
	if b {
		return " (incl. tests)"
	}
	return " (no test change)"
}
