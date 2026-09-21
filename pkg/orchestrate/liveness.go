// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"os"
	"time"

	"github.com/shirou/gopsutil/v4/process"
	"github.com/wavetermdev/waveterm/pkg/agentask"
	"github.com/wavetermdev/waveterm/pkg/agentsessions"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// StallThreshold is how long a running child may go without a transcript write before the engine flags
// it stalled. A headless worker writes its session on every token, so silence this long means the
// child is not progressing (provider hang, dead process) — and nothing else ever notices.
const StallThreshold = 15 * time.Minute

// FirstTokenDeadline is how long a running child may go having written NOTHING before the engine
// treats it as dead. It is separate from StallThreshold because the two measure different things:
// StallThreshold ages a transcript that stopped growing, and a child that never wrote one has no
// such clock. Shorter, because "no first token yet" resolves within seconds in the healthy case —
// the pathological one is a provider hang, where every extra minute is wasted wall time. Armed only
// for the runtimes in firstTokenRuntimes.
const FirstTokenDeadline = 5 * time.Minute

// spawnTs is when a child run started working: the earliest StartedTs across its phases. It is the
// only clock available for a child that has produced no transcript at all.
func spawnTs(run *waveobj.Run) int64 {
	if run == nil {
		return 0
	}
	var earliest int64
	for _, p := range run.Phases {
		if p.StartedTs > 0 && (earliest == 0 || p.StartedTs < earliest) {
			earliest = p.StartedTs
		}
	}
	return earliest
}

// sessionsRootFor resolves a worker runtime's transcript root (a var so tests can point the lookup at a
// temp dir). agentsessions owns where every runtime writes, so liveness asks it rather than keeping a
// second copy of those paths.
var sessionsRootFor = agentsessions.SessionRoot

// livenessRuntimes are the worker runtimes whose transcript reads as a heartbeat: an append-only JSONL
// named by the session id the worker was launched with, so the file's mtime is progress.
var livenessRuntimes = map[string]bool{"claude": true, "pi": true}

// firstTokenRuntimes are the runtimes whose transcript is written per event, which is the only thing
// that makes "has written nothing yet" mean hung. claude is deliberately absent: in the 2026-09-05
// live run all four children wrote no transcript at all for their entire successful lifetime, two of
// them past this deadline while committing correct work, so arming it there is a per-task coin flip
// that retries and discards a finished worktree. codex is unverified and stays out until measured.
// The StallThreshold path is unaffected — it needs a transcript to exist before it can age one.
var firstTokenRuntimes = map[string]bool{"pi": true}

// firstTokenArmed reports whether a child may be judged by the first-token deadline, resolving an
// empty runtime the same way lastActivityForRun does.
func firstTokenArmed(run *waveobj.Run) bool {
	if run == nil {
		return false
	}
	runtime := run.Runtime
	if runtime == "" {
		runtime = defaultWorkerRuntime
	}
	return firstTokenRuntimes[runtime]
}

// defaultWorkerRuntime mirrors runroute.DefaultRuntime: a child run persisted before the
// route carried a runtime ran claude.
const defaultWorkerRuntime = "claude"

// lastActivityForRun returns the newest write time of the child's own worker transcript (the heartbeat a
// headless agent actually emits) and whether the child is observable at all. A false second return means
// there is no activity source: the caller must report freshness unknown rather than age a frozen
// timestamp into a stall, because a wrong stall verdict costs the lead a retry that kills live work while
// a missed one only costs a timeout. The transcript is the one named by the session id the child was
// launched with, so siblings sharing a cwd never refresh each other's heartbeat, and a child spawned
// before workers carried a session id is unobservable. A dag child runs in its ProjectPath.
func lastActivityForRun(run *waveobj.Run) (int64, bool) {
	path, _, tracked := transcriptForRun(run)
	if !tracked {
		return 0, false
	}
	if path == "" {
		return 0, true
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0, true
	}
	return info.ModTime().UnixMilli(), true
}

// transcriptForRun is the child's own worker transcript and the runtime that wrote it. tracked is false for a child
// with no readable transcript at all; path is "" while a tracked child has written none yet.
func transcriptForRun(run *waveobj.Run) (path, runtime string, tracked bool) {
	if run == nil || run.SessionId == "" {
		return "", "", false
	}
	runtime = run.Runtime
	if runtime == "" {
		runtime = defaultWorkerRuntime
	}
	if !livenessRuntimes[runtime] {
		return "", "", false
	}
	root := sessionsRootFor(runtime)
	if root == "" {
		return "", "", false
	}
	return agentsessions.TranscriptForSession(root, runtime, run.ProjectPath, run.SessionId), runtime, true
}

