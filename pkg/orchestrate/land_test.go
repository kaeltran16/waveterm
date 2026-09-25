// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// landFixture is a done, branch-landed run on main whose branch added feature.txt, and whose final stage
// passed on the branch's head. Its checkout is clean.
func landFixture(t *testing.T) (*mergeFixture, string) {
	t.Helper()
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	base := gitCmd(t, f.project, "rev-parse", "HEAD")
	tree := f.land(t)
	writeFile(t, filepath.Join(tree, "feature.txt"), "feature\n")
	gitCmd(t, tree, "add", ".")
	gitCmd(t, tree, "commit", "-m", "add feature")
	head := gitCmd(t, tree, "rev-parse", "HEAD")
	if err := wstore.UpdateRun(f.ctx, f.channel, f.ownerID, func(r *waveobj.Run) error {
		r.BaseBranch, r.BaseCommit, r.Status = "main", base, jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	f.setFinal(t, &waveobj.FinalStage{State: FinalState_Passed, Round: 1, Commit: head})
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Title = "Coupon codes"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return f, tree
}

func (f *mergeFixture) setFinal(t *testing.T, final *waveobj.FinalStage) {
	t.Helper()
	if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
		cur.Final = final
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// commitOnBranch commits file on the run's branch, as a lane or the lead's wrap-up would.
func commitOnBranch(t *testing.T, tree, file, content string) {
	t.Helper()
	writeFile(t, filepath.Join(tree, file), content)
	gitCmd(t, tree, "add", ".")
	gitCmd(t, tree, "commit", "-m", "change "+file)
}

func (f *mergeFixture) landRun(t *testing.T, force bool) *waveobj.RunLand {
	t.Helper()
	land, err := LandRun(f.ctx, f.channel, f.ownerID, force)
	if err != nil {
		t.Fatal(err)
	}
	return land
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func branchExists(dir, branch string) bool {
	return exec.Command("git", "-C", dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch).Run() == nil
}

// assertHeld checks a held land's reason, that it is stored on the run with a land-held event, and that the
// checkout's branch did not move.
func (f *mergeFixture) assertHeld(t *testing.T, land *waveobj.RunLand, head, want string) {
	t.Helper()
	if land == nil || land.State != LandState_Held || !strings.Contains(land.Reason, want) {
		t.Fatalf("land = %+v, want held with %q", land, want)
	}
	if got := f.owner(t).Land; !reflect.DeepEqual(got, land) {
		t.Fatalf("stored land = %+v, want %+v", got, land)
	}
	if n := countEvents(t, f.ctx, f.channel, f.ownerID, waveobj.RunEventKindLandHeld); n != 1 {
		t.Fatalf("%d land-held events, want 1", n)
	}
	if got := gitCmd(t, f.project, "rev-parse", "main"); got != head {
		t.Fatalf("main moved from %s to %s", head, got)
	}
	if !branchExists(f.project, "wave/"+f.ownerID) {
		t.Fatal("a held land deleted the run's branch")
	}
}

func TestLandMergesTheBranchIntoACleanCheckout(t *testing.T) {
	f, tree := landFixture(t)
	land := f.landRun(t, false)

	if land == nil || land.State != LandState_Landed || land.Reason != "" || len(land.Notes) != 0 {
		t.Fatalf("land = %+v, want landed with no notes", land)
	}
	head := gitCmd(t, f.project, "rev-parse", "HEAD")
	if land.Commit != head {
		t.Fatalf("land commit %s, want the checkout's new head %s", land.Commit, head)
	}
	if parents := strings.Fields(gitCmd(t, f.project, "log", "-1", "--format=%P")); len(parents) != 2 {
		t.Fatalf("head has parents %v, want a --no-ff merge", parents)
	}
	msg := gitCmd(t, f.project, "log", "-1", "--format=%B")
	if !strings.HasPrefix(msg, "Coupon codes\n") || !strings.Contains(msg, "Arc-Run: "+f.ownerID) {
		t.Fatalf("merge message %q, want the plan title and the Arc-Run line", msg)
	}
	// core.autocrlf may check it out with CRLF
	if got := strings.ReplaceAll(readFile(t, filepath.Join(f.project, "feature.txt")), "\r\n", "\n"); got != "feature\n" {
		t.Fatalf("feature.txt = %q after the land", got)
	}
	if _, err := os.Stat(tree); !os.IsNotExist(err) {
		t.Fatalf("the landing tree is still there: %v", err)
	}
	if branchExists(f.project, "wave/"+f.ownerID) {
		t.Fatal("the run's branch was not deleted")
	}
	if got := f.owner(t).Land; !reflect.DeepEqual(got, land) {
		t.Fatalf("stored land = %+v, want %+v", got, land)
	}
	// a second call finds it landed and does nothing
	if again := f.landRun(t, false); !reflect.DeepEqual(again, land) {
		t.Fatalf("second land = %+v, want the first %+v", again, land)
	}
}

func TestLandHoldsWhatItCannotMergeSafely(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, f *mergeFixture, tree string)
		want  string
	}{
		{"checkout on another branch", func(t *testing.T, f *mergeFixture, _ string) {
			gitCmd(t, f.project, "checkout", "-b", "x")
		}, "checkout is on x, not main"},
		{"staged change", func(t *testing.T, f *mergeFixture, _ string) {
			writeFile(t, filepath.Join(f.project, "base.txt"), "staged\n")
			gitCmd(t, f.project, "add", "base.txt")
		}, "staged"},
		{"merge in progress", func(t *testing.T, f *mergeFixture, _ string) {
			sha := gitCmd(t, f.project, "rev-parse", "HEAD")
			writeFile(t, filepath.Join(f.project, ".git", "MERGE_HEAD"), sha+"\n")
		}, "a merge is in progress"},
		{"rebase in progress", func(t *testing.T, f *mergeFixture, _ string) {
			if err := os.MkdirAll(filepath.Join(f.project, ".git", "rebase-merge"), 0o755); err != nil {
				t.Fatal(err)
			}
		}, "a rebase is in progress"},
		{"final stage failed", func(t *testing.T, f *mergeFixture, _ string) {
			f.setFinal(t, &waveobj.FinalStage{State: FinalState_Failed, Round: 2, Detail: "Check failed"})
		}, "the final stage failed"},
		{"final stage not finished", func(t *testing.T, f *mergeFixture, _ string) {
			f.setFinal(t, &waveobj.FinalStage{State: FinalState_Verifying, Round: 1})
		}, "the final stage has not finished"},
		{"detached base", func(t *testing.T, f *mergeFixture, _ string) {
			if err := wstore.UpdateRun(f.ctx, f.channel, f.ownerID, func(r *waveobj.Run) error {
				r.BaseBranch = ""
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		}, "the run started on a detached HEAD"},
		{"untracked file that differs from the branch's", func(t *testing.T, f *mergeFixture, _ string) {
			writeFile(t, filepath.Join(f.project, "feature.txt"), "mine\n")
		}, "an untracked feature.txt in the checkout differs"},
		{"conflict", func(t *testing.T, f *mergeFixture, tree string) {
			commitOnBranch(t, tree, "base.txt", "branch\n")
			f.setFinal(t, &waveobj.FinalStage{State: FinalState_Passed, Round: 1, Commit: gitCmd(t, tree, "rev-parse", "HEAD")})
			commitOnBranch(t, f.project, "base.txt", "main\n")
		}, "base.txt"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f, tree := landFixture(t)
			c.setup(t, f, tree)
			head := gitCmd(t, f.project, "rev-parse", "main")
			f.assertHeld(t, f.landRun(t, false), head, c.want)
		})
	}
}

func TestLandAbortsAConflictedMerge(t *testing.T) {
	f, tree := landFixture(t)
	commitOnBranch(t, tree, "base.txt", "branch\n")
	f.setFinal(t, &waveobj.FinalStage{State: FinalState_Passed, Round: 1, Commit: gitCmd(t, tree, "rev-parse", "HEAD")})
	commitOnBranch(t, f.project, "base.txt", "main\n")

	land := f.landRun(t, false)
	if land.State != LandState_Held || !strings.Contains(land.Reason, "conflict") {
		t.Fatalf("land = %+v, want a held conflict", land)
	}
	if status := gitCmd(t, f.project, "status", "--porcelain"); status != "" {
		t.Fatalf("checkout left dirty after the abort:\n%s", status)
	}
	if _, err := os.Stat(filepath.Join(f.project, ".git", "MERGE_HEAD")); !os.IsNotExist(err) {
		t.Fatal("the conflicted merge was not aborted")
	}
}

func TestLandKeepsUncommittedEdits(t *testing.T) {
	t.Run("an edit to a file the branch changes holds the land", func(t *testing.T) {
		f, tree := landFixture(t)
		commitOnBranch(t, tree, "base.txt", "branch\n")
		f.setFinal(t, &waveobj.FinalStage{State: FinalState_Passed, Round: 1, Commit: gitCmd(t, tree, "rev-parse", "HEAD")})
		edit := "the human's edit\r\nwith odd bytes \x00\n"
		writeFile(t, filepath.Join(f.project, "base.txt"), edit)
		head := gitCmd(t, f.project, "rev-parse", "main")

		f.assertHeld(t, f.landRun(t, false), head, "base.txt")
		if got := readFile(t, filepath.Join(f.project, "base.txt")); got != edit {
			t.Fatalf("base.txt = %q, want the edit byte-identical", got)
		}
	})
	t.Run("an edit to an unrelated file lands around it", func(t *testing.T) {
		f, _ := landFixture(t)
		writeFile(t, filepath.Join(f.project, "base.txt"), "the human's edit\n")

		if land := f.landRun(t, false); land.State != LandState_Landed {
			t.Fatalf("land = %+v, want landed", land)
		}
		if got := readFile(t, filepath.Join(f.project, "base.txt")); got != "the human's edit\n" {
			t.Fatalf("base.txt = %q, want the edit intact", got)
		}
	})
}

// the lead writes its spec or plan in the checkout before submit, and the engine commits the same file on
// the run's branch; the untracked copy is the one git would refuse to overwrite
func TestLandRemovesAnUntrackedCopyOfWhatTheBranchAdds(t *testing.T) {
	f, _ := landFixture(t)
	writeFile(t, filepath.Join(f.project, "feature.txt"), "feature\n")

	if land := f.landRun(t, false); land.State != LandState_Landed {
		t.Fatalf("land = %+v, want landed", land)
	}
	if got := gitCmd(t, f.project, "ls-files", "feature.txt"); got != "feature.txt" {
		t.Fatalf("feature.txt is not tracked after the land: %q", got)
	}
}

func TestLandForceLandsAFailedOutcome(t *testing.T) {
	f, _ := landFixture(t)
	f.setFinal(t, &waveobj.FinalStage{State: FinalState_Failed, Round: 2, Detail: "Check failed"})
	if land := f.landRun(t, true); land.State != LandState_Landed {
		t.Fatalf("land = %+v, want landed under force", land)
	}
}

func TestLandReverifiesCommitsAfterTheFinalStage(t *testing.T) {
	t.Run("a failing Verify holds", func(t *testing.T) {
		f, tree := landFixture(t)
		commitOnBranch(t, tree, "wrapup.txt", "wrap-up\n")
		if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
			cur.Verify = "exit 1"
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		head := gitCmd(t, f.project, "rev-parse", "main")
		f.assertHeld(t, f.landRun(t, false), head, "Verify `exit 1` failed")
	})
	t.Run("a passing Check and Verify land", func(t *testing.T) {
		f, tree := landFixture(t)
		commitOnBranch(t, tree, "wrapup.txt", "wrap-up\n")
		out := filepath.ToSlash(t.TempDir())
		if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
			cur.Check = "test -f wrapup.txt && echo check > " + out + "/check"
			cur.Verify = "test -f wrapup.txt && echo verify > " + out + "/verify"
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if land := f.landRun(t, false); land.State != LandState_Landed {
			t.Fatalf("land = %+v, want landed", land)
		}
		for _, name := range []string{"check", "verify"} {
			if _, err := os.Stat(filepath.Join(out, name)); err != nil {
				t.Fatalf("%s did not run in the landing tree: %v", name, err)
			}
		}
	})
	t.Run("an unmoved branch runs nothing", func(t *testing.T) {
		f, _ := landFixture(t)
		if err := wstore.UpdateDag(f.ctx, f.dagID, func(cur *waveobj.TaskGroup) error {
			cur.Verify = "exit 1"
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if land := f.landRun(t, false); land.State != LandState_Landed {
			t.Fatalf("land = %+v, want landed without re-running Verify", land)
		}
	})
}

func TestLandNotesCommitsThatLandedOnTheBaseDuringTheRun(t *testing.T) {
	f, _ := landFixture(t)
	commitOnBranch(t, f.project, "one.txt", "1\n")
	commitOnBranch(t, f.project, "two.txt", "2\n")

	land := f.landRun(t, false)
	want := []string{"merged onto 2 commits that landed on main during the run; the combination was not verified"}
	if land.State != LandState_Landed || !reflect.DeepEqual(land.Notes, want) {
		t.Fatalf("land = %+v, want landed with notes %q", land, want)
	}
}

func TestLandLeavesACheckoutLandedRunAlone(t *testing.T) {
	f := newMergeFixture(t, []waveobj.TaskNode{{ID: "t-0", Label: "first"}})
	if err := wstore.UpdateRun(f.ctx, f.channel, f.ownerID, func(r *waveobj.Run) error {
		r.BaseBranch, r.Status = "main", jarvis.RunStatus_Done
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if land := f.landRun(t, false); land != nil {
		t.Fatalf("land = %+v, want nothing for a checkout-landed run", land)
	}
	if got := f.owner(t).Land; got != nil {
		t.Fatalf("stored land = %+v, want none", got)
	}
}
