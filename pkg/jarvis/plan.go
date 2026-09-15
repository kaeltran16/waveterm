// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// PlanFormat states the plan shape ParsePlan accepts, for whoever writes the plan. Its example is
// parsed by TestPlanFormatParses, so the prose and the parser cannot drift apart.
const PlanFormat = "Plan format. Verify and Setup are optional, go before the first task, and each hold one command in backticks. " +
	"Number tasks 1, 2, 3... in order under `##` or `###` headings. A Depends on line must be the first line under its heading: " +
	"leave it out to run after the previous task, write `none` for no dependencies, or list earlier tasks (`Task 1, Task 3`).\n\n" +
	"# <plan title>\n\n" +
	"**Verify:** `<command that runs the tests>`\n" +
	"**Setup:** `<command that prepares a fresh worktree>`\n\n" +
	"### Task 1: <title>\n" +
	"**Depends on:** none\n" +
	"<what to do, and the tests that prove it>\n\n" +
	"### Task 2: <title>\n" +
	"<no Depends line: runs after Task 1>\n\n" +
	"### Task 3: <title>\n" +
	"**Depends on:** Task 1\n" +
	"<runs beside Task 2>\n"

// Plan is a parsed implementation plan: its tasks as DAG nodes ("t-N"), plus the plan-level commands.
type Plan struct {
	Title  string
	Verify string
	Setup  string
	Tasks  []waveobj.TaskNode
}

var (
	planTaskHeadingRe = regexp.MustCompile(`^#{2,3} Task (\d+)(?::\s*(.*?))?\s*$`)
	planTitleRe       = regexp.MustCompile(`^# (.+?)\s*$`)
	planCommandRe     = regexp.MustCompile(`^\*\*(Verify|Setup):\*\*\s*(.*?)\s*$`)
	planBacktickRe    = regexp.MustCompile("^`([^`]+)`$")
	planDependsRe     = regexp.MustCompile(`^\*\*Depends on:\*\*\s*(.*?)\s*$`)
	planTaskRefRe     = regexp.MustCompile(`^Task (\d+)$`)
)

func planTaskID(n int) string {
	return "t-" + strconv.Itoa(n)
}

func planFenceMarker(line string) string {
	trimmed := strings.TrimLeft(line, " \t")
	for _, marker := range []string{"```", "~~~"} {
		if strings.HasPrefix(trimmed, marker) {
			return marker
		}
	}
	return ""
}

// ParsePlan reads a plan in PlanFormat. Lines inside code fences are task text only, so a plan that
// quotes a sample plan does not grow the sample's tasks.
func ParsePlan(src string) (Plan, error) {
	var p Plan
	var body []string
	fence := ""
	awaitingDepends := false
	flush := func() {
		if len(p.Tasks) > 0 {
			p.Tasks[len(p.Tasks)-1].Description = strings.TrimSpace(strings.Join(body, "\n"))
		}
		body = nil
	}
	for _, line := range strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n") {
		if marker := planFenceMarker(line); marker != "" && (fence == "" || marker == fence) {
			if fence == "" {
				fence = marker
			} else {
				fence = ""
			}
			awaitingDepends = false
			body = append(body, line)
			continue
		}
		if fence != "" {
			body = append(body, line)
			continue
		}
		if m := planTaskHeadingRe.FindStringSubmatch(line); m != nil {
			n, _ := strconv.Atoi(m[1])
			if n != len(p.Tasks)+1 {
				return Plan{}, fmt.Errorf("plan heading %q is out of order: tasks are numbered 1, 2, 3..., want Task %d", strings.TrimSpace(line), len(p.Tasks)+1)
			}
			flush()
			task := waveobj.TaskNode{ID: planTaskID(n), Label: m[2]}
			if task.Label == "" {
				task.Label = "Task " + m[1]
			}
			if n > 1 {
				task.Deps = []string{planTaskID(n - 1)}
			}
			p.Tasks = append(p.Tasks, task)
			awaitingDepends = true
			continue
		}
		if len(p.Tasks) == 0 {
			if err := readPlanPreamble(&p, line); err != nil {
				return Plan{}, err
			}
			continue
		}
		if awaitingDepends {
			if strings.TrimSpace(line) == "" {
				continue
			}
			awaitingDepends = false
			if m := planDependsRe.FindStringSubmatch(line); m != nil {
				deps, err := parsePlanDepends(m[1], len(p.Tasks))
				if err != nil {
					return Plan{}, err
				}
				p.Tasks[len(p.Tasks)-1].Deps = deps
				continue
			}
		}
		body = append(body, line)
	}
	flush()
	if len(p.Tasks) == 0 {
		return Plan{}, fmt.Errorf("plan has no tasks: expected headings like \"### Task 1: <title>\"")
	}
	return p, nil
}

