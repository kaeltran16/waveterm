// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// collectDependency emits a floating-pin fact for each security-relevant package.json dependency. It
// reads tracked package.json files offline and parses them with stdlib JSON — no registry, no network,
// no CVE lookup. go.mod is pinned by design (no floating pins); Cargo.toml and staleness are deferred.
func collectDependency(ctx context.Context, in collectInput) ([]waveobj.RadarSignal, error) {
	out, err := git(ctx, in.projectPath, "ls-files", "-z")
	if err != nil {
		return nil, fmt.Errorf("git ls-files: %w", err)
	}
	var sigs []waveobj.RadarSignal
	for _, f := range strings.Split(out, "\x00") {
		f = strings.TrimSpace(strings.ReplaceAll(f, "\\", "/"))
		if f == "" || isIgnored(f) || path.Base(f) != "package.json" {
			continue
		}
		content, ok := readBoundedFile(in.projectPath, f)
		if !ok {
			continue
		}
		var pkg struct {
			Dependencies    map[string]string `json:"dependencies"`
			DevDependencies map[string]string `json:"devDependencies"`
		}
		if json.Unmarshal([]byte(content), &pkg) != nil {
			continue // malformed manifest is skipped, not fatal
		}
		for _, deps := range []map[string]string{pkg.Dependencies, pkg.DevDependencies} {
			// sort names so the emitted order (and thus the payload) is deterministic across runs.
			names := make([]string, 0, len(deps))
			for name := range deps {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				spec := deps[name]
				if !securityRelevantDep(name) || !isFloatingSpec(spec) {
					continue
				}
				summary := fmt.Sprintf("security-relevant dependency %s uses a floating version range %q in %s", name, spec, f)
				facts := map[string]any{"classes": []string{ClassDependencyPin}, "package": name, "spec": spec}
				sigs = append(sigs, newSignal(CollectorDependency, "dep:floating:"+f+":"+name, in.sinceTs, []string{f}, summary, facts, ""))
			}
		}
	}
	return sigs, nil
}
