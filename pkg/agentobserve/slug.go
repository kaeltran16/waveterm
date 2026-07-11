// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agentobserve derives an agent's live state and transcript path from the files
// Claude Code writes plus OS process liveness — the source of truth the hook channel only
// approximates. It is the reusable core of the hook-reliability pilot (shadow, log-only) and
// of the observer that replaces hook-dependence if the pilot passes. See
// docs/superpowers/specs/2026-07-12-hook-reliability-pilot-design.md.
package agentobserve

import "strings"

// SlugifyCwd encodes a working directory into the Claude Code projects-dir name: every
// non-alphanumeric rune becomes '-'. Verified against real dirs on disk, e.g.
// `C:\Users\cktra\Projects\opal\.claude-worktrees\design-system-impl` ->
// `C--Users-cktra-Projects-opal--claude-worktrees-design-system-impl`.
//
// The encoding is lossy (distinct paths can collide), so discovery never trusts the slug
// alone — it re-validates against the transcript's own `cwd` field. The slug only narrows
// which directory to look in.
func SlugifyCwd(cwd string) string {
	var b strings.Builder
	b.Grow(len(cwd))
	for _, r := range cwd {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('-')
	}
	return b.String()
}
