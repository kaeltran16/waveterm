// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// MaxLiveWorkers caps live workers across every run. Parallelism bounds one run, and two wide runs at once
// otherwise put twice the processes and memory on one machine.
const MaxLiveWorkers = MaxParallelism

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

// UncapWorkersForTest lifts the live-worker cap and the memory gate for another package's tests: their store is
// shared too, and the cap would count the dags earlier tests left live in it and the machine's free memory.
func UncapWorkersForTest() (restore func()) {
	oldLive := liveDags
	liveDags = func(context.Context) ([]*waveobj.TaskGroup, error) { return nil, nil }
	restoreFree := memgate.UncapForTest()
	return func() {
		liveDags = oldLive
		restoreFree()
	}
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
		}
	}
	return l
}

// workerGrant is how many of want new workers a dag with mine in flight may start. While other dags wait, it
// refills only to its fair share: the dag whose worker just finished ticks first and would otherwise take every
// freed slot. Memory is the gate's (claimWorkers).
func workerGrant(want, mine int, l workerLoad) int {
	room := MaxLiveWorkers - l.live - mine
	if l.waiting > 0 {
		room = min(room, max(1, MaxLiveWorkers/(l.waiting+1))-mine)
	}
	return max(0, min(want, room))
}

// claimWorkers reserves workers for the tasks of next that g's dispatch may start: the count grant first, then
// each task's admission at the memory gate, in plan order. After the first refusal the rest of the grant is held
// without being tried, so no task jumps ahead of one waiting for memory. It returns the admitted tasks and their
// claims; the caller releases the count claim with releaseWorkerClaim once the dispatch is persisted, and every
// claim its dispatch did not bind.
func claimWorkers(ctx context.Context, g *waveobj.TaskGroup, next []string) ([]string, map[string]*memgate.Claim) {
	if len(next) == 0 {
		return nil, nil
	}
	workerClaims.Lock()
	defer workerClaims.Unlock()
	granted := next
	if dags, err := liveDags(ctx); err != nil {
		// the cap is a guard for the machine, not a correctness rule: an unreadable store must not stop dispatch
		log.Printf("dag %s: worker cap skipped: %v", g.OID, err)
	} else {
		granted = next[:workerGrant(len(next), len(busyTaskIDs(g)), workerLoadOf(dags, g.OID, workerClaims.byDag))]
	}
	var admitted []string
	claims := make(map[string]*memgate.Claim)
	for i, taskID := range granted {
		claim, ok := memgate.TryAdmit(workerRequest(g, taskID))
		if !ok {
			for _, held := range granted[i+1:] {
				memgate.Hold(workerRequest(g, held))
			}
			break
		}
		admitted = append(admitted, taskID)
		claims[taskID] = claim
	}
	if len(admitted) > 0 {
		workerClaims.byDag[g.OID] += len(admitted)
	}
	return admitted, claims
}

func releaseWorkerClaim(dagID string) {
	workerClaims.Lock()
	defer workerClaims.Unlock()
	delete(workerClaims.byDag, dagID)
}
