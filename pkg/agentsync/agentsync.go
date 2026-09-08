// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/memroots"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
)

// Paths are the locations one sync run reads and writes. Passed explicitly rather than read from
// globals so tests drive a temp home without stubbing package state.
type Paths struct {
	Home        string
	SteeringDoc string
	SkillsRoot  string
}

func DefaultPaths() Paths {
	return Paths{
		Home:        wavebase.GetHomeDir(),
		SteeringDoc: memroots.SteeringDocPath(),
		SkillsRoot:  memroots.SkillsRoot(),
	}
}

const (
	ActionSteeringWrite  = "steering-write"
	ActionSkillWrite     = "skill-write"
	ActionSkillRemove    = "skill-remove"
	ActionSkillUnmanaged = "skill-unmanaged"
)

// Action is one change a sync run made, or would make under dryRun.
type Action struct {
	Kind    string `json:"kind"`
	Runtime string `json:"runtime"`
	Path    string `json:"path"`
	Detail  string `json:"detail,omitempty"`
}

// configRootExists gates every write: Arc syncs a harness only once the user has actually run it.
func configRootExists(spec harness.Spec, home string) bool {
	root := spec.ConfigRoot(home)
	if root == "" {
		return false
	}
	st, err := os.Stat(root)
	return err == nil && st.IsDir()
}

// projectSteering writes the canonical body into each present harness's steering region. A render
// identical to what is already on disk is not written, so mtimes stay meaningful for status.
func projectSteering(p Paths, dryRun bool) ([]Action, error) {
	body, err := os.ReadFile(p.SteeringDoc)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil // nothing canonical yet; adoption seeds it
		}
		return nil, fmt.Errorf("reading canonical steering doc: %w", err)
	}
	var actions []Action
	for _, spec := range harness.List() {
		if !configRootExists(spec, p.Home) {
			continue
		}
		target := spec.SteeringPath(p.Home)
		existing, readErr := os.ReadFile(target)
		if readErr != nil && !os.IsNotExist(readErr) {
			return actions, fmt.Errorf("reading %s: %w", target, readErr)
		}
		next := applyRegion(string(existing), string(body))
		if next == string(existing) {
			continue
		}
		actions = append(actions, Action{Kind: ActionSteeringWrite, Runtime: spec.Runtime, Path: target})
		if dryRun {
			continue
		}
		if err := os.WriteFile(target, []byte(next), 0o644); err != nil {
			return actions, fmt.Errorf("writing %s: %w", target, err)
		}
	}
	return actions, nil
}

// WriteResult mirrors memvault.WriteResult: a conflict means the file changed under the editor and
// nothing was written.
type WriteResult struct {
	Mtime    int64
	Conflict bool
}

// WriteSteering replaces the canonical document, refusing when it changed since baseMtime. A
// baseMtime of 0 means "the caller has not read it yet" and skips the check.
func WriteSteering(p Paths, content string, baseMtime int64) (WriteResult, error) {
	if st, err := os.Stat(p.SteeringDoc); err == nil && baseMtime != 0 && st.ModTime().UnixMilli() != baseMtime {
		return WriteResult{Mtime: st.ModTime().UnixMilli(), Conflict: true}, nil
	}
	if err := os.MkdirAll(filepath.Dir(p.SteeringDoc), 0o755); err != nil {
		return WriteResult{}, err
	}
	if err := os.WriteFile(p.SteeringDoc, []byte(content), 0o644); err != nil {
		return WriteResult{}, err
	}
	st, err := os.Stat(p.SteeringDoc)
	if err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Mtime: st.ModTime().UnixMilli()}, nil
}

// HarnessDoc is one harness's steering file split into the three zones the Steering tab shows: the
// rules that harness holds of its own, the shared block Arc projects into it, and the memory
// projection. Own is the only editable zone here — Shared is edited once in the vault, and Memory
// belongs to pkg/memvault.
type HarnessDoc struct {
	Runtime string `json:"runtime"`
	Path    string `json:"path"`
	Present bool   `json:"present"`
	Own     string `json:"own"`
	Shared  string `json:"shared"`
	Memory  string `json:"memory"`
	State   string `json:"state"` // current | stale | absent
	Mtime   int64  `json:"mtime"`
	// Carried counts the lines in Own that the shared doc does not have — what a fold would move.
	Carried int `json:"carried"`
}

