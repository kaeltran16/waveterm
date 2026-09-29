// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"time"

	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// LightPickRoute is the plan reviewer's sonnet pick, resolved at dispatch like any pin.
var LightPickRoute = waveobj.RoutePin{Runtime: "claude", Model: "sonnet"}

// effectiveTaskRoute is the one precedence rule for a task's route (spec §3): a human's, an escalation's or a typed
// pin wins; a plan line or reviewer pick counts only on Reviewer picks; then the workers route; then the lead's.
func effectiveTaskRoute(task *waveobj.TaskNode, owner *waveobj.Run, group *waveobj.TaskGroup) waveobj.RoutePin {
	if task.RunSpec.Runtime != "" || task.RunSpec.Model != "" {
		runtime := task.RunSpec.Runtime
		if runtime == "" {
			runtime = owner.Runtime
		}
		pin := waveobj.RoutePin{Runtime: runroute.DefaultRuntime(runtime), Model: task.RunSpec.Model}
		switch task.ModelSource {
		case "", waveobj.TaskModelSource_Owner, waveobj.TaskModelSource_Escalation:
			return pin
		case waveobj.TaskModelSource_Plan, waveobj.TaskModelSource_Reviewer:
			if group != nil && group.ReviewerPicks {
				return pin
			}
		}
	}
	if group != nil && group.WorkerRoute != nil && (group.WorkerRoute.Runtime != "" || group.WorkerRoute.Model != "") {
		return waveobj.RoutePin{Runtime: runroute.DefaultRuntime(group.WorkerRoute.Runtime), Model: group.WorkerRoute.Model}
	}
	return waveobj.RoutePin{Runtime: runroute.DefaultRuntime(owner.Runtime), Model: owner.Model}
}

// taskWaiting reports a task that has never started, the only kind whose model the owner may still change.
func taskWaiting(t *waveobj.TaskNode) bool {
	return (t.State == TaskState_Pending || t.State == TaskState_Ready) && t.RunID == "" &&
		t.Attempts == 0 && t.Escalations == 0 && t.FirstActivity == 0
}

// setTaskModel is the owner's per-task choice. An empty target is the lead's route. Unlike escalate it also checks
// the harness, so a model this machine cannot run is refused on the panel row rather than at dispatch.
func setTaskModel(task *waveobj.TaskNode, owner *waveobj.Run, group *waveobj.TaskGroup, target waveobj.RoutePin) error {
	if !taskWaiting(task) {
		return fmt.Errorf("task %q has started (%s); a started task keeps its model", task.ID, task.State)
	}
	var pin waveobj.RoutePin
	if target.Runtime != "" || target.Model != "" {
		pin = waveobj.RoutePin{Runtime: target.Runtime, Model: target.Model}
		if pin.Runtime == "" {
			pin.Runtime = effectiveTaskRoute(task, owner, group).Runtime
		}
		if _, err := runroute.Resolve(pin); err != nil {
			return fmt.Errorf("setting %q's model: %w", task.ID, err)
		}
		if err := validateWorkerHarness(pin.Runtime); err != nil {
			return fmt.Errorf("setting %q's model: %w", task.ID, err)
		}
	}
	task.RunSpec.Runtime, task.RunSpec.Model = pin.Runtime, pin.Model
	task.ModelSource = waveobj.TaskModelSource_Owner
	return nil
}

// resetPicksToLead puts every waiting task the reviewer moved off the lead back on it, reporting whether any
// changed. A task the reviewer already left on the lead keeps its reviewer source.
func resetPicksToLead(g *waveobj.TaskGroup) bool {
	changed := false
	for i := range g.Tasks {
		t := &g.Tasks[i]
		if !taskWaiting(t) || t.PickReason == "" || (t.RunSpec.Runtime == "" && t.RunSpec.Model == "") {
			continue
		}
		t.RunSpec.Runtime, t.RunSpec.Model = "", ""
		t.ModelSource = waveobj.TaskModelSource_Owner
		changed = true
	}
	return changed
}

// applyModelActionLocked runs setmodel and leadmodels. It leaves g.Failures alone, unlike the other dag actions:
// changing a waiting task's model answers no circuit-break.
func applyModelActionLocked(ctx context.Context, g *waveobj.TaskGroup, taskID, action string, target waveobj.RoutePin) error {
	switch action {
	case "setmodel":
		task := taskByID(g, taskID)
		if task == nil {
			return fmt.Errorf("no task %q", taskID)
		}
		owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
		if err != nil {
			return fmt.Errorf("loading owner run: %w", err)
		}
		if err := setTaskModel(task, owner, g, target); err != nil {
			return err
		}
	case "leadmodels":
		if !resetPicksToLead(g) {
			return nil
		}
	default:
		return fmt.Errorf("unknown dag action %q", action)
	}
	g.UpdatedTs = time.Now().UnixMilli()
	if err := wstore.UpdateDag(ctx, g.OID, func(cur *waveobj.TaskGroup) error {
		*cur = *g
		return nil
	}); err != nil {
		return err
	}
	wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, g.OID))
	return nil
}
