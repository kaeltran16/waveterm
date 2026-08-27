// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestBuildPlanDagPromptIncludesAuthorityAndSchema(t *testing.T) {
	input := DagPlanInput{
		Goal:        "ship fast approval",
		ChannelName: "waveterm",
		Principles:  waveobj.PrincipleList{{ID: "simple", Text: "prefer the smallest safe change"}},
		RunRoute:    waveobj.RoutePin{Runtime: "claude", Tier: "mid"},
		AllowedRoutes: []waveobj.RoutePin{
			{Runtime: "pi", Model: "opencode/deepseek-v4-flash"},
			{Runtime: "claude", Tier: "mid"},
		},
	}
	prompt := BuildPlanDagPrompt(input)
	for _, want := range []string{
		"ship fast approval", "waveterm", "prefer the smallest safe change",
		`"runtime":"claude"`, `"tier":"mid"`, `"runtime":"pi"`, `"model":"opencode/deepseek-v4-flash"`,
		"one to eight", "inherit the Run route", `"description"`, `"deps"`, `"gate"`, `"route"`,
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q:\n%s", want, prompt)
		}
	}
}

func TestPlanDagUsesMidTier(t *testing.T) {
	oldSpec := planDagSpec
	oldRun := runFn
	t.Cleanup(func() { planDagSpec, runFn = oldSpec, oldRun })
	var gotTier consult.Tier
	planDagSpec = func(tier consult.Tier) (consult.RuntimeSpec, bool) {
		gotTier = tier
		return consult.RuntimeSpec{}, true
	}
	runFn = func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error) {
		return `{"title":"ship","tasks":[{"id":"a","label":"build"}]}`, nil
	}
	_, _, err := PlanDag(context.Background(), ".", DagPlanInput{Goal: "ship"})
	if err != nil || gotTier != consult.TierMid {
		t.Fatalf("tier=%q err=%v", gotTier, err)
	}
}

