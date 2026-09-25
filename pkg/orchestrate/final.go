// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// Final stage states (TaskGroup.Final.State). Empty is a round set up but not started.
const (
	FinalState_Checking   = "checking"  // Check, then the Final command, are running
	FinalState_Final      = "final"     // Check passed; the Final command is running
	FinalState_Verifying  = "verifying" // the deterministic steps passed; the verifier session judges the result
	FinalState_Passed     = "passed"
	FinalState_Unverified = "unverified" // nothing failed, but something could not be verified
	FinalState_Failed     = "failed"
)

// FinalExitUnverified is the Final command's exit code for "could not verify": its last output line says why.
// Any other non-zero exit is a failure.
const FinalExitUnverified = 3

// MaxFinalRounds is how many times the final stage runs on one dag: the first, and one fix round.
const MaxFinalRounds = 2

// FinalTimeout bounds the Final command. A dev-app check boots the app first (up to 10 minutes) and then
// runs its scenarios, so it is longer than Verify's.
const FinalTimeout = 30 * time.Minute

// finalOutEnv names the directory the Final command writes its screenshots and reports into.
const finalOutEnv = "ARC_FINAL_OUT"

// finalCommandTimeout is FinalTimeout, a var so a test can time a hanging command out in a second.
var finalCommandTimeout = FinalTimeout

// finalFinished is called once a final stage's commands have run and their result is recorded. A var so
// tests can wait for it.
var finalFinished = func(dagID string) {}

// finalRuns holds the cancel of each dag's running final commands. In memory only: a restart loses the
// commands, and the next tick starts them over from the persisted state.
var finalRuns = struct {
	sync.Mutex
	byDag map[string]context.CancelFunc
}{byDag: make(map[string]context.CancelFunc)}

// stopDagFinal kills a cancelled dag's running final commands: nothing will read their result.
func stopDagFinal(dagID string) {
	finalRuns.Lock()
	defer finalRuns.Unlock()
	if cancel := finalRuns.byDag[dagID]; cancel != nil {
		cancel()
	}
}

func finalTerminal(state string) bool {
	return state == FinalState_Passed || state == FinalState_Unverified || state == FinalState_Failed
}

// finalOutDir is ARC_FINAL_OUT for one round, outside every tree so nothing it writes can be committed. Forward
// slashes, because Git Bash eats the backslashes of an unquoted Windows path.
func finalOutDir(dagID string, round int) string {
	return filepath.ToSlash(filepath.Join(os.TempDir(), "arc-final", dagID, fmt.Sprint(round)))
}

// notGitRepo is why a dag outside git gets no final checks: its tree is the shared checkout, where the stage
// never runs.
func notGitRepo(path string) error {
	return fmt.Errorf("%s is not a git repository, so the final stage has no tree of its own to run in", path)
}

// advanceFinal moves the final stage along once every task landed (RecomputeDagStatus says finalizing). It
// starts a round that has not started. With no Check and no Final command there is nothing to run, so the
// stage goes straight on in this tick; otherwise the commands run off the tick, as Verify does, because they
// take minutes and hold no dag lock while they run. The caller holds the dag mutation lock.
func advanceFinal(ctx, spawnCtx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, now int64, afterCommit *[]func()) {
	if g.Status != DagStatus_Finalizing {
		return
	}
	if g.Final == nil {
		g.Final = &waveobj.FinalStage{Round: 1}
	}
	f := g.Final
	if f.State == "" {
		*f = waveobj.FinalStage{State: FinalState_Checking, Round: f.Round, OutDir: finalOutDir(g.OID, f.Round), StartedTs: now}
		if g.Check == "" && g.FinalCmd == "" {
			if owner.LandPath != "" {
				f.Tree = owner.LandPath
				head, err := landingHead(ctx, owner)
				if err != nil {
					log.Printf("dag %s: reading the landing head for the final stage: %v", g.OID, err)
				}
				f.Commit = head
			} else if !IsGitRepo(owner.ProjectPath) {
				f.Unverified = append(f.Unverified, notGitRepo(owner.ProjectPath).Error())
			}
			f.State = FinalState_Verifying
			startVerifier(ctx, spawnCtx, g, owner, afterCommit)
			RecomputeDagStatus(g)
			return
		}
	}
	if f.State == FinalState_Checking || f.State == FinalState_Final {
		dagID, ownerCopy := g.OID, *owner
		*afterCommit = append(*afterCommit, func() { startFinalCommands(dagID, &ownerCopy) })
	}
}

