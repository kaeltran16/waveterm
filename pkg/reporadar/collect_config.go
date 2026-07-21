// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"
	"path"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// collectConfig emits factual signals about migration pairing. It records "migration X has no
// paired down file" as a fact; it does NOT claim a deploy will fail (that is a later hypothesis).
func collectConfig(ctx context.Context, in collectInput) ([]waveobj.RadarSignal, error) {
	out, err := git(ctx, in.projectPath, "ls-files", "-z")
	if err != nil {
		return nil, fmt.Errorf("git ls-files: %w", err)
	}
	var migrations []string
	var configFiles []string
	for _, f := range strings.Split(out, "\x00") {
		f = strings.TrimSpace(strings.ReplaceAll(f, "\\", "/"))
		if f == "" || isIgnored(f) {
			continue
		}
		if strings.Contains(f, "migration") && strings.HasSuffix(f, ".sql") {
			migrations = append(migrations, f)
		}
		if isConfigFile(f) {
			configFiles = append(configFiles, f)
		}
	}
	downSet := map[string]bool{}
	for _, m := range migrations {
		if strings.HasSuffix(m, ".down.sql") {
			downSet[migrationStem(m)] = true
		}
	}
	var sigs []waveobj.RadarSignal
	for _, m := range migrations {
		if !strings.HasSuffix(m, ".up.sql") {
			continue
		}
		if downSet[migrationStem(m)] {
			continue
		}
		summary := fmt.Sprintf("migration %s has no paired down file", m)
		sigs = append(sigs, newSignal(CollectorConfig, "migration-unpaired:"+m, in.sinceTs, []string{m}, summary, map[string]any{"migration": m}, ""))
	}
	sigs = append(sigs, configSecuritySignals(in, configFiles)...)
	return sigs, nil
}

func migrationStem(p string) string {
	base := path.Base(p)
	base = strings.TrimSuffix(base, ".up.sql")
	base = strings.TrimSuffix(base, ".down.sql")
	return path.Dir(p) + "/" + base
}

// isConfigFile reports whether a path is a config file the security scan should read for
// misconfiguration facts. JSON is included only when clearly a config file (excludes package manifests).
func isConfigFile(f string) bool {
	switch strings.ToLower(path.Ext(f)) {
	case ".yaml", ".yml", ".toml", ".ini", ".conf":
		return true
	case ".json":
		base := path.Base(f)
		return base != "package.json" && base != "package-lock.json" && strings.Contains(strings.ToLower(f), "config")
	}
	return false
}

// configSecuritySignals emits a fact (never a raw line) for each deterministic misconfiguration marker
// found in the given config files. Reads are bounded; no snippet is attached, so no secret is persisted.
func configSecuritySignals(in collectInput, files []string) []waveobj.RadarSignal {
	var sigs []waveobj.RadarSignal
	for _, f := range files {
		content, ok := readBoundedFile(in.projectPath, f)
		if !ok {
			continue
		}
		low := strings.ToLower(content)
		if configHasPermissiveCORS(low) {
			summary := fmt.Sprintf("config %s allows any CORS origin (wildcard)", f)
			facts := map[string]any{"classes": []string{ClassConfigSecurity}, "issue": "permissive-cors"}
			sigs = append(sigs, newSignal(CollectorConfig, "config-security:permissive-cors:"+f, in.sinceTs, []string{f}, summary, facts, ""))
		}
		if configHasDisabledAuth(low) {
			summary := fmt.Sprintf("config %s appears to disable authentication", f)
			facts := map[string]any{"classes": []string{ClassConfigSecurity}, "issue": "disabled-auth"}
			sigs = append(sigs, newSignal(CollectorConfig, "config-security:disabled-auth:"+f, in.sinceTs, []string{f}, summary, facts, ""))
		}
	}
	return sigs
}

func configHasPermissiveCORS(low string) bool {
	if !strings.Contains(low, "cors") && !strings.Contains(low, "allow-origin") {
		return false
	}
	for _, pat := range []string{"origin: *", "origin: \"*\"", "origin: '*'", "origin:*", "allow-origin: *", "allow-origin:*"} {
		if strings.Contains(low, pat) {
			return true
		}
	}
	return false
}

func configHasDisabledAuth(low string) bool {
	for _, pat := range []string{"auth_enabled: false", "auth: false", "require_auth: false", "authentication: false", "auth_required: false", "disable_auth: true", "authentication: none", "auth: none"} {
		if strings.Contains(low, pat) {
			return true
		}
	}
	return false
}
