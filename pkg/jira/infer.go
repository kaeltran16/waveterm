// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const (
	commitScanDepth = 2000
	// a project with no initiative needs this many tagged commits before Arc trusts it
	sureMinCommits = 3
	// on an initiative tie, the winner needs this multiple of the runner-up's tagged commits
	sureCommitRatio = 2
)

// Inference is which Arc project a Jira project's tickets belong to. Project is set only when Sure;
// otherwise the agent asks, and Evidence says why.
type Inference struct {
	Project  string
	Evidence string
	Sure     bool
}

type candidate struct {
	name    string
	inits   int
	commits int
}

func (c candidate) hasHistory() bool { return c.inits > 0 || c.commits > 0 }

// InferProject picks the registered project (the keys of commits, each project's tagged commit count)
// whose initiatives and commits most often carry jiraProject's tickets.
func InferProject(jiraProject string, efforts []*waveobj.Effort, commits map[string]int) Inference {
	jiraProject = strings.ToUpper(strings.TrimSpace(jiraProject))
	inits := map[string]int{}
	for _, e := range efforts {
		if e != nil && e.Project != "" && ProjectKey(e.Ticket) == jiraProject {
			inits[e.Project]++
		}
	}
	cands := make([]candidate, 0, len(commits))
	for name, n := range commits {
		cands = append(cands, candidate{name: name, inits: inits[name], commits: n})
	}
	sort.Slice(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if a.inits != b.inits {
			return a.inits > b.inits
		}
		if a.commits != b.commits {
			return a.commits > b.commits
		}
		return a.name < b.name
	})
	if len(cands) == 0 || !cands[0].hasHistory() {
		return Inference{Evidence: "No history for " + jiraProject}
	}
	win := cands[0]
	var runner candidate
	if len(cands) > 1 {
		runner = cands[1]
	}
	evidence := fmt.Sprintf("%s, %s", plural(win.inits, "initiative"), plural(win.commits, "tagged commit"))
	// a full tie (equal commits too) is never sure, even at 0 vs 0, where "twice the runner-up" holds
	beats := win.inits > runner.inits ||
		(win.commits > runner.commits && win.commits >= sureCommitRatio*runner.commits)
	if !beats && runner.hasHistory() {
		return Inference{Evidence: fmt.Sprintf("Tied: %s and %s", win.name, runner.name)}
	}
	if !beats || (win.inits < 1 && win.commits < sureMinCommits) {
		return Inference{Evidence: evidence}
	}
	return Inference{Project: win.name, Evidence: evidence, Sure: true}
}

func plural(n int, noun string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", noun)
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// CommitCounts counts, per project (name -> path), the commit subjects among the last 2000 on HEAD
// that name a jiraProject ticket. A project git cannot read counts 0.
func CommitCounts(ctx context.Context, projects map[string]string, jiraProject string) map[string]int {
	key := strings.ToUpper(strings.TrimSpace(jiraProject))
	re := regexp.MustCompile(`\b` + regexp.QuoteMeta(key) + `-\d+\b`)
	counts := make(map[string]int, len(projects))
	for name, path := range projects {
		counts[name] = 0
		out, err := exec.CommandContext(ctx, "git", "-C", path, "log", "-n", fmt.Sprint(commitScanDepth), "--format=%s").Output()
		if err != nil {
			log.Printf("jira: counting %s commits in project %s (%s): %v\n", key, name, path, err)
			continue
		}
		for _, subject := range strings.Split(string(out), "\n") {
			if re.MatchString(subject) {
				counts[name]++
			}
		}
	}
	return counts
}
