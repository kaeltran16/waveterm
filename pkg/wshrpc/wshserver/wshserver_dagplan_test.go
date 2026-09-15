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
}
