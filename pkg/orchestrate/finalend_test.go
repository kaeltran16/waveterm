// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func TestAHumanEndsAVerifyingStage(t *testing.T) {
	cases := []struct{ outcome, wantStatus string }{
		{FinalState_Unverified, DagStatus_Done},
		{FinalState_Failed, DagStatus_Blocked},
	}
	for _, c := range cases {
		t.Run(c.outcome, func(t *testing.T) {
			f, lead, verifierID := verifyingFixture(t)
			tree := f.dag(t).Final.Tree

			if err := EndFinalStage(f.ctx, f.dagID, c.outcome, "  the verifier's tools were rejected  "); err != nil {
				t.Fatal(err)
			}

			g := f.dag(t)
			want := "ended by the human: the verifier's tools were rejected"
			if g.Final.State != c.outcome || g.Status != c.wantStatus {
				t.Fatalf("want %s / %s, got %s / %s", c.outcome, c.wantStatus, g.Final.State, g.Status)
			}
			if c.outcome == FinalState_Failed {
				if g.Final.Detail != want || len(lead.sends) != 1 || !strings.Contains(lead.sends[0], want) {
					t.Fatalf("a failed end is the stage's Detail and wakes the lead with it, got %q / %q", g.Final.Detail, lead.sends)
				}
			} else if !slices.Contains(g.Final.Unverified, want) || g.Final.Detail != "" {
				t.Fatalf("an unverified end records the reason, got %+v", g.Final)
			}
			if g.Final.VerifierRunID != verifierID {
				t.Fatalf("the verifier stays on the stage for the usage totals, got %q", g.Final.VerifierRunID)
			}
			verifier, err := wstore.GetRun(f.ctx, f.channel, verifierID)
			if err != nil || verifier.Status != jarvis.RunStatus_Cancelled {
				t.Fatalf("the verifier's run is cancelled, got %+v / %v", verifier, err)
			}
			if err := RecordFinalVerdict(f.ctx, f.dagID, verifierID, ReviewVerdict_Pass, "late", ""); err == nil {
				t.Fatal("a verdict after the human ended the stage must be refused")
			}
			if got := f.dag(t).Final.State; got != c.outcome {
				t.Fatalf("the refused verdict changes nothing, got %s", got)
			}
			if _, err := os.Stat(tree); !os.IsNotExist(err) {
				t.Fatalf("the detached final tree is removed, stat err %v", err)
			}
		})
	}
}

func TestAHumanEndsARunningFinalCommand(t *testing.T) {
	f := finalFixture(t, passVerify, "", "sleep 30")
	await := awaitFinal(t)
	if err := Schedule(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for f.dag(t).Final.State != FinalState_Final {
		if time.Now().After(deadline) {
			t.Fatal("the Final command did not start")
		}
		time.Sleep(20 * time.Millisecond)
	}

	if err := EndFinalStage(f.ctx, f.dagID, FinalState_Unverified, "the dev app hangs on boot"); err != nil {
		t.Fatal(err)
	}
	await() // returns well before the sleep only if the end stopped the command

	g := f.dag(t)
	if g.Final.State != FinalState_Unverified || g.Status != DagStatus_Done || !slices.Contains(g.Final.Unverified, "ended by the human: the dev app hangs on boot") {
		t.Fatalf("the command's late result must not overwrite the human's end, got %s / %+v", g.Status, g.Final)
	}
}

func TestRefusedFinalStageEnds(t *testing.T) {
	f := finalFixture(t, passVerify, "", "")
	cases := []struct{ name, outcome, reason, want string }{
		{"not started", FinalState_Unverified, "r", "not started"},
		{"bad outcome", FinalState_Passed, "r", "must be unverified or failed"},
		{"blank reason", FinalState_Failed, "   ", "needs the human's reason"},
		{"long reason", FinalState_Failed, strings.Repeat("r", MaxReviewNoteLen+1), "the limit is 2000"},
	}
	for _, c := range cases {
		if err := EndFinalStage(f.ctx, f.dagID, c.outcome, c.reason); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: want an error with %q, got %v", c.name, c.want, err)
		}
	}
	g := runFinal(t, f) // TestMain's skipVerifier ends it passed
	if g.Final.State != FinalState_Passed {
		t.Fatalf("setup: want a passed stage, got %s", g.Final.State)
	}
	if err := EndFinalStage(f.ctx, f.dagID, FinalState_Failed, "r"); err == nil || !strings.Contains(err.Error(), "is passed") {
		t.Fatalf("a finished stage cannot be ended, got %v", err)
	}
}
