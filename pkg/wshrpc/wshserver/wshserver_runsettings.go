// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The session sheet's write path. Three things make it safe rather than merely valid. Every guard runs
// before any persistence. The wave object updates are emitted only after the write succeeded, so a control
// that was refused never leaves a view showing settings that never landed. And the Run-versus-TaskGroup
// decision is made under the same lock the engine mutates the group with — the scheduler replaces the whole
// TaskGroup from a snapshot it read there, so a write that skips the lock can be silently reverted by an
// overlapping tick and still report success.

package wshserver

import (
	"context"
	"errors"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/orchestrate"
	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// validateParallelism enforces the one width contract. zeroMeansUnset is true only for the launch form,
// whose documented 0 already means "let the lead choose"; every other caller omits the field instead, so an
// explicitly supplied 0 is a wrong model of the dial rather than an absence.
func validateParallelism(n int, zeroMeansUnset bool) error {
	if n == 0 && zeroMeansUnset {
		return nil
	}
	if n < 1 || n > orchestrate.MaxParallelism {
		return fmt.Errorf("parallelism must be an integer from 1 through %d", orchestrate.MaxParallelism)
	}
	return nil
}

// validateWorkerRoute is the worker-route half of the profile and run-settings validation. It resolves the
// route through the same resolver and harness check CreateRun uses, so a route that could not launch a
// worker cannot be stored as a default that will later fail to launch one.
func validateWorkerRoute(route *waveobj.RoutePin, requireInstalled bool) error {
	if route == nil {
		return nil
	}
	if _, err := runroute.Resolve(*route); err != nil {
		return fmt.Errorf("workerRoute %w", err)
	}
	if requireInstalled {
		if _, err := validateHarness(route.Runtime, harness.OperationRunWorker); err != nil {
			return fmt.Errorf("workerRoute %w", err)
		}
	}
	return nil
}

// validateEngineDefaults validates a profile override's engine sections before any write.
func validateEngineDefaults(o *waveobj.ProfileOverride) error {
	if o == nil {
		return nil
	}
	if o.Machine != nil && *o.Machine != jarvis.Orchestration_Engine && *o.Machine != jarvis.Orchestration_Adaptive {
		return fmt.Errorf("machine must be %q or %q", jarvis.Orchestration_Engine, jarvis.Orchestration_Adaptive)
	}
	if o.Parallelism != nil {
		// a stored default is a width, not an absence: omission is how a profile says "let the lead choose"
		if err := validateParallelism(*o.Parallelism, false); err != nil {
			return err
		}
	}
	// a profile default is stored, not launched: it is resolved against the harness catalog at launch,
	// exactly like the profile's lead route already is.
	return validateWorkerRoute(o.WorkerRoute, false)
}

// errDagLinkedDuringSettings marks the one interleave that cannot be avoided: a group appeared between
// deciding the Run was the authority and writing to it. The write must not be reported as success — the
// decision is redone against the group instead.
var errDagLinkedDuringSettings = errors.New("run gained a dag during the settings write")

// runSettingsAfterAuthorityRead is a test seam for that window. Nothing in production changes it.
var runSettingsAfterAuthorityRead = func() {}

// runSettingsAttempts bounds the Run -> TaskGroup handoff retry. One retry is the real case (a single
// submission); the rest is headroom for a pathological caller, not a loop.
const runSettingsAttempts = 4

func (ws *WshServer) SetRunSettingsCommand(ctx context.Context, data wshrpc.CommandSetRunSettingsData) error {
	if data.ChannelId == "" || data.RunId == "" {
		return fmt.Errorf("channelid and runid are required")
	}
	// shape-independent validation first: a bad width or route never reaches persistence at all
	if data.Parallelism != nil {
		if err := validateParallelism(*data.Parallelism, false); err != nil {
			return err
		}
	}
	if err := validateWorkerRoute(data.WorkerRoute, true); err != nil {
		return err
	}
	settings := jarvis.PendingEngineSettings{
		Parallelism: data.Parallelism,
		WorkerRoute: data.WorkerRoute,
		PlanGate:    data.PlanGate,
	}

	for attempt := 0; attempt < runSettingsAttempts; attempt++ {
		run, err := wstore.GetRun(ctx, data.ChannelId, data.RunId)
		if err != nil {
			return fmt.Errorf("loading run: %w", err)
		}
		if blocker := jarvis.EngineSettingsBlocker(run); blocker != "" {
			return fmt.Errorf("cannot change run settings: %s", blocker)
		}
		// the owning group is the post-submission authority. A child run carries its group's oref too, so
		// ownership is checked rather than assumed from the link.
		var group *waveobj.TaskGroup
		if run.DagORef != "" {
			g, gerr := wstore.GetDag(ctx, run.DagORef)
			if gerr != nil {
				return fmt.Errorf("loading dag: %w", gerr)
			}
			if g.RunID == run.ID {
				group = g
			}
		}
		runSettingsAfterAuthorityRead()

		if group == nil {
			raced := false
			uerr := wstore.UpdateRun(ctx, data.ChannelId, data.RunId, func(r *waveobj.Run) error {
				if r.DagORef != "" {
					raced = true
					return errDagLinkedDuringSettings
				}
				// re-checked under the write, like the taskgroup branch below: the run can go terminal
				// between the guard above and this update, and a guard that only runs before the write is
				// not the same claim as one that runs with it.
				if blocker := jarvis.EngineSettingsBlocker(r); blocker != "" {
					return errors.New(blocker)
				}
				*r = jarvis.ApplyPendingEngineSettings(*r, settings)
				return nil
			})
			if raced {
				continue // a taskgroup owns the scheduler now: decide again against it
			}
			if uerr != nil {
				return fmt.Errorf("updating run settings: %w", uerr)
			}
			publishRunUpdate(data.ChannelId, data.RunId)
			return nil
		}

		// re-read and re-validate inside the critical section: the run may have gone terminal, the gate may
		// have been approved, and a task may have been dispatched since the request was read.
		if derr := orchestrate.WithDagMutation(group.OID, func() error {
			fresh, gerr := wstore.GetDag(ctx, group.OID)
			if gerr != nil {
				return fmt.Errorf("reloading dag: %w", gerr)
			}
			if fresh.RunID != data.RunId {
				return fmt.Errorf("dag %s is not owned by run %s", group.OID, data.RunId)
			}
			freshRun, rerr := wstore.GetRun(ctx, data.ChannelId, data.RunId)
			if rerr != nil {
				return fmt.Errorf("reloading run: %w", rerr)
			}
			if blocker := jarvis.EngineSettingsBlocker(freshRun); blocker != "" {
				return fmt.Errorf("cannot change run settings: %s", blocker)
			}
			if data.PlanGate != nil {
				if blocker := jarvis.GateSettingsBlocker(freshRun, fresh); blocker != "" {
					return fmt.Errorf("cannot change the plan gate: %s", blocker)
				}
			}
			return wstore.UpdateDag(ctx, group.OID, func(cur *waveobj.TaskGroup) error {
				*cur = jarvis.ApplyLiveEngineSettings(*cur, settings)
				return nil
			})
		}); derr != nil {
			return fmt.Errorf("updating dag settings: %w", derr)
		}
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, group.OID))
		publishRunUpdate(data.ChannelId, data.RunId)
		return nil
	}
	return fmt.Errorf("run settings were not applied: the run changed under the write")
}
