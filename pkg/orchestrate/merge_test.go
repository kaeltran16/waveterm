package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
)

func TestMergeSquash(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "feature")
	sha, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "do the thing"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "feature.txt")); err != nil {
		t.Fatalf("merged file missing: %v", err)
	}
	if len(sha) != 40 {
		t.Fatalf("bad merge sha %q", sha)
	}
	// integration is separate from resource cleanup: the worktree stays until the caller
	// runs CleanupTaskWorktree, so a cleanup failure can never obscure an already-landed merge.
	if _, err := os.Stat(wt); err != nil {
		t.Fatalf("worktree removal must be left to the cleanup helper: %v", err)
	}
}

// a lane lands under the messages its workers wrote, oldest first and each once, not the plan's task titles,
// without the agent's attribution or any trailer
func TestMergeSquashKeepsTheWorkersCommitMessages(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	attributed := "feat(x): add the feature\n\nwhy it exists\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_1"
	for i, msg := range []string{attributed, "docs: record the feature", "docs: record the feature"} {
		os.WriteFile(filepath.Join(wt, fmt.Sprintf("f%d.txt", i)), []byte("x\n"), 0o644)
		gitCmd(t, wt, "add", ".")
		gitCmd(t, wt, "commit", "-m", msg)
	}
	if _, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "Add the feature", TaskIDs: []string{"t-1"}}, nil); err != nil {
		t.Fatal(err)
	}
	want := "feat(x): add the feature\n\nwhy it exists\n\ndocs: record the feature"
	if got := gitCmd(t, dir, "log", "-1", "--format=%B"); got != want {
		t.Fatalf("squash message = %q, want %q", got, want)
	}
}

// one worker's subject names only its own task, so a lane of several lands under their titles, with the
// workers' messages as the body; a retry still finds the commit by its message
func TestMergeSquashOfASeveralTaskLaneNamesEveryTask(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	for i, msg := range []string{"feat(schema): add the table", "feat(ui): show the table"} {
		os.WriteFile(filepath.Join(wt, fmt.Sprintf("f%d.txt", i)), []byte("x\n"), 0o644)
		gitCmd(t, wt, "add", ".")
		gitCmd(t, wt, "commit", "-m", msg)
	}
	lane := MergeLane{Title: "schema; ui", TaskIDs: []string{"t-1", "t-4"}}
	landed, err := MergeRunWorktree(context.Background(), dir, "run-1", lane, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := "feat: schema; ui\n\nfeat(schema): add the table\n\nfeat(ui): show the table"
	if got := gitCmd(t, dir, "log", "-1", "--format=%B"); got != want {
		t.Fatalf("squash message = %q, want %q", got, want)
	}
	if sha, err := MergeRunWorktree(context.Background(), dir, "run-1", lane, nil); err != nil || sha != landed {
		t.Fatalf("retry: want %s, got %q (%v)", landed, sha, err)
	}
}

// run 33880f82's t-2 + t-3 lane joined two task titles into a ~150-character subject; the body still names both
func TestMergeSquashOfASeveralTaskLaneCutsItsSubjectLine(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	for i, msg := range []string{"feat(orchestrate): show how long a merge gate has sat", "feat(cockpit): show a waiting merge gate"} {
		os.WriteFile(filepath.Join(wt, fmt.Sprintf("f%d.txt", i)), []byte("x\n"), 0o644)
		gitCmd(t, wt, "add", ".")
		gitCmd(t, wt, "commit", "-m", msg)
	}
	title := "F16 — the digest carries the merge gate's clock; `dag status` shows its age; F16 — the lead card shows a waiting merge gate and its age"
	if _, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: title, TaskIDs: []string{"t-2", "t-3"}}, nil); err != nil {
		t.Fatal(err)
	}
	subject := gitCmd(t, dir, "log", "-1", "--format=%s")
	if n := utf8.RuneCountInString(subject); n > jarvis.MaxCommitSubjectLen || !strings.HasPrefix(subject, "feat: F16 — the digest carries") {
		t.Fatalf("subject = %q (%d runes), want the lane title cut to %d", subject, n, jarvis.MaxCommitSubjectLen)
	}
	body := gitCmd(t, dir, "log", "-1", "--format=%b")
	for _, want := range []string{"feat(orchestrate): show how long a merge gate has sat", "feat(cockpit): show a waiting merge gate"} {
		if !strings.Contains(body, want) {
			t.Fatalf("body lost %q:\n%s", want, body)
		}
	}
}

