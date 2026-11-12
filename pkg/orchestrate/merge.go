package orchestrate

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
)

var ErrMergeConflict = errors.New("merge conflict")

// MergeLane is what a lane's squash commit names: Title is its task titles, joined, and TaskIDs the tasks it
// lands. Skipped tasks are in neither, since they landed nothing.
type MergeLane struct {
	Title   string
	TaskIDs []string
}

// MergeRunWorktree squash-merges wave/<runID> into the project branch and returns the merge commit
// sha, or "" when the branch had nothing to land. The commit carries the branch's own commit messages;
// lane's title stands in only when they are empty. Worktree removal is the caller's step (CleanupTaskWorktree) so a cleanup
// failure can never obscure an already-landed merge. On conflict the tree is left mid-merge
// (ErrMergeConflict) and the caller resolves then calls MergeContinue.
func MergeRunWorktree(ctx context.Context, projectPath, runID string, lane MergeLane) (string, error) {
	if !IsGitRepo(projectPath) {
		return "", ErrNotGitRepo
	}
	branch := "wave/" + runID
	// Idempotency: if the branch is already gone, the squash commit landed on a prior attempt that failed only
	// on worktree cleanup. Nothing marks which commit that was, so it lands nothing more and credits none, and
	// the caller can still stamp Merged and clean up. Only a missing branch reads so: a probe git cannot answer would
	// have the caller stamp the lane merged and remove its unmerged branch.
	exists, err := gitAsk(ctx, projectPath, "rev-parse", "-q", "--verify", branch)
	if err != nil {
		return "", fmt.Errorf("reading %s: %w", branch, err)
	}
	if !exists {
		return "", nil
	}
	// the lead's merge runs on a dirty index: only a squash staged on a clean one can be put back without
	// taking the lead's staged work with it
	undoable, err := IndexClean(ctx, projectPath)
	if err != nil {
		return "", err
	}
	if _, err := git(ctx, projectPath, "merge", "--squash", branch); err != nil {
		if strings.Contains(err.Error(), "CONFLICT") {
			return "", ErrMergeConflict
		}
		// the branch is an ancestor of HEAD: it has no commit of its own to land
		if strings.Contains(err.Error(), "Already up to date") {
			if sha, gerr := landedHead(ctx, projectPath, runID, lane); gerr == nil {
				return sha, nil
			}
		}
		return "", fmt.Errorf("squash merge: %w", err)
	}
	return finishMerge(ctx, projectPath, runID, lane, false, undoable)
}

