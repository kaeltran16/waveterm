// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/harness"
)

// Adoption brings a harness's hand-maintained skill directories into the vault. Steering has no
// adoption step any more — FoldIntoShared moves one harness's rules into the shared doc, one
// harness at a time, with the result visible in the editor between steps.

// SkillMove is one harness-local skill tree folded into the vault.
type SkillMove struct {
	Runtime string `json:"runtime"`
	Name    string `json:"name"`
	From    string `json:"from"`
	// Seed marks the copy that becomes the shared tree. Every later copy of the same name becomes a
	// delta against it rather than a refusal.
	Seed bool `json:"seed"`
	// Keys and Files are what this copy overrides: frontmatter keys and sidecar file paths.
	Keys  []string `json:"keys,omitempty"`
	Files []string `json:"files,omitempty"`
	// BodyDiff marks the one case adoption will not decide: two copies whose markdown bodies differ.
	// The copy is left exactly where it is and the name is reported unresolved.
	BodyDiff bool `json:"bodydiff"`
}

type AdoptPlan struct {
	Moves []SkillMove `json:"moves,omitempty"`
	// Unresolved names skills whose copies differ in body text, left in place for a human.
	Unresolved []string `json:"unresolved,omitempty"`
}

// skillTextParts splits a SKILL.md into its frontmatter entries and its body.
func skillTextParts(dir string) (map[string]fmEntry, string, error) {
	data, err := os.ReadFile(filepath.Join(dir, skillFile))
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]fmEntry{}, "", nil
		}
		return nil, "", fmt.Errorf("reading %s: %w", filepath.Join(dir, skillFile), err)
	}
	block, body, _ := splitFrontmatter(string(data))
	entries := map[string]fmEntry{}
	for _, e := range parseFrontmatterEntries(block) {
		entries[e.key] = e
	}
	return entries, body, nil
}

