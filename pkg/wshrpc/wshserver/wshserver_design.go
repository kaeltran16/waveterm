// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// deleteDesignLeadTab closes the tab of a lead that handed its run to a design session. A var so tests need no
// live workspace. The app drops the tab only on a broadcast workspace update, so the updates are collected and sent.
var deleteDesignLeadTab = func(ctx context.Context, workspaceId, tabId string) error {
	ctx = waveobj.ContextWithUpdates(ctx)
	defer func() { wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx)) }()
	_, err := wcore.DeleteTab(ctx, workspaceId, tabId, true)
	return err
}

func checkDesignKind(kind string) error {
	if kind != waveobj.RunDesignKind_Brainstorm && kind != waveobj.RunDesignKind_Canvas {
		return fmt.Errorf("design kind is %s or %s, not %q", waveobj.RunDesignKind_Brainstorm, waveobj.RunDesignKind_Canvas, kind)
	}
	return nil
}

// checkDesignFirst refuses a Design first launch with no goal to design, or nobody to design it with. data's
// Autonomous is the resolved setting.
func checkDesignFirst(data wshrpc.CommandCreateRunData, engineLaunch bool) error {
	switch {
	case data.DesignFirst == "":
		return nil
	case !engineLaunch:
		return fmt.Errorf("design first needs an orchestrator run")
	case data.PlanPath != "":
		return fmt.Errorf("design first starts from a goal, not a plan")
	case data.Spec != "" || data.Prototype != "":
		return fmt.Errorf("design first starts from a goal: this run already has a design")
	case data.Autonomous != nil && *data.Autonomous:
		return fmt.Errorf("design first needs a human: this run's approvals are autonomous")
	}
	return checkDesignKind(data.DesignFirst)
}

// checkDesignFile refuses a spec or prototype path the lead could not open.
func checkDesignFile(field, path string) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("%s %q must be absolute", field, path)
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("%s %q: %w", field, path, err)
	}
	return nil
}

// startDesignSession starts the design session run waits on, in place of a lead: a normal interactive session
// on the run's lead route, in the main checkout (where .superpowers/ and the specs live). The run reads
// planning with Design set until the session's design attaches. Both entry points, CreateRun's Design first
// and a lead's `wsh jarvis design`, come through here.
func startDesignSession(ctx context.Context, channelId string, run *waveobj.Run, kind string) (string, error) {
	if err := checkDesignKind(kind); err != nil {
		return "", err
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, channelId)
	if err != nil {
		return "", fmt.Errorf("loading channel: %w", err)
	}
	pin := waveobj.RoutePin{Runtime: runroute.DefaultRuntime(run.Runtime), Model: run.Model}
	cap, err := runroute.Resolve(pin)
	if err != nil {
		return "", err
	}
	if _, err := validateHarness(pin.Runtime, harness.OperationRunWorker); err != nil {
		return "", err
	}
	// a half-created tab would outlive a caller that stopped waiting
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), jarvis.RunWorkerSpawnTimeout)
	defer cancel()
	oref, err := jarvis.SpawnRunWorker(ctx, cap, run.WorkspaceId, ch.Name, run.ProjectPath, jarvis.DesignSessionPrompt(run.Goal, kind), jarvis.DesignSessionOptions(run.Goal))
	if err != nil {
		return "", fmt.Errorf("spawning the design session: %w", err)
	}
	blockId, err := tabBlockId(ctx, oref)
	if err != nil {
		return "", err
	}
	if err := jarvis.StartRunWorker(ctx, oref); err != nil {
		return "", fmt.Errorf("starting the design session: %w", err)
	}
	design := &waveobj.RunDesign{Kind: kind, BlockId: blockId}
	if err := wstore.UpdateRun(ctx, channelId, run.ID, func(r *waveobj.Run) error {
		r.Design = design
		r.Status = jarvis.RunStatus_Planning
		return nil
	}); err != nil {
		return "", fmt.Errorf("recording the design session: %w", err)
	}
	run.Design, run.Status = design, jarvis.RunStatus_Planning
	appendRunEvent(ctx, channelId, run.ID, waveobj.RunEventKindDesignStarted, nil, map[string]any{"kind": kind, "blockid": blockId})
	publishRunUpdate(channelId, run.ID)
	return blockId, nil
}

// tabBlockId is the block of a spawned session's tab: the design session is found by it, as the pane knows it.
func tabBlockId(ctx context.Context, tabORef string) (string, error) {
	oref, err := waveobj.ParseORef(tabORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		return "", fmt.Errorf("bad session oref %q", tabORef)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, oref.OID)
	if err != nil {
		return "", fmt.Errorf("loading the session's tab: %w", err)
	}
	if len(tab.BlockIds) == 0 {
		return "", fmt.Errorf("session tab %s has no block", oref.OID)
	}
	return tab.BlockIds[0], nil
}