// workerBlockFn reads a child's worker block and whether its process runs. A var so tests can script the
// worker without a live block.
var workerBlockFn = readWorkerBlock

func readWorkerBlock(ctx context.Context, run *waveobj.Run) (string, bool) {
	if run == nil {
		return "", false
	}
	tabId := runTabID(run)
	if tabId == "" {
		return "", false
	}
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil || tab == nil || len(tab.BlockIds) == 0 {
		return "", false
	}
	blockId := tab.BlockIds[0]
	return blockId, blockRunning(blockId)
}

// blockShellStatus is a block's shell process status, "" when it has no controller. Var so tests need no
// real block controller.
var blockShellStatus = func(blockId string) string {
	if rs := blockcontroller.GetBlockControllerRuntimeStatus(blockId); rs != nil {
		return rs.ShellProcStatus
	}
	return ""
}

// blockRunning reports whether the block's shell process is running. A block still starting is not.
func blockRunning(blockId string) bool {
	return blockShellStatus(blockId) == blockcontroller.Status_Running
}

// childCPUTime reads the CPU time (ms) used so far by a block's whole process tree, and whether a reading
// exists. A var so tests can script it.
var childCPUTime = sampleChildCPUTime

func sampleChildCPUTime(blockId string) (int64, bool) {
	pid := blockcontroller.GetBlockControllerPid(blockId)
	if pid <= 0 {
		return 0, false
	}
	root, err := process.NewProcess(int32(pid))
	if err != nil {
		return 0, false
	}
	var totalSec float64
	for _, p := range processTree(root) {
		if times, err := p.Times(); err == nil {
			totalSec += times.User + times.System
		}
	}
	return int64(totalSec * 1000), true
}

// processTree is root and every descendant. gopsutil lists only direct children, and a test run is a
// shell, then go, then the compiled test binary.
func processTree(root *process.Process) []*process.Process {
	tree := []*process.Process{root}
	for i := 0; i < len(tree); i++ {
		children, err := tree[i].Children()
		if err != nil {
			continue
		}
		tree = append(tree, children...)
	}
	return tree
}

// childStillWorking reports whether a task whose transcript has gone quiet must not be stalled yet:
// its worker is running and its process tree used CPU since the last sample. A worker sitting in a
// foreground test run writes no transcript for as long as the run lasts, so the mtime cannot see it.
// The first reading has nothing to compare with, so it is recorded and the verdict is deferred a tick
// rather than guessed: a wrong stall costs a retry that kills live work, a late one costs a tick. A
// changed total counts as activity in either direction, because a child that finished and exited
// lowers the tree's sum. No reading at all returns false and leaves the mtime rule alone.
func childStillWorking(ctx context.Context, t *waveobj.TaskNode, run *waveobj.Run, now int64) bool {
	blockId, alive := workerBlockFn(ctx, run)
	if !alive {
		return false
	}
	cpu, ok := childCPUTime(blockId)
	if !ok {
		return false
	}
	prev, hadBaseline := t.CPUSample, t.CPUSampleTs > 0
	t.CPUSample, t.CPUSampleTs = cpu, now
	if !hadBaseline {
		return true
	}
	if cpu != prev {
		t.LastActivity = now
		return true
	}
	return false
}

// workerControllerGone reports whether a child's worker block exists but no controller runs it, which is
// what a machine restart leaves behind: the block is in the store, the process is not. An unresolvable
// worker (no tab yet, a run without one) is not gone, only unknown. A var so tests can script it.
var workerControllerGone = func(ctx context.Context, run *waveobj.Run) bool {
	if run == nil {
		return false
	}
	tabId := runTabID(run)
	if tabId == "" {
		return false
	}
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabId)
	if err != nil || tab == nil || len(tab.BlockIds) == 0 {
		return false
	}
	return blockcontroller.GetBlockControllerRuntimeStatus(tab.BlockIds[0]) == nil
}

// hungWake is the judgment line for a task that just stalled, or "" when its worker is not hung. A worker
// whose process exited fails through the exit path, and one waiting on an answer belongs to the question
// queue, so neither is the lead's to judge here.
func hungWake(ctx context.Context, taskID string, run *waveobj.Run, silentMs int64) string {
	blockId, alive := workerBlockFn(ctx, run)
	if !alive {
		return ""
	}
	if _, asking := agentask.GlobalRegistry.Get(waveobj.MakeORef(waveobj.OType_Block, blockId).String()); asking {
		return ""
	}
	return taskHungWake(taskID, silentMs/time.Minute.Milliseconds())
}
