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
	for _, f := range strings.Split(out, "\x00") {
		f = strings.TrimSpace(strings.ReplaceAll(f, "\\", "/"))
		if f == "" || isIgnored(f) {
			continue
		}
		if strings.Contains(f, "migration") && strings.HasSuffix(f, ".sql") {
			migrations = append(migrations, f)
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
	return sigs, nil
}

func migrationStem(p string) string {
	base := path.Base(p)
	base = strings.TrimSuffix(base, ".up.sql")
	base = strings.TrimSuffix(base, ".down.sql")
	return path.Dir(p) + "/" + base
}
