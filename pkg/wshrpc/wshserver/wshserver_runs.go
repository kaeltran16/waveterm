// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/reporadar"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// runSpawnLocks serializes spawnRunWorkers per runId so the read-back double-spawn guard
// (len(WorkerOrefs) > 0) is effective across concurrent CreateRun/AdvanceRun calls for one run.
var runSpawnLocks = newKeyedMutex()

// runWorkerSpawnTimeout bounds detached worker-spawn work; evidenceSealTimeout bounds detached evidence
// sealing (git diff + transcript reads). Both are generous so the short FE-call budget can't cancel
// CreateTab mid-flight (orphaning a tab) or cut a git diff short into an empty, immutable snapshot.
const (
	runWorkerSpawnTimeout = 60 * time.Second
	evidenceSealTimeout   = 30 * time.Second
)

// spawnRunWorkers reads the run back, spawns workers for any newly-running phase, and persists the
// attached orefs — a second write, so tab-creation never nests inside the run's state-transition write.
//
// EnsureWorkers creates a tab + block per worker (via wcore.CreateTab), which mutates the workspace's
// tab list and inserts new objects. Those mutations only reach the frontend if this ctx collects and
// flushes their update events — without that, the workspace atom never gains the worker's tab, the tab
// never enters the session roster, and the run renders a false "worker exited" until a full reload.
func spawnRunWorkers(ctx context.Context, channelId, runId, projectName string) error {
	runSpawnLocks.Lock(runId)
	defer runSpawnLocks.Unlock(runId)
	// detach from the caller's RPC budget (a 5s FE-call ctx): worker spawning calls wcore.CreateTab, and a
	// mid-flight cancellation would orphan a half-created tab. keep parent values, bound with our own deadline.
	ctx = context.WithoutCancel(ctx)
	ctx, cancel := context.WithTimeout(ctx, runWorkerSpawnTimeout)
	defer cancel()
	ctx = waveobj.ContextWithUpdates(ctx)
	run, err := wstore.GetRun(ctx, channelId, runId)
	if err != nil {
		return err
	}
	spawned, spawnErr := jarvis.EnsureWorkers(ctx, run, projectName)
	if len(spawned) > 0 {
		if uerr := wstore.UpdateRun(ctx, channelId, runId, func(r *waveobj.Run) error {
			for idx, oref := range spawned {
				if idx >= 0 && idx < len(r.Phases) {
					r.Phases[idx].WorkerOrefs = append(r.Phases[idx].WorkerOrefs, oref)
				}
			}
			return nil
		}); uerr != nil {
			return uerr
		}
	}
	wps.Broker.SendUpdateEvents(waveobj.ContextGetUpdatesRtn(ctx))
	return spawnErr // surfaced but non-fatal to already-persisted state
}

