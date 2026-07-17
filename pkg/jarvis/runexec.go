// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// SpawnClaudeWorker creates a background tab running `claude --dangerously-skip-permissions <prompt>` in
// cwd and returns its tab oref ("tab:<id>"). Mirrors the frontend launchAgent path for the claude runtime,
// but the permission-skip flag is mandatory here (opt-in in the launcher): a run worker is headless with no
// human attached, so without it claude blocks forever on the folder-trust dialog / per-tool prompts —
// alive but never running, never firing the hooks that report agent:status (the "worker never starts"
// symptom). Configure the new tab's default block as a cmd worker, tag the tab for the roster, and
// force-start the controller (controllers otherwise start lazily on a frontend terminal resync —
// force=true launches it headlessly).
//
// It is a var so tests can stub the process-spawning boundary without a live tab/PTY.
var SpawnClaudeWorker = func(ctx context.Context, workspaceId, projectName, cwd, prompt string) (string, error) {
	if workspaceId == "" {
		return "", fmt.Errorf("workspaceId is required to spawn a worker")
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

	blockMeta := waveobj.MetaMapType{
		waveobj.MetaKey_View:       "term",
		waveobj.MetaKey_Controller: "cmd",
		waveobj.MetaKey_Cmd:        "claude",
		waveobj.MetaKey_CmdArgs:    []string{"--dangerously-skip-permissions", prompt},
		waveobj.MetaKey_CmdShell:   false,
		waveobj.MetaKey_CmdJwt:     true,
	}
	if cwd != "" {
		blockMeta[waveobj.MetaKey_CmdCwd] = cwd
	}
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId), blockMeta, false); err != nil {
		return "", fmt.Errorf("setting worker block meta: %w", err)
	}
	// Tab meta: put the worker in the agent roster (and route the external status reporter). These keys
	// have no generated constants; the literals match the frontend (see launchAgent).
	tabMeta := waveobj.MetaMapType{
		"session:agent":   "claude",
		"session:project": projectName,
	}
	if err := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Tab, tabId), tabMeta, false); err != nil {
		return "", fmt.Errorf("setting worker tab meta: %w", err)
	}
	if err := blockcontroller.ResyncController(ctx, tabId, blockId, &waveobj.RuntimeOpts{}, true); err != nil {
		return "", fmt.Errorf("starting worker controller: %w", err)
	}
	// Make the worker visible in the roster immediately. The roster keys off agent:status, which
	// otherwise arrives only from the external reporter hook — unreliable for a headless worker (the
	// hook may be owned by a coexisting install and route to the wrong wavesrv). A real hook event
	// later refines this (detail/model, idle-on-stop).
	wps.Broker.Publish(initialWorkerStatusEvent(blockId, time.Now().UnixMilli()))
	return waveobj.MakeORef(waveobj.OType_Tab, tabId).String(), nil
}

// initialWorkerStatusEvent is the retained agent:status the backend emits at spawn so a run worker
// enters the cockpit roster without waiting on the external reporter hook. Delegates to the shared
// constructor so spawn (working) and exit (idle) events share one shape.
func initialWorkerStatusEvent(blockId string, ts int64) wps.WaveEvent {
	return blockcontroller.AgentStatusEvent(blockId, baseds.AgentState_Working, "claude", ts)
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
		return BuildOrchestratePrompt(run.Goal, run.Principles, p.Gate)
	}
	return BuildPhasePrompt(p, run.Goal, priorArtifacts(run, idx), run.Principles)
}

// EnsureWorkers spawns a claude worker for each running phase that has none yet, returning the phase
// index -> tab oref it created. It does not mutate/persist the run; the caller attaches the orefs.
// On a spawn error it returns what it has so far plus the error (the caller still persists partial work).
func EnsureWorkers(ctx context.Context, run *waveobj.Run, projectName string) (map[int]string, error) {
	spawned := map[int]string{}
	for i := range run.Phases {
		p := run.Phases[i]
		if p.State != PhaseState_Running || len(p.WorkerOrefs) > 0 {
			continue
		}
		prompt := phasePrompt(run, i)
		oref, err := SpawnClaudeWorker(ctx, run.WorkspaceId, projectName, run.ProjectPath, prompt)
		if err != nil {
			return spawned, fmt.Errorf("spawning worker for phase %d: %w", i, err)
		}
		spawned[i] = oref
	}
	return spawned, nil
}
