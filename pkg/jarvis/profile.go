// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const MetaKey_JarvisProfile = "jarvis:profile"

const globalProfileFileName = "jarvis-profile.json"

const (
	DiagnosticMissingReplacement = "missing-replacement"
	DiagnosticMissingDisabled    = "missing-disabled"
)

var DefaultPrinciples = waveobj.PrincipleList{
	{ID: "simple-solutions", Text: "Prefer simple, direct solutions over enterprise over-engineering."},
	{ID: "engineering-principles", Text: "Apply SOLID, KISS, YAGNI, and DRY. Keep a single source of truth."},
	{ID: "measure-first", Text: "Measure before optimizing. Do not abstract for a single implementation."},
	{ID: "boundary-errors", Text: "Handle errors at boundaries and never silently swallow them."},
}

func BuiltinProfile() waveobj.JarvisProfile {
	return waveobj.JarvisProfile{Playbook: DefaultPlaybook(), Principles: clonePrinciples(DefaultPrinciples)}
}

func LoadGlobalProfile() waveobj.JarvisProfile {
	path := filepath.Join(wavebase.GetWaveConfigDir(), globalProfileFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("jarvis profile: reading %s: %v (using builtin)", path, err)
		}
		return BuiltinProfile()
	}
	var profile waveobj.JarvisProfile
	if err := json.Unmarshal(data, &profile); err != nil {
		log.Printf("jarvis profile: malformed %s: %v (using builtin)", path, err)
		return BuiltinProfile()
	}
	if err := ValidateGlobalPrinciples(profile.Principles); err != nil {
		log.Printf("jarvis profile: invalid principles in %s: %v (using builtin)", path, err)
		return BuiltinProfile()
	}
	return profile
}

func ValidateGlobalPrinciples(items waveobj.PrincipleList) error {
	seen := make(map[string]struct{}, len(items))
	for i, item := range items {
		if strings.TrimSpace(item.ID) == "" {
			return fmt.Errorf("principle %d has a blank id", i)
		}
		if strings.TrimSpace(item.Text) == "" {
			return fmt.Errorf("principle %q has blank text", item.ID)
		}
		if _, ok := seen[item.ID]; ok {
			return fmt.Errorf("duplicate principle id %q", item.ID)
		}
		seen[item.ID] = struct{}{}
	}
	return nil
}

func ValidatePrinciplePatch(global waveobj.PrincipleList, patch *waveobj.PrinciplePatch) error {
	if err := ValidateGlobalPrinciples(global); err != nil {
		return fmt.Errorf("invalid global principles: %w", err)
	}
	if patch == nil {
		return nil
	}
	if _, legacy := patch.LegacyReplacement(); legacy {
		return nil
	}
	globalIDs := make(map[string]struct{}, len(global))
	for _, item := range global {
		globalIDs[item.ID] = struct{}{}
	}
	additionIDs := make(map[string]struct{}, len(patch.Additions))
	for i, item := range patch.Additions {
		if strings.TrimSpace(item.ID) == "" {
			return fmt.Errorf("addition %d has a blank id", i)
		}
		if strings.TrimSpace(item.Text) == "" {
			return fmt.Errorf("addition %q has blank text", item.ID)
		}
		if _, ok := globalIDs[item.ID]; ok {
			return fmt.Errorf("addition id %q collides with a global principle", item.ID)
		}
		if _, ok := additionIDs[item.ID]; ok {
			return fmt.Errorf("duplicate addition id %q", item.ID)
		}
		additionIDs[item.ID] = struct{}{}
	}
	for id, text := range patch.Replacements {
		if strings.TrimSpace(id) == "" {
			return fmt.Errorf("replacement has a blank id")
		}
		if strings.TrimSpace(text) == "" {
			return fmt.Errorf("replacement %q has blank text", id)
		}
	}
	for i, id := range patch.Disabled {
		if strings.TrimSpace(id) == "" {
			return fmt.Errorf("disabled principle %d has a blank id", i)
		}
	}
	return nil
}

func NormalizePrinciplePatch(global waveobj.PrincipleList, patch *waveobj.PrinciplePatch) *waveobj.PrinciplePatch {
	if patch == nil {
		return nil
	}
	if legacy, ok := patch.LegacyReplacement(); ok {
		disabled := make([]string, 0, len(global))
		for _, item := range global {
			disabled = append(disabled, item.ID)
		}
		return &waveobj.PrinciplePatch{
			Additions: []waveobj.Principle{{ID: waveobj.LegacyProjectPrincipleID, Text: legacy}},
			Disabled:  disabled,
		}
	}
	return clonePrinciplePatch(patch)
}

