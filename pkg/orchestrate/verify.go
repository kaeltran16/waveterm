// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvisstate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// errProjectBusy is a merge that has to wait: another task's merge or Verify holds the project checkout.
var errProjectBusy = errors.New("project checkout is busy")

// landing is one task's claim on its project checkout, from its squash merge through the Verify after it.
type landing struct {
	dagID  string
	taskID string
	cancel context.CancelFunc // set once Verify starts
}

// landings serializes merges and their Verify runs per project checkout: a merge landing mid-Verify would
// be judged by a test run that started before it. In memory only: a restart kills the Verify the claim
// covered, and AutoMergeReady restarts it from the persisted verifying state.
var landings = struct {
	sync.Mutex
	byProject map[string]*landing
}{byProject: make(map[string]*landing)}

// claimProject reserves projectPath for one landing, or names the landing that holds it.
func claimProject(projectPath, dagID, taskID string) (*landing, error) {
	key := filepath.Clean(projectPath)
	landings.Lock()
	defer landings.Unlock()
	if cur := landings.byProject[key]; cur != nil {
		return nil, fmt.Errorf("%w: task %s of dag %s is landing", errProjectBusy, cur.taskID, cur.dagID)
	}
	l := &landing{dagID: dagID, taskID: taskID}
	landings.byProject[key] = l
	return l, nil
}

func releaseProject(projectPath string, l *landing) {
	key := filepath.Clean(projectPath)
	landings.Lock()
	defer landings.Unlock()
	if landings.byProject[key] == l {
		delete(landings.byProject, key)
	}
}

// stopDagVerify kills a cancelled dag's running Verify: nothing will read its result.
func stopDagVerify(dagID string) {
	landings.Lock()
	defer landings.Unlock()
	for _, l := range landings.byProject {
		if l.dagID == dagID && l.cancel != nil {
			l.cancel()
		}
	}
}

// verifyFinished is called once a Verify run has recorded its result and ticked its dag. A var so tests
// can wait for it.
var verifyFinished = func(dagID, taskID string) {}

// startVerify runs Verify in the project checkout for a task the caller moved to verifying, and releases l
// once the result is recorded. It runs on its own goroutine because Verify takes minutes and neither the
// watchdog tick nor an RPC handler can wait on it, and it holds no dag lock while the command runs.
func startVerify(channelID, dagID, runID, taskID, projectPath, command string, l *landing) {
	ctx, cancel := context.WithCancel(context.Background())
	landings.Lock()
	l.cancel = cancel
	landings.Unlock()
	appendRunEvent(ctx, channelID, runID, waveobj.RunEventKindTaskVerifyStarted, nil, map[string]any{"taskid": taskID})
	go func() {
		defer verifyFinished(dagID, taskID)
		start := time.Now()
		verr := runPlanCommand(ctx, projectPath, command, VerifyTimeout)
		cancel()
		bg := context.Background()
		if err := WithDagMutation(dagID, func() error {
			return recordVerifyLocked(bg, dagID, taskID, verr, time.Since(start).Milliseconds())
		}); err != nil {
			log.Printf("dag %s task %s: recording verify: %v", dagID, taskID, err)
		}
		releaseProject(projectPath, l)
		// the next merge was held for this Verify, and a pass unblocks dependents
		if err := Schedule(bg, dagID); err != nil {
			log.Printf("dag %s: schedule after verify: %v", dagID, err)
		}
	}()
}

// recordVerifyLocked moves a verifying task to done or verify-failed. A task that is no longer verifying,
// because its dag was cancelled, records nothing. The caller holds the dag mutation lock.
func recordVerifyLocked(ctx context.Context, dagID, taskID string, verr error, ms int64) error {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return err
	}
	task := taskByID(g, taskID)
	if g.Status == DagStatus_Cancelled || task == nil || task.State != TaskState_Verifying {
		return nil
	}
	reason := ""
	if verr == nil {
		task.State, task.VerifyError = TaskState_Done, ""
	} else {
		reason = "error"
		var pe *planCommandError
		if errors.As(verr, &pe) {
			reason = pe.reason()
		}
		task.State, task.VerifyError = TaskState_VerifyFailed, verr.Error()
	}
	RecomputeDagStatus(g)
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
	if verr == nil {
		appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskVerifyPassed, nil, map[string]any{"taskid": taskID, "ms": ms})
		closeLandedChunks(ctx, g, taskID)
		return nil
	}
	appendRunEvent(ctx, g.ChannelId, g.RunID, waveobj.RunEventKindTaskVerifyFailed, nil, map[string]any{
		"taskid": taskID, "reason": reason, "detail": failureDetail(verr),
	})
	PostWake(ctx, g.ChannelId, g.RunID, verifyFailedWake(taskID, reason))
	return nil
}