// RunDesignAttachCommand is a design session's Approve / Build this…: the run waiting on the session takes its
// design and starts its lead. A block no run ever waited on is a normal session, answered with an empty reply.
func (ws *WshServer) RunDesignAttachCommand(ctx context.Context, data wshrpc.CommandRunDesignAttachData) (*wshrpc.CommandRunDesignAttachRtnData, error) {
	if data.BlockId == "" {
		return nil, fmt.Errorf("blockid is required")
	}
	if data.Spec == "" && data.Prototype == "" {
		return nil, fmt.Errorf("a design attaches a spec, a prototype or both")
	}
	if data.Spec != "" {
		if err := checkDesignFile("spec", data.Spec); err != nil {
			return nil, err
		}
	}
	if data.Prototype != "" {
		if err := checkDesignFile("prototype", data.Prototype); err != nil {
			return nil, err
		}
	}
	// the block id names the session in Design or DesignSession, so the rows that hold it are the candidates
	runs, err := wstore.GetRunCandidatesByWorker(ctx, data.BlockId)
	if err != nil {
		return nil, fmt.Errorf("finding the run waiting on %s: %w", data.BlockId, err)
	}
	var waiting, took *waveobj.Run
	for _, r := range runs {
		switch {
		case r.Mode == jarvis.RunMode_Orchestrator && r.Status == jarvis.RunStatus_Planning && r.Design != nil && r.Design.BlockId == data.BlockId:
			waiting = r
		case r.DesignSession == data.BlockId:
			took = r
		}
	}
	if waiting == nil {
		if took != nil {
			return nil, fmt.Errorf("run %s already took this session's design", took.ID)
		}
		return &wshrpc.CommandRunDesignAttachRtnData{}, nil
	}
	channelId, runId := waiting.ChannelOID, waiting.ID
	if err := wstore.UpdateRun(ctx, channelId, runId, func(r *waveobj.Run) error {
		// decided under the update: a second Approve racing this one finds the design already taken
		if r.Design == nil || r.Design.BlockId != data.BlockId {
			if r.DesignSession == data.BlockId {
				return fmt.Errorf("run %s already took this session's design", runId)
			}
			return fmt.Errorf("run %s is not waiting on this session's design", runId)
		}
		if data.Spec != "" {
			r.Spec = data.Spec
		}
		if data.Prototype != "" {
			r.Prototype = data.Prototype
		}
		r.DesignSession, r.Design = data.BlockId, nil
		// its lead starts now, which is what an executing orchestrator run is
		r.Status = jarvis.RunStatus_Executing
		return nil
	}); err != nil {
		return nil, err
	}
	appendRunEvent(ctx, channelId, runId, waveobj.RunEventKindDesignAttached, nil, map[string]any{"spec": data.Spec, "prototype": data.Prototype})
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, channelId)
	if err != nil {
		return nil, fmt.Errorf("loading channel: %w", err)
	}
	// the run's prompt is the plan-from-design one now that it holds the design
	if err := spawnRunWorkersWithPrompt(ctx, channelId, runId, ch.Name, ""); err != nil {
		publishRunUpdate(channelId, runId)
		return nil, fmt.Errorf("starting the lead: %w", err)
	}
	publishRunUpdate(channelId, runId)
	return &wshrpc.CommandRunDesignAttachRtnData{ChannelId: channelId, RunId: runId}, nil
}

// JarvisDesignCommand is a lead's `wsh jarvis design`: its run waits on a design session instead, and the lead's
// tab closes. The lead does not wait for the design; a fresh lead plans from it once it attaches.
func (ws *WshServer) JarvisDesignCommand(ctx context.Context, data wshrpc.CommandJarvisDesignData) error {
	if err := checkDesignKind(data.Kind); err != nil {
		return err
	}
	tabORef, err := callerTabORef(ctx, data.ORef)
	if err != nil {
		return err
	}
	m := jarvis.ResolveRunWorkerFromMeta(ctx, tabORef)
	if m == nil {
		return fmt.Errorf("no run owns %q", data.ORef)
	}
	run := m.Run
	switch {
	case run.Mode != jarvis.RunMode_Orchestrator:
		return fmt.Errorf("design needs an orchestrator run")
	case run.Autonomous:
		return fmt.Errorf("design needs a human: this run's approvals are autonomous")
	case run.DagORef != "":
		return fmt.Errorf("run %s already has a plan: the design comes before it", run.ID)
	}
	// the lead's tab is the caller's process: what follows must finish after it is gone
	ctx = context.WithoutCancel(ctx)
	channelId := m.Channel.OID
	if _, err := startDesignSession(ctx, channelId, run, data.Kind); err != nil {
		return err
	}
	// the lead's oref goes first: closing a run's agent tab fails the phase that lists it (HandleWorkerTabClose)
	if err := wstore.UpdateRun(ctx, channelId, run.ID, func(r *waveobj.Run) error {
		for i := range r.Phases {
			kept := r.Phases[i].WorkerOrefs[:0]
			for _, oref := range r.Phases[i].WorkerOrefs {
				if !strings.HasPrefix(oref, "tab:") {
					kept = append(kept, oref)
				}
			}
			r.Phases[i].WorkerOrefs = kept
		}
		return nil
	}); err != nil {
		return fmt.Errorf("removing the lead from run %s: %w", run.ID, err)
	}
	publishRunUpdate(channelId, run.ID)
	tabId := strings.TrimPrefix(tabORef, "tab:")
	if err := deleteDesignLeadTab(ctx, run.WorkspaceId, tabId); err != nil {
		log.Printf("JarvisDesign: closing lead tab %s of run %s: %v", tabId, run.ID, err)
	}
	return nil
}

// callerTabORef is the tab of the caller's oref: wsh sends its block, and a run lists its lead by tab.
func callerTabORef(ctx context.Context, orefStr string) (string, error) {
	oref, err := waveobj.ParseORef(orefStr)
	if err != nil {
		return "", fmt.Errorf("bad oref %q: %w", orefStr, err)
	}
	switch oref.OType {
	case waveobj.OType_Tab:
		return oref.String(), nil
	case waveobj.OType_Block:
		block, err := wstore.DBMustGet[*waveobj.Block](ctx, oref.OID)
		if err != nil {
			return "", fmt.Errorf("loading block %s: %w", oref.OID, err)
		}
		tabRef, err := waveobj.ParseORef(block.ParentORef)
		if err != nil || tabRef.OType != waveobj.OType_Tab {
			return "", fmt.Errorf("block %s is not in a tab", oref.OID)
		}
		return tabRef.String(), nil
	}
	return "", fmt.Errorf("oref %q is not a tab or a block", orefStr)
}
