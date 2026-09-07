// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/wavetermdev/waveterm/pkg/harness"
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