func ResolvePrinciples(global waveobj.PrincipleList, patch *waveobj.PrinciplePatch) (waveobj.PrincipleList, []waveobj.PrincipleDiagnostic) {
	if patch == nil {
		return clonePrinciples(global), nil
	}
	if legacy, ok := patch.LegacyReplacement(); ok {
		return waveobj.PrincipleList{{ID: waveobj.LegacyProjectPrincipleID, Text: legacy}}, nil
	}
	if ValidatePrinciplePatch(global, patch) != nil {
		return clonePrinciples(global), nil
	}

	globalIDs := make(map[string]struct{}, len(global))
	for _, item := range global {
		globalIDs[item.ID] = struct{}{}
	}
	diagnostics := make([]waveobj.PrincipleDiagnostic, 0)
	missingReplacementIDs := make([]string, 0)
	for id := range patch.Replacements {
		if _, ok := globalIDs[id]; !ok {
			missingReplacementIDs = append(missingReplacementIDs, id)
		}
	}
	sort.Strings(missingReplacementIDs)
	for _, id := range missingReplacementIDs {
		diagnostics = append(diagnostics, waveobj.PrincipleDiagnostic{Code: DiagnosticMissingReplacement, PrincipleID: id})
	}
	disabled := make(map[string]struct{}, len(patch.Disabled))
	for _, id := range patch.Disabled {
		if _, ok := globalIDs[id]; !ok {
			diagnostics = append(diagnostics, waveobj.PrincipleDiagnostic{Code: DiagnosticMissingDisabled, PrincipleID: id})
			continue
		}
		disabled[id] = struct{}{}
	}

	resolved := make(waveobj.PrincipleList, 0, len(global)+len(patch.Additions))
	for _, item := range global {
		if _, ok := disabled[item.ID]; ok {
			continue
		}
		if replacement, ok := patch.Replacements[item.ID]; ok {
			item.Text = replacement
		}
		resolved = append(resolved, item)
	}
	resolved = append(resolved, patch.Additions...)
	return resolved, diagnostics
}

func ResolveProfileWithDiagnostics(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) (waveobj.JarvisProfile, []waveobj.PrincipleDiagnostic) {
	out := global
	var patch *waveobj.PrinciplePatch
	if override != nil {
		patch = override.Principles
		if override.Playbook != nil {
			out.Playbook = *override.Playbook
		}
		if override.DefaultMode != nil {
			out.DefaultMode = *override.DefaultMode
		}
		if override.DefaultPlanGate != nil {
			out.DefaultPlanGate = override.DefaultPlanGate
		}
	}
	principles, diagnostics := ResolvePrinciples(global.Principles, patch)
	out.Principles = principles
	return out, diagnostics
}

func ResolveProfile(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) waveobj.JarvisProfile {
	resolved, _ := ResolveProfileWithDiagnostics(global, override)
	return resolved
}

func RenderPrinciples(items waveobj.PrincipleList) string {
	if len(items) == 0 {
		return ""
	}
	if len(items) == 1 && (items[0].ID == waveobj.LegacyGlobalPrincipleID || items[0].ID == waveobj.LegacyProjectPrincipleID) {
		return items[0].Text
	}
	lines := make([]string, 0, len(items))
	for _, item := range items {
		lines = append(lines, "- "+item.Text)
	}
	return strings.Join(lines, "\n")
}

func ResolvePlaybook(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) []waveobj.RunPhase {
	playbook := ResolveProfile(global, override).Playbook
	if len(playbook) == 0 {
		return DefaultPlaybook()
	}
	return playbook
}

func OverrideFromMeta(ch *waveobj.Channel) *waveobj.ProfileOverride {
	if ch == nil || !ch.Meta.HasKey(MetaKey_JarvisProfile) {
		return nil
	}
	raw, err := json.Marshal(ch.Meta[MetaKey_JarvisProfile])
	if err != nil {
		log.Printf("jarvis profile: marshaling override meta: %v", err)
		return nil
	}
	var override waveobj.ProfileOverride
	if err := json.Unmarshal(raw, &override); err != nil {
		log.Printf("jarvis profile: bad override meta, ignoring: %v", err)
		return nil
	}
	return &override
}

func clonePrinciples(items waveobj.PrincipleList) waveobj.PrincipleList {
	return append(waveobj.PrincipleList(nil), items...)
}

func clonePrinciplePatch(patch *waveobj.PrinciplePatch) *waveobj.PrinciplePatch {
	if patch == nil {
		return nil
	}
	out := &waveobj.PrinciplePatch{
		Additions: append([]waveobj.Principle(nil), patch.Additions...),
		Disabled:  append([]string(nil), patch.Disabled...),
	}
	if patch.Replacements != nil {
		out.Replacements = make(map[string]string, len(patch.Replacements))
		for id, text := range patch.Replacements {
			out.Replacements[id] = text
		}
	}
	return out
}
