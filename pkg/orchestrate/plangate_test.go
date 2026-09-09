// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// The gate is the pair (PlanGate, PlanApprovedTs), never the status string: every recompute derives
// the status from task state, so a gate that lived in the status alone would be released by the next
// unrelated mutation.
func TestGatedPlanHoldsStatusAndDispatch(t *testing.T) {
	g := mustGroup(t, mkTasks())
	GatePlan(g)

	if g.Status != DagStatus_AwaitingPlan {
		t.Fatalf("status = %q, want %q", g.Status, DagStatus_AwaitingPlan)
	}
	if next := NextToSpawn(g); len(next) != 0 {
		t.Fatalf("a gated plan must dispatch nothing, got %v", next)
	}
	// ReadyTasks stays unguarded so the digest can still report what is being held back
	if ready := ReadyTasks(g); len(ready) != 1 || ready[0] != "t-0" {
		t.Fatalf("ready tasks = %v, want [t-0] even while gated", ready)
	}

	// an unrelated recompute must not release it
	RecomputeDagStatus(g)
	if g.Status != DagStatus_AwaitingPlan {
		t.Fatalf("recompute released the gate: status = %q", g.Status)
	}

	g.PlanApprovedTs = 42
	RecomputeDagStatus(g)
	if g.Status != DagStatus_Running {
		t.Fatalf("approved status = %q, want running", g.Status)
	}
	if next := NextToSpawn(g); len(next) != 1 || next[0] != "t-0" {
		t.Fatalf("approved dispatch = %v, want [t-0]", next)
	}
}

// A cancel while the plan sits at the gate is terminal, exactly as it is anywhere else.
func TestCancelBeatsPlanGate(t *testing.T) {
	g := mustGroup(t, mkTasks())
	GatePlan(g)
	CancelGroup(g)
	RecomputeDagStatus(g)
	if g.Status != DagStatus_Cancelled {
		t.Fatalf("status = %q, want cancelled", g.Status)
	}
}

// The digest has to name the gate. Falling through to the ordinary wait kinds reports
// "dependency-wait" — true of the later layers, and a complete misread of why nothing is moving.
func TestDigestNamesThePlanGate(t *testing.T) {
	g := mustGroup(t, mkTasks())
	GatePlan(g)
	d := BuildDigest(DagDigestSnapshot{Group: g})
	if d.Next.Kind != "plan-gate" {
		t.Fatalf("next kind = %q, want plan-gate", d.Next.Kind)
	}
	if len(d.Next.Actions) != 0 {
		t.Fatalf("the plan gate carries no task actions, got %v", d.Next.Actions)
	}
	if d.Health != "needs-you" {
		t.Fatalf("health = %q, want needs-you", d.Health)
	}
}

// PlanGatePending is what every guard reads; an ungated group and an approved one both answer false.
func TestPlanGatePendingOnlyWhileUnapproved(t *testing.T) {
	cases := []struct {
		name string
		g    *waveobj.TaskGroup
		want bool
	}{
		{"ungated", &waveobj.TaskGroup{}, false},
		{"gated", &waveobj.TaskGroup{PlanGate: true}, true},
		{"approved", &waveobj.TaskGroup{PlanGate: true, PlanApprovedTs: 1}, false},
		{"nil", nil, false},
	}
	for _, tc := range cases {
		if got := PlanGatePending(tc.g); got != tc.want {
			t.Errorf("%s: PlanGatePending = %v, want %v", tc.name, got, tc.want)
		}
	}
}
