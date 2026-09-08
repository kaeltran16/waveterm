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
	ActionSteeringWrite = "steering-write"
	ActionLinkCreate    = "link-create"
	ActionLinkRetarget  = "link-retarget"
	ActionLinkRemove    = "link-remove"
	ActionSkillConflict = "skill-conflict"
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

// Projection is what one harness's steering file currently holds, for the read-only preview beside
// the canonical editor. Body is what is on disk, not what the canonical doc would render — the
// difference is exactly what "stale" means.
type Projection struct {
	Runtime string `json:"runtime"`
	Path    string `json:"path"`
	Present bool   `json:"present"`
	State   string `json:"state"` // current | stale | absent
	Body    string `json:"body"`
}

// ProjectionFor reads one harness's steering file. State mirrors Status so the preview and the
// harness rows can never disagree.
func ProjectionFor(p Paths, runtime string) (Projection, error) {
	spec, ok := harness.Lookup(runtime)
	if !ok {
		return Projection{}, fmt.Errorf("unknown harness runtime %q", runtime)
	}
	proj := Projection{Runtime: runtime, Path: spec.SteeringPath(p.Home), State: "absent"}
	proj.Present = configRootExists(spec, p.Home)
	if !proj.Present {
		return proj, nil
	}
	existing, err := os.ReadFile(proj.Path)
	if err != nil && !os.IsNotExist(err) {
		return proj, fmt.Errorf("reading %s: %w", proj.Path, err)
	}
	proj.Body = regionBody(string(existing))
	canonical, err := os.ReadFile(p.SteeringDoc)
	if err != nil && !os.IsNotExist(err) {
		return proj, fmt.Errorf("reading canonical steering doc: %w", err)
	}
	if !strings.Contains(string(existing), steeringBegin) || len(canonical) == 0 {
		return proj, nil
	}
	if applyRegion(string(existing), string(canonical)) == string(existing) {
		proj.State = "current"
	} else {
		proj.State = "stale"
	}
	return proj, nil
}
