// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestFlakyTestsReadsTheMarkerLines(t *testing.T) {
	out := strings.Join([]string{
		"ok  \tpkg/a\t0.4s",
		"verify: flaky, failed and then passed when rerun alone: pkg/a TestX",
		"ARC_VERIFY_FLAKY: pkg/a TestX",
		"  ARC_VERIFY_FLAKY: pkg/b TestY  ",
		"ARC_VERIFY_FLAKY: pkg/a TestX",
		"ARC_VERIFY_FLAKY:",
		"not at the start ARC_VERIFY_FLAKY: pkg/c TestZ",
	}, "\r\n")

	want := []string{"pkg/a TestX", "pkg/b TestY"}
	if got := flakyTests(out); !reflect.DeepEqual(got, want) {
		t.Fatalf("want each marked test once, got %q", got)
	}
	if got := flakyTests("ok  \tpkg/a\t0.4s"); len(got) != 0 {
		t.Fatalf("a clean output reports nothing, got %q", got)
	}
}

// a merge Verify that passed on a rerun leaves the tip a caveat the digest and the final stage read
func TestMergeVerifyFlakyReportReachesTheUnverifiedNotes(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "first"},
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "third", Deps: []string{"t-0"}},
	})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	stubPlanCommandOutput(t, func(context.Context, string, string) (string, error) {
		return "ok pkg/a\nARC_VERIFY_FLAKY: pkg/a TestX", nil
	})
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	g := f.dag(t)
	if g.Tasks[0].State != TaskState_Done {
		t.Fatalf("a flaky pass is still a pass, got %s", g.Tasks[0].State)
	}
	want := []wshrpc.DagUnverifiedNote{{TaskId: "t-0", Text: "Verify passed only on a rerun; flaky: pkg/a TestX"}}
	if got := BuildDigest(digestSnapshot(g, nil, nil, nil, digestNow)).Report.UnverifiedNotes; !reflect.DeepEqual(got, want) {
		t.Fatalf("the report names the flaky test, got %+v", got)
	}
}

func TestMergeVerifyFlakyReportKeepsTheTipsOwnCaveat(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "first"},
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "third", Deps: []string{"t-0"}},
	})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Tasks[0].ReviewUnverified = "no browser to check the layout"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	stubMerge(t, landedSha)
	stubPlanCommandOutput(t, func(context.Context, string, string) (string, error) {
		return "ARC_VERIFY_FLAKY: pkg/a TestX", nil
	})
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	want := "no browser to check the layout; Verify passed only on a rerun; flaky: pkg/a TestX"
	if got := f.dag(t).Tasks[0].ReviewUnverified; got != want {
		t.Fatalf("the reviewer's caveat stays and the flaky report joins it, got %q", got)
	}
}

func TestMergeVerifyCleanPassAddsNoNote(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{
		{ID: "t-0", Label: "first"},
		{ID: "t-1", Label: "second", Deps: []string{"t-0"}},
		{ID: "t-2", Label: "third", Deps: []string{"t-0"}},
	})
	f.setPlanCommands(t, verifyCmd, "")
	f.finish(t, "t-0")
	stubMerge(t, landedSha)
	stubPlanCommandOutput(t, func(context.Context, string, string) (string, error) {
		return "ok pkg/a\nverify: all good", nil
	})
	var spawned []string
	stubSpawn(t, &spawned)
	await := awaitVerify(t)

	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	await()

	if got := f.dag(t).Tasks[0].ReviewUnverified; got != "" {
		t.Fatalf("a pass with no flaky report adds nothing, got %q", got)
	}
}

func TestFinalVerifyFlakyReportIsUnverified(t *testing.T) {
	f := finalFixture(t, "echo ok; echo 'ARC_VERIFY_FLAKY: pkg/a TestX'", "", "")

	g := runFinal(t, f)

	if g.Final.State != FinalState_Unverified || g.Status != DagStatus_Done {
		t.Fatalf("a flaky pass ends the stage unverified, got %s / %s", g.Final.State, g.Status)
	}
	if want := []string{"Verify passed only on a rerun; flaky: pkg/a TestX"}; !reflect.DeepEqual(g.Final.Unverified, want) {
		t.Fatalf("the reason names the flaky test, got %q", g.Final.Unverified)
	}
}

func TestFinalVerifyCleanPassStaysPassed(t *testing.T) {
	f := finalFixture(t, "echo ok", "", "")

	g := runFinal(t, f)

	if g.Final.State != FinalState_Passed || len(g.Final.Unverified) != 0 {
		t.Fatalf("a clean Verify passes the stage, got %s %q", g.Final.State, g.Final.Unverified)
	}
}
