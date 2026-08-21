// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const planDagTimeout = 120 * time.Second

var planDagSpec = consult.HeadlessSpecForTier

var (
	ErrDagPlanModelUnavailable = errors.New("dag planner model unavailable")
	ErrInvalidDagPlan          = errors.New("invalid dag plan")
)

const (
	dagPlanWarningModelUnavailable = "Planner model is unavailable. Review the fallback task before launching."
	dagPlanWarningTimeout          = "Planner timed out. Review the fallback task before launching."
	dagPlanWarningInvalid          = "Planner returned an invalid plan. Review the fallback task before launching."
	dagPlanWarningExecution        = "Planner failed. Review the fallback task before launching."
)

type DagPlanInput struct {
	Goal          string
	ChannelName   string
	Principles    waveobj.PrincipleList
	RunRoute      waveobj.RoutePin
	AllowedRoutes []waveobj.RoutePin
}

type DagPlanDraft struct {
	Title string
	Tasks []DagPlanTask
}

type DagPlanTask struct {
	ID          string
	Label       string
	Description string
	Deps        []string
	Gate        bool
	Route       *waveobj.RoutePin
}

type rawDagPlan struct {
	Title string           `json:"title"`
	Tasks []rawDagPlanTask `json:"tasks"`
}

type rawDagPlanTask struct {
	ID          string            `json:"id"`
	Label       string            `json:"label"`
	Description string            `json:"description"`
	Deps        []string          `json:"deps"`
	Gate        bool              `json:"gate"`
	Route       *waveobj.RoutePin `json:"route"`
}

func BuildPlanDagPrompt(input DagPlanInput) string {
	runRoute, _ := json.Marshal(input.RunRoute)
	allowedRoutes, _ := json.Marshal(input.AllowedRoutes)
	schema := `{"title":"short plan title","tasks":[{"id":"plan","label":"Plan","description":"what this task delivers","deps":[],"gate":false,"route":null}]}`
	lines := []string{
		fmt.Sprintf(`You are Jarvis, creating an execution DAG for the goal %q in the %q channel.`, input.Goal, input.ChannelName),
		"Create one to eight tasks. Tasks should explain execution order, meaningful descriptions, and decision gates.",
		"Tasks inherit the Run route unless there is a concrete reason to use an allowed exceptional route.",
		"Return ONLY one JSON object, with no surrounding prose, matching this schema:",
		schema,
		"The Run route is:", string(runRoute),
		"Allowed exceptional task routes are:", string(allowedRoutes),
		"Use only exact routes from the allowed list; route must be null when inheriting the Run route.",
	}
	if rendered := RenderPrinciples(input.Principles); rendered != "" {
		lines = append(lines, "Resolved principles:", rendered)
	}
	return strings.Join(lines, "\n")
}

