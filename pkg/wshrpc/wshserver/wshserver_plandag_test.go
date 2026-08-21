// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/harness"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestJarvisPlanDagRejectsInvalidInput(t *testing.T) {
	ctx := context.Background()
	channel, err := wstore.CreateChannel(ctx, "plan-dag-invalid", "/repo")
	if err != nil {
		t.Fatal(err)
	}
	oldPlan, oldValidate := planDag, validateHarness
	t.Cleanup(func() { planDag, validateHarness = oldPlan, oldValidate })
	calls := 0
	planDag = func(context.Context, string, jarvis.DagPlanInput) (jarvis.DagPlanDraft, []string, error) {
		calls++
		return jarvis.DagPlanDraft{}, nil, nil
	}
	validateHarness = func(runtime string, _ harness.Operation) (harness.Spec, error) {
		if runtime == "pi" {
			return harness.Spec{}, errors.New("not installed")
		}
		return harness.Spec{Runtime: runtime}, nil
	}

	cases := []wshrpc.CommandJarvisPlanDagData{
		{Goal: "ship", Route: waveobj.RoutePin{Runtime: "claude", Tier: "mid"}},
		{ChannelId: channel.OID, Goal: " ", Route: waveobj.RoutePin{Runtime: "claude", Tier: "mid"}},
		{ChannelId: channel.OID, Goal: "ship", Route: waveobj.RoutePin{Runtime: "codex", Tier: "mid"}},
		{ChannelId: "missing-channel", Goal: "ship", Route: waveobj.RoutePin{Runtime: "claude", Tier: "mid"}},
		{ChannelId: channel.OID, Goal: "ship", Route: waveobj.RoutePin{Runtime: "pi", Tier: "cheap"}},
	}
	for _, data := range cases {
		if _, err := (&WshServer{}).JarvisPlanDagCommand(ctx, data); err == nil {
			t.Fatalf("data=%+v unexpectedly succeeded", data)
		}
	}
	if calls != 0 {
		t.Fatalf("planner calls=%d", calls)
	}
}

func TestJarvisPlanDagResolvesInputWithoutCreatingRuns(t *testing.T) {
	ctx := context.Background()
	channel, err := wstore.CreateChannel(ctx, "plan-dag-input", "/project/input")
	if err != nil {
		t.Fatal(err)
	}
	seedProfileMeta(t, ctx, channel.OID, &waveobj.ProfileOverride{
		Principles: &waveobj.PrinciplePatch{Additions: []waveobj.Principle{{ID: "custom", Text: "prefer small seams"}}},
	})
	before, err := wstore.GetChannelRuns(ctx, channel.OID)
	if err != nil {
		t.Fatal(err)
	}

	oldPlan, oldValidate, oldProbe := planDag, validateHarness, probeHarnesses
	t.Cleanup(func() { planDag, validateHarness, probeHarnesses = oldPlan, oldValidate, oldProbe })
	validateHarness = func(runtime string, _ harness.Operation) (harness.Spec, error) {
		return harness.Spec{Runtime: runtime}, nil
	}
	probeHarnesses = func(context.Context) []harness.ProbeResult {
		return []harness.ProbeResult{
			{Spec: harness.Spec{Runtime: "pi", RunWorkerCapable: true}, Installed: true},
			{Spec: harness.Spec{Runtime: "claude", RunWorkerCapable: true}, Installed: false},
			{Spec: harness.Spec{Runtime: "codex", RunWorkerCapable: false}, Installed: true},
		}
	}
	var gotPath string
	var gotInput jarvis.DagPlanInput
	planDag = func(_ context.Context, projectPath string, input jarvis.DagPlanInput) (jarvis.DagPlanDraft, []string, error) {
		gotPath, gotInput = projectPath, input
		return jarvis.DagPlanDraft{Title: "ship", Tasks: []jarvis.DagPlanTask{{ID: "t-1", Label: "build"}}}, nil, nil
	}

	data := wshrpc.CommandJarvisPlanDagData{
		ChannelId: channel.OID,
		Goal:      " ship ",
		Route:     waveobj.RoutePin{Runtime: "pi", Tier: "cheap"},
	}
	rtn, err := (&WshServer{}).JarvisPlanDagCommand(ctx, data)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/project/input" || gotInput.Goal != "ship" || gotInput.ChannelName != "plan-dag-input" || gotInput.RunRoute != data.Route {
		t.Fatalf("planner input path=%q input=%+v", gotPath, gotInput)
	}
	if !strings.Contains(jarvis.RenderPrinciples(gotInput.Principles), "prefer small seams") {
		t.Fatalf("resolved principles=%+v", gotInput.Principles)
	}
	wantPins := []waveobj.RoutePin{
		{Runtime: "pi", Tier: "cheap"},
		{Runtime: "pi", Tier: "mid"},
		{Runtime: "pi", Tier: "capable"},
	}
	if !reflect.DeepEqual(gotInput.AllowedRoutes, wantPins) {
		t.Fatalf("allowed routes=%+v want=%+v", gotInput.AllowedRoutes, wantPins)
	}
	if rtn.Fallback || rtn.Draft.Title != "ship" || len(rtn.Draft.Tasks) != 1 || rtn.Draft.Tasks[0].Label != "build" {
		t.Fatalf("response=%+v", rtn)
	}
	after, err := wstore.GetChannelRuns(ctx, channel.OID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("run count changed from %d to %d", len(before), len(after))
	}
}

