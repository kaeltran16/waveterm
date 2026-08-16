// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// watchdogInterval is the DAG-advance tick: the engine otherwise advances only on events (submit,
// dag action, run update), and a stalled child produces no events — the watchdog tick is what notices.
const watchdogInterval = 30 * time.Second

// watchdogOnce guards the single start; watchdogTick is the per-tick body (a var so tests can count
// invocations without running a real ticker).
var (
	watchdogOnce sync.Once
	watchdogTick = func(ctx context.Context) {
		dags, err := wstore.GetDagsByStatus(ctx, DagStatus_Running)
		if err != nil {
			log.Printf("watchdog: listing active dags: %v", err)
			return
		}
		for _, g := range dags {
			if serr := ScheduleOnce(ctx, g); serr != nil {
				log.Printf("watchdog: advancing dag %s: %v", g.ID, serr)
			}
		}
	}
)

// StartWatchdog launches the periodic DAG-advance loop (idempotent; the first call wins). The loop
// runs until ctx is done. Wired once at server startup.
func StartWatchdog(ctx context.Context) {
	watchdogOnce.Do(func() {
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("watchdog: panic: %v", r)
				}
			}()
			ticker := time.NewTicker(watchdogInterval)
			defer ticker.Stop()
			watchdogTick(ctx) // first pass immediately (a submitted dag's children may already need attention)
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					watchdogTick(ctx)
				}
			}
		}()
	})
}