func ParsePlanDag(reply string, input DagPlanInput) (DagPlanDraft, []string, error) {
	var raw rawDagPlan
	if err := json.Unmarshal([]byte(strings.TrimSpace(reply)), &raw); err != nil {
		return DagPlanDraft{}, nil, fmt.Errorf("%w: invalid JSON: %v", ErrInvalidDagPlan, err)
	}
	if len(raw.Tasks) < 1 || len(raw.Tasks) > 8 {
		return DagPlanDraft{}, nil, fmt.Errorf("%w: task count must be between one and eight", ErrInvalidDagPlan)
	}

	byID := make(map[string]int, len(raw.Tasks))
	for i, task := range raw.Tasks {
		id := strings.TrimSpace(task.ID)
		if id == "" {
			return DagPlanDraft{}, nil, fmt.Errorf("%w: task %d has a blank id", ErrInvalidDagPlan, i+1)
		}
		if _, exists := byID[id]; exists {
			return DagPlanDraft{}, nil, fmt.Errorf("%w: duplicate task id %q", ErrInvalidDagPlan, id)
		}
		if strings.TrimSpace(task.Label) == "" {
			return DagPlanDraft{}, nil, fmt.Errorf("%w: task %d has a blank label", ErrInvalidDagPlan, i+1)
		}
		byID[id] = i
	}
	for i, task := range raw.Tasks {
		for _, dep := range task.Deps {
			dep = strings.TrimSpace(dep)
			if dep == "" {
				return DagPlanDraft{}, nil, fmt.Errorf("%w: task %d has a blank dependency", ErrInvalidDagPlan, i+1)
			}
			if _, exists := byID[dep]; !exists {
				return DagPlanDraft{}, nil, fmt.Errorf("%w: task %q depends on unknown task %q", ErrInvalidDagPlan, task.ID, dep)
			}
			if dep == strings.TrimSpace(task.ID) {
				return DagPlanDraft{}, nil, fmt.Errorf("%w: task %q depends on itself", ErrInvalidDagPlan, task.ID)
			}
		}
	}
	if hasDagCycle(raw.Tasks, byID) {
		return DagPlanDraft{}, nil, fmt.Errorf("%w: dependency cycle", ErrInvalidDagPlan)
	}

	canonical := make(map[string]string, len(raw.Tasks))
	for i, task := range raw.Tasks {
		canonical[strings.TrimSpace(task.ID)] = fmt.Sprintf("t-%d", i+1)
	}
	draft := DagPlanDraft{Title: strings.TrimSpace(raw.Title), Tasks: make([]DagPlanTask, len(raw.Tasks))}
	if draft.Title == "" {
		draft.Title = strings.TrimSpace(input.Goal)
	}
	var warnings []string
	for i, task := range raw.Tasks {
		id := fmt.Sprintf("t-%d", i+1)
		deps := make([]string, 0, len(task.Deps))
		seenDeps := make(map[string]struct{}, len(task.Deps))
		for _, dep := range task.Deps {
			canonicalDep := canonical[strings.TrimSpace(dep)]
			if _, seen := seenDeps[canonicalDep]; seen {
				continue
			}
			seenDeps[canonicalDep] = struct{}{}
			deps = append(deps, canonicalDep)
		}
		draft.Tasks[i] = DagPlanTask{
			ID:          id,
			Label:       strings.TrimSpace(task.Label),
			Description: strings.TrimSpace(task.Description),
			Deps:        deps,
			Gate:        task.Gate,
		}
		if task.Route == nil {
			continue
		}
		if *task.Route == input.RunRoute {
			continue
		}
		if routeAllowed(*task.Route, input.AllowedRoutes) {
			route := *task.Route
			draft.Tasks[i].Route = &route
			continue
		}
		warnings = append(warnings, fmt.Sprintf("Task %s route %s/%s is unavailable and now inherits the Run route.", id, task.Route.Runtime, task.Route.Tier))
	}
	return draft, warnings, nil
}

func hasDagCycle(tasks []rawDagPlanTask, byID map[string]int) bool {
	state := make([]uint8, len(tasks))
	var visit func(int) bool
	visit = func(index int) bool {
		switch state[index] {
		case 1:
			return true
		case 2:
			return false
		}
		state[index] = 1
		for _, dep := range tasks[index].Deps {
			if visit(byID[strings.TrimSpace(dep)]) {
				return true
			}
		}
		state[index] = 2
		return false
	}
	for i := range tasks {
		if visit(i) {
			return true
		}
	}
	return false
}

func routeAllowed(route waveobj.RoutePin, allowed []waveobj.RoutePin) bool {
	for _, candidate := range allowed {
		if route == candidate {
			return true
		}
	}
	return false
}

func PlanDag(ctx context.Context, projectPath string, input DagPlanInput) (DagPlanDraft, []string, error) {
	spec, ok := planDagSpec(consult.TierMid)
	if !ok {
		return DagPlanDraft{}, nil, ErrDagPlanModelUnavailable
	}
	runCtx, cancel := context.WithTimeout(ctx, planDagTimeout)
	defer cancel()
	reply, err := runFn(runCtx, spec, projectPath, BuildPlanDagPrompt(input), func(string) {})
	if err != nil {
		return DagPlanDraft{}, nil, fmt.Errorf("running dag planner: %w", err)
	}
	return ParsePlanDag(strings.TrimSpace(reply), input)
}

func FallbackDagPlan(goal string, cause error) (DagPlanDraft, []string) {
	warning := dagPlanWarningExecution
	switch {
	case errors.Is(cause, ErrDagPlanModelUnavailable):
		warning = dagPlanWarningModelUnavailable
	case errors.Is(cause, context.DeadlineExceeded):
		warning = dagPlanWarningTimeout
	case errors.Is(cause, ErrInvalidDagPlan):
		warning = dagPlanWarningInvalid
	}
	return DagPlanDraft{Title: goal, Tasks: []DagPlanTask{{ID: "t-1", Label: goal}}}, []string{warning}
}