// SIEM-1739's t-2 worker packed its report into a ~160-character subject; the squash cuts it to one log line
// and keeps the whole line, and the rest of the message, in the body
func TestMergeSquashCutsAWorkersOverlongSubject(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	long := "[2.6.10.1][MP][SIEM-1739] I1 I2 user update checks the write right and the target's tenant in code; a self-edit changes only profile fields; userDetails answers 404"
	os.WriteFile(filepath.Join(wt, "f.txt"), []byte("x\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", long+"\n\nwhy it changed")
	if _, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "user update", TaskIDs: []string{"t-2"}}, nil); err != nil {
		t.Fatal(err)
	}
	subject := gitCmd(t, dir, "log", "-1", "--format=%s")
	if n := utf8.RuneCountInString(subject); n > jarvis.MaxCommitSubjectLen || !strings.HasPrefix(subject, "[2.6.10.1][MP][SIEM-1739] I1 I2 user update") {
		t.Fatalf("subject = %q (%d runes), want the worker's subject cut to %d", subject, n, jarvis.MaxCommitSubjectLen)
	}
	if body := gitCmd(t, dir, "log", "-1", "--format=%b"); body != long+"\n\nwhy it changed" {
		t.Fatalf("body = %q, want the worker's whole message", body)
	}
}

// a skipped task landed nothing, so the squash commit's subject leaves it out
func TestMergeLaneLeavesOutSkippedTasks(t *testing.T) {
	g := laneGroup(t, true, map[string]string{"t-1": TaskState_Done, "t-2": TaskState_Skipped, "t-3": TaskState_Done})
	want := MergeLane{Title: "schema; ui", TaskIDs: []string{"t-1", "t-3"}}
	if got := mergeLane(g, []string{"t-1", "t-2", "t-3"}); !reflect.DeepEqual(got, want) {
		t.Fatalf("lane = %+v, want %+v", got, want)
	}
}

func TestStripAttributionDropsAgentCredit(t *testing.T) {
	msg := "feat(x): add it\n\nwhy\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_1"
	if got, want := stripAttribution(msg), "feat(x): add it\n\nwhy"; got != want {
		t.Fatalf("stripAttribution = %q, want %q", got, want)
	}
}

// a branch whose commits carry no message lands under the lane's task titles
func TestMergeSquashFallsBackToTheLaneLabel(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "--allow-empty-message", "-m", "")
	if _, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "Add the feature"}, nil); err != nil {
		t.Fatal(err)
	}
	if got, want := gitCmd(t, dir, "log", "-1", "--format=%B"), "chore: Add the feature"; got != want {
		t.Fatalf("squash message = %q, want %q", got, want)
	}
}

func TestMergeConflictBlocked(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "base.txt"), []byte("child change\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "child")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("parent change\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "parent")
	_, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "do the thing"}, nil)
	if !errors.Is(err, ErrMergeConflict) {
		t.Fatalf("want ErrMergeConflict, got %v", err)
	}
	// resolve in the project tree, then continue
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("resolved\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	if _, err := MergeContinue(context.Background(), dir, "run-1", MergeLane{Title: "do the thing"}, nil); err != nil {
		t.Fatal(err)
	}
}

