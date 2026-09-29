// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/runroute"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestReviewerRoute(t *testing.T) {
	lead := &waveobj.Run{Runtime: "pi", Model: "gpt-5"}
	cases := []struct {
		name  string
		owner *waveobj.Run
		route *waveobj.RoutePin
		want  waveobj.RoutePin
	}{
		{"nil route is the lead's", lead, nil, waveobj.RoutePin{Runtime: "pi", Model: "gpt-5"}},
		{"empty route is the lead's", lead, &waveobj.RoutePin{}, waveobj.RoutePin{Runtime: "pi", Model: "gpt-5"}},
		{"lead with no runtime gets the default", &waveobj.Run{Model: "opus"}, nil, waveobj.RoutePin{Runtime: runroute.DefaultRuntime(""), Model: "opus"}},
		{"set route wins", lead, &waveobj.RoutePin{Runtime: "claude", Model: "sonnet"}, waveobj.RoutePin{Runtime: "claude", Model: "sonnet"}},
		{"model with no runtime gets the default runtime", lead, &waveobj.RoutePin{Model: "sonnet"}, waveobj.RoutePin{Runtime: runroute.DefaultRuntime(""), Model: "sonnet"}},
		{"runtime with no model", lead, &waveobj.RoutePin{Runtime: "claude"}, waveobj.RoutePin{Runtime: "claude"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := reviewerRoute(c.owner, &waveobj.TaskGroup{ReviewerRoute: c.route}); got != c.want {
				t.Fatalf("reviewerRoute = %+v, want %+v", got, c.want)
			}
		})
	}
}

func TestSpawnReviewerUsesReviewerRoute(t *testing.T) {
	cases := []struct {
		name  string
		route *waveobj.RoutePin
		want  waveobj.RoutePin
	}{
		{"zero group runs on the lead's route", nil, waveobj.RoutePin{Runtime: "claude", Model: "opus"}},
		{"reviewer route", &waveobj.RoutePin{Runtime: "claude", Model: "sonnet"}, waveobj.RoutePin{Runtime: "claude", Model: "sonnet"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx, dag, worker := seedReviewDag(t)
			if err := wstore.UpdateRun(ctx, dag.ChannelId, dag.RunID, func(r *waveobj.Run) error {
				r.Runtime, r.Model = "claude", "opus"
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if err := wstore.UpdateDag(ctx, dag.OID, func(g *waveobj.TaskGroup) error {
				g.ReviewerRoute = c.route
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			stubReviewTree(t, worker.EndCommit)
			calls := captureSpawns(t)
			schedule(t, ctx, dag.OID)
			if len(*calls) != 1 {
				t.Fatalf("want one reviewer, got %d", len(*calls))
			}
			if cap := (*calls)[0].cap; cap.Runtime != c.want.Runtime || cap.Model != c.want.Model {
				t.Fatalf("reviewer spawned on %s/%s, want %+v", cap.Runtime, cap.Model, c.want)
			}
			child, err := wstore.GetRun(ctx, dag.ChannelId, firstTask(t, ctx, dag.OID).ReviewRunID)
			if err != nil {
				t.Fatal(err)
			}
			if child.Runtime != c.want.Runtime || child.Model != c.want.Model {
				t.Fatalf("reviewer run records %s/%s, want %+v", child.Runtime, child.Model, c.want)
			}
		})
	}
}

func TestStageSessionUsesReviewerRoute(t *testing.T) {
	cases := []struct {
		name  string
		route *waveobj.RoutePin
		want  waveobj.RoutePin
	}{
		{"zero group runs on the lead's route", nil, waveobj.RoutePin{Runtime: "claude", Model: "opus"}},
		{"reviewer route", &waveobj.RoutePin{Runtime: "claude", Model: "sonnet"}, waveobj.RoutePin{Runtime: "claude", Model: "sonnet"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx, dag := seedPendingDag(t)
			calls := captureSpawns(t)
			owner := dagOwner(t, ctx, dag)
			owner.Runtime, owner.Model = "claude", "opus"
			dag.ReviewerRoute = c.route
			runID, err := spawnStageSession(ctx, ctx, dag, owner, StageSession{Role: "verifier", Label: "final check", Tree: t.TempDir(), Prompt: "judge it"})
			if err != nil {
				t.Fatal(err)
			}
			if cap := (*calls)[0].cap; cap.Runtime != c.want.Runtime || cap.Model != c.want.Model {
				t.Fatalf("session spawned on %s/%s, want %+v", cap.Runtime, cap.Model, c.want)
			}
			run, err := wstore.GetRun(ctx, dag.ChannelId, runID)
			if err != nil {
				t.Fatal(err)
			}
			if run.Runtime != c.want.Runtime || run.Model != c.want.Model {
				t.Fatalf("session run records %s/%s, want %+v", run.Runtime, run.Model, c.want)
			}
		})
	}
}
