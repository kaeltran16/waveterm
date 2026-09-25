// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// verifierDidNotFinish is the unverified reason of a stage whose verifier ended without a verdict twice.
const verifierDidNotFinish = "the verifier did not finish"

// fixRoundPrefix opens the description of a task a fix round appended, which names the fix plan.
const fixRoundPrefix = "Fix round "

// tendVerifier keeps the final stage's verifier going while the stage is verifying. A verifier that could not
// finish twice leaves the result unverified rather than failed: nothing found a defect, but nothing judged it.
// The caller holds the dag mutation lock.
func tendVerifier(ctx, spawnCtx context.Context, g *waveobj.TaskGroup, owner *waveobj.Run, now int64, afterCommit *[]func()) {
	f := g.Final
	session := func() StageSession {
		return StageSession{Role: jarvis.UsageRole_Verifier, Label: "final verifier", Tree: f.Tree, Prompt: verifierPrompt(g, owner)}
	}
	reason := tendStageSession(ctx, spawnCtx, g, owner, session, &f.VerifierRunID, &f.StartedTs, &f.Respawns, now, afterCommit)
	if reason == "" {
		return
	}
	f.Unverified = append(f.Unverified, verifierDidNotFinish+": "+reason)
	finishFinal(g, afterCommit)
	releaseFinalTree(g, owner, afterCommit)
}

// verifierPrompt is the verifier's brief. It reads the docs in the final tree, where a branch-landed dag
// committed them at submit.
func verifierPrompt(g *waveobj.TaskGroup, owner *waveobj.Run) string {
	f := g.Final
	var b strings.Builder
	fmt.Fprintf(&b, "You are the final verifier for run %s. Every task has landed; judge the combined result in this tree, %s, before the run is done.\n", g.RunID, f.Tree)
	if g.SpecPath != "" {
		fmt.Fprintf(&b, "The spec is at %s.\n", DocPath(g, f.Tree, g.SpecPath))
	}
	if g.PlanPath != "" {
		fmt.Fprintf(&b, "The plan is at %s.\n", DocPath(g, f.Tree, g.PlanPath))
	}
	// a fix round's plan is not the dag's PlanPath: only its tasks' descriptions name it
	if f.Round > 1 {
		fmt.Fprintf(&b, "This is fix round %d: the last round's final stage failed, and these tasks fixed it:\n", f.Round)
		for _, t := range g.Tasks {
			if strings.HasPrefix(t.Description, fixRoundPrefix) {
				first, _, _ := strings.Cut(t.Description, ";")
				fmt.Fprintf(&b, "- %s %s: %s\n", t.ID, t.Label, first)
			}
		}
	}
	head := f.Commit
	if head == "" {
		head = "HEAD"
	}
	if owner.BaseCommit != "" {
		fmt.Fprintf(&b, "The run's change is `git diff %s..%s`.\n", owner.BaseCommit, head)
	}
	if g.FinalCmd != "" {
		fmt.Fprintf(&b, "The plan's Final command `%s` wrote its screenshots and reports into %s.\n", g.FinalCmd, f.OutDir)
	}
	if g.Prototype != "" {
		// a canvas is usually a gitignored mockup, so it is in the checkout, not in the final tree
		fmt.Fprintf(&b, "The design canvas is at %s. Compare each screenshot to its board structurally: which elements are there, their order, their copy, and the controls at that width. Do not compare pixels: the data in the screenshots is invented.\n", DocPath(g, owner.ProjectPath, g.Prototype))
	}
	var notes []string
	for _, t := range g.Tasks {
		if t.ReviewUnverified != "" {
			notes = append(notes, t.ID+": "+t.ReviewUnverified)
		}
	}
	notes = append(notes, f.Unverified...)
	if len(notes) > 0 {
		b.WriteString("Earlier checks could not verify these; check them here where you can:\n")
		for _, n := range notes {
			b.WriteString("- " + n + "\n")
		}
	}
	b.WriteString("Check that:\n")
	b.WriteString("- the combined change does what the spec asks;\n")
	b.WriteString("- nothing broke where tasks meet: code one task changed that another task uses, a name two tasks spell differently, behavior two tasks both touch.\n")
	b.WriteString("Classify each difference from the spec or the canvas as allowed, when the spec's Deviations section lists it, or as a defect.\n")
	b.WriteString("Only read: never edit, stage or commit, and ask no questions, since nobody answers a verifier.\n")
	b.WriteString("Finish with exactly one command, which ends your session:\n")
	b.WriteString("- `wsh jarvis dag final pass \"<summary>\"`, adding `--unverified \"<what you could not verify, and why>\"` when something could not be checked;\n")
	b.WriteString("- `wsh jarvis dag final fail \"<defects: each one, where it is, and the fix>\"`.\n")
	fmt.Fprintf(&b, "Keep each text within %d characters; a longer one is refused.", MaxReviewNoteLen)
	return b.String()
}

