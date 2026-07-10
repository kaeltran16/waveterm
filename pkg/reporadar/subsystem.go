// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"path"
	"sort"
	"strings"
)

// subsystemForPaths derives a deterministic canonical subsystem from project-relative paths:
// the longest common directory prefix (by path segment). This is the stable identity component
// of a finding's fingerprint — it must never depend on model output or path ordering.
//
//	["src/coupons/a.ts","src/coupons/b.ts"] -> "src/coupons"
//	["src/checkout/a.ts","src/coupons/b.ts"] -> "src"
//	["main.go"] -> "." (repo root)
//	[] -> "unknown"
func subsystemForPaths(paths []string) string {
	cleaned := make([]string, 0, len(paths))
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		cleaned = append(cleaned, path.Dir(path.Clean(strings.ReplaceAll(p, "\\", "/"))))
	}
	if len(cleaned) == 0 {
		return "unknown"
	}
	sort.Strings(cleaned)
	prefix := strings.Split(cleaned[0], "/")
	for _, dir := range cleaned[1:] {
		segs := strings.Split(dir, "/")
		n := 0
		for n < len(prefix) && n < len(segs) && prefix[n] == segs[n] {
			n++
		}
		prefix = prefix[:n]
		if len(prefix) == 0 {
			break
		}
	}
	if len(prefix) == 0 {
		return "."
	}
	return strings.Join(prefix, "/")
}
