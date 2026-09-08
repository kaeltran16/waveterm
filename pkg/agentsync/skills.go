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
	"gopkg.in/yaml.v3"
)

// ObservedEntry is one entry in a harness's skills directory as it exists on disk.
type ObservedEntry struct {
	Name   string
	IsLink bool
	Target string // resolved link target; empty when the entry is not a link
}

// SkillAction is one reconcile step for a single skill name.
type SkillAction struct {
	Kind string // create | retarget | remove | conflict
	Name string
}

// planSkills reconciles one harness's skills directory against the canonical set. A real directory
// is reported as a conflict and never touched — adoption resolves those. A link that points outside
// the vault belongs to someone else (a plugin manager, the user) and is left alone entirely.
// Order is stable: canonical order first, then orphan removals in observed order.
func planSkills(canonical []string, observed []ObservedEntry, skillsRoot string) []SkillAction {
	byName := make(map[string]ObservedEntry, len(observed))
	for _, e := range observed {
		byName[e.Name] = e
	}
	wanted := make(map[string]bool, len(canonical))
	var out []SkillAction
	for _, name := range canonical {
		wanted[name] = true
		e, present := byName[name]
		switch {
		case !present:
			out = append(out, SkillAction{Kind: "create", Name: name})
		case !e.IsLink:
			out = append(out, SkillAction{Kind: "conflict", Name: name})
		case !sameTarget(e.Target, filepath.Join(skillsRoot, name)):
			out = append(out, SkillAction{Kind: "retarget", Name: name})
		}
	}
	for _, e := range observed {
		if wanted[e.Name] || !e.IsLink {
			continue
		}
		if withinRoot(e.Target, skillsRoot) {
			out = append(out, SkillAction{Kind: "remove", Name: e.Name})
		}
	}
	return out
}

// canonicalSkills lists the vault's skill directories, sorted for a deterministic plan.
func canonicalSkills(skillsRoot string) ([]string, error) {
	entries, err := os.ReadDir(skillsRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading canonical skills: %w", err)
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

// observeSkills reads a harness's skills directory without following links.
func observeSkills(dir string) ([]ObservedEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("reading %s: %w", dir, err)
	}
	out := make([]ObservedEntry, 0, len(entries))
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		entry := ObservedEntry{Name: e.Name(), IsLink: isLink(path)}
		if entry.IsLink {
			target, err := linkTarget(path)
			if err != nil {
				// an unreadable link is treated as foreign and left alone
				continue
			}
			entry.Target = target
		}
		out = append(out, entry)
	}
	return out, nil
}

// reconcileSkills junctions every canonical skill into each present harness that scans a fixed
// skills directory. The skills directory itself is created when missing: that is Arc's own target,
// unlike the harness config root, which Arc never creates.
func reconcileSkills(p Paths, dryRun bool) ([]Action, error) {
	canonical, err := canonicalSkills(p.SkillsRoot)
	if err != nil {
		return nil, err
	}
	var actions []Action
	for _, spec := range harness.List() {
		dir := spec.SkillsPath(p.Home)
		if dir == "" || !configRootExists(spec, p.Home) {
			continue
		}
		observed, err := observeSkills(dir)
		if err != nil {
			return actions, err
		}
		for _, a := range planSkills(canonical, observed, p.SkillsRoot) {
			link := filepath.Join(dir, a.Name)
			if a.Kind == "conflict" {
				actions = append(actions, Action{Kind: ActionSkillConflict, Runtime: spec.Runtime, Path: link, Detail: "real directory; run adopt"})
				continue
			}
			actions = append(actions, Action{Kind: actionKindFor(a.Kind), Runtime: spec.Runtime, Path: link})
			if dryRun {
				continue
			}
			if err := applySkillAction(a.Kind, dir, link, filepath.Join(p.SkillsRoot, a.Name)); err != nil {
				return actions, err
			}
		}
	}
	return actions, nil
}

func actionKindFor(kind string) string {
	switch kind {
	case "create":
		return ActionLinkCreate
	case "retarget":
		return ActionLinkRetarget
	default:
		return ActionLinkRemove
	}
}