// RecordFinalVerdict applies the verifier's verdict and ends the final stage. A fail's defects become the
// stage's Detail whole, since the lead writes its fix plan from them. It does not schedule: the caller does,
// off the verifier's RPC, and that tick announces a done dag.
func RecordFinalVerdict(ctx context.Context, dagID, verifierRunID, verdict, text, unverified string) error {
	text, unverified = strings.TrimSpace(text), strings.TrimSpace(unverified)
	switch {
	case verdict != ReviewVerdict_Pass && verdict != ReviewVerdict_Fail:
		return fmt.Errorf("verdict must be %s or %s, got %q", ReviewVerdict_Pass, ReviewVerdict_Fail, verdict)
	case text == "":
		return fmt.Errorf("a %s verdict needs its text: the summary for a pass, the defects for a fail", verdict)
	case verdict == ReviewVerdict_Fail && unverified != "":
		return fmt.Errorf("--unverified goes with a pass; a fail's defects already say what is wrong")
	}
	// refused rather than clipped: the lead writes the fix plan from these defects
	for _, n := range []struct{ name, text string }{{"text", text}, {"--unverified note", unverified}} {
		if count := utf8.RuneCountInString(n.text); count > MaxReviewNoteLen {
			return fmt.Errorf("the %s is %d characters; the limit is %d. Shorten it and send the verdict again", n.name, count, MaxReviewNoteLen)
		}
	}
	var afterCommit []func()
	err := withDagMutation(dagID, func() error {
		g, err := wstore.GetDag(ctx, dagID)
		if err != nil {
			return fmt.Errorf("loading dag: %w", err)
		}
		f := g.Final
		if g.Status == DagStatus_Cancelled || f == nil || f.State != FinalState_Verifying || f.VerifierRunID != verifierRunID {
			return fmt.Errorf("run %s is not verifying this dag's result", verifierRunID)
		}
		owner, err := wstore.GetRun(ctx, g.ChannelId, g.RunID)
		if err != nil {
			return fmt.Errorf("loading the dag's run: %w", err)
		}
		if verdict == ReviewVerdict_Fail {
			f.Detail = text
		} else {
			if unverified != "" {
				f.Unverified = append(f.Unverified, "verifier: "+unverified)
			}
			channelID, runID := g.ChannelId, g.RunID
			afterCommit = append(afterCommit, func() {
				PostQuiet(ctx, channelID, runID, "the final verifier passed the merged result: "+flatLine(text))
			})
		}
		finishFinal(g, &afterCommit)
		releaseFinalTree(g, owner, &afterCommit)
		RecomputeDagStatus(g)
		g.UpdatedTs = time.Now().UnixMilli()
		if err := wstore.UpdateDag(ctx, dagID, func(cur *waveobj.TaskGroup) error {
			*cur = *g
			return nil
		}); err != nil {
			return err
		}
		wcore.SendWaveObjUpdate(waveobj.MakeORef(waveobj.OType_Dag, dagID))
		return nil
	})
	if err != nil {
		return err
	}
	for _, fn := range afterCommit {
		fn()
	}
	return nil
}

// finalTreeRemoveAttempts and finalTreeRemoveInterval bound the retries of a final tree's removal: the verifier
// sends its verdict from inside the tree, and on Windows its session holds the directory until it exits.
const finalTreeRemoveAttempts = 6

var finalTreeRemoveInterval = 10 * time.Second

// releaseFinalTree removes the detached tree a checkout-landed dag's stage made, once the verifier is done
// with it. A branch-landed dag's tree is its landing tree, which the run keeps.
func releaseFinalTree(g *waveobj.TaskGroup, owner *waveobj.Run, afterCommit *[]func()) {
	if owner.LandPath != "" || g.Final == nil || g.Final.Tree == "" {
		return
	}
	dagID, project, tree := g.OID, owner.ProjectPath, g.Final.Tree
	*afterCommit = append(*afterCommit, func() {
		if removeWorktreeDir(context.Background(), project, tree) == nil {
			return
		}
		go func() {
			var err error
			for i := 1; i < finalTreeRemoveAttempts; i++ {
				time.Sleep(finalTreeRemoveInterval)
				if err = removeWorktreeDir(context.Background(), project, tree); err == nil {
					return
				}
			}
			log.Printf("dag %s: removing the final tree: %v", dagID, err)
		}()
	})
}
