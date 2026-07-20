// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Freshness: content-drift detection. The deterministic half auto-archives a note whose only concrete
// path references are all absent from the repo (about deleted code). The LLM half (soft drift) is
// flag-only and added later. Deterministic checks cost 0 tokens.
// See docs/superpowers/specs/2026-07-20-memory-relevance-gardener-design.md.
package memgarden

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/memvault"
)

// refRe matches path-like tokens with a source extension, optionally with a :line suffix (group 1 is
// the path). Conservative on purpose: prose words never match.
var refRe = regexp.MustCompile(`([A-Za-z0-9_./-]+\.(?:go|ts|tsx|js|jsx|rs|py|md|json|sql|css|scss|ya?ml|toml|sh))(?::\d+)?`)

// extractRefs returns the deduped concrete path references in a note body (":line" stripped).
func extractRefs(body string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range refRe.FindAllStringSubmatch(body, -1) {
		p := m[1]
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// allRefsDead reports whether refs is non-empty and every ref is absent from index. A ref with a
// slash is matched as a relative path; a bare filename is matched by basename.
func allRefsDead(refs []string, index map[string]bool) bool {
	if len(refs) == 0 {
		return false
	}
	for _, r := range refs {
		key := filepath.ToSlash(r)
		if index[key] {
			return false
		}
	}
	return true
}

// maxIndexEntries caps the repo index so a pathological tree can't blow up memory.
const maxIndexEntries = 200000

var skipDirs = map[string]bool{".git": true, "node_modules": true, "dist": true, "vendor": true, ".claude": true, "target": true}

// buildRepoIndex walks repoPath and returns the set of present files keyed by both relative slash-path
// and basename. Skips heavy/generated dirs. Empty repoPath -> empty set.
func buildRepoIndex(repoPath string) map[string]bool {
	out := map[string]bool{}
	if repoPath == "" {
		return out
	}
	_ = filepath.WalkDir(repoPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if len(out) >= maxIndexEntries {
			return filepath.SkipAll
		}
		if rel, relErr := filepath.Rel(repoPath, path); relErr == nil {
			out[filepath.ToSlash(rel)] = true
		}
		out[d.Name()] = true
		return nil
	})
	return out
}

const (
	maxLLMChecksPerPass = 20
	maxRefBytes         = 4 * 1024 // per referenced file fed to the drift check
	driftPrompt         = "You are checking whether a project memory note still matches the current code. " +
		"Input: the note, then the current content of files it references. " +
		`Output ONLY JSON: {"drift": bool, "reason": string}. ` +
		"Set drift=true only if the note's advice clearly contradicts the current code (renamed symbol, " +
		"removed flag, changed behavior). If it is still accurate or you are unsure, drift=false."
)

// lastRefCheck gates the drift LLM per note by the mtime fingerprint of its referenced files. In-memory
// (mirrors harvest.go's lastHarvestMtime); a server restart re-checks once. Steady-state: no LLM calls.
var (
	lastRefCheckMu sync.Mutex
	lastRefCheck   = map[string]string{}
)

// parseDriftVerdict extracts {"drift":bool,"reason":string} from an LLM response. Fail-safe: any parse
// problem yields drift=false so a note is never flagged on garbage output.
func parseDriftVerdict(raw string) (bool, string) {
	i := strings.IndexByte(raw, '{')
	j := strings.LastIndexByte(raw, '}')
	if i < 0 || j <= i {
		return false, ""
	}
	var v struct {
		Drift  bool   `json:"drift"`
		Reason string `json:"reason"`
	}
	if json.Unmarshal([]byte(raw[i:j+1]), &v) != nil {
		return false, ""
	}
	return v.Drift, v.Reason
}

// driftCorpus assembles the note + its referenced files' current content for the drift check.
func driftCorpus(noteBody string, refContents map[string]string) string {
	var b strings.Builder
	b.WriteString("=== MEMORY NOTE ===\n")
	b.WriteString(noteBody)
	for ref, content := range refContents {
		fmt.Fprintf(&b, "\n\n=== FILE: %s ===\n%s", ref, content)
	}
	return b.String()
}

// refMtimeFingerprint concatenates ref:mtime for each existing referenced file (a change any of them
// invalidates). Missing files are skipped (their disappearance is the dead-ref pillar's job).
func refMtimeFingerprint(repoPath string, refs []string) string {
	var b strings.Builder
	for _, r := range refs {
		if info, err := os.Stat(filepath.Join(repoPath, filepath.FromSlash(r))); err == nil {
			fmt.Fprintf(&b, "%s:%d;", r, info.ModTime().UnixMilli())
		}
	}
	return b.String()
}

// checkSoftDrift runs the flag-only drift LLM on notes whose referenced files changed, capped per pass.
// Already-flagged and ref-less notes are skipped. repoPath="" (unknown project) -> no-op.
func (g *gardener) checkSoftDrift(repoPath string, notes []memvault.NoteWithBody) {
	if repoPath == "" {
		return
	}
	checks := 0
	for _, n := range notes {
		if n.Note.GardenerFlag != "" {
			continue // already surfaced; don't re-check
		}
		refs := extractRefs(n.Body)
		refContents := map[string]string{}
		for _, r := range refs {
			if data, err := os.ReadFile(filepath.Join(repoPath, filepath.FromSlash(r))); err == nil {
				refContents[r] = truncate(string(data), maxRefBytes)
			}
		}
		if len(refContents) == 0 {
			continue // nothing live to compare against (all-dead is the deterministic pillar's job)
		}
		fp := refMtimeFingerprint(repoPath, refs)
		lastRefCheckMu.Lock()
		unchanged := lastRefCheck[n.Note.Path] == fp
		lastRefCheckMu.Unlock()
		if unchanged {
			continue // mtime gate: referenced files unchanged since last check
		}
		if checks >= maxLLMChecksPerPass {
			continue // spread the rest across later sweeps (fingerprint left stale so it re-runs)
		}
		checks++
		raw, ok := g.llmFn(pickModel(driftCorpus(n.Body, refContents)), driftPrompt, driftCorpus(n.Body, refContents))
		if !ok {
			continue // LLM failure: retain state, retry next sweep
		}
		lastRefCheckMu.Lock()
		lastRefCheck[n.Note.Path] = fp
		lastRefCheckMu.Unlock()
		if drift, _ := parseDriftVerdict(raw); drift {
			if err := g.flagFn(n.Note.Path, "drift"); err != nil {
				log.Printf("[memgarden] flag drift %s: %v\n", n.Note.Path, err)
			}
		}
	}
}

// truncate caps s at n bytes on a rune boundary-safe cut.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
