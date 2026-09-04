// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// RunWorkerSpec is the unattended launch form for one harness's run worker: the executable plus the
// argument prefix that goes before the prompt. The prompt travels positionally (claude) or as a flag
// value (opencode --prompt); codex appends it positionally in interactive mode (never `exec`).
type RunWorkerSpec struct {
	Bin  string
	Args []string
}

// RunWorkerSpecFor resolves the unattended worker launch form from one validated capability. The
// capability authority owns runtime/tier compatibility and model selection; this adapter only supplies
// each runtime's unattended base arguments.
func RunWorkerSpecFor(cap runroute.Capability, prompt string) (RunWorkerSpec, bool) {
	if !runroute.IsValid(cap) {
		return RunWorkerSpec{}, false
	}
	h, ok := harness.Lookup(cap.Runtime)
	if !ok || !h.RunWorkerCapable {
		return RunWorkerSpec{}, false
	}
	var args []string
	switch cap.Runtime {
	case "claude":
		args = []string{"--dangerously-skip-permissions"}
	case "codex":
		args = []string{"--dangerously-bypass-approvals-and-sandbox"}
	case "opencode":
		args = []string{"--auto", "--prompt"}
	case "pi":
		args = nil
	default:
		return RunWorkerSpec{}, false
	}
	args = append(args, cap.ModelArgs...)
	args = append(args, prompt)
	return RunWorkerSpec{Bin: h.Bin, Args: args}, true
}

// SpawnRunWorker creates a background tab running the runtime's unattended worker form in cwd and
// returns its tab oref ("tab:<id>"). Mirrors the frontend launchAgent path, but the permission-skip
// flag is mandatory here (opt-in in the launcher): a run worker is headless with no human attached, so
// without it the agent blocks forever on per-tool prompts — alive but never running, never firing the
// hooks that report agent:status (the "worker never starts" symptom). The flag stops there, so claude's
// separate first-run folder-trust prompt is handled by ensureClaudeDirTrusted (see claudetrust.go).
// Configure the new tab's default block as a cmd worker, tag the tab for the roster, and force-start
// the controller (controllers otherwise start lazily on a frontend terminal resync — force=true
// launches it headlessly).
//
// It is a var so tests can stub the process-spawning boundary without a live tab/PTY.

type RunWorkerOptions struct {
    KeepOnExit bool
}

var persistWorkerBlockMeta = func(ctx context.Context, blockID string, meta waveobj.MetaMapType) error {
    return wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockID), meta, false)
}

var startWorkerController = func(ctx context.Context, tabID, blockID string) error {
    return blockcontroller.ResyncController(ctx, tabID, blockID, &waveobj.RuntimeOpts{}, true)
}

func configureAndStartWorker(ctx context.Context, tabID, blockID string, meta waveobj.MetaMapType) error {
    if err := persistWorkerBlockMeta(ctx, blockID, meta); err != nil {
        return fmt.Errorf("setting worker block meta: %w", err)
    }
    if err := startWorkerController(ctx, tabID, blockID); err != nil {
        return fmt.Errorf("starting worker controller: %w", err)
    }
    return nil
}

// makeWorkerBlockMeta builds the block meta for a run worker. keepOnExit is true for
// orchestrator leads, whose tab must outlive the lead process while DAG children run.
func makeWorkerBlockMeta(spec RunWorkerSpec, cwd string, keepOnExit bool) waveobj.MetaMapType {
	m := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "cmd",
		waveobj.MetaKey_Cmd:        spec.Bin,
		waveobj.MetaKey_CmdArgs:    spec.Args,
		waveobj.MetaKey_CmdShell:   false,
		waveobj.MetaKey_CmdJwt:     true,
	}
	if cwd != "" {
		m[waveobj.MetaKey_CmdCwd] = cwd
	}
	if keepOnExit {
		m[waveobj.MetaKey_CmdKeepOnExit] = true
	}
	return m
}

