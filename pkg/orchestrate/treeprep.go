// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// worktreePrepTimeout bounds one lane tree's checkout off the lock. cyber_assistant checkouts took 15-55 s and
// RunWorkerSpawnTimeout (60 s) killed the slower ones; this only stops a hung git.
const worktreePrepTimeout = 5 * time.Minute

// treePrep is one task's tree preparation, from the tick that claims the task to the tick that spawns or fails it
type treePrep struct {
	claim      *memgate.Claim // the worker's admission, held through Setup and bound at spawn
	done       bool
	failKind   string // FailureKindWorktree or FailureKindSetup, set with err
	err        error
	wt, head   string   // the prepared tree and its head, which the spawn pass uses while wt exists
	leftovers  []string // laneLeftovers' result, written to the task's CleanupError by the spawn pass
	worktreeMs int64
	setupMs    int64
	notLinked  []string
}

type treePrepJob struct {
	dagID, taskID, ownerID, projectPath, key, spawnBase, setup string
}

// treePreps holds the prepares between the pass that claims a task and the pass that spawns or fails it. It lives in
// memory only: a restart loses it, and settlePreparing sends a preparing task with no entry back to pending.
var treePreps = struct {
	sync.Mutex
	byKey map[string]*treePrep
}{byKey: make(map[string]*treePrep)}

func treePrepKey(dagID, taskID string) string {
	return dagID + "/" + taskID
}

func registerTreePrep(dagID, taskID string, claim *memgate.Claim) {
	treePreps.Lock()
	defer treePreps.Unlock()
	treePreps.byKey[treePrepKey(dagID, taskID)] = &treePrep{claim: claim}
}

func treePrepFor(dagID, taskID string) (treePrep, bool) {
	treePreps.Lock()
	defer treePreps.Unlock()
	p, ok := treePreps.byKey[treePrepKey(dagID, taskID)]
	if !ok {
		return treePrep{}, false
	}
	return *p, true
}

// finishTreePrep records a prepare's outcome; false when a skip or cancel dropped the entry while it ran.
func finishTreePrep(dagID, taskID string, outcome treePrep) bool {
	treePreps.Lock()
	defer treePreps.Unlock()
	p, ok := treePreps.byKey[treePrepKey(dagID, taskID)]
	if !ok {
		return false
	}
	outcome.claim, outcome.done = p.claim, true
	*p = outcome
	return true
}

func takeTreePrep(dagID, taskID string) *treePrep {
	treePreps.Lock()
	defer treePreps.Unlock()
	key := treePrepKey(dagID, taskID)
	p := treePreps.byKey[key]
	delete(treePreps.byKey, key)
	return p
}

// dropTreePreps removes every entry of dagID that keep refuses (nil keeps none) and releases its claim.
func dropTreePreps(dagID string, keep func(taskID string) bool) {
	prefix := treePrepKey(dagID, "")
	treePreps.Lock()
	defer treePreps.Unlock()
	for key, p := range treePreps.byKey {
		taskID, ok := strings.CutPrefix(key, prefix)
		if !ok || (keep != nil && keep(taskID)) {
			continue
		}
		p.claim.Release()
		delete(treePreps.byKey, key)
	}
}

func treePrepCount(dagID string) int {
	prefix := treePrepKey(dagID, "")
	treePreps.Lock()
	defer treePreps.Unlock()
	n := 0
	for key := range treePreps.byKey {
		if strings.HasPrefix(key, prefix) {
			n++
		}
	}
	return n
}

// prepareTaskTree checks out the task's lane tree and runs Setup in it, without the dag lock. Its outcome goes to the
// registry, and the next locked pass writes what belongs on the dag.
func prepareTaskTree(ctx context.Context, job treePrepJob) {
	wtCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), worktreePrepTimeout)
	defer cancel()
	out := prepareTree(ctx, wtCtx, job)
	finishTreePrep(job.dagID, job.taskID, out)
	if out.wt == "" {
		return
	}
	// Cancel removes every tree it finds, and this one may not have existed yet when it ran
	if g, err := wstore.GetDag(ctx, job.dagID); err == nil && g.Status == DagStatus_Cancelled {
		if err := removeWorktreeDir(context.WithoutCancel(ctx), job.projectPath, out.wt); err != nil {
			log.Printf("schedule dag %s task %s: removing the tree prepared for a cancelled dag: %v", job.dagID, job.taskID, err)
		}
	}
}

// prepareTree checks out job's lane tree on wtCtx and runs Setup in it on its own SetupTimeout. The spawn pass calls it
// too, under the dag lock, for a prepared tree that vanished.
func prepareTree(ctx, wtCtx context.Context, job treePrepJob) treePrep {
	var out treePrep
	// a lane's tasks share one tree, so each starts from the commits of the task before it
	wtStart := time.Now()
	wt, head, _, err := EnsureRunWorktree(wtCtx, job.projectPath, job.key, job.spawnBase)
	out.worktreeMs = time.Since(wtStart).Milliseconds()
	if err != nil {
		out.failKind, out.err = FailureKindWorktree, err
		return out
	}
	out.leftovers = laneLeftovers(wtCtx, job.projectPath, job.key)
	// not "created by this call": a failed add or a server that died during Setup leaves a clean tree the retry reuses.
	// With no Setup the default link step runs on a reused tree too: it is idempotent and takes milliseconds
	if job.setup == "" || !treeSetUp(wtCtx, wt) {
		setupStart := time.Now()
		// it runs on its worker's admission, which covers it
		setupCtx := WithGateAdmitted(withRunCmdOwner(context.WithoutCancel(ctx), job.ownerID, PlanCmd_Setup, ""))
		_, notLinked, serr := PrepareTree(setupCtx, wt, job.setup)
		out.setupMs = time.Since(setupStart).Milliseconds()
		if serr != nil {
			// only a new tree is set up, so a retry must not reuse this half-prepared one. The branch
			// stays: it holds the lane's earlier commits, and the retry checks it out again.
			if rerr := removeWorktreeDir(context.WithoutCancel(ctx), job.projectPath, wt); rerr != nil {
				log.Printf("schedule dag %s task %s: removing worktree after setup failure: %v", job.dagID, job.taskID, rerr)
			}
			out.failKind, out.err = FailureKindSetup, serr
			return out
		}
		markTreeSetUp(context.WithoutCancel(ctx), wt)
		out.notLinked = notLinked
	}
	out.wt, out.head = wt, head
	return out
}
