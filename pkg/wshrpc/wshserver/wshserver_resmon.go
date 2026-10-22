// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"log"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/resmon"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	resMonClosedTab   = "Closed tab"
	resMonRunFallback = "Orchestrator run" // runTitle's fallback in frontend/app/view/agents/runlineage.ts

	resMonRoleLead         = "Lead"
	resMonRoleWorker       = "Worker"
	resMonRoleReviewer     = "Reviewer"
	resMonRolePlanReviewer = "Plan reviewer"
	resMonRoleVerifier     = "Verifier"
)

func (ws *WshServer) ResMonSnapshotCommand(ctx context.Context, data wshrpc.CommandResMonSnapshotData) (*wshrpc.ResMonSnapshotData, error) {
	rtn := resmon.Snapshot(ctx, resolveResMonOwner)
	return &rtn, nil
}

func (ws *WshServer) ResMonKillCommand(ctx context.Context, data wshrpc.CommandResMonKillData) (*wshrpc.ResMonKillRtnData, error) {
	rtn := resmon.Kill(ctx, resolveResMonOwner, data)
	return &rtn, nil
}

func (ws *WshServer) ResMonKillChildrenCommand(ctx context.Context, data wshrpc.CommandResMonKillChildrenData) (*wshrpc.ResMonKillRtnData, error) {
	rtn := resmon.KillChildren(ctx, resolveResMonOwner, data)
	return &rtn, nil
}

func (ws *WshServer) ResMonKillShellTaskCommand(ctx context.Context, data wshrpc.CommandResMonKillShellTaskData) (*wshrpc.ResMonKillRtnData, error) {
	rtn := resmon.KillShellTask(ctx, resolveResMonOwner, data)
	return &rtn, nil
}

// resolveResMonOwner names a job's owner from the store; an owner it cannot resolve still gets a group.
func resolveResMonOwner(ctx context.Context, o jobobject.Owner) resmon.OwnerInfo {
	if o.Kind == jobobject.OwnerKind_RunCmd {
		run, err := wstore.DBGet[*waveobj.Run](ctx, o.Id)
		if err != nil {
			log.Printf("resmon: loading run %s: %v", o.Id, err)
		}
		dag := resMonDag(ctx, run)
		runId := o.Id
		if dag != nil && dag.RunID != "" {
			runId = dag.RunID
		}
		role := o.Cmd
		if o.Task != "" {
			role = resMonTask(o.Task) + " " + o.Cmd
		}
		return resmon.OwnerInfo{Kind: wshrpc.ResMonOwner_RunCmd, Label: resMonDagTitle(dag, run), RunId: runId, Role: role}
	}
	closed := resmon.OwnerInfo{Kind: wshrpc.ResMonOwner_AgentTab, Label: resMonClosedTab}
	block, err := wstore.DBGet[*waveobj.Block](ctx, o.Id)
	if err != nil || block == nil {
		return closed
	}
	tabORef, err := waveobj.ParseORef(block.ParentORef)
	if err != nil || tabORef.OType != waveobj.OType_Tab {
		return closed
	}
	tab, err := wstore.DBGet[*waveobj.Tab](ctx, tabORef.OID)
	if err != nil || tab == nil {
		return closed
	}
	runtime := tab.Meta.GetString(waveobj.MetaKey_SessionAgent, "")
	info := resmon.OwnerInfo{Kind: wshrpc.ResMonOwner_AgentTab, Label: tab.Name, Runtime: runtime, Agent: runtime != ""}
	if run, _, ok := ownerRunForBlock(ctx, "block:"+o.Id); ok {
		info.Kind = wshrpc.ResMonOwner_RunWorker
		info.Label, info.RunId, info.Role = resMonWorkerPlace(ctx, run)
	}
	return info
}

func resMonTask(id string) string {
	return "Task " + id
}

func resMonDag(ctx context.Context, run *waveobj.Run) *waveobj.TaskGroup {
	if run == nil || run.DagORef == "" {
		return nil
	}
	dag, err := wstore.GetDag(ctx, run.DagORef)
	if err != nil {
		log.Printf("resmon: loading dag %s of run %s: %v", run.DagORef, run.OID, err)
		return nil
	}
	return dag
}

// resMonWorkerPlace is the owning run's title and id, and the worker's role in it.
func resMonWorkerPlace(ctx context.Context, run *waveobj.Run) (title, runId, role string) {
	dag := resMonDag(ctx, run)
	link, placed := runLinkOf(run, dag)
	if !placed {
		return resMonDagTitle(dag, run), run.OID, resMonRoleWorker
	}
	owner := run
	if link.RunId != run.OID {
		var err error
		if owner, err = wstore.DBGet[*waveobj.Run](ctx, link.RunId); err != nil {
			log.Printf("resmon: loading run %s: %v", link.RunId, err)
		}
	}
	return resMonDagTitle(dag, owner), link.RunId, resMonRole(link)
}

func resMonRole(link sessionRunLink) string {
	switch link.Role {
	case sessionRole_Lead:
		return resMonRoleLead
	case sessionRole_Review:
		if link.TaskId != "" {
			return resMonTask(link.TaskId) + " review"
		}
		return resMonRoleReviewer
	case jarvis.UsageRole_PlanReviewer:
		return resMonRolePlanReviewer
	case jarvis.UsageRole_Verifier:
		return resMonRoleVerifier
	case sessionRole_Worker:
		if link.TaskId != "" {
			return resMonTask(link.TaskId)
		}
		return resMonRoleWorker
	}
	return link.Role
}

func resMonDagTitle(dag *waveobj.TaskGroup, run *waveobj.Run) string {
	if dag != nil {
		if title := strings.TrimSpace(dag.Title); title != "" {
			return title
		}
	}
	if run != nil {
		if goal, _, _ := strings.Cut(strings.TrimSpace(run.Goal), "\n"); goal != "" {
			return goal
		}
	}
	return resMonRunFallback
}
