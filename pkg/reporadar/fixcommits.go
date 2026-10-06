// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

var fixSubjectRe = regexp.MustCompile(`(?i)^fix(\([^)]*\))?!?:`)

var docExts = []string{".md", ".mdx", ".txt", ".rst"}

// listWindowCommits returns the non-merge commits since sinceTs (unix millis), newest first.
func listWindowCommits(ctx context.Context, projectPath string, sinceTs int64) ([]gitCommit, error) {
	args := []string{"log", "--no-color", "--no-merges", "--pretty=format:%H%x1f%ct%x1f%s", "--numstat", "-z"}
	if sinceTs > 0 {
		args = append(args, "--since", strconv.FormatInt(sinceTs/1000, 10))
	} else {
		args = append(args, "--since", "30 days ago")
	}
	out, err := git(ctx, projectPath, args...)
	if err != nil {
		return nil, fmt.Errorf("git log: %w", err)
	}
	return parseGitLog(out), nil
}

func isDocPath(p string) bool {
	p = strings.ToLower(p)
	if strings.HasPrefix(p, "docs/") {
		return true
	}
	for _, ext := range docExts {
		if strings.HasSuffix(p, ext) {
			return true
		}
	}
	return false
}

func codeFiles(c gitCommit) []string {
	var files []string
	for _, f := range c.files {
		if !isDocPath(f.path) && !isTestPath(f.path) {
			files = append(files, f.path)
		}
	}
	sort.Strings(files)
	return files
}

// selectFixCommits applies the spec's trigger: fix subjects, code files only, ranked, audited ones removed, capped.
func selectFixCommits(commits []gitCommit, audited map[string]bool, limit int) []fixCommit {
	var fixes []fixCommit
	fileFixes := map[string]int{}
	for _, c := range commits {
		if !fixSubjectRe.MatchString(c.subject) {
			continue
		}
		files := codeFiles(c)
		if len(files) == 0 {
			continue
		}
		for _, f := range files {
			fileFixes[f]++
		}
		fixes = append(fixes, fixCommit{Hash: c.hash, Subject: c.subject, Ts: c.ts * 1000, Files: files})
	}
	score := func(fc fixCommit) int {
		best := 0
		for _, f := range fc.Files {
			best = max(best, fileFixes[f])
		}
		return best
	}
	var kept []fixCommit
	for _, fc := range fixes {
		if !audited[fc.Hash] {
			kept = append(kept, fc)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool {
		a, b := kept[i], kept[j]
		if sa, sb := score(a), score(b); sa != sb {
			return sa > sb
		}
		if a.Ts != b.Ts {
			return a.Ts > b.Ts
		}
		return a.Hash < b.Hash
	})
	if limit >= 0 && len(kept) > limit {
		kept = kept[:limit]
	}
	return kept
}