// ReadHarness reads one harness's steering file whole. Unlike a region-only read, an unsynced
// harness still shows everything the user wrote in it.
func ReadHarness(p Paths, runtime string) (HarnessDoc, error) {
	spec, ok := harness.Lookup(runtime)
	if !ok {
		return HarnessDoc{}, fmt.Errorf("unknown harness runtime %q", runtime)
	}
	doc := HarnessDoc{Runtime: runtime, Path: spec.SteeringPath(p.Home), State: "absent"}
	doc.Present = configRootExists(spec, p.Home)
	if !doc.Present {
		return doc, nil
	}
	existing, err := os.ReadFile(doc.Path)
	if err != nil && !os.IsNotExist(err) {
		return doc, fmt.Errorf("reading %s: %w", doc.Path, err)
	}
	if st, statErr := os.Stat(doc.Path); statErr == nil {
		doc.Mtime = st.ModTime().UnixMilli()
	}
	shared, err := os.ReadFile(p.SteeringDoc)
	if err != nil && !os.IsNotExist(err) {
		return doc, fmt.Errorf("reading the shared steering doc: %w", err)
	}
	doc.Own = blockBefore(string(existing))
	doc.Shared = regionBody(string(existing))
	doc.Memory = memoryRegion(string(existing))
	doc.State = steeringState(string(existing), string(shared))
	doc.Carried = len(carriedLines(doc.Own, string(shared)))
	return doc, nil
}

// WriteHarnessOwn replaces a harness's own block, leaving every managed region byte-identical: an
// edit to one harness must not re-render the steering region (that is the sync's job) or disturb the
// memory region (that is pkg/memvault's). Same mtime guard as WriteSteering.
func WriteHarnessOwn(p Paths, runtime, own string, baseMtime int64) (WriteResult, error) {
	spec, ok := harness.Lookup(runtime)
	if !ok {
		return WriteResult{}, fmt.Errorf("unknown harness runtime %q", runtime)
	}
	if !configRootExists(spec, p.Home) {
		return WriteResult{}, fmt.Errorf("%s has no config directory; Arc never creates one", spec.Label)
	}
	target := spec.SteeringPath(p.Home)
	existing, err := os.ReadFile(target)
	if err != nil && !os.IsNotExist(err) {
		return WriteResult{}, fmt.Errorf("reading %s: %w", target, err)
	}
	if st, statErr := os.Stat(target); statErr == nil && baseMtime != 0 && st.ModTime().UnixMilli() != baseMtime {
		return WriteResult{Mtime: st.ModTime().UnixMilli(), Conflict: true}, nil
	}
	tail := strings.TrimPrefix(string(existing), blockBefore(string(existing)))
	if err := os.WriteFile(target, []byte(joinOwn(own, tail)), 0o644); err != nil {
		return WriteResult{}, fmt.Errorf("writing %s: %w", target, err)
	}
	st, err := os.Stat(target)
	if err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Mtime: st.ModTime().UnixMilli()}, nil
}

// FoldResult is what one fold moved into the shared doc.
type FoldResult struct {
	Runtime string   `json:"runtime"`
	Lines   []string `json:"lines"`
	Seeded  bool     `json:"seeded"` // the shared doc was empty and took this harness's block verbatim
}

// FoldIntoShared moves a harness's own rules into the shared doc and clears them from the harness
// file. This is the migration, run once per harness: the first fold seeds the shared doc verbatim,
// each later one appends only the lines that harness holds and the doc does not, under a heading
// naming where they came from so they can be re-filed in the editor.
//
// Order matters. The shared doc is written and projected into every harness BEFORE the source
// harness's own block is cleared, so no rule is ever absent from the file it was serving.
func FoldIntoShared(p Paths, runtime string) (FoldResult, error) {
	doc, err := ReadHarness(p, runtime)
	if err != nil {
		return FoldResult{}, err
	}
	res := FoldResult{Runtime: runtime}
	if !doc.Present {
		return res, fmt.Errorf("harness %q is not installed", runtime)
	}
	sharedBytes, err := os.ReadFile(p.SteeringDoc)
	if err != nil && !os.IsNotExist(err) {
		return res, fmt.Errorf("reading the shared steering doc: %w", err)
	}
	shared := string(sharedBytes)
	if strings.TrimSpace(doc.Own) != "" {
		spec, _ := harness.Lookup(runtime)
		res.Lines = carriedLines(doc.Own, shared)
		switch {
		case strings.TrimSpace(shared) == "":
			// verbatim, not line-by-line: an empty doc should inherit the block's headings and
			// spacing rather than a flattened list of its non-blank lines
			shared = strings.TrimRight(doc.Own, "\n") + "\n"
			res.Seeded = true
		case len(res.Lines) > 0:
			shared = strings.TrimRight(shared, "\n") + "\n\n## From " + spec.Label + "\n\n" +
				strings.Join(res.Lines, "\n") + "\n"
		}
		if _, err := WriteSteering(p, shared, 0); err != nil {
			return res, err
		}
	}
	if _, err := projectSteering(p, false); err != nil {
		return res, err
	}
	if _, err := WriteHarnessOwn(p, runtime, "", 0); err != nil {
		return res, err
	}
	return res, nil
}
