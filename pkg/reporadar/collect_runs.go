// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package reporadar

import (
	"context"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// collectRuns emits one signal per failed or blocked run phase for the scanned project. It records
// phase artifacts (RunPhase.Artifacts) as affected paths but references run/phase identity rather
// than copying full timelines. Retries/send-backs are not persisted, so they are not emitted.
func collectRuns(ctx context.Context, in collectInput) ([]waveobj.RadarSignal, error) {
	projectPaths, err := wstore.GetChannelProjectPaths(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading channel project paths: %w", err)
	}
	cp := canonPath(in.projectPath)
	var sigs []waveobj.RadarSignal
	for channelId, chProjectPath := range projectPaths {
		if canonPath(chProjectPath) != cp {
			continue
		}
		runs, rerr := wstore.GetChannelRuns(ctx, channelId)
		if rerr != nil {
			return nil, fmt.Errorf("reading runs for channel %s: %w", channelId, rerr)
		}
		for _, run := range runs {
			if canonPath(run.ProjectPath) != cp && run.ProjectPath != "" {
				continue
			}
			for idx, ph := range run.Phases {
				if ph.State != "failed" && ph.State != "blocked" {
					continue
				}
				ref := fmt.Sprintf("run:%s:phase:%d", run.ID, idx)
				summary := fmt.Sprintf("run %q phase %q (%s) %s", run.Goal, ph.Kind, ph.State, run.Status)
				facts := map[string]any{
					"runid": run.ID, "phasekind": ph.Kind, "phasestate": ph.State, "runstatus": run.Status,
				}
				sigs = append(sigs, newSignal(CollectorRuns, ref, run.CreatedTs, ph.Artifacts, summary, facts, ""))
			}
		}
	}
	return sigs, nil
}