func readPlanPreamble(p *Plan, line string) error {
	if m := planTitleRe.FindStringSubmatch(line); m != nil && p.Title == "" {
		p.Title = m[1]
		return nil
	}
	m := planCommandRe.FindStringSubmatch(line)
	if m == nil {
		return nil
	}
	cmd := planBacktickRe.FindStringSubmatch(m[2])
	if cmd == nil {
		return fmt.Errorf("plan **%s:** line must hold one command in backticks, got %q", m[1], m[2])
	}
	field := &p.Verify
	if m[1] == "Setup" {
		field = &p.Setup
	}
	if *field != "" {
		return fmt.Errorf("plan has more than one **%s:** line", m[1])
	}
	*field = cmd[1]
	return nil
}

func parsePlanDepends(value string, n int) ([]string, error) {
	if strings.EqualFold(value, "none") {
		return nil, nil
	}
	if value == "" {
		return nil, fmt.Errorf("task %d: **Depends on:** is empty; write none, or list earlier tasks like \"Task 1, Task 2\"", n)
	}
	var deps []string
	for _, ref := range strings.Split(value, ",") {
		ref = strings.TrimSpace(ref)
		m := planTaskRefRe.FindStringSubmatch(ref)
		if m == nil {
			return nil, fmt.Errorf("task %d depends on %q; write references like \"Task 1\"", n, ref)
		}
		dep, _ := strconv.Atoi(m[1])
		if dep < 1 || dep >= n {
			return nil, fmt.Errorf("task %d depends on %s, which is not an earlier task", n, ref)
		}
		if slices.Contains(deps, planTaskID(dep)) {
			return nil, fmt.Errorf("task %d lists %s twice", n, ref)
		}
		deps = append(deps, planTaskID(dep))
	}
	return deps, nil
}

// Lanes groups tasks into maximal chains: a task continues its dependency's lane when it has exactly
// one dependency and is that dependency's only dependent. Lanes are ordered by their first task.
// Tasks must be acyclic.
func Lanes(tasks []waveobj.TaskNode) [][]string {
	byID := make(map[string]waveobj.TaskNode, len(tasks))
	dependents := map[string][]string{}
	for _, t := range tasks {
		byID[t.ID] = t
		for _, d := range t.Deps {
			dependents[d] = append(dependents[d], t.ID)
		}
	}
	var lanes [][]string
	for _, t := range tasks {
		if len(t.Deps) == 1 && len(dependents[t.Deps[0]]) == 1 {
			continue
		}
		lane := []string{t.ID}
		for cur := t.ID; len(dependents[cur]) == 1; {
			next := byID[dependents[cur][0]]
			if len(next.Deps) != 1 {
				break
			}
			lane = append(lane, next.ID)
			cur = next.ID
		}
		lanes = append(lanes, lane)
	}
	return lanes
}

// LongestChain is the number of tasks on the longest dependency path. Tasks must be acyclic.
func LongestChain(tasks []waveobj.TaskNode) int {
	deps := make(map[string][]string, len(tasks))
	for _, t := range tasks {
		deps[t.ID] = t.Deps
	}
	depth := map[string]int{}
	var walk func(id string) int
	walk = func(id string) int {
		if d, ok := depth[id]; ok {
			return d
		}
		best := 0
		for _, d := range deps[id] {
			best = max(best, walk(d))
		}
		depth[id] = best + 1
		return depth[id]
	}
	longest := 0
	for _, t := range tasks {
		longest = max(longest, walk(t.ID))
	}
	return longest
}