// conflictedSquash leaves dir mid-squash of wave/run-1, conflicting in base.txt.
func conflictedSquash(t *testing.T) string {
	t.Helper()
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "base.txt"), []byte("child change\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "child")
	os.WriteFile(filepath.Join(dir, "base.txt"), []byte("parent change\n"), 0o644)
	gitCmd(t, dir, "add", ".")
	gitCmd(t, dir, "commit", "-m", "parent")
	if _, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "do the thing"}, nil); !errors.Is(err, ErrMergeConflict) {
		t.Fatalf("want ErrMergeConflict, got %v", err)
	}
	return dir
}

// A continue with nothing staged must not credit the lane with whatever is at HEAD: a squash the resolver threw
// away would mark the task merged on the previous lane's commit, and one they committed themselves lands under
// a message of their own, which a retried merge cannot recognize as the lane's.
func TestMergeContinueRefusesWhatTheLaneDidNotLand(t *testing.T) {
	t.Run("squash abandoned", func(t *testing.T) {
		dir := conflictedSquash(t)
		head := gitCmd(t, dir, "rev-parse", "HEAD")
		gitCmd(t, dir, "reset", "-q", "--hard")
		if sha, err := MergeContinue(context.Background(), dir, "run-1", MergeLane{Title: "do the thing"}, nil); err == nil {
			t.Fatalf("continue credited %q to a squash that was thrown away", sha)
		}
		if got := gitCmd(t, dir, "rev-parse", "HEAD"); got != head {
			t.Fatalf("a refused continue moved HEAD to %s", got)
		}
	})
	t.Run("resolver committed", func(t *testing.T) {
		dir := conflictedSquash(t)
		os.WriteFile(filepath.Join(dir, "base.txt"), []byte("parent change\nchild change\n"), 0o644)
		gitCmd(t, dir, "add", ".")
		gitCmd(t, dir, "commit", "-m", "resolve the base.txt conflict")
		_, err := MergeContinue(context.Background(), dir, "run-1", MergeLane{Title: "do the thing"}, nil)
		if err == nil || !strings.Contains(err.Error(), "git reset --soft HEAD~1") {
			t.Fatalf("continue over the resolver's own commit: err = %v, want a refusal naming the undo", err)
		}
		// the way out the refusal names lands the squash under the lane's message, and a retry recognizes it
		gitCmd(t, dir, "reset", "-q", "--soft", "HEAD~1")
		lane := MergeLane{Title: "do the thing", TaskIDs: []string{"t-1"}}
		landed, err := MergeContinue(context.Background(), dir, "run-1", lane, nil)
		if err != nil {
			t.Fatal(err)
		}
		if msg := gitCmd(t, dir, "log", "-1", "--format=%B"); strings.Contains(msg, "Arc-") {
			t.Fatalf("squash message carries a trailer: %q", msg)
		}
		if sha, err := MergeContinue(context.Background(), dir, "run-1", lane, nil); err != nil || sha != landed {
			t.Fatalf("retried continue: want %s, got %q (%v)", landed, sha, err)
		}
	})
}

