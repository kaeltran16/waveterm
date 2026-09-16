// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestDagSubmitFromPlanPath(t *testing.T) {
	ctx := context.Background()
	newRun := func(t *testing.T) (string, string) {
		t.Helper()
		ch, err := wstore.CreateChannel(ctx, "dag-plan-test", t.TempDir())
		if err != nil {
			t.Fatalf("CreateChannel: %v", err)
		}
		run := jarvis.NewRun("ship coupons", "ws-1", ch.ProjectPath, nil, jarvis.RunMode_Orchestrator, jarvis.DefaultOrchestratorPlaybook(false), 1)
		run.Status = jarvis.RunStatus_Planning
		if err := wstore.AppendRun(ctx, ch.OID, run); err != nil {
			t.Fatalf("AppendRun: %v", err)
		}
		return ch.OID, run.ID
	}
	writePlan := func(t *testing.T, name, src string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	const plan = "# Coupon codes\n\n### Task 1: input\nadd the field\n\n### Task 2: totals\n**Depends on:** none\n\n### Task 3: tests\n**Depends on:** Task 1, Task 2\n"

	t.Run("the plan's tasks, dependencies and title become the dag", func(t *testing.T) {
		channelId, runId := newRun(t)
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: writePlan(t, "plan.md", plan)})
		if err != nil {
			t.Fatal(err)
		}
		got := make([]string, len(g.Tasks))
		for i, task := range g.Tasks {
			got[i] = task.ID + " " + task.Label + " <- " + strings.Join(task.Deps, ",")
		}
		if want := []string{"t-1 input <- ", "t-2 totals <- ", "t-3 tests <- t-1,t-2"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("tasks = %v, want %v", got, want)
		}
		if g.Title != "Coupon codes" || g.Tasks[0].Description != "add the field" {
			t.Fatalf("title %q, task 1 text %q", g.Title, g.Tasks[0].Description)
		}
		// nothing pinned a width, so the plan's shape picks it: two tasks can start at once
		if g.Parallelism != 2 {
			t.Fatalf("parallelism = %d, want 2", g.Parallelism)
		}
	})

	t.Run("a plan without a title is named by its file", func(t *testing.T) {
		channelId, runId := newRun(t)
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: writePlan(t, "2026-09-15-coupons.md", "### Task 1: input\n")})
		if err != nil {
			t.Fatal(err)
		}
		if g.Title != "2026-09-15-coupons" {
			t.Fatalf("title = %q", g.Title)
		}
	})

	t.Run("a rejected plan leaves the run free to take a valid one", func(t *testing.T) {
		channelId, runId := newRun(t)
		dir := t.TempDir()
		cases := []struct {
			name    string
			data    wshrpc.CommandDagSubmitData
			errPart string
		}{
			{"relative path", wshrpc.CommandDagSubmitData{PlanPath: "plan.md"}, "absolute"},
			{"plan path and tasks together", wshrpc.CommandDagSubmitData{PlanPath: writePlan(t, "plan.md", plan), Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "a"}}}, "not both"},
			{"missing plan file", wshrpc.CommandDagSubmitData{PlanPath: filepath.Join(dir, "missing.md")}, "missing.md"},
			{"unparseable plan", wshrpc.CommandDagSubmitData{PlanPath: writePlan(t, "prose.md", "just prose\n")}, "no tasks"},
			{"spec without a plan", wshrpc.CommandDagSubmitData{SpecPath: writePlan(t, "spec.md", "# spec\n"), Tasks: []waveobj.TaskNode{{ID: "t-1", Label: "a"}}}, "needs planpath"},
			{"relative spec path", wshrpc.CommandDagSubmitData{PlanPath: writePlan(t, "plan.md", plan), SpecPath: "spec.md"}, "absolute"},
			{"missing spec file", wshrpc.CommandDagSubmitData{PlanPath: writePlan(t, "plan.md", plan), SpecPath: filepath.Join(dir, "missing-spec.md")}, "missing-spec.md"},
		}
		for _, c := range cases {
			c.data.ChannelId, c.data.RunId = channelId, runId
			_, err := (&WshServer{}).DagSubmitCommand(ctx, c.data)
			if err == nil || !strings.Contains(err.Error(), c.errPart) {
				t.Fatalf("%s: error %v should name %q", c.name, err, c.errPart)
			}
		}
		if _, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: writePlan(t, "plan.md", plan)}); err != nil {
			t.Fatalf("valid plan after rejections: %v", err)
		}
	})

	t.Run("the plan's Verify and Setup commands are stored on the dag", func(t *testing.T) {
		channelId, runId := newRun(t)
		src := "**Verify:** `task test`\n**Setup:** `task worktree:prepare`\n\n### Task 1: input\n"
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: writePlan(t, "plan.md", src)})
		if err != nil {
			t.Fatal(err)
		}
		if g.Verify != "task test" || g.Setup != "task worktree:prepare" {
			t.Fatalf("verify %q, setup %q", g.Verify, g.Setup)
		}
	})

	t.Run("the plan and spec paths are stored on the dag", func(t *testing.T) {
		channelId, runId := newRun(t)
		planPath, specPath := writePlan(t, "plan.md", plan), writePlan(t, "spec.md", "# spec\n")
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, PlanPath: planPath, SpecPath: specPath})
		if err != nil {
			t.Fatal(err)
		}
		if g.PlanPath != planPath || g.SpecPath != specPath {
			t.Fatalf("planpath %q, specpath %q", g.PlanPath, g.SpecPath)
		}
	})
}

