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

// watchdogStatuses are the dag statuses worth a periodic tick: every nonterminal one. Stall detection
// lives inside the schedule tick, so scanning only "running" stops supervising a dag the moment one
// task fails or a gate opens — while its siblings are still live children that can hang with nothing
// else to notice them. Ticking the parked ones cannot advance work that should not advance: every
// dispatch guard (the gate halt, the circuit-break, parallelism) is inside NextToSpawn, so the tick
// observes and reports without spawning.
var watchdogStatuses = []string{DagStatus_Running, DagStatus_Blocked, DagStatus_AwaitingReview}

// watchdogOnce guards the single start; watchdogTick is the per-tick body (a var so tests can count
// invocations without running a real ticker).
var (
	watchdogOnce sync.Once
	watchdogTick = func(ctx context.Context) {
		for _, status := range watchdogStatuses {
			dags, err := wstore.GetDagsByStatus(ctx, status)
			if err != nil {
				log.Printf("watchdog: listing %s dags: %v", status, err)
				continue
			}
			for _, g := range dags {
				// a parked dag is ticked only to observe its live children. With none, the tick would
				// just rewrite the row every interval — a version bump the UI reads as a change, on
				// exactly the dags a human is sitting and looking at.
				if status != DagStatus_Running && len(busyTaskIDs(g)) == 0 {
					continue
				}
				if serr := Schedule(ctx, g.OID); serr != nil {
					log.Printf("watchdog: advancing dag %s: %v", g.ID, serr)
				}
			}
		}
	}
)

// StartWatchdog launches the periodic DAG-advance loop (idempotent; the first call wins). The loop
// runs until ctx is done. Wired once at server startup.
func StartWatchdog(ctx context.Context) {
	watchdogOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(watchdogInterval)
			defer ticker.Stop()
			safeTick(ctx) // first pass immediately (a submitted dag's children may already need attention)
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					safeTick(ctx)
				}
			}
		}()
	})
}

// safeTick recovers per tick: a panic inside one Schedule must not kill the loop for the server's
// lifetime — the watchdog is the only advance path for event-less stalls.
func safeTick(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("watchdog: tick panic (loop continues): %v", r)
		}
	}()
	watchdogTick(ctx)
}
