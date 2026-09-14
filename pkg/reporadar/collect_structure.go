// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// maxUntestedPathsPerDir bounds the file list one directory's no-test signal carries; the count fact
// keeps the full number.
const maxUntestedPathsPerDir = 20

// ignoredDirs are never scanned (git internals, deps, build output, secrets).
var ignoredDirs = []string{".git/", "node_modules/", "vendor/", "dist/", "build/", ".next/", "target/", "__pycache__/"}

// collectStructure enumerates tracked text files, classifies them (source/test/migration/config),
// and emits production-source-without-adjacent-test observations. It makes no risk judgment — a
// missing test is a fact, not a defect.
func collectStructure(ctx context.Context, in collectInput) ([]waveobj.RadarSignal, error) {
	out, err := git(ctx, in.projectPath, "ls-files", "-z")
	if err != nil {
		return nil, fmt.Errorf("git ls-files: %w", err)
	}
	var files []string
	for _, f := range strings.Split(out, "\x00") {
		f = strings.TrimSpace(f)
		if f == "" || isIgnored(f) || !isTextish(f) {
			continue
		}
		files = append(files, f)
	}
	testStems := map[string]bool{}
	for _, f := range files {
		if isTestPath(f) {
			testStems[testStemKey(f)] = true
		}
	}
	// one signal per directory, not per file: per-file facts were most of every candidate pool and
	// crowded the payload budget out of the activity evidence that actually corroborates a risk
	untestedByDir := map[string][]string{}
	for _, f := range files {
		if !isProductionSource(f) || testStems[sourceStemKey(f)] {
			continue
		}
		dir := path.Dir(f)
		untestedByDir[dir] = append(untestedByDir[dir], f)
	}
	dirs := make([]string, 0, len(untestedByDir))
	for dir := range untestedByDir {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	var sigs []waveobj.RadarSignal
	for _, dir := range dirs {
		untested := untestedByDir[dir]
		summary := fmt.Sprintf("%d production source(s) in %s have no adjacent test", len(untested), dir)
		facts := map[string]any{"classes": []string{"source-without-test"}, "count": len(untested)}
		paths := untested
		if len(paths) > maxUntestedPathsPerDir {
			paths = paths[:maxUntestedPathsPerDir]
		}
		sigs = append(sigs, newSignal(CollectorStructure, "struct:no-test:"+dir, in.sinceTs, paths, summary, facts, ""))
	}
	// security-boundary classification: tag tracked production files whose path is security-relevant. This
	// is a fact (a boundary exists), never a defect — the security lens pairs it with a consequence.
	for _, f := range files {
		if isTestPath(f) {
			continue // a test exercises a boundary; it is not one
		}
		kind := securityBoundaryKind(f)
		if kind == "" {
			continue
		}
		summary := fmt.Sprintf("%s is a %s security boundary", f, kind)
		facts := map[string]any{"classes": []string{ClassSecurityBoundary}, "boundary": kind}
		sigs = append(sigs, newSignal(CollectorStructure, "struct:security-boundary:"+f, in.sinceTs, []string{f}, summary, facts, ""))
	}
	return sigs, nil
}

func isIgnored(p string) bool {
	p = strings.ReplaceAll(p, "\\", "/")
	for _, d := range ignoredDirs {
		if strings.HasPrefix(p, d) || strings.Contains(p, "/"+d) {
			return true
		}
	}
	base := path.Base(p)
	return base == ".env" || strings.HasPrefix(base, ".env.") || strings.HasSuffix(base, ".lock")
}

func isTextish(p string) bool {
	ext := strings.ToLower(path.Ext(p))
	switch ext {
	case ".ts", ".tsx", ".js", ".jsx", ".go", ".py", ".rb", ".java", ".rs", ".sql", ".yaml", ".yml", ".json", ".toml", ".sh":
		return true
	}
	return false
}

func isProductionSource(p string) bool {
	if isTestPath(p) {
		return false
	}
	ext := strings.ToLower(path.Ext(p))
	switch ext {
	case ".ts", ".tsx", ".js", ".jsx", ".go", ".py", ".rb", ".java", ".rs":
		return true
	}
	return false
}

// stem keys pair a source file with its test by directory + base-name-without-test-marker.
func sourceStemKey(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	base := strings.TrimSuffix(path.Base(p), path.Ext(p))
	return path.Dir(p) + "|" + base
}

func testStemKey(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	base := path.Base(p)
	base = strings.TrimSuffix(base, path.Ext(base)) // drop .ts
	base = strings.TrimSuffix(base, ".test")
	base = strings.TrimSuffix(base, ".spec")
	base = strings.TrimSuffix(base, "_test")
	dir := path.Dir(p)
	dir = strings.TrimSuffix(dir, "/tests")
	dir = strings.TrimSuffix(dir, "/test")
	return dir + "|" + base
}