func TestDagPlanPreview(t *testing.T) {
	ctx := context.Background()
	write := func(t *testing.T, name, src string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}

	t.Run("reports the plan's name, commands and shape", func(t *testing.T) {
		src := "# Coupons\n\n**Verify:** `task test`\n\n### Task 1: input\n**Depends on:** none\n\n### Task 2: totals\n**Depends on:** none\n\n### Task 3: tests\n**Depends on:** Task 1, Task 2\n"
		got, err := (&WshServer{}).DagPlanPreviewCommand(ctx, wshrpc.CommandDagPlanPreviewData{PlanPath: write(t, "plan.md", src)})
		if err != nil {
			t.Fatal(err)
		}
		want := wshrpc.CommandDagPlanPreviewRtnData{
			Title:  "Coupons",
			Verify: "task test",
			Shape:  wshrpc.DagPlanShape{Tasks: 3, Lanes: 3, LongestChain: 2},
		}
		if !reflect.DeepEqual(*got, want) {
			t.Fatalf("preview = %+v, want %+v", *got, want)
		}
	})

	t.Run("a plan with no title is named by its file", func(t *testing.T) {
		got, err := (&WshServer{}).DagPlanPreviewCommand(ctx, wshrpc.CommandDagPlanPreviewData{PlanPath: write(t, "2026-09-15-coupons.md", "### Task 1: input\n")})
		if err != nil {
			t.Fatal(err)
		}
		if got.Title != "2026-09-15-coupons" {
			t.Fatalf("title = %q", got.Title)
		}
	})

	t.Run("a plan that will not run is refused with the parser's message", func(t *testing.T) {
		cases := []struct {
			name    string
			path    string
			errPart string
		}{
			{"relative path", "plan.md", "absolute"},
			{"missing file", filepath.Join(t.TempDir(), "missing.md"), "missing.md"},
			{"no tasks", write(t, "prose.md", "just prose\n"), "no tasks"},
		}
		for _, c := range cases {
			_, err := (&WshServer{}).DagPlanPreviewCommand(ctx, wshrpc.CommandDagPlanPreviewData{PlanPath: c.path})
			if err == nil || !strings.Contains(err.Error(), c.errPart) {
				t.Fatalf("%s: error %v should name %q", c.name, err, c.errPart)
			}
		}
	})
}