// MergeContinue completes a merge after the caller resolved conflicts in the project tree.
func MergeContinue(ctx context.Context, projectPath, runID string, lane MergeLane) (string, error) {
	status, err := git(ctx, projectPath, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(status, "\n") {
		if strings.HasPrefix(line, "UU ") || strings.HasPrefix(line, "AA ") || strings.HasPrefix(line, "DD ") {
			return "", fmt.Errorf("unresolved conflict: %s", line)
		}
	}
	return finishMerge(ctx, projectPath, runID, lane, true, false)
}

// finishMerge commits the squash. resolved is a continue after a conflict: with
// nothing staged it lands nothing, since HEAD is then the lane's squash from an earlier attempt or not the lane's
// at all (the squash was thrown away, or its resolver committed it under a message of their own). A commit git
// refuses (a hook, signing, a held index.lock) puts the squash back when undo is set (undoMerge): left staged, it
// would hold every later merge at the clean-index check, uncounted. undo is unset for a continue, whose staged tree
// is its resolver's work, and for a squash staged on top of other staged work, which a reset would also discard.
func finishMerge(ctx context.Context, projectPath, runID string, lane MergeLane, resolved, undo bool) (string, error) {
	if _, err := git(ctx, projectPath, "commit", "-m", mergeMessage(ctx, projectPath, runID, lane)); err != nil {
		// "nothing to commit": a retry whose squash commit already landed on the prior attempt, a branch whose
		// commits change nothing, or a resolved squash that is no longer staged
		if strings.Contains(err.Error(), "nothing to commit") || strings.Contains(err.Error(), "no changes added") || strings.Contains(err.Error(), "nothing added") {
			sha, lerr := landedHead(ctx, projectPath, runID, lane)
			if resolved && lerr == nil && sha == "" {
				return "", fmt.Errorf("nothing to commit in %s: the resolved merge is not staged. Resolve the conflicts and `git add` them without committing; if you committed the resolution yourself, undo that commit with `git reset --soft HEAD~1`; then run --continue again", projectPath)
			}
			return sha, lerr
		}
		err = fmt.Errorf("merge commit: %w", err)
		if undo {
			if uerr := undoMerge(ctx, projectPath); uerr != nil {
				err = errors.Join(err, fmt.Errorf("putting the squash back: %w", uerr))
			}
		}
		return "", err
	}
	return git(ctx, projectPath, "rev-parse", "HEAD")
}

// undoMerge puts tree back at HEAD after a merge git started and could not finish: the squash's or the merge's
// staged result and MERGE_HEAD go, while uncommitted edits outside the merge stay, as git merge --abort keeps them.
// It runs on a fresh context when ctx has ended, since that may be what killed the merge.
func undoMerge(ctx context.Context, tree string) error {
	ctx, cancel := cleanupContext(ctx)
	defer cancel()
	_, err := git(ctx, tree, "reset", "--merge")
	return err
}

// mergeMessage is the branch's commit messages, oldest first, each once and without agent attribution. The
// branch always starts at a commit on the project branch, so HEAD..branch is exactly its workers' commits. A
// lane of several tasks takes its title as the subject, since any one worker's subject names only that worker's
// task, cut to a subject line as a land title is: two task titles joined run past it, typed from the workers'
// subjects. A one-task lane falls back to the title only when the messages are empty or unreadable.
func mergeMessage(ctx context.Context, projectPath, runID string, lane MergeLane) string {
	var msgs, subjects []string
	out, err := git(ctx, projectPath, "log", "--reverse", "--format=%B%x00", "HEAD..wave/"+runID)
	if err != nil {
		log.Printf("merge %s: reading the branch's commit messages: %v", runID, err)
	}
	for _, m := range strings.Split(out, "\x00") {
		if m = stripAttribution(m); m != "" && !slices.Contains(msgs, m) {
			msgs = append(msgs, m)
			subjects = append(subjects, firstLine(m))
		}
	}
	if len(lane.TaskIDs) > 1 || len(msgs) == 0 {
		msgs = append([]string{conventionalTitle(firstLine(lane.Title), subjects)}, msgs...)
	}
	// a worker's subject past the limit is cut, and its whole line opens the body, so nothing it said is lost
	if subject, _, _ := strings.Cut(msgs[0], "\n"); len([]rune(subject)) > jarvis.MaxCommitSubjectLen {
		msgs = append([]string{landSubject(subject, jarvis.MaxCommitSubjectLen)}, msgs...)
	}
	return strings.Join(msgs, "\n\n")
}

// attributionPrefixes start the credit lines an agent harness appends to its commits. The project never
// credits the agent, and a worker's harness adds them regardless of the project's rules.
var attributionPrefixes = []string{"co-authored-by: claude", "claude-session:", "🤖 generated with [claude code]"}

func stripAttribution(msg string) string {
	var kept []string
	for _, line := range strings.Split(msg, "\n") {
		l := strings.ToLower(strings.TrimSpace(line))
		if !slices.ContainsFunc(attributionPrefixes, func(p string) bool { return strings.HasPrefix(l, p) }) {
			kept = append(kept, line)
		}
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// landedHead is HEAD when it is this branch's squash commit, and "" otherwise. A merge that commits nothing
// finds some other commit at HEAD, the previous lane's or a human's, and crediting the branch with it
// overstates what landed. The commit carries no marker, so it is recognized by its message, which the branch's
// commits fix. A one-commit lane squashed in the same second its worker committed is that very commit, so the
// branch is then no longer ahead of HEAD and nothing is credited; a worker commits well before its merge.
func landedHead(ctx context.Context, projectPath, runID string, lane MergeLane) (string, error) {
	out, err := git(ctx, projectPath, "log", "-1", "--format=%H%x00%B")
	if err != nil {
		return "", err
	}
	sha, msg, _ := strings.Cut(out, "\x00")
	if cleanMessage(msg) != cleanMessage(mergeMessage(ctx, projectPath, runID, lane)) {
		return "", nil
	}
	return sha, nil
}

// cleanMessage is msg as git stores a message given with -m: each line without trailing whitespace, and blank
// lines collapsed to one.
func cleanMessage(msg string) string {
	var kept []string
	for _, line := range strings.Split(strings.TrimSpace(msg), "\n") {
		line = strings.TrimRight(line, " \t\r")
		if line == "" && len(kept) > 0 && kept[len(kept)-1] == "" {
			continue
		}
		kept = append(kept, line)
	}
	return strings.Join(kept, "\n")
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if idx := strings.Index(s, "\n"); idx >= 0 {
		s = s[:idx]
	}
	s = strings.TrimSpace(s)
	if len(s) > 200 {
		s = s[:200]
	}
	if s == "" {
		return "merge"
	}
	return s
}
