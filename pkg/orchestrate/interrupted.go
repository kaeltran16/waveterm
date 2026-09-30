// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"log"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// interruptedNote is why a non-dag run found running at boot stopped.
const interruptedNote = "the app stopped while the worker was running"

// MarkInterruptedRuns fails the running phase of every non-dag run that was executing when wavesrv last
// stopped. Neither a quit nor a crash reaches HandleRunWorkerExit, and every worker is a child of the previous
// wavesrv, so at boot none of them can be alive: without this the run reads executing forever. Dag runs are
// the watchdog's. Call before StartWatchdog; a run that fails to reconcile is logged and skipped.
func MarkInterruptedRuns(ctx context.Context) {
	runs, err := wstore.GetRunsByStatus(ctx, jarvis.RunStatus_Executing, jarvis.RunStatus_Planning)
	if err != nil {
		log.Printf("listing runs to mark interrupted: %v", err)
		return
	}
	for _, run := range runs {
		if run.DagORef != "" {
			continue
		}
		failed, _, err := failRunningPhase(ctx, run.ChannelOID, run.ID, func(workers []string) bool {
			// a running phase with no worker was never launched, so nothing was interrupted
			return len(workers) > 0
		})
		if err != nil {
			log.Printf("marking run %s interrupted: %v", run.ID, err)
			continue
		}
		if !failed {
			continue
		}
		appendRunEvent(ctx, run.ChannelOID, run.ID, waveobj.RunEventKindInterrupted, nil, map[string]any{"reason": interruptedNote})
		sendRunUpdates(run.ChannelOID, run.ID)
	}
}
