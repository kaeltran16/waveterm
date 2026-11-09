// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
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

// a Check that failed on something outside the code (docker down) runs again once the human fixed it, in the same
// round, and the lead woken to plan a fix round is told to drop it
func TestAHumanRerunsAFailedFinalStage(t *testing.T) {
	lead := newFakeLead(t)
	marker := filepath.ToSlash(filepath.Join(t.TempDir(), "docker-up"))
	f := finalFixture(t, passVerify, "test -f "+marker+" || { echo 'docker is not running'; exit 1; }", "")
	if g := runFinal(t, f); g.Final.State != FinalState_Failed || len(lead.sends) != 1 {
		t.Fatalf("setup: want a failed stage that woke the lead, got %s / %q", g.Final.State, lead.sends)
	}
	ackWake(lead)
	writeFile(t, marker, "")

	if err := RerunFinalStage(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}

	g := f.dag(t)
	if g.Final.Round != 1 || g.Final.State != "" || g.Final.Detail != "" || g.Status != DagStatus_Finalizing {
		t.Fatalf("the stage starts over in the same round, got %s / %+v", g.Status, g.Final)
	}
	if len(lead.sends) != 2 || !strings.Contains(lead.sends[1], "reran the final stage of round 1") || !strings.Contains(lead.sends[1], "Drop any fix plan") {
		t.Fatalf("the lead is told to drop its fix plan, got %q", lead.sends)
	}
	if n := lead.countKind(waveobj.RunEventKindFinalRerun); n != 1 {
		t.Fatalf("the rerun writes one final-rerun row, got %d", n)
	}
	if g := runFinal(t, f); g.Final.State != FinalState_Passed || g.Final.Round != 1 || g.Status != DagStatus_Done {
		t.Fatalf("the rerun passes in round 1, got %s / %+v", g.Status, g.Final)
	}
}

// failedStageWithAskingLead is a failed final stage whose woken lead now holds its own question open, as when it put
// the failure to the human
func failedStageWithAskingLead(t *testing.T) (*mergeFixture, *fakeLead) {
	t.Helper()
	lead := newFakeLead(t)
	f := finalFixture(t, passVerify, "echo 'docker is not running'; exit 1", "")
	if g := runFinal(t, f); g.Final.State != FinalState_Failed || len(lead.sends) != 1 {
		t.Fatalf("setup: want a failed stage that woke the lead, got %s / %q", g.Final.State, lead.sends)
	}
	ackWake(lead)
	lead.state.State = baseds.AgentState_Asking
	seedLeadOwnAsk(singleSelect())
	return f, lead
}

// heldRerunWakes counts the rerun wakes sent or held for the lead
func heldRerunWakes(lead *fakeLead) int {
	wakes.lock.Lock()
	defer wakes.lock.Unlock()
	n := 0
	for _, line := range lead.sends {
		if strings.HasPrefix(line, finalRerunWakeHead) {
			n++
		}
	}
	for _, rw := range wakes.runs {
		for _, line := range rw.lines {
			if strings.HasPrefix(line, finalRerunWakeHead) {
				n++
			}
		}
	}
	return n
}

// the lead's open question about the failed stage is answered by the rerun, so it does not act on the human's
// answer to it before the held wake arrives
func TestARerunAnswersTheLeadsOpenQuestion(t *testing.T) {
	f, lead := failedStageWithAskingLead(t)
	calls, release := stubLeadDelivery(t, nil)
	defer close(release)

	if err := RerunFinalStage(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-calls:
		if got.oref != leadAskOref() || len(got.answers) != 1 || got.answers[0].Text != finalRerunAnswer(1) {
			t.Fatalf("want the rerun answer on the lead's own ask, got %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the lead's question was never answered")
	}
	if n := heldRerunWakes(lead); n != 0 {
		t.Fatalf("an answered question needs no rerun wake, got %d", n)
	}
	if n := lead.countKind(waveobj.RunEventKindFinalRerun); n != 1 {
		t.Fatalf("the rerun writes one final-rerun row, got %d", n)
	}
}

// an answer that fails to type still tells the lead, once, by the wake
func TestARerunWhoseAnswerFailsWakesOnce(t *testing.T) {
	f, lead := failedStageWithAskingLead(t)
	calls, release := stubLeadDelivery(t, errors.New("the picker closed"))

	if err := RerunFinalStage(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-calls:
	case <-time.After(5 * time.Second):
		t.Fatal("the lead's question was never answered")
	}
	if n := heldRerunWakes(lead); n != 0 {
		t.Fatalf("no wake while the answer is still being typed, got %d", n)
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for heldRerunWakes(lead) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := heldRerunWakes(lead); n != 1 {
		t.Fatalf("a failed answer posts one rerun wake, got %d", n)
	}
}

// the lead completed after its last round failed; a rerun then wakes nobody, since nobody would read it
func TestARerunOfADoneRunWakesNobody(t *testing.T) {
	lead := newFakeLead(t)
	f := finalFixture(t, passVerify, "echo 'docker is not running'; exit 1", "")
	if g := runFinal(t, f); g.Final.State != FinalState_Failed || len(lead.sends) != 1 {
		t.Fatalf("setup: want a failed stage that woke the lead, got %s / %q", g.Final.State, lead.sends)
	}
	ackWake(lead)
	if err := wstore.UpdateRun(f.ctx, f.channel, f.ownerID, func(r *waveobj.Run) error {
		r.Status = jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	sent := len(lead.sends)

	if err := RerunFinalStage(f.ctx, f.dagID); err != nil {
		t.Fatal(err)
	}
	runFinal(t, f)

	if len(lead.sends) != sent {
		t.Fatalf("a done run's lead gets no wake, got %q", lead.sends[sent:])
	}
}

func TestRefusedFinalStageReruns(t *testing.T) {
	f := finalFixture(t, passVerify, "", "")
	if err := RerunFinalStage(f.ctx, f.dagID); err == nil || !strings.Contains(err.Error(), "has not started") {
		t.Fatalf("a stage not started cannot be rerun, got %v", err)
	}
	runFinal(t, f) // TestMain's skipVerifier ends it passed
	if err := RerunFinalStage(f.ctx, f.dagID); err == nil || !strings.Contains(err.Error(), "is passed; only a failed one") {
		t.Fatalf("a passed stage cannot be rerun, got %v", err)
	}
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Status, cur.Final.State = DagStatus_Cancelled, FinalState_Failed
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := RerunFinalStage(f.ctx, f.dagID); err == nil || !strings.Contains(err.Error(), "is cancelled") {
		t.Fatalf("a cancelled run's stage cannot be rerun, got %v", err)
	}
}

// ackWake has the fake lead take its wake, working then idle, so the waker sends the next one
func ackWake(lead *fakeLead) {
	NoteLeadStatus(context.Background(), lead.status(baseds.AgentState_Working))
	NoteLeadStatus(context.Background(), lead.status(baseds.AgentState_Idle))
}

// a run that never had a lead gets none launched only to be told to drop a fix plan it never wrote
func TestARerunWakeLaunchesNoLead(t *testing.T) {
	if !nothingToLaunchFor([]string{finalRerunWake(1)}) {
		t.Fatal("the rerun wake alone must not launch a lead")
	}
	if nothingToLaunchFor([]string{finalRerunWake(1), finalFailedWake(1, "r", "Check failed", false, false)}) {
		t.Fatal("a failed stage beside it still launches one")
	}
}