// deltaAgainst compares one harness's copy of a skill against the tree that will be shared. Keys are
// the frontmatter entries whose text differs; files are the sidecars the copy has that the shared
// tree does not match. A differing body is not a delta — the format has nowhere to put one.
func deltaAgainst(sharedDir, copyDir string) (keys []string, files []string, bodyDiff bool, err error) {
	sharedFM, sharedBody, err := skillTextParts(sharedDir)
	if err != nil {
		return nil, nil, false, err
	}
	copyFM, copyBody, err := skillTextParts(copyDir)
	if err != nil {
		return nil, nil, false, err
	}
	for key, e := range copyFM {
		if s, ok := sharedFM[key]; !ok || s.text != e.text {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	bodyDiff = strings.TrimSpace(sharedBody) != strings.TrimSpace(copyBody)

	sharedFiles, err := collectTree(sharedDir, skipDelta)
	if err != nil {
		return nil, nil, false, err
	}
	copyFiles, err := collectTree(copyDir, skipDelta)
	if err != nil {
		return nil, nil, false, err
	}
	for rel, data := range copyFiles {
		if rel == skillFile || rel == managedMarkName {
			continue
		}
		if !bytes.Equal(sharedFiles[rel], data) {
			files = append(files, rel)
		}
	}
	sort.Strings(files)
	return keys, files, bodyDiff, nil
}

func skipDelta(rel string) bool {
	return rel == deltaDirName || strings.HasPrefix(rel, deltaDirName+string(filepath.Separator))
}

// PlanAdopt reports which harness-local skill directories would move into the vault and what each
// contributes. Deterministic: harnesses in catalog order, skills sorted, so the first copy of a name
// seeds the shared tree and later ones become deltas against it.
func PlanAdopt(p Paths) (AdoptPlan, error) {
	plan := AdoptPlan{}
	canonical, err := canonicalSkills(p.SkillsRoot)
	if err != nil {
		return plan, err
	}
	// where the shared tree for a name lives, or will live once this plan is applied
	sharedDir := map[string]string{}
	for _, name := range canonical {
		sharedDir[name] = filepath.Join(p.SkillsRoot, name)
	}
	unresolved := map[string]bool{}
	for _, spec := range harness.List() {
		dir := spec.SkillsPath(p.Home)
		if dir == "" || !configRootExists(spec, p.Home) {
			continue
		}
		observed, err := observeSkills(dir)
		if err != nil {
			return plan, err
		}
		sort.Slice(observed, func(i, j int) bool { return observed[i].Name < observed[j].Name })
		for _, e := range observed {
			if e.Managed {
				continue // already Arc's
			}
			from := filepath.Join(dir, e.Name)
			move := SkillMove{Runtime: spec.Runtime, Name: e.Name, From: from}
			if _, claimed := sharedDir[e.Name]; !claimed {
				move.Seed = true
				sharedDir[e.Name] = from
				plan.Moves = append(plan.Moves, move)
				continue
			}
			move.Keys, move.Files, move.BodyDiff, err = deltaAgainst(sharedDir[e.Name], from)
			if err != nil {
				return plan, err
			}
			if move.BodyDiff {
				unresolved[e.Name] = true
			}
			plan.Moves = append(plan.Moves, move)
		}
	}
	for name := range unresolved {
		plan.Unresolved = append(plan.Unresolved, name)
	}
	sort.Strings(plan.Unresolved)
	return plan, nil
}

// Adopt applies the plan: each seed tree is moved into the vault, each later copy is reduced to a
// delta beside it and removed, and the reconcile then renders every harness from the vault. A skill
// whose copies differ in body text is skipped entirely — nothing is moved and nothing is deleted.
func Adopt(p Paths, apply bool) (AdoptPlan, error) {
	plan, err := PlanAdopt(p)
	if err != nil || !apply {
		return plan, err
	}
	blocked := map[string]bool{}
	for _, n := range plan.Unresolved {
		blocked[n] = true
	}
	if err := os.MkdirAll(p.SkillsRoot, 0o755); err != nil {
		return plan, err
	}
	// seeds first: a delta cannot be written beside a shared tree that is not there yet
	for _, m := range plan.Moves {
		if !m.Seed || blocked[m.Name] {
			continue
		}
		dest := filepath.Join(p.SkillsRoot, m.Name)
		if _, err := os.Stat(dest); err == nil {
			continue // already canonical
		}
		if err := os.Rename(m.From, dest); err != nil {
			return plan, fmt.Errorf("moving %s into the vault: %w", m.From, err)
		}
		// the ownership mark belongs to a rendered copy, never to the canonical tree
		_ = os.Remove(filepath.Join(dest, managedMarkName))
	}
	for _, m := range plan.Moves {
		if m.Seed || blocked[m.Name] {
			continue
		}
		if err := writeDelta(p, m); err != nil {
			return plan, err
		}
		if err := os.RemoveAll(m.From); err != nil {
			return plan, fmt.Errorf("removing the adopted copy %s: %w", m.From, err)
		}
	}
	if _, err := Apply(p, false); err != nil {
		return plan, err
	}
	return plan, nil
}

// writeDelta records one harness's overrides beside the shared skill: differing frontmatter keys as
// a fragment, differing files as a sidecar tree.
func writeDelta(p Paths, m SkillMove) error {
	deltaRoot := filepath.Join(p.SkillsRoot, m.Name, deltaDirName)
	if len(m.Keys) > 0 {
		entries, _, err := skillTextParts(m.From)
		if err != nil {
			return err
		}
		var b strings.Builder
		for _, key := range m.Keys {
			b.WriteString(entries[key].text)
		}
		if err := os.MkdirAll(deltaRoot, 0o755); err != nil {
			return err
		}
		path := filepath.Join(deltaRoot, m.Runtime+".yaml")
		if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
			return fmt.Errorf("writing %s: %w", path, err)
		}
	}
	for _, rel := range m.Files {
		data, err := os.ReadFile(filepath.Join(m.From, rel))
		if err != nil {
			return err
		}
		dest := filepath.Join(deltaRoot, m.Runtime, rel)
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, data, 0o644); err != nil {
			return fmt.Errorf("writing %s: %w", dest, err)
		}
	}
	return nil
}