func TestParsePlanDagCanonicalizesAValidPlan(t *testing.T) {
	input := DagPlanInput{
		Goal:     "ship",
		RunRoute: waveobj.RoutePin{Runtime: "claude", Tier: "mid"},
		AllowedRoutes: []waveobj.RoutePin{
			{Runtime: "claude", Tier: "mid"},
			{Runtime: "pi", Model: "opencode/deepseek-v4-flash"},
		},
	}
	raw := `{"title":" Release ","tasks":[` +
		`{"id":"plan","label":" Plan ","description":" Decide seams ","gate":true},` +
		`{"id":"build","label":"Build","deps":["plan","plan"],"route":{"runtime":"pi","model":"opencode/deepseek-v4-flash"}}]}`
	draft, warnings, err := ParsePlanDag(raw, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 || draft.Title != "Release" {
		t.Fatalf("draft=%+v warnings=%v", draft, warnings)
	}
	if draft.Tasks[0].ID != "t-1" || draft.Tasks[0].Description != "Decide seams" || !draft.Tasks[0].Gate {
		t.Fatalf("first task=%+v", draft.Tasks[0])
	}
	if !reflect.DeepEqual(draft.Tasks[1].Deps, []string{"t-1"}) || draft.Tasks[1].Route == nil || draft.Tasks[1].Route.Runtime != "pi" || draft.Tasks[1].Route.Model != "opencode/deepseek-v4-flash" {
		t.Fatalf("second task=%+v", draft.Tasks[1])
	}
}

func TestParsePlanDagClearsRedundantRouteSilently(t *testing.T) {
	route := waveobj.RoutePin{Runtime: "claude", Tier: "mid"}
	input := DagPlanInput{Goal: "ship", RunRoute: route, AllowedRoutes: []waveobj.RoutePin{route}}
	draft, warnings, err := ParsePlanDag(
		`{"tasks":[{"id":"a","label":"Build","route":{"runtime":"claude","tier":"mid"}}]}`,
		input,
	)
	if err != nil || draft.Tasks[0].Route != nil || len(warnings) != 0 {
		t.Fatalf("draft=%+v warnings=%v err=%v", draft, warnings, err)
	}
}

func TestParsePlanDagClearsInvalidRouteWithTaskWarning(t *testing.T) {
	input := DagPlanInput{
		Goal:          "ship",
		RunRoute:      waveobj.RoutePin{Runtime: "claude", Tier: "mid"},
		AllowedRoutes: []waveobj.RoutePin{{Runtime: "claude", Tier: "mid"}},
	}
	draft, warnings, err := ParsePlanDag(
		`{"tasks":[{"id":"a","label":"Build","route":{"runtime":"pi","tier":"cheap"}}]}`,
		input,
	)
	if err != nil || draft.Tasks[0].Route != nil || len(warnings) != 1 || !strings.Contains(warnings[0], "t-1") || !strings.Contains(warnings[0], "pi/cheap") {
		t.Fatalf("draft=%+v warnings=%v err=%v", draft, warnings, err)
	}
}

func TestParsePlanDagClearsUnavailableModelRouteWithLabelWarning(t *testing.T) {
	input := DagPlanInput{
		Goal:          "ship",
		RunRoute:      waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"},
		AllowedRoutes: []waveobj.RoutePin{{Runtime: "pi", Model: "opencode/deepseek-v4-pro"}},
	}
	draft, warnings, err := ParsePlanDag(
		`{"tasks":[{"id":"a","label":"Build","route":{"runtime":"pi","model":"not-allowed"}}]}`,
		input,
	)
	if err != nil || draft.Tasks[0].Route != nil || len(warnings) != 1 {
		t.Fatalf("draft=%+v warnings=%v err=%v", draft, warnings, err)
	}
	if !strings.Contains(warnings[0], "route pi/not-allowed") {
		t.Fatalf("warning must use the model label: %q", warnings[0])
	}
}

func TestParsePlanDagRejectsStructuralErrors(t *testing.T) {
	nine := make([]string, 9)
	for i := range nine {
		nine[i] = fmt.Sprintf(`{"id":"%d","label":"task %d"}`, i, i)
	}
	cases := map[string]string{
		"malformed":     `{`,
		"zero tasks":    `{"tasks":[]}`,
		"nine tasks":    `{"tasks":[` + strings.Join(nine, ",") + `]}`,
		"duplicate ids": `{"tasks":[{"id":"a","label":"A"},{"id":"a","label":"B"}]}`,
		"blank id":      `{"tasks":[{"id":" ","label":"A"}]}`,
		"blank label":   `{"tasks":[{"id":"a","label":" "}]}`,
		"unknown dep":   `{"tasks":[{"id":"a","label":"A","deps":["missing"]}]}`,
		"self dep":      `{"tasks":[{"id":"a","label":"A","deps":["a"]}]}`,
		"cycle":         `{"tasks":[{"id":"a","label":"A","deps":["b"]},{"id":"b","label":"B","deps":["a"]}]}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			_, _, err := ParsePlanDag(raw, DagPlanInput{Goal: "ship"})
			if !errors.Is(err, ErrInvalidDagPlan) {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestParsePlanDagUsesGoalForBlankTitle(t *testing.T) {
	draft, _, err := ParsePlanDag(`{"title":" ","tasks":[{"id":"a","label":"Build"}]}`, DagPlanInput{Goal: "ship"})
	if err != nil || draft.Title != "ship" {
		t.Fatalf("draft=%+v err=%v", draft, err)
	}
}

func TestPlanDagReturnsClassifiedInternalFailures(t *testing.T) {
	oldSpec, oldRun := planDagSpec, runFn
	t.Cleanup(func() { planDagSpec, runFn = oldSpec, oldRun })
	input := DagPlanInput{Goal: "ship"}

	planDagSpec = func(consult.Tier) (consult.RuntimeSpec, bool) { return consult.RuntimeSpec{}, false }
	if _, _, err := PlanDag(context.Background(), ".", input); !errors.Is(err, ErrDagPlanModelUnavailable) {
		t.Fatalf("lookup err=%v", err)
	}

	planDagSpec = func(consult.Tier) (consult.RuntimeSpec, bool) { return consult.RuntimeSpec{}, true }
	runFn = func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error) {
		return "", errors.New("provider secret")
	}
	if _, _, err := PlanDag(context.Background(), ".", input); err == nil || errors.Is(err, ErrInvalidDagPlan) {
		t.Fatalf("execution err=%v", err)
	}

	runFn = func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error) {
		return "", context.DeadlineExceeded
	}
	if _, _, err := PlanDag(context.Background(), ".", input); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout err=%v", err)
	}

	runFn = func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error) {
		return "SECRET_RAW_REPLY", nil
	}
	if _, _, err := PlanDag(context.Background(), ".", input); !errors.Is(err, ErrInvalidDagPlan) {
		t.Fatalf("parse err=%v", err)
	}
}

func TestFallbackDagPlanIsBounded(t *testing.T) {
	causes := []error{
		ErrDagPlanModelUnavailable,
		context.DeadlineExceeded,
		fmt.Errorf("%w: SECRET_RAW_REPLY", ErrInvalidDagPlan),
		errors.New("provider failed with --api-key secret"),
	}
	for _, cause := range causes {
		draft, warnings := FallbackDagPlan("ship", cause)
		if len(draft.Tasks) != 1 || draft.Tasks[0].ID != "t-1" || draft.Tasks[0].Label != "ship" || len(warnings) != 1 {
			t.Fatalf("draft=%+v warnings=%v", draft, warnings)
		}
		joined := strings.Join(warnings, " ")
		for _, leaked := range []string{"SECRET_RAW_REPLY", "--api-key", "provider failed"} {
			if strings.Contains(joined, leaked) {
				t.Fatalf("warning leaked %q: %s", leaked, joined)
			}
		}
	}
}

// An exact-model run route plans on that same model so the decomposition comes from the model
// family the workers will use; a legacy tier route keeps the headless mid spec.
func TestPlanDagPrefersRunRouteModel(t *testing.T) {
	oldRun := runFn
	t.Cleanup(func() { runFn = oldRun })
	input := DagPlanInput{Goal: "ship", RunRoute: waveobj.RoutePin{Runtime: "pi", Model: "opencode-go/ox-alpha-free"}}
	var gotSpec consult.RuntimeSpec
	runFn = func(_ context.Context, spec consult.RuntimeSpec, _, _ string, _ func(string)) (string, error) {
		gotSpec = spec
		return `{"title":"ship","tasks":[{"id":"a","label":"build"}]}`, nil
	}
	if _, _, err := PlanDag(context.Background(), ".", input); err != nil {
		t.Fatal(err)
	}
	if !containsModelArg(gotSpec.BaseArgs, "opencode-go/ox-alpha-free") {
		t.Fatalf("planner spec missing run-route model: %+v", gotSpec)
	}
}

func TestPlanDagFallsBackWhenRunRouteModelUnresolvable(t *testing.T) {
	oldSpec, oldRun := planDagSpec, runFn
	t.Cleanup(func() { planDagSpec, runFn = oldSpec, oldRun })
	input := DagPlanInput{Goal: "ship", RunRoute: waveobj.RoutePin{Runtime: "bogus", Model: "m"}}
	var gotTier consult.Tier
	planDagSpec = func(tier consult.Tier) (consult.RuntimeSpec, bool) {
		gotTier = tier
		return consult.RuntimeSpec{}, true
	}
	runFn = func(context.Context, consult.RuntimeSpec, string, string, func(string)) (string, error) {
		return `{"title":"ship","tasks":[{"id":"a","label":"build"}]}`, nil
	}
	if _, _, err := PlanDag(context.Background(), ".", input); err != nil || gotTier != consult.TierMid {
		t.Fatalf("tier=%q err=%v", gotTier, err)
	}
}

// A missing planner credential is named as a class, never via the raw cause (which can carry
// configuration detail).
func TestFallbackDagPlanNamesMissingCredentials(t *testing.T) {
	cause := fmt.Errorf("running dag planner: %w", consult.ErrOpenRouterKeyMissing)
	_, warnings := FallbackDagPlan("ship", cause)
	joined := strings.Join(warnings, " ")
	if !strings.Contains(strings.ToLower(joined), "credential") {
		t.Fatalf("warning must name the credential class: %s", joined)
	}
	for _, leaked := range []string{"OPENROUTER_KEY", "dag planner", "SECRET"} {
		if strings.Contains(joined, leaked) {
			t.Fatalf("warning leaked %q: %s", leaked, joined)
		}
	}
}

func containsModelArg(args []string, model string) bool {
	for i, a := range args {
		if a == "--model" && i+1 < len(args) && args[i+1] == model {
			return true
		}
	}
	return false
}

// Models narrate: the reply may carry prose and stray fragments around the plan object, so
// parsing extracts the outermost {...} span instead of requiring a bare JSON document.
func TestParsePlanDagExtractsObjectFromProse(t *testing.T) {
	input := DagPlanInput{Goal: "ship", RunRoute: waveobj.RoutePin{Runtime: "pi", Tier: "capable", Model: "m"}}
	raw := "I'll create an execution plan. Let me check the structure first.[\n" +
		`  {"id":"stray","label":"not a plan"}` + "\n]" +
		`{"title":" Release ","tasks":[{"id":"plan","label":" Plan ","description":" Decide seams ","gate":true},` +
		`{"id":"build","label":"Build"}]}` + "\nDone."
	draft, warnings, err := ParsePlanDag(raw, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 || draft.Title != "Release" || len(draft.Tasks) != 2 {
		t.Fatalf("draft=%+v warnings=%v", draft, warnings)
	}
	if draft.Tasks[0].ID != "t-1" || !draft.Tasks[0].Gate || draft.Tasks[1].ID != "t-2" {
		t.Fatalf("tasks=%+v", draft.Tasks)
	}
}

// A reply with no object at all still fails as invalid.
func TestParsePlanDagRejectsReplyWithoutObject(t *testing.T) {
	if _, _, err := ParsePlanDag("no json here [1, 2]", DagPlanInput{Goal: "ship"}); !errors.Is(err, ErrInvalidDagPlan) {
		t.Fatalf("err=%v", err)
	}
}
