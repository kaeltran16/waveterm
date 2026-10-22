// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/shirou/gopsutil/v4/mem"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MaxLiveWorkers caps live workers across every run. Parallelism bounds one run, and two wide runs at once
// otherwise put twice the processes and memory on one machine.
const MaxLiveWorkers = MaxParallelism

// WorkerMemoryReserve is the available memory a new worker needs: its claude (~0.7 GB) and the largest test
// peak measured in this repo, the typecheck (2.8 GB, 10-20). Memory, not CPU, is what runs out when runs pile up.
const WorkerMemoryReserve = 3584 << 20

// availableMemory is a var so tests can stand in for the machine.
var availableMemory = func() (uint64, error) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		return 0, err
	}
	return vm.Available, nil
}

// liveDags lists the dags whose workers count against the cap: every nonterminal one. A var so tests can
// leave out the dags other tests left in the shared store.
var liveDags = func(ctx context.Context) ([]*waveobj.TaskGroup, error) {
	var out []*waveobj.TaskGroup
	for _, status := range watchdogStatuses {
		dags, err := wstore.GetDagsByStatus(ctx, status)
		if err != nil {
			return nil, fmt.Errorf("listing %s dags: %w", status, err)
		}
		out = append(out, dags...)
	}
	return out, nil
}

// UncapWorkersForTest lifts the live-worker cap for another package's tests: their store is shared too, and the
// cap would count the dags earlier tests left live in it and the machine's free memory.
func UncapWorkersForTest() (restore func()) {
	oldLive, oldMem := liveDags, availableMemory
	liveDags = func(context.Context) ([]*waveobj.TaskGroup, error) { return nil, nil }
	availableMemory = func() (uint64, error) { return ^uint64(0), nil }
	return func() { liveDags, availableMemory = oldLive, oldMem }
}

// workerClaims holds the workers each dag's dispatch has granted itself and not yet persisted: a tick spawns
// its batch under its own dag lock, so until it commits no other dag's read of the store can see them.
var workerClaims = struct {
	sync.Mutex
	byDag map[string]int
}{byDag: make(map[string]int)}

// workerLoad is what the other dags hold of the cap.
type workerLoad struct {
	live    int // workers in flight or claimed by a dispatch under way
	claimed int // the claimed part of live: spawned, or about to be, and not yet grown to their memory
	waiting int // dags with ready work and no dispatch under way
}

func workerLoadOf(dags []*waveobj.TaskGroup, selfID string, claims map[string]int) workerLoad {
	var l workerLoad
	for _, g := range dags {
		if g.OID == selfID {
			continue
		}
		l.live += len(busyTaskIDs(g))
		if claims[g.OID] == 0 && len(NextToSpawn(g)) > 0 {
			l.waiting++
		}
	}
	for id, n := range claims {
		if id != selfID {
			l.live += n
			l.claimed += n
		}
	}
	return l
}

// workerGrant is how many of want new workers a dag with mine in flight may start. While other dags wait, it
// refills only to its fair share: the dag whose worker just finished ticks first and would otherwise take every
// freed slot. Memory admits one worker per WorkerMemoryReserve available, less the workers other dispatches
// started that have not grown yet. With nothing live anywhere one worker always starts, so a machine short of
// memory for reasons outside Arc slows runs down instead of stalling them with nothing to say why.
func workerGrant(want, mine int, l workerLoad, avail uint64) int {
	room := MaxLiveWorkers - l.live - mine
	if l.waiting > 0 {
		room = min(room, max(1, MaxLiveWorkers/(l.waiting+1))-mine)
	}
	byMemory := int(avail/WorkerMemoryReserve) - l.claimed
	if l.live+mine == 0 {
		byMemory = max(1, byMemory)
	}
	return max(0, min(want, room, byMemory))
}

// claimWorkers reserves up to want new workers for g's dispatch and returns how many it got. The caller
// releases the claim with releaseWorkerClaim once the dispatch is persisted.
func claimWorkers(ctx context.Context, g *waveobj.TaskGroup, want int) int {
	if want == 0 {
		return 0
	}
	workerClaims.Lock()
	defer workerClaims.Unlock()
	dags, err := liveDags(ctx)
	if err != nil {
		// the cap is a guard for the machine, not a correctness rule: an unreadable store must not stop dispatch
		log.Printf("dag %s: worker cap skipped: %v", g.OID, err)
		return want
	}
	avail, err := availableMemory()
	if err != nil {
		log.Printf("dag %s: worker memory check skipped: %v", g.OID, err)
		avail = ^uint64(0)
	}
	n := workerGrant(want, len(busyTaskIDs(g)), workerLoadOf(dags, g.OID, workerClaims.byDag), avail)
	if n > 0 {
		workerClaims.byDag[g.OID] += n
	}
	return n
}

func releaseWorkerClaim(dagID string) {
	workerClaims.Lock()
	defer workerClaims.Unlock()
	delete(workerClaims.byDag, dagID)
}