// startFinalCommands runs a dag's Check and Final command on their own goroutine, unless they are running
// already: every tick while the stage runs asks, and only a restart finds nothing running.
func startFinalCommands(dagID string, owner *waveobj.Run) {
	ctx, cancel := context.WithCancel(context.Background())
	finalRuns.Lock()
	if finalRuns.byDag[dagID] != nil {
		finalRuns.Unlock()
		cancel()
		return
	}
	finalRuns.byDag[dagID] = cancel
	finalRuns.Unlock()
	go func() {
		defer finalFinished(dagID)
		res := runFinalSteps(ctx, dagID, owner)
		cancel()
		bg := context.Background()
		spawnCtx, spawnCancel := context.WithTimeout(bg, jarvis.RunWorkerSpawnTimeout)
		keepTree := false
		if err := WithDagMutation(dagID, func() error {
			var rerr error
			keepTree, rerr = recordFinalLocked(bg, spawnCtx, dagID, owner, res)
			return rerr
		}); err != nil {
			log.Printf("dag %s: recording the final stage: %v", dagID, err)
		}
		spawnCancel()
		if res.cleanup != nil && !keepTree {
			res.cleanup()
		}
		finalRuns.Lock()
		delete(finalRuns.byDag, dagID)
		finalRuns.Unlock()
		// the outcome makes the dag done or blocked, which the tick announces
		if err := Schedule(bg, dagID); err != nil {
			log.Printf("dag %s: schedule after the final stage: %v", dagID, err)
		}
	}()
}

// finalResult is what the deterministic steps found: a failure's Detail, or what they could not verify.
type finalResult struct {
	round      int
	tree       string
	commit     string
	detail     string
	unverified []string
	cleanup    func()
}

// runFinalSteps runs Check, then the Final command, in the final tree. It reads the dag without the lock:
// the commands and the round it is for were fixed when the round started.
func runFinalSteps(ctx context.Context, dagID string, owner *waveobj.Run) finalResult {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil || g.Final == nil {
		return finalResult{round: -1}
	}
	res := finalResult{round: g.Final.Round}
	tree, cleanup, err := finalTree(ctx, g, owner)
	if err != nil {
		res.unverified = []string{"the final stage could not check the merged result: " + err.Error()}
		return res
	}
	res.tree, res.cleanup = tree, cleanup
	if res.commit, err = git(ctx, tree, "rev-parse", "HEAD"); err != nil {
		log.Printf("dag %s: reading the final tree's head: %v", dagID, err)
	}
	if g.Check != "" {
		if out, err := runPlanCommand(ctx, tree, g.Check, VerifyTimeout, nil); err != nil {
			res.detail = fmt.Sprintf("Check `%s` failed (%s):\n%s", g.Check, commandReason(err), out)
			return res
		}
	}
	if g.FinalCmd == "" {
		return res
	}
	if err := WithDagMutation(dagID, func() error { return markFinalCommandLocked(ctx, dagID, res.round) }); err != nil {
		log.Printf("dag %s: marking the Final command started: %v", dagID, err)
	}
	exit, tail, err := runFinalCommand(ctx, tree, g.FinalCmd, g.Final.OutDir, finalCommandTimeout)
	switch {
	case err != nil:
		res.detail = fmt.Sprintf("Final `%s` failed (%s):\n%s", g.FinalCmd, err, tail)
	case exit == FinalExitUnverified:
		reason := lastOutputLine(tail)
		if reason == "" {
			reason = fmt.Sprintf("Final `%s` exited %d, could not verify, and gave no reason", g.FinalCmd, exit)
		}
		res.unverified = append(res.unverified, reason)
	case exit != 0:
		res.detail = fmt.Sprintf("Final `%s` failed (exit %d):\n%s", g.FinalCmd, exit, tail)
	}
	return res
}

// commandReason is a plan command's exit code or timeout, or the error that kept it from running.
func commandReason(err error) string {
	var pe *planCommandError
	if errors.As(err, &pe) {
		return pe.reason()
	}
	return err.Error()
}

// markFinalCommandLocked shows that Check passed and the Final command is running.
func markFinalCommandLocked(ctx context.Context, dagID string, round int) error {
	err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		if cur.Status == DagStatus_Cancelled || cur.Final == nil || cur.Final.Round != round || cur.Final.State != FinalState_Checking {
			return errVerifyProgressStale
		}
		cur.Final.State = FinalState_Final
		cur.UpdatedTs = time.Now().UnixMilli()
		return nil
	})
	if errors.Is(err, errVerifyProgressStale) {
		return nil
	}
	if err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
	return nil
}

// recordFinalLocked writes what the deterministic steps found. A failure ends the stage; otherwise the verifier
// judges the result. A dag that was cancelled, or moved to another round meanwhile, takes nothing. It reports
// whether the stage still needs its tree. The caller holds the dag mutation lock.
func recordFinalLocked(ctx, spawnCtx context.Context, dagID string, owner *waveobj.Run, res finalResult) (bool, error) {
	g, err := wstore.GetDag(ctx, dagID)
	if err != nil {
		return false, err
	}
	f := g.Final
	if g.Status == DagStatus_Cancelled || f == nil || f.Round != res.round || (f.State != FinalState_Checking && f.State != FinalState_Final) {
		return false, nil
	}
	f.Tree, f.Commit = res.tree, res.commit
	f.Unverified = append(f.Unverified, res.unverified...)
	var afterCommit []func()
	if res.detail != "" {
		f.Detail = res.detail
		finishFinal(g, &afterCommit)
	} else {
		f.State = FinalState_Verifying
		startVerifier(ctx, spawnCtx, g, owner, &afterCommit)
	}
	RecomputeDagStatus(g)
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return false, err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
	for _, fn := range afterCommit {
		fn()
	}
	return !finalTerminal(g.Final.State), nil
}