func applySkillAction(kind, dir, link, target string) error {
	switch kind {
	case "create":
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("creating %s: %w", dir, err)
		}
		return createLink(link, target)
	case "retarget":
		if err := removeLink(link); err != nil {
			return err
		}
		return createLink(link, target)
	case "remove":
		return removeLink(link)
	}
	return nil
}

// Apply runs both projections. Steering first: a harness that starts mid-sync should see the rules
// before it sees new skills.
func Apply(p Paths, dryRun bool) ([]Action, error) {
	actions, err := projectSteering(p, dryRun)
	if err != nil {
		return actions, err
	}
	skillActions, err := reconcileSkills(p, dryRun)
	return append(actions, skillActions...), err
}

// SkillRow is one canonical skill and how each harness currently sees it. The states are read-only:
// this is the Vault surface's skills matrix, not a reconcile.
type SkillRow struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	// States maps runtime -> linked | pending | conflict | absent. A harness with no fixed skills
	// directory (pi) never appears: it reads an explicit list of paths from its own settings.
	States map[string]string `json:"states"`
}

// skillFrontmatter is the SKILL.md header. Only the description is read; name comes from the
// directory, which is what every harness actually keys on.
type skillFrontmatter struct {
	Description string `yaml:"description"`
}

// skillDescription reads a skill's one-line description. A skill directory without a readable
// SKILL.md is still a skill — the row renders with an empty description rather than failing the read.
func skillDescription(skillsRoot, name string) string {
	data, err := os.ReadFile(filepath.Join(skillsRoot, name, "SKILL.md"))
	if err != nil || !bytes.HasPrefix(data, []byte("---\n")) {
		return ""
	}
	end := bytes.Index(data[4:], []byte("\n---"))
	if end < 0 {
		return ""
	}
	var fm skillFrontmatter
	if yaml.Unmarshal(data[4:4+end], &fm) != nil {
		return ""
	}
	return strings.TrimSpace(fm.Description)
}

// skillStateFor turns one planned action into the state the matrix shows. No action for a canonical
// name means the link is already in place.
func skillStateFor(kind string) string {
	switch kind {
	case "conflict":
		return "conflict"
	case "create", "retarget":
		return "pending"
	default:
		return "linked"
	}
}

// SkillColumn is one harness that scans a fixed skills directory — a column of the skills matrix.
// A harness without one (pi) never appears: it reads an explicit list of paths from its settings.
type SkillColumn struct {
	Runtime string `json:"runtime"`
	Label   string `json:"label"`
	Present bool   `json:"present"`
}

// SkillColumns lists the harnesses the skills matrix has a column for.
func SkillColumns(p Paths) []SkillColumn {
	var out []SkillColumn
	for _, spec := range harness.List() {
		if spec.SkillsPath(p.Home) == "" {
			continue
		}
		out = append(out, SkillColumn{Runtime: spec.Runtime, Label: spec.Label, Present: configRootExists(spec, p.Home)})
	}
	return out
}

// SkillRows reports every canonical skill against every harness that scans a fixed skills directory,
// reusing the same plan the reconcile runs so the matrix cannot drift from what a sync would do.
func SkillRows(p Paths) ([]SkillRow, error) {
	canonical, err := canonicalSkills(p.SkillsRoot)
	if err != nil {
		return nil, err
	}
	rows := make([]SkillRow, 0, len(canonical))
	for _, name := range canonical {
		rows = append(rows, SkillRow{
			Name:        name,
			Description: skillDescription(p.SkillsRoot, name),
			States:      map[string]string{},
		})
	}
	for _, spec := range harness.List() {
		dir := spec.SkillsPath(p.Home)
		if dir == "" {
			continue
		}
		if !configRootExists(spec, p.Home) {
			for i := range rows {
				rows[i].States[spec.Runtime] = "absent"
			}
			continue
		}
		observed, err := observeSkills(dir)
		if err != nil {
			return nil, err
		}
		planned := map[string]string{}
		for _, a := range planSkills(canonical, observed, p.SkillsRoot) {
			planned[a.Name] = a.Kind
		}
		for i := range rows {
			rows[i].States[spec.Runtime] = skillStateFor(planned[rows[i].Name])
		}
	}
	return rows, nil
}
