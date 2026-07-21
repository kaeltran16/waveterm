// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// This file holds the deterministic security classifiers shared by the security collectors and the
// security lens (modes.go). Everything here is pure path/string logic — no repo access except the
// bounded file reader, which reads a single tracked text file.

// factClasses reads a signal's fact classes tolerantly: []string in-memory, []any after a DB round-trip
// (SQLite -> JSON -> map[string]any). A []string-only assertion would silently drop every classification
// on the retry path (runClusterOnly reloads candidates from the store).
func factClasses(s waveobj.RadarSignal) []string {
	raw, ok := s.Facts["classes"]
	if !ok {
		return nil
	}
	switch v := raw.(type) {
	case []string:
		return v
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if str, ok := e.(string); ok {
				out = append(out, str)
			}
		}
		return out
	}
	return nil
}

func hasClass(s waveobj.RadarSignal, class string) bool {
	for _, c := range factClasses(s) {
		if c == class {
			return true
		}
	}
	return false
}

// isSecurityClassified reports whether Radar tagged this signal as a security boundary or a
// self-sufficient security fact (config-security / dependency-pin).
func isSecurityClassified(s waveobj.RadarSignal) bool {
	return hasClass(s, ClassSecurityBoundary) || hasClass(s, ClassConfigSecurity) || hasClass(s, ClassDependencyPin)
}

// isSecurityConsequence reports whether this signal is evidence of fragility AT a boundary: a
// churn/failure signal (git/runs/transcript) or a self-sufficient security fact. A structure
// security-boundary tag alone is NOT a consequence — a boundary that never changed and never failed
// is not fragile.
func isSecurityConsequence(s waveobj.RadarSignal) bool {
	switch s.Collector {
	case CollectorGit, CollectorRuns, CollectorTranscript:
		return true
	}
	return hasClass(s, ClassConfigSecurity) || hasClass(s, ClassDependencyPin)
}

// securityBoundaryKind maps a path to a security-boundary category via deterministic name heuristics,
// or "" when the path is not security-relevant. Order matters: auth wins over secret wins over input.
func securityBoundaryKind(p string) string {
	lp := strings.ToLower(strings.ReplaceAll(p, "\\", "/"))
	for _, m := range authMarkers {
		if strings.Contains(lp, m) {
			return "auth"
		}
	}
	for _, m := range secretMarkers {
		if strings.Contains(lp, m) {
			return "secret"
		}
	}
	for _, m := range inputMarkers {
		if strings.Contains(lp, m) {
			return "input"
		}
	}
	return ""
}

var authMarkers = []string{"auth", "session", "login", "permission", "rbac", "oauth", "jwt", "/acl"}
var secretMarkers = []string{"secret", "credential", "keystore", "crypto", "encrypt", "vault"}
var inputMarkers = []string{"validate", "sanitize", "deserialize", "webhook", "upload", "graphql"}

var securityDepMarkers = []string{"auth", "jwt", "jsonwebtoken", "passport", "oauth", "bcrypt", "crypto", "session", "cors", "helmet", "sanitize", "csrf", "cookie", "openssl", "tls"}

// securityRelevantDep reports whether a dependency name looks security-relevant (deterministic
// substring match). Keeps the dependency lens focused and its signal count bounded.
func securityRelevantDep(name string) bool {
	n := strings.ToLower(name)
	for _, m := range securityDepMarkers {
		if strings.Contains(n, m) {
			return true
		}
	}
	return false
}

// isFloatingSpec reports whether an npm version spec is a floating range (caret/tilde/wildcard/range)
// rather than an exact pin. URLs, git refs, and workspace protocols (specs containing ':' or '/') are
// skipped — they are not floating-pin facts.
func isFloatingSpec(spec string) bool {
	s := strings.TrimSpace(spec)
	if s == "" || strings.ContainsAny(s, ":/") {
		return false
	}
	if s == "*" || strings.EqualFold(s, "latest") || strings.EqualFold(s, "x") {
		return true
	}
	switch s[0] {
	case '^', '~', '>', '<':
		return true
	}
	return strings.Contains(s, "x") || strings.Contains(s, "*") || strings.Contains(s, " - ") || strings.Contains(s, "||")
}

const maxManifestBytes = 512 * 1024

// readBoundedFile reads one tracked text file (working-tree copy) up to maxManifestBytes, returning
// ("", false) when missing, oversized, or a directory. Bounded and read-only.
func readBoundedFile(projectPath, rel string) (string, bool) {
	full := filepath.Join(projectPath, filepath.FromSlash(rel))
	info, err := os.Stat(full)
	if err != nil || info.IsDir() || info.Size() > maxManifestBytes {
		return "", false
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", false
	}
	return string(b), true
}