// stopWorkerORef terminates one worker the run owns: it parses the tab oref, and for each block in the
// tab flips cmd:runonstart off (so a later ResyncController can't relaunch the command) then destroys the
// block controller, killing the claude process (the idle-on-exit backstop in shellcontroller then flips
// the roster row working->idle). Returns an error only for the resolution boundary (bad oref / missing
// tab). A meta-write failure and an already-dead controller are logged no-ops, never fatal — a worker is
// spawned with cmd:runonstart defaulting true and no cmd:runonce, so the flip is what makes the kill
// durable: without it, opening the tab (or a reload) would resync the block and revive the worker.
func stopWorkerORef(ctx context.Context, workerORef string) error {
	oref, err := waveobj.ParseORef(workerORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		return fmt.Errorf("bad worker oref %q: %w", workerORef, err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, oref.OID)
	if err != nil {
		return fmt.Errorf("loading tab %q: %w", workerORef, err)
	}
	for _, blockId := range tab.BlockIds {
		meta := waveobj.MetaMapType{waveobj.MetaKey_CmdRunOnStart: false}
		if merr := wstore.UpdateObjectMeta(ctx, waveobj.MakeORef(waveobj.OType_Block, blockId), meta, false); merr != nil {
			log.Printf("stopWorkerORef: clearing runonstart on block %s: %v", blockId, merr)
		}
		blockcontroller.DestroyBlockController(blockId)
	}
	return nil
}

// stopRunWorkers terminates every live worker the run owns (best-effort; each worker's failure is logged,
// never fatal — the run's cancelled state is already persisted).
func stopRunWorkers(ctx context.Context, run *waveobj.Run) {
	for i := range run.Phases {
		for _, workerORef := range run.Phases[i].WorkerOrefs {
			if err := stopWorkerORef(ctx, workerORef); err != nil {
				log.Printf("stopRunWorkers: %v", err)
			}
		}
	}
}

// resolveRunPlan derives the effective mode + playbook for a new run from the resolved profile and the
// request's optional overrides. Precedence: request > profile default > built-in (pipeline; gate on).
func resolveRunPlan(resolved waveobj.JarvisProfile, reqMode string, reqPlanGate *bool) (string, []waveobj.RunPhase) {
	mode := reqMode
	if mode == "" {
		mode = resolved.DefaultMode
	}
	if mode == "" {
		mode = jarvis.RunMode_Pipeline
	}
	if mode == jarvis.RunMode_Quick {
		// quick is a bare single-phase run; it has no plan gate, so reqPlanGate is ignored.
		return mode, jarvis.QuickPlaybook()
	}
	if mode == jarvis.RunMode_Orchestrator {
		gate := true
		if reqPlanGate != nil {
			gate = *reqPlanGate
		} else if resolved.DefaultPlanGate != nil {
			gate = *resolved.DefaultPlanGate
		}
		return mode, jarvis.DefaultOrchestratorPlaybook(gate)
	}
	playbook := resolved.Playbook
	if len(playbook) == 0 {
		playbook = jarvis.DefaultPlaybook()
	}
	return mode, playbook
}

// childRunPlan derives a hands-off playbook for a child run: resolve the plan for the requested (or inherited)
// mode with the plan gate off, then strip any phase-level gates. A child never halts for human review — the
// decomposition was already gated once at the parent lead's plan gate.
func childRunPlan(resolved waveobj.JarvisProfile, reqMode string) (string, []waveobj.RunPhase) {
	gateOff := false
	mode, pb := resolveRunPlan(resolved, reqMode, &gateOff)
	return mode, jarvis.StripPhaseGates(pb)
}

func (ws *WshServer) CreateRunCommand(ctx context.Context, data wshrpc.CommandCreateRunData) (*wshrpc.CommandCreateRunRtnData, error) {
	if data.ChannelId == "" || data.WorkspaceId == "" || data.Goal == "" {
		return nil, fmt.Errorf("channelid, workspaceid and goal are required")
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
	if err != nil {
		return nil, fmt.Errorf("loading channel: %w", err)
	}
	global := jarvis.LoadGlobalProfile()
	resolved := jarvis.ResolveProfile(global, jarvis.OverrideFromMeta(ch))
	mode, playbook := resolveRunPlan(resolved, data.Mode, data.PlanGate)
	run := jarvis.NewRun(data.Goal, data.WorkspaceId, ch.ProjectPath, resolved.Principles, mode, playbook, time.Now().UnixMilli())
	// capture the repo baseline so the evidence diff survives the worker committing its changes;
	// non-fatal — an unborn/absent repo just leaves BaseCommit "" and the diff falls back to HEAD.
	if head, herr := gitinfo.HeadCommit(ctx, ch.ProjectPath); herr == nil {
		run.BaseCommit = head
	}
	run.RadarOrigin = data.RadarOrigin // nil for normal runs; set only from a Radar handoff
	if err := wstore.AppendRun(ctx, data.ChannelId, run); err != nil {
		return nil, fmt.Errorf("appending run: %w", err)
	}
	if run.RadarOrigin != nil {
		inv := reporadar.InvestigationFromRun(&run, data.ChannelId, "executing", run.CreatedTs)
		if rerr := reporadar.RecordInvestigation(ctx, run.ProjectPath, run.RadarOrigin.Fingerprint, inv); rerr != nil {
			log.Printf("CreateRun: recording radar investigation (executing) failed: %v", rerr)
		}
	}
	if err := spawnRunWorkers(ctx, data.ChannelId, run.ID, ch.Name); err != nil {
		// the run is persisted; surface the spawn failure but return the run so the UI can show blocked/retry
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
		return nil, fmt.Errorf("spawning first worker: %w", err)
	}
	out, _ := wstore.GetRun(ctx, data.ChannelId, run.ID)
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return &wshrpc.CommandCreateRunRtnData{Run: out}, nil
}

func (ws *WshServer) CreateChildRunCommand(ctx context.Context, data wshrpc.CommandCreateChildRunData) (*wshrpc.CommandCreateChildRunRtnData, error) {
	if data.ORef == "" || data.Goal == "" {
		return nil, fmt.Errorf("oref and goal are required")
	}
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return nil, fmt.Errorf("loading channels: %w", err)
	}
	m := jarvis.ResolveRunWorker(channels, data.ORef)
	if m == nil {
		return nil, fmt.Errorf("no run owns oref %q", data.ORef)
	}
	channelId := m.Channel.OID
	parent := m.Run
	mode := data.Mode
	if mode == "" {
		mode = parent.Mode // inherit the channel strategy the parent run was created with
	}
	resolved := jarvis.ResolveProfile(jarvis.LoadGlobalProfile(), jarvis.OverrideFromMeta(m.Channel))
	childMode, playbook := childRunPlan(resolved, mode)
	child := jarvis.NewRun(data.Goal, parent.WorkspaceId, parent.ProjectPath, parent.Principles, childMode, playbook, time.Now().UnixMilli())
	child.ParentLeadORef = data.ORef
	if head, herr := gitinfo.HeadCommit(ctx, parent.ProjectPath); herr == nil {
		child.BaseCommit = head
	}
	if err := wstore.AppendRun(ctx, channelId, child); err != nil {
		return nil, fmt.Errorf("appending child run: %w", err)
	}
	if err := spawnRunWorkers(ctx, channelId, child.ID, m.Channel.Name); err != nil {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelId))
		return nil, fmt.Errorf("spawning child worker: %w", err)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, channelId))
	return &wshrpc.CommandCreateChildRunRtnData{RunId: child.ID}, nil
}

