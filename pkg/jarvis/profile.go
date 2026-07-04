// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// MetaKey_JarvisProfile stores a channel's per-project ProfileOverride (JSON) on channel meta.
const MetaKey_JarvisProfile = "jarvis:profile"

const globalProfileFileName = "jarvis-profile.json"

// DefaultPrinciples seeds the builtin global profile's judgment text. Stored/resolved only in Piece 3;
// consumed by the classifier + phase prompts in Piece 4.
const DefaultPrinciples = `Prefer simple, direct solutions over enterprise over-engineering.
Apply SOLID, KISS, YAGNI, DRY. Single source of truth for every piece of knowledge.
No premature optimization or abstraction. Handle errors at boundaries; never swallow them.`

// BuiltinProfile is the fallback global profile when no global file exists: the default playbook plus
// the default principles. DefaultPlaybook stays the single source of the default pipeline.
func BuiltinProfile() waveobj.JarvisProfile {
	return waveobj.JarvisProfile{Playbook: DefaultPlaybook(), Principles: DefaultPrinciples}
}

// LoadGlobalProfile reads the global profile file from the config home, falling back to BuiltinProfile
// on a missing or malformed file (logged, never fatal).
func LoadGlobalProfile() waveobj.JarvisProfile {
	path := filepath.Join(wavebase.GetWaveConfigDir(), globalProfileFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("jarvis profile: reading %s: %v (using builtin)", path, err)
		}
		return BuiltinProfile()
	}
	var p waveobj.JarvisProfile
	if err := json.Unmarshal(data, &p); err != nil {
		log.Printf("jarvis profile: malformed %s: %v (using builtin)", path, err)
		return BuiltinProfile()
	}
	return p
}

// ResolveProfile applies a per-project override onto the global profile, section by section: a non-nil
// override section replaces the global's; a nil section inherits. Pure; the single home of the merge rule.
func ResolveProfile(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) waveobj.JarvisProfile {
	out := global
	if override != nil {
		if override.Playbook != nil {
			out.Playbook = *override.Playbook
		}
		if override.Principles != nil {
			out.Principles = *override.Principles
		}
	}
	return out
}

// ResolvePlaybook returns the playbook a new run should use: the resolved profile's playbook, or the
// default playbook when that is empty (a run always has phases).
func ResolvePlaybook(global waveobj.JarvisProfile, override *waveobj.ProfileOverride) []waveobj.RunPhase {
	pb := ResolveProfile(global, override).Playbook
	if len(pb) == 0 {
		return DefaultPlaybook()
	}
	return pb
}

// OverrideFromMeta extracts a channel's ProfileOverride from meta, or nil when absent or malformed (a
// bad blob degrades to pure-global, never a crash). Round-trips through JSON because meta values arrive
// as generic map[string]any after a DB read.
func OverrideFromMeta(ch *waveobj.Channel) *waveobj.ProfileOverride {
	if ch == nil || !ch.Meta.HasKey(MetaKey_JarvisProfile) {
		return nil
	}
	raw, err := json.Marshal(ch.Meta[MetaKey_JarvisProfile])
	if err != nil {
		log.Printf("jarvis profile: marshaling override meta: %v", err)
		return nil
	}
	var ov waveobj.ProfileOverride
	if err := json.Unmarshal(raw, &ov); err != nil {
		log.Printf("jarvis profile: bad override meta, ignoring: %v", err)
		return nil
	}
	return &ov
}