// closeLandedChunks marks the effort chunks of every task the merge that just passed Verify landed as done:
// a lane lands as one squash commit recorded on its tip, and each task in it may name its own chunks. It
// never fails the Verify or the merge, which already happened: a chunk it cannot close is logged with the
// effort, chunk and task, and left for the human to close.
func closeLandedChunks(ctx context.Context, g *waveobj.TaskGroup, tipID string) {
	if g.EffortOID == "" {
		return
	}
	commit := ""
	if tip := taskByID(g, tipID); tip != nil && tip.RunID != "" {
		if child, err := wstore.GetRun(ctx, g.ChannelId, tip.RunID); err == nil {
			commit = child.EndCommit
		}
	}
	landed := "landed"
	if commit != "" {
		landed += " " + commit
	}
	for _, id := range laneOf(g, tipID) {
		task := taskByID(g, id)
		if task == nil || task.State == TaskState_Skipped {
			continue
		}
		for _, chunk := range task.Chunks {
			note := fmt.Sprintf("%s (run %s, task %s)", landed, g.RunID, task.ID)
			op := wshrpc.EffortOp{Op: "setChunkStatus", Chunk: chunk, Status: "done"}
			err := wstore.UpdateEffort(ctx, g.EffortOID, func(e *waveobj.Effort) error {
				return jarvisstate.ApplyEffortOps(e, []wshrpc.EffortOp{op}, note, time.Now().UnixMilli())
			})
			if err != nil {
				log.Printf("dag %s task %s: closing chunk %q of effort %s: %v", g.OID, task.ID, chunk, g.EffortOID, err)
			}
		}
	}
}

// resumeVerify restarts a Verify the server lost: the task was persisted verifying and nothing holds its
// project. A Verify still running holds the claim, so this starts nothing.
func resumeVerify(ctx context.Context, g *waveobj.TaskGroup, taskID string) {
	owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
	if err != nil {
		return
	}
	l, err := claimProject(owner.ProjectPath, g.OID, taskID)
	if err != nil {
		return
	}
	// g predates the claim: a Verify that recorded its result and released in between must not run again
	fresh, err := wstore.GetDag(ctx, g.OID)
	if err != nil || fresh.Status == DagStatus_Cancelled {
		releaseProject(owner.ProjectPath, l)
		return
	}
	if task := taskByID(fresh, taskID); task == nil || task.State != TaskState_Verifying {
		releaseProject(owner.ProjectPath, l)
		return
	}
	startVerify(g.ChannelId, g.OID, g.RunID, taskID, owner.ProjectPath, fresh.Verify, l)
}

// rerunVerify re-runs Verify for a task whose Verify failed, after the caller committed a fix.
func rerunVerify(ctx context.Context, channelID string, owner *waveobj.Run, taskID string) error {
	l, err := claimProject(owner.ProjectPath, owner.DagORef, taskID)
	if err != nil {
		return err
	}
	var verify string
	err = WithDagMutation(owner.DagORef, func() error {
		g, gerr := wstore.GetDag(ctx, owner.DagORef)
		if gerr != nil {
			return gerr
		}
		task := taskByID(g, taskID)
		if task == nil || task.State != TaskState_VerifyFailed {
			return fmt.Errorf("task %s is no longer verify-failed", taskID)
		}
		task.State, task.VerifyError = TaskState_Verifying, ""
		RecomputeDagStatus(g)
		g.UpdatedTs = time.Now().UnixMilli()
		if uerr := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
			*cur = *g
			return nil
		}); uerr != nil {
			return uerr
		}
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
		verify = g.Verify
		return nil
	})
	if err != nil {
		releaseProject(owner.ProjectPath, l)
		return err
	}
	startVerify(channelID, owner.DagORef, owner.ID, taskID, owner.ProjectPath, verify, l)
	return nil
}