var SpawnRunWorker = func(ctx context.Context, cap runroute.Capability, workspaceId, projectName, cwd, prompt string, opts RunWorkerOptions) (string, error) {
	if workspaceId == "" {
		return "", fmt.Errorf("workspaceId is required to spawn a worker")
	}
	spec, ok := RunWorkerSpecFor(cap, prompt)
	if !ok {
		return "", fmt.Errorf("no unattended run worker adapter for runtime %q tier %q", cap.Runtime, cap.Tier)
	}
	// --dangerously-skip-permissions covers tool prompts, not the first-run folder-trust prompt, so a
	// worker launched into an untrusted project would park there forever with no signal. Every claude
	// spawn is checked, not just leads: a run can pin a non-claude lead with claude workers, making a
	// DAG child the first claude process to touch the project. The check costs one config read and
	// writes at most one entry per project (never per worktree — see claudetrust.go); when it cannot
	// register the trust the spawn fails visibly instead of returning a worker that can never start.
	if cap.Runtime == "claude" && cwd != "" {
		if err := ensureClaudeDirTrusted(cwd); err != nil {
			return "", fmt.Errorf("registering claude folder trust for %s: %w", cwd, err)
		}
	}
	tabId, err := wcore.CreateTab(ctx, workspaceId, projectName, false, false)
	if err != nil {
		return "", fmt.Errorf("creating worker tab: %w", err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil {
		return "", fmt.Errorf("loading worker tab: %w", err)
	}
	if len(tab.BlockIds) == 0 {
		return "", fmt.Errorf("worker tab %s has no block", tabId)
	}
	blockId := tab.BlockIds[0]

	blockMeta := makeWorkerBlockMeta(spec, cwd, opts.KeepOnExit)
	// Tab meta: put the worker in the agent roster (and route the external status reporter). These keys
	// have no generated constants; the literals match the frontend (see launchAgent).
	tabMeta := waveobj.MetaMapType{
		"session:agent":   cap.Runtime,
		"session:project": projectName,
	}
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Tab, tabId), tabMeta, false); err != nil {
		return "", fmt.Errorf("setting worker tab meta: %w", err)
	}
	if err := configureAndStartWorker(ctx, tabId, blockId, blockMeta); err != nil {
		return "", err
	}
	// Make the worker visible in the roster immediately. The roster keys off agent:status, which
	// otherwise arrives only from the external reporter hook — unreliable for a headless worker (the
	// hook may be owned by a coexisting install and route to the wrong wavesrv). A real hook event
	// later refines this (detail/model, idle-on-stop).
	wps.Broker.Publish(initialWorkerStatusEvent(blockId, cap.Runtime, time.Now().UnixMilli()))
	return waveobj.MakeORef(waveobj.OType_Tab, tabId).String(), nil
}

// initialWorkerStatusEvent is the retained agent:status the backend emits at spawn so a run worker
// enters the cockpit roster without waiting on the external reporter hook. Delegates to the shared
// constructor so spawn (working) and exit (idle) events share one shape.
func initialWorkerStatusEvent(blockId, runtime string, ts int64) wps.WaveEvent {
	return blockcontroller.AgentStatusEvent(blockId, baseds.AgentState_Working, runtime, ts)
}

// priorArtifacts collects the artifacts of all phases before idx (in order).
func priorArtifacts(run *waveobj.Run, idx int) []string {
	var out []string
	for i := 0; i < idx && i < len(run.Phases); i++ {
		out = append(out, run.Phases[i].Artifacts...)
	}
	return out
}

// phasePrompt builds the initial worker prompt for a phase, mode-aware: orchestrator runs get the
// adaptive lead prompt; pipeline runs get the per-phase skill prompt.
func phasePrompt(run *waveobj.Run, idx int) string {
	p := run.Phases[idx]
	if run.Mode == RunMode_Quick {
		return BuildQuickPrompt(run.Goal, run.Principles)
	}
	if run.Mode == RunMode_Orchestrator {
		return BuildOrchestratePrompt(run.Goal, run.Principles, run.Runtime, run.Orchestration)
	}
	return BuildPhasePrompt(p, run.Goal, priorArtifacts(run, idx), run.Principles)
}

// EnsureWorkers spawns a worker for each running phase that has none yet, returning the phase
// index -> tab oref it created. It does not mutate/persist the run; the caller attaches the orefs.
// The runtime comes from the persisted run; an empty runtime (legacy Run) resolves to Claude, the
// historical worker implementation. On a spawn error it returns what it has so far plus the error
// (the caller still persists partial work).
func EnsureWorkers(ctx context.Context, run *waveobj.Run, cap runroute.Capability, projectName string) (map[int]string, error) {
	spawned := map[int]string{}
	for i := range run.Phases {
		p := run.Phases[i]
		if p.State != PhaseState_Running || len(p.WorkerOrefs) > 0 {
			continue
		}
		prompt := phasePrompt(run, i)
		opts := RunWorkerOptions{KeepOnExit: run.Mode == RunMode_Orchestrator}
		oref, err := SpawnRunWorker(ctx, cap, run.WorkspaceId, projectName, run.ProjectPath, prompt, opts)
		if err != nil {
			return spawned, fmt.Errorf("spawning worker for phase %d: %w", i, err)
		}
		spawned[i] = oref
	}
	return spawned, nil
}
