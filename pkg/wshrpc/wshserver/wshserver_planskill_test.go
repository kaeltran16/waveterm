// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func setPlanSkillSetting(t *testing.T, value string) {
	t.Helper()
	prev := runPlanSkillSetting
	runPlanSkillSetting = func() string { return value }
	t.Cleanup(func() { runPlanSkillSetting = prev })
}

func TestCreateRunPlanSkill(t *testing.T) {
	ctx := context.Background()
	stubRunServer(t, "pi", nil)

	cases := []struct{ name, setting, want string }{
		{"unset records plan", "", jarvis.PlanSkill_Plan},
		{"writing-plans records writing-plans", "writing-plans", jarvis.PlanSkill_WritingPlans},
		{"an unknown value records plan", "nonsense", jarvis.PlanSkill_Plan},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			setPlanSkillSetting(t, tc.setting)
			created, err := createEngineRun(t, ctx, nil, wshrpc.CommandCreateRunData{})
			if err != nil {
				t.Fatalf("CreateRunCommand: %v", err)
			}
			if created.PlanSkill != tc.want {
				t.Fatalf("returned run PlanSkill = %q, want %q", created.PlanSkill, tc.want)
			}
			if stored := mustRun(t, ctx, created.ChannelOID, created.ID); stored.PlanSkill != tc.want {
				t.Fatalf("stored run PlanSkill = %q, want %q", stored.PlanSkill, tc.want)
			}
		})
	}

	t.Run("a quick run records none", func(t *testing.T) {
		setPlanSkillSetting(t, "writing-plans")
		ch, err := wstore.CreateChannel(ctx, "planskill-quick", t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		rtn, err := (&WshServer{}).CreateRunCommand(ctx, wshrpc.CommandCreateRunData{
			ChannelId: ch.OID, WorkspaceId: "ws", Goal: "g", Runtime: "pi", Mode: jarvis.RunMode_Quick, DeferStart: true,
		})
		if err != nil {
			t.Fatalf("CreateRunCommand: %v", err)
		}
		if got := mustRun(t, ctx, ch.OID, rtn.Run.ID).PlanSkill; got != "" {
			t.Fatalf("a quick run recorded PlanSkill %q, want none", got)
		}
	})
}

func TestDagSubmitCarriesPlanSkill(t *testing.T) {
	stubModelSubmit(t)
	tasks := []waveobj.TaskNode{{ID: "t-1", Label: "a"}}
	for _, stored := range []string{jarvis.PlanSkill_Plan, jarvis.PlanSkill_WritingPlans, ""} {
		ctx, channelId, runId := seedModelRun(t, func(run *waveobj.Run) { run.PlanSkill = stored })
		g, err := (&WshServer{}).DagSubmitCommand(ctx, wshrpc.CommandDagSubmitData{ChannelId: channelId, RunId: runId, Title: "g", Parallelism: 1, Tasks: tasks})
		if err != nil {
			t.Fatal(err)
		}
		if g.PlanSkill != stored {
			t.Fatalf("run PlanSkill %q: group PlanSkill = %q", stored, g.PlanSkill)
		}
	}
}