// startVerifier hands the merged result to the verifier session once the deterministic steps passed. Until the
// verifier exists, the stage's outcome follows from the steps alone.
func startVerifier(ctx, spawnCtx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, afterCommit *[]func()) {
	finishFinal(g, afterCommit)
}

// finishFinal decides the stage's outcome: failed on a Detail, unverified when anything could not be verified,
// else passed. The reviewers' caveats and a plan with no Verify are reasons too, since nothing checked them. A
// done outcome wakes the lead from the tick that announces the dag done; a failure wakes it here, with the
// Detail whole, because the fix plan is written from it.
func finishFinal(g *waveobj.TaskGroup, afterCommit *[]func()) {
	f := g.Final
	for _, t := range g.Tasks {
		if t.ReviewUnverified != "" {
			f.Unverified = append(f.Unverified, t.ID+": "+t.ReviewUnverified)
		}
	}
	if g.Verify == "" {
		f.Unverified = append(f.Unverified, "the plan has no Verify")
	}
	switch {
	case f.Detail != "":
		f.State = FinalState_Failed
	case len(f.Unverified) > 0:
		f.State = FinalState_Unverified
	default:
		f.State = FinalState_Passed
	}
	if f.State != FinalState_Failed {
		return
	}
	round, detail, last := f.Round, f.Detail, f.Round >= MaxFinalRounds
	channelID, runID := g.ChannelId, g.RunID
	*afterCommit = append(*afterCommit, func() {
		PostWake(context.Background(), channelID, runID, finalFailedWake(round, detail, last))
	})
}

// finalTree is where the final stage runs: the landing tree for a dag landing on its own branch. A dag landing
// in the checkout gets a detached worktree at the checkout's HEAD, prepared with Setup, because the stage never
// runs in the shared checkout. cleanup removes a tree the stage made.
func finalTree(ctx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run) (string, func(), error) {
	if owner.LandPath != "" {
		if err := checkLandingTree(ctx, owner); err != nil {
			return "", nil, err
		}
		return owner.LandPath, func() {}, nil
	}
	if !IsGitRepo(owner.ProjectPath) {
		return "", nil, notGitRepo(owner.ProjectPath)
	}
	wt := worktreeDir(owner.ProjectPath, owner.ID+"-final")
	// a tree a lost stage left behind would refuse the add
	if _, err := os.Stat(wt); err == nil {
		if err := removeWorktreeDir(ctx, owner.ProjectPath, wt); err != nil {
			return "", nil, fmt.Errorf("removing a stale final tree: %w", err)
		}
	}
	if _, err := git(ctx, owner.ProjectPath, "worktree", "add", "--detach", wt, "HEAD"); err != nil {
		return "", nil, fmt.Errorf("creating the final tree: %w", err)
	}
	cleanup := func() {
		if err := removeWorktreeDir(context.Background(), owner.ProjectPath, wt); err != nil {
			log.Printf("dag %s: removing the final tree: %v", g.OID, err)
		}
	}
	if g.Setup != "" {
		if _, err := runPlanCommand(ctx, wt, g.Setup, SetupTimeout, nil); err != nil {
			cleanup()
			return "", nil, fmt.Errorf("Setup failed in the final tree: %s", failureDetail(err))
		}
	}
	return wt, cleanup, nil
}

// runFinalCommand runs the plan's Final command in tree with ARC_FINAL_OUT set to a fresh outDir, and returns
// its exit code and output tail. err is set only when there is no exit code to judge: the command timed out,
// or could not start.
func runFinalCommand(ctx context.Context, tree, cmd, outDir string, timeout time.Duration) (int, string, error) {
	// a stage the server lost runs again into the same round's directory; the old screenshots would pass for new ones
	if err := os.RemoveAll(outDir); err != nil {
		return -1, "", fmt.Errorf("clearing %s %s: %w", finalOutEnv, outDir, err)
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return -1, "", fmt.Errorf("creating %s %s: %w", finalOutEnv, outDir, err)
	}
	out, err := execPlanCommandEnv(ctx, tree, cmd, []string{finalOutEnv + "=" + outDir}, timeout, nil)
	if err == nil {
		return 0, out, nil
	}
	var pe *planCommandError
	if !errors.As(err, &pe) {
		return -1, out, err
	}
	if pe.timeout == 0 && pe.exitCode >= 0 {
		return pe.exitCode, out, nil
	}
	return -1, out, errors.New(pe.reason())
}
