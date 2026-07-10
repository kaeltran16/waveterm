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
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("reading channels: %w", err)
	}
	cp := canonPath(in.projectPath)
	var sigs []waveobj.RadarSignal
	for _, ch := range channels {
		if canonPath(ch.ProjectPath) != cp {
			continue
		}
		for _, run := range ch.Runs {
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
