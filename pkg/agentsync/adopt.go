// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsync

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/harness"
)

// CarriedLine is a line a harness holds that the canonical document does not. Adoption refuses to
// apply while any exists, because seeding from one harness would otherwise delete another's rules.
type CarriedLine struct {
	Runtime string `json:"runtime"`
	Line    string `json:"line"`
}

// SkillMove relocates one harness-local skill tree into the vault.
type SkillMove struct {
	Runtime string `json:"runtime"`
	Name    string `json:"name"`
	From    string `json:"from"`
}

// SkillCollision is one skill name held by more than one harness. Never merged automatically.
type SkillCollision struct {
	Name    string   `json:"name"`
	Sources []string `json:"sources"`
}

type AdoptPlan struct {
	SeedFrom   string           `json:"seedfrom"`
	SeedLines  int              `json:"seedlines"`
	Carried    []CarriedLine    `json:"carried"`
	Moves      []SkillMove      `json:"moves"`
	Collisions []SkillCollision `json:"collisions"`
	Blocked    bool             `json:"blocked"`
	Reasons    []string         `json:"reasons,omitempty"`
}

// carriedLines returns block's lines that are absent from canonical, compared as a trimmed set so
// reordering and whitespace never register as a loss.
func carriedLines(block, canonical string) []string {
	have := map[string]bool{}
	for _, l := range strings.Split(canonical, "\n") {
		have[strings.TrimSpace(l)] = true
	}
	seen := map[string]bool{}
	var out []string
	for _, l := range strings.Split(block, "\n") {
		t := strings.TrimSpace(l)
		if t == "" || have[t] || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

// collisions reports every skill name claimed by more than one harness, sorted for stable output.
func collisions(inventory map[string][]SkillMove) []SkillCollision {
	holders := map[string][]string{}
	for _, moves := range inventory {
		for _, m := range moves {
			holders[m.Name] = append(holders[m.Name], m.Runtime+":"+m.From)
		}
	}
	var out []SkillCollision
	for name, sources := range holders {
		if len(sources) < 2 {
			continue
		}
		sort.Strings(sources)
		out = append(out, SkillCollision{Name: name, Sources: sources})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// seedRuntime is the harness whose steering file seeds the canonical document when the vault has
// none. Claude by decision: it is where the user authors these rules today.
const seedRuntime = "claude"

// PlanAdopt reports what adoption would do, including everything that would block it.
func PlanAdopt(p Paths) (AdoptPlan, error) {
	plan := AdoptPlan{}
	canonical, err := os.ReadFile(p.SteeringDoc)
	if err != nil && !os.IsNotExist(err) {
		return plan, err
	}
	if len(canonical) == 0 {
		spec, ok := harness.Lookup(seedRuntime)
		if !ok {
			return plan, fmt.Errorf("seed harness %q missing from the catalog", seedRuntime)
		}
		seed, readErr := os.ReadFile(spec.SteeringPath(p.Home))
		if readErr != nil {
			return plan, fmt.Errorf("no canonical doc and no %s steering file to seed from: %w", seedRuntime, readErr)
		}
		canonical = []byte(blockBefore(string(seed)))
		plan.SeedFrom = spec.SteeringPath(p.Home)
	}
	plan.SeedLines = len(strings.Split(strings.TrimRight(string(canonical), "\n"), "\n"))

	inventory := map[string][]SkillMove{}
	for _, spec := range harness.List() {
		if !configRootExists(spec, p.Home) {
			continue
		}
		existing, _ := os.ReadFile(spec.SteeringPath(p.Home))
		for _, line := range carriedLines(blockBefore(string(existing)), string(canonical)) {
			plan.Carried = append(plan.Carried, CarriedLine{Runtime: spec.Runtime, Line: line})
		}
		dir := spec.SkillsPath(p.Home)
		if dir == "" {
			continue
		}
		observed, err := observeSkills(dir)
		if err != nil {
			return plan, err
		}
		for _, e := range observed {
			if e.IsLink {
				continue // already managed, or someone else's
			}
			inventory[spec.Runtime] = append(inventory[spec.Runtime], SkillMove{Runtime: spec.Runtime, Name: e.Name, From: filepath.Join(dir, e.Name)})
		}
	}
	plan.Collisions = collisions(inventory)
	for _, moves := range inventory {
		plan.Moves = append(plan.Moves, moves...)
	}
	sort.Slice(plan.Moves, func(i, j int) bool {
		if plan.Moves[i].Name != plan.Moves[j].Name {
			return plan.Moves[i].Name < plan.Moves[j].Name
		}
		return plan.Moves[i].Runtime < plan.Moves[j].Runtime
	})
	return plan, nil
}

// Adopt migrates hand-maintained steering blocks and skills into the vault. It refuses rather than
// guess: a rule only one harness holds, or a skill name two harnesses claim, must be resolved first.
func Adopt(p Paths, apply bool, prefer map[string]string, acceptLoss bool) (AdoptPlan, error) {
	plan, err := PlanAdopt(p)
	if err != nil {
		return plan, err
	}
	unresolved := plan.Collisions[:0:0]
	for _, c := range plan.Collisions {
		if prefer[c.Name] == "" {
			unresolved = append(unresolved, c)
		}
	}
	if len(plan.Carried) > 0 && !acceptLoss {
		plan.Blocked = true
		plan.Reasons = append(plan.Reasons, fmt.Sprintf("%d line(s) exist only in a harness copy; fold them into the canonical doc or pass accept-loss", len(plan.Carried)))
	}
	if len(unresolved) > 0 {
		plan.Blocked = true
		for _, c := range unresolved {
			plan.Reasons = append(plan.Reasons, fmt.Sprintf("skill %q is held by %d harnesses; choose one with prefer", c.Name, len(c.Sources)))
		}
	}
	if !apply || plan.Blocked {
		if apply && plan.Blocked {
			return plan, fmt.Errorf("adoption blocked: %s", strings.Join(plan.Reasons, "; "))
		}
		return plan, nil
	}

	if plan.SeedFrom != "" {
		seed, err := os.ReadFile(plan.SeedFrom)
		if err != nil {
			return plan, err
		}
		if err := os.MkdirAll(filepath.Dir(p.SteeringDoc), 0o755); err != nil {
			return plan, err
		}
		if err := os.WriteFile(p.SteeringDoc, []byte(blockBefore(string(seed))), 0o644); err != nil {
			return plan, err
		}
	}
	canonical, err := os.ReadFile(p.SteeringDoc)
	if err != nil {
		return plan, err
	}
	for _, spec := range harness.List() {
		if !configRootExists(spec, p.Home) {
			continue
		}
		target := spec.SteeringPath(p.Home)
		existing, readErr := os.ReadFile(target)
		if readErr != nil && !os.IsNotExist(readErr) {
			return plan, readErr
		}
		if len(existing) > 0 {
			if err := os.WriteFile(target+".bak", existing, 0o644); err != nil {
				return plan, fmt.Errorf("backing up %s: %w", target, err)
			}
		}
		stripped := strings.TrimPrefix(string(existing), blockBefore(string(existing)))
		if err := os.WriteFile(target, []byte(applyRegion(stripped, string(canonical))), 0o644); err != nil {
			return plan, err
		}
	}

	if err := os.MkdirAll(p.SkillsRoot, 0o755); err != nil {
		return plan, err
	}
	for _, m := range plan.Moves {
		if winner, ok := prefer[m.Name]; ok && winner != m.Runtime {
			continue // a losing copy stays where it is; the reconciler reports it as a conflict
		}
		dest := filepath.Join(p.SkillsRoot, m.Name)
		if _, err := os.Stat(dest); err == nil {
			continue // already canonical
		}
		if err := os.Rename(m.From, dest); err != nil {
			return plan, fmt.Errorf("moving %s into the vault: %w", m.From, err)
		}
	}
	for _, m := range plan.Moves {
		if winner, ok := prefer[m.Name]; ok && winner != m.Runtime {
			if err := os.RemoveAll(m.From); err != nil {
				return plan, fmt.Errorf("removing the losing copy %s: %w", m.From, err)
			}
		}
	}
	if _, err := Apply(p, false); err != nil {
		return plan, err
	}
	return plan, nil
}