// steerRunLead sends a line of input into the block of a run worker (tab oref "tab:<id>"), resuming a
// long-lived lead in place. Best-effort: resolution/send failures are logged, never fatal. It is a var so
// tests can observe the parent notify-back without a live PTY.
var steerRunLead = func(ctx context.Context, tabORef, text string) {
	oref, err := waveobj.ParseORef(tabORef)
	if err != nil || oref.OType != waveobj.OType_Tab {
		log.Printf("steerRunLead: bad oref %q: %v", tabORef, err)
		return
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, oref.OID)
	if err != nil || len(tab.BlockIds) == 0 {
		log.Printf("steerRunLead: no block for %q: %v", tabORef, err)
		return
	}
	if err := blockcontroller.SendInput(tab.BlockIds[0], &blockcontroller.BlockInputUnion{InputData: []byte(text)}); err != nil {
		log.Printf("steerRunLead: sending input to %q: %v", tabORef, err)
	}
}

// applyRunAction dispatches a run action to the matching engine transition (pure; no persistence).
// Triage is non-blocking — it records the lead's verdict and leaves progress untouched.
func applyRunAction(r waveobj.Run, data wshrpc.CommandAdvanceRunData, ts int64) (waveobj.Run, error) {
	switch data.Action {
	case jarvis.RunAction_Complete:
		next, err := jarvis.CompletePhase(r, data.PhaseIdx, data.Artifacts, ts)
		if err == nil && data.Commit != "" {
			next.EndCommit = data.Commit // the run's reported result commit; scopes the sealed evidence diff
		}
		return next, err
	case jarvis.RunAction_Approve:
		return jarvis.ApproveGate(r, ts)
	case jarvis.RunAction_SendBack:
		return jarvis.SendBackGate(r, ts)
	case jarvis.RunAction_Hold:
		return jarvis.HoldPhase(r, data.PhaseIdx, data.Artifacts)
	case jarvis.RunAction_Triage:
		return jarvis.RecordTriage(r, data.PhaseIdx, data.Verdict, data.Note)
	default:
		return r, fmt.Errorf("unknown run action %q", data.Action)
	}
}