func TestJarvisPlanDagConvertsPlannerFailureToBoundedFallback(t *testing.T) {
	ctx := context.Background()
	channel, err := wstore.CreateChannel(ctx, "plan-dag-fallback", "/repo")
	if err != nil {
		t.Fatal(err)
	}
	oldPlan, oldValidate := planDag, validateHarness
	t.Cleanup(func() { planDag, validateHarness = oldPlan, oldValidate })
	validateHarness = func(runtime string, _ harness.Operation) (harness.Spec, error) {
		return harness.Spec{Runtime: runtime}, nil
	}
	planDag = func(context.Context, string, jarvis.DagPlanInput) (jarvis.DagPlanDraft, []string, error) {
		return jarvis.DagPlanDraft{}, nil, errors.New("SECRET_PROVIDER_OUTPUT")
	}
	validData := wshrpc.CommandJarvisPlanDagData{
		ChannelId: channel.OID,
		Goal:      "ship",
		Route:     waveobj.RoutePin{Runtime: "pi", Tier: "cheap"},
	}
	rtn, err := (&WshServer{}).JarvisPlanDagCommand(ctx, validData)
	if err != nil || !rtn.Fallback || len(rtn.Draft.Tasks) != 1 || rtn.Draft.Tasks[0].Label != validData.Goal {
		t.Fatalf("rtn=%+v err=%v", rtn, err)
	}
	if strings.Contains(strings.Join(rtn.Warnings, " "), "SECRET_PROVIDER_OUTPUT") {
		t.Fatalf("warnings leaked internal error: %v", rtn.Warnings)
	}

	planDag = func(context.Context, string, jarvis.DagPlanInput) (jarvis.DagPlanDraft, []string, error) {
		return jarvis.DagPlanDraft{Title: "ship", Tasks: []jarvis.DagPlanTask{{ID: "t-1", Label: "Build"}}}, []string{"Task t-1 route pi/cheap is unavailable and now inherits the Run route."}, nil
	}
	rtn, err = (&WshServer{}).JarvisPlanDagCommand(ctx, validData)
	if err != nil || rtn.Fallback || !reflect.DeepEqual(rtn.Warnings, []string{"Task t-1 route pi/cheap is unavailable and now inherits the Run route."}) {
		t.Fatalf("rtn=%+v err=%v", rtn, err)
	}
}