// a lane that landed nothing must not be credited with whatever commit is the project's tip: acceptance 2's
// report credited a verify-only task with its predecessor's commit
func TestMergeOfALaneThatLandedNothingReturnsNoCommit(t *testing.T) {
	cases := map[string]func(t *testing.T, wt string){
		"no commits": func(*testing.T, string) {},
		"commits that net to none": func(t *testing.T, wt string) {
			os.WriteFile(filepath.Join(wt, "scratch.txt"), []byte("scratch\n"), 0o644)
			gitCmd(t, wt, "add", ".")
			gitCmd(t, wt, "commit", "-m", "add scratch")
			gitCmd(t, wt, "rm", "-q", "scratch.txt")
			gitCmd(t, wt, "commit", "-m", "drop scratch")
		},
	}
	for name, work := range cases {
		t.Run(name, func(t *testing.T) {
			dir := newGitRepo(t)
			os.WriteFile(filepath.Join(dir, "earlier.txt"), []byte("earlier lane\n"), 0o644)
			gitCmd(t, dir, "add", ".")
			gitCmd(t, dir, "commit", "-m", "an earlier lane")
			head := gitCmd(t, dir, "rev-parse", "HEAD")
			wt, err := CreateRunWorktree(context.Background(), dir, "run-2", head)
			if err != nil {
				t.Fatal(err)
			}
			work(t, wt)

			sha, err := MergeRunWorktree(context.Background(), dir, "run-2", MergeLane{Title: "verify only"}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if sha != "" {
				t.Fatalf("want no commit, got %q", sha)
			}
			if got := gitCmd(t, dir, "rev-parse", "HEAD"); got != head {
				t.Fatalf("nothing may be committed, HEAD moved to %s", got)
			}
		})
	}
}

// a merge retried after its squash already landed still reports that squash while the branch survives; once
// cleanup deleted the branch nothing marks the squash as the lane's, so the retry credits no commit
func TestMergeRetryAfterTheSquashLandedReturnsItsCommit(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	// a worker commits well before its merge; in the same second the squash would be this very commit
	gitCmd(t, wt, "commit", "--date", "2020-01-01T00:00:00", "-m", "feature")
	landed, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "do the thing"}, nil)
	if err != nil {
		t.Fatal(err)
	}

	if sha, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "do the thing"}, nil); err != nil || sha != landed {
		t.Fatalf("branch still present: want %s, got %q (%v)", landed, sha, err)
	}
	gitCmd(t, dir, "worktree", "remove", "--force", wt)
	gitCmd(t, dir, "branch", "-D", "wave/run-1")
	if sha, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "do the thing"}, nil); err != nil || sha != "" {
		t.Fatalf("branch deleted: want no commit, got %q (%v)", sha, err)
	}
	if got := gitCmd(t, dir, "rev-parse", "HEAD"); got != landed {
		t.Fatalf("a retry after the branch is gone must commit nothing, HEAD moved to %s", got)
	}
}

func TestMergeRunWorktreeNonGit(t *testing.T) {
	dir := t.TempDir()
	_, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "x"}, nil)
	if !errors.Is(err, ErrNotGitRepo) {
		t.Fatalf("want ErrNotGitRepo, got %v", err)
	}
}

// the run's spec and plan sit uncommitted in the project checkout until its first merge, which lands them
// with the work they describe
func TestMergeRunWorktreeFoldsDocsIntoTheSquashCommit(t *testing.T) {
	dir := newGitRepo(t)
	base := gitCmd(t, dir, "rev-parse", "HEAD")
	wt, _ := CreateRunWorktree(context.Background(), dir, "run-1", base)
	os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feat\n"), 0o644)
	gitCmd(t, wt, "add", ".")
	gitCmd(t, wt, "commit", "-m", "feature")
	spec := filepath.Join(dir, "spec.md")
	plan := filepath.Join(dir, "plan.md")
	os.WriteFile(spec, []byte("# spec\n"), 0o644)
	os.WriteFile(plan, []byte("# plan\n"), 0o644)
	outside := filepath.Join(t.TempDir(), "elsewhere.md")
	os.WriteFile(outside, []byte("# not in this repo\n"), 0o644)

	if _, err := MergeRunWorktree(context.Background(), dir, "run-1", MergeLane{Title: "lane"}, []string{spec, plan, outside}); err != nil {
		t.Fatalf("a path git will not stage must not fail the merge: %v", err)
	}
	files := strings.Fields(gitCmd(t, dir, "show", "--name-only", "--format=", "HEAD"))
	if want := []string{"feature.txt", "plan.md", "spec.md"}; !reflect.DeepEqual(files, want) {
		t.Fatalf("squash commit files = %v, want %v", files, want)
	}
}

// The conflict wake names the files a stopped squash left unmerged, read from the index.
func TestConflictedFilesNamesWhatTheSquashLeftUnmerged(t *testing.T) {
	dir := conflictedSquash(t)
	files, err := conflictedFiles(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(files, []string{"base.txt"}) {
		t.Fatalf("conflicted files = %q, want [base.txt]", files)
	}
}