func (ws *WshServer) AdvanceRunCommand(ctx context.Context, data wshrpc.CommandAdvanceRunData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	// approve-in-place: an orchestrator lead held at the plan gate resumes via steer, not a fresh worker.
	leadToSteer := ""
	if data.Action == jarvis.RunAction_Approve {
		if pre, perr := wstore.GetRun(ctx, data.ChannelId, data.RunId); perr == nil {
			for i := range pre.Phases {
				if pre.Phases[i].State == jarvis.PhaseState_Running && pre.Phases[i].Held && len(pre.Phases[i].WorkerOrefs) > 0 {
					leadToSteer = pre.Phases[i].WorkerOrefs[0]
					break
				}
			}
		}
	}
	ts := time.Now().UnixMilli()
	err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		next, e := applyRunAction(*r, data, ts)
		if e != nil {
			return e
		}
		*r = next
		return nil
	})
	if err != nil {
		return fmt.Errorf("advancing run: %w", err)
	}
	// seal the immutable evidence snapshot on the non-done -> done transition, then notify the parent lead
	// (if this is a child run). The notify is keyed on Done, not on evidence, so an empty-diff run still wakes
	// its parent. Reached once per run: applyRunAction errors on an already-done run.
	if run, gerr := wstore.GetRun(ctx, data.ChannelId, data.RunId); gerr == nil && run.Status == jarvis.RunStatus_Done {
		if run.Evidence == nil {
			// detach the seal from the FE-call budget so a slow git diff can't be canceled into an empty
			// (then immutable) snapshot; SealEvidence refuses to seal on a git failure/timeout, leaving the
			// run unsealed for the backfill (SealRunEvidenceCommand) to retry.
			sealCtx, sealCancel := context.WithTimeout(context.WithoutCancel(ctx), evidenceSealTimeout)
			serr := jarvis.SealEvidence(sealCtx, run)
			sealCancel()
			if serr != nil {
				log.Printf("AdvanceRun: sealing evidence for run %s deferred to backfill: %v", data.RunId, serr)
			} else if run.Evidence != nil {
				ev := run.Evidence
				completedTs := run.CompletedTs
				if uerr := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
					if r.Evidence == nil { // idempotent under concurrent advances
						r.Evidence = ev
						r.CompletedTs = completedTs
					}
					return nil
				}); uerr != nil {
					log.Printf("AdvanceRun: persisting evidence for run %s failed: %v", data.RunId, uerr)
				}
				if run.RadarOrigin != nil {
					inv := reporadar.InvestigationFromRun(run, data.ChannelId, "done", run.CompletedTs)
					if rerr := reporadar.RecordInvestigation(ctx, run.ProjectPath, run.RadarOrigin.Fingerprint, inv); rerr != nil {
						log.Printf("AdvanceRun: recording radar investigation (done) failed: %v", rerr)
					}
				}
			}
		}
		if line, ok := jarvis.ParentNotifyLine(run); ok {
			steerRunLead(ctx, run.ParentLeadORef, line)
		}
	}
	ch, err := wstore.DBMustGet[*waveobj.Channel](ctx, data.ChannelId)
	if err != nil {
		return fmt.Errorf("loading channel: %w", err)
	}
	if err := spawnRunWorkers(ctx, data.ChannelId, data.RunId, ch.Name); err != nil {
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
		return fmt.Errorf("spawning next worker: %w", err)
	}
	if leadToSteer != "" {
		steerRunLead(ctx, leadToSteer, "approved, proceed\r")
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

func (ws *WshServer) ReportRunPhaseCommand(ctx context.Context, data wshrpc.CommandReportRunPhaseData) error {
	if data.ORef == "" {
		return fmt.Errorf("oref is required")
	}
	channels, err := wstore.GetChannels(ctx)
	if err != nil {
		return fmt.Errorf("loading channels: %w", err)
	}
	m := jarvis.ResolveRunWorker(channels, data.ORef)
	if m == nil {
		log.Printf("ReportRunPhase: no run owns oref %q (ignoring)", data.ORef)
		return nil // fail safe: a stray report is a no-op, not an error
	}
	return ws.AdvanceRunCommand(ctx, wshrpc.CommandAdvanceRunData{
		ChannelId: m.Channel.OID,
		RunId:     m.Run.ID,
		PhaseIdx:  m.PhaseIdx,
		Action:    data.Action,
		Artifacts: data.Artifacts,
		Verdict:   data.Verdict,
		Note:      data.Note,
		Commit:    data.Commit,
	})
}

func (ws *WshServer) CancelRunCommand(ctx context.Context, data wshrpc.CommandCancelRunData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	err := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		*r = jarvis.CancelRun(*r)
		return nil
	})
	if err != nil {
		return fmt.Errorf("cancelling run: %w", err)
	}
	// stop the live workers the run spawned; state is already persisted, so this is best-effort.
	if run, gerr := wstore.GetRun(ctx, data.ChannelId, data.RunId); gerr == nil {
		stopRunWorkers(ctx, run)
		if line, ok := jarvis.ParentNotifyLine(run); ok {
			steerRunLead(ctx, run.ParentLeadORef, line)
		}
		if run.RadarOrigin != nil {
			inv := reporadar.InvestigationFromRun(run, data.ChannelId, "cancelled", time.Now().UnixMilli())
			if rerr := reporadar.RecordInvestigation(ctx, run.ProjectPath, run.RadarOrigin.Fingerprint, inv); rerr != nil {
				log.Printf("CancelRun: recording radar investigation (cancelled) failed: %v", rerr)
			}
		}
	} else {
		log.Printf("CancelRun: reload for worker stop failed: %v", gerr)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

// StopRunWorkerCommand stops one worker the run owns — the per-worker action of the cancelled-run
// partial-failure surface (its only caller). The guard is ownership only (RunOwnsWorker), not a
// run-status check: the command is a general owned-worker stop, and the cancelled-ness lives in the FE
// that calls it. The kill's success is observed via the roster flipping to idle (the FE re-derives
// survivors); this returns an error only for validation / ownership failures.
func (ws *WshServer) StopRunWorkerCommand(ctx context.Context, data wshrpc.CommandStopRunWorkerData) error {
	if data.ChannelId == "" || data.RunId == "" || data.WorkerORef == "" {
		return fmt.Errorf("channelid, runid and workeroref are required")
	}
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if !jarvis.RunOwnsWorker(run, data.WorkerORef) {
		return fmt.Errorf("run %s does not own worker %s", data.RunId, data.WorkerORef)
	}
	if serr := stopWorkerORef(ctx, data.WorkerORef); serr != nil {
		return fmt.Errorf("stopping worker: %w", serr)
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}

// SealRunEvidenceCommand derives and persists a done run's evidence snapshot if it has none yet — the
// lazy backfill for runs completed before the feature existed (new runs seal at completion in
// AdvanceRun). Idempotent: a run already sealed is a no-op. Only seals runs in the done state.
func (ws *WshServer) SealRunEvidenceCommand(ctx context.Context, data wshrpc.CommandSealRunEvidenceData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
	if err != nil {
		return fmt.Errorf("loading run: %w", err)
	}
	if run.Status != jarvis.RunStatus_Done || run.Evidence != nil {
		return nil // nothing to seal
	}
	// detach from the FE-call budget so a slow git diff isn't canceled into an empty snapshot; on a git
	// failure/timeout SealEvidence returns an error and leaves Evidence nil, so this backfill can retry.
	sealCtx, sealCancel := context.WithTimeout(context.WithoutCancel(ctx), evidenceSealTimeout)
	serr := jarvis.SealEvidence(sealCtx, run)
	sealCancel()
	if serr != nil || run.Evidence == nil {
		return serr
	}
	ev, completedTs := run.Evidence, run.CompletedTs
	if uerr := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
		if r.Evidence == nil {
			r.Evidence = ev
			r.CompletedTs = completedTs
		}
		return nil
	}); uerr != nil {
		return fmt.Errorf("persisting evidence: %w", uerr)
	}
	if run.RadarOrigin != nil {
		inv := reporadar.InvestigationFromRun(run, data.ChannelId, "done", run.CompletedTs)
		if rerr := reporadar.RecordInvestigation(ctx, run.ProjectPath, run.RadarOrigin.Fingerprint, inv); rerr != nil {
			log.Printf("SealRunEvidence: recording radar investigation (done) failed: %v", rerr)
		}
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Channel, data.ChannelId))
	return nil
}
