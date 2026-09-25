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
const PlanFormat = "Plan format. Verify, Setup and Check are optional, go before the first task, and each hold one command in backticks. " +
	"All three commands run in a POSIX shell (sh, or Git Bash on Windows). Verify runs the plan's full test suite after a " +
	"task merges; Check is a fast whole-project static check (for example typecheck plus go vet) that each worker runs " +
	"itself, instead of Verify, before it completes. " +
	"An optional Final line, also one command in backticks, runs once on the merged result after every task landed and Check " +
	"passed, with ARC_FINAL_OUT set to a directory for its screenshots and reports: exit 0 passes, exit 3 means it could not " +
	"verify and its last output line says why, and any other exit fails the run. An optional Prototype line names the design " +
	"canvas the result should match (a path, not in backticks; at most one), for the engine's final verifier. " +
	"An optional Effort line, also before the first task, names the effort tracker (`effort:<oid>` or a bare oid, not in backticks; " +
	"at most one). A task may then list `**Chunk:** <exact chunk label>` lines, one per chunk, directly after its Depends on line " +
	"(or first under the heading when it has none): the engine marks those chunks done when the task's merge passes Verify. " +
	"A Chunk line anywhere else is task text, and a plan with a Chunk line but no Effort line is refused. " +
	"Number tasks 1, 2, 3... in order under `##` or `###` headings. A Depends on line must be the first line under its heading: " +
	"leave it out to run after the previous task, write `none` for no dependencies, or list earlier tasks (`Task 1, Task 3`).\n" +
	"The engine runs tasks at the same time whenever nothing makes them wait, so the Depends on lines are what set a plan's width. " +
	"Split the work by what can proceed independently, and make a task wait only when it truly builds on another's output — a plan " +
	"with no Depends on lines is one serial chain and gets none of that.\n\n" +
	"# <plan title>\n\n" +
	"**Effort:** effort:<oid>\n" +
	"**Verify:** `<command that runs the tests>`\n" +
	"**Setup:** `<command that prepares a fresh worktree>`\n" +
	"**Check:** `<fast static check each worker runs>`\n" +
	"**Final:** `<command that checks the merged result end to end>`\n" +
	"**Prototype:** <path to the design canvas>\n\n" +
	"### Task 1: <title>\n" +
	"**Depends on:** none\n" +
	"**Chunk:** <exact chunk label>\n" +
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
	Check  string
	// Final is the command the engine's final stage runs on the merged result; Prototype is the design canvas
	// path the final verifier compares against. Both are empty when the plan names none.
	Final     string
	Prototype string
	// EffortOID is the effort tracker whose chunks tasks close through **Chunk:** lines; empty when the
	// plan names none.
	EffortOID string
	// Preamble is every header line other than the title and the plan-level lines above, verbatim and
	// in order, blank lines at each end trimmed. A worker's task prompt carries it so header prose — a
	// scope rule, a shared constraint — reaches every task, not just whichever worker opened the plan.
	Preamble string
	Tasks    []waveobj.TaskNode
}

var (
	planTaskHeadingRe = regexp.MustCompile(`^#{2,3} Task (\d+)(?::\s*(.*?))?\s*$`)
	planTitleRe       = regexp.MustCompile(`^# (.+?)\s*$`)
	planCommandRe     = regexp.MustCompile(`^\*\*(Verify|Setup|Check|Final):\*\*\s*(.*?)\s*$`)
	planBacktickRe    = regexp.MustCompile("^`([^`]+)`$")
	planEffortRe      = regexp.MustCompile(`^\*\*Effort:\*\*\s*(.*?)\s*$`)
	planPrototypeRe   = regexp.MustCompile(`^\*\*Prototype:\*\*\s*(.*?)\s*$`)
	planDependsRe     = regexp.MustCompile(`^\*\*Depends on:\*\*\s*(.*?)\s*$`)
	planChunkRe       = regexp.MustCompile(`^\*\*Chunk:\*\*\s*(.*?)\s*$`)
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
	var preamble []string
	fence := ""
	inTaskHead, dependsAllowed := false, false
	flush := func() {
		if len(p.Tasks) > 0 {
			p.Tasks[len(p.Tasks)-1].Description = strings.TrimSpace(strings.Join(body, "\n"))
		}
		body = nil
	}
	preambleLine := func(line string) {
		if len(p.Tasks) == 0 {
			preamble = append(preamble, line)
		} else {
			body = append(body, line)
		}
	}
	for _, line := range strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n") {
		if marker := planFenceMarker(line); marker != "" && (fence == "" || marker == fence) {
			if fence == "" {
				fence = marker
			} else {
				fence = ""
			}
			inTaskHead = false
			preambleLine(line)
			continue
		}
		if fence != "" {
			preambleLine(line)
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
			inTaskHead, dependsAllowed = true, true
			continue
		}
		if len(p.Tasks) == 0 {
			consumed, err := readPlanPreamble(&p, line)
			if err != nil {
				return Plan{}, err
			}
			if !consumed {
				preamble = append(preamble, line)
			}
			continue
		}
		if inTaskHead {
			if strings.TrimSpace(line) == "" {
				continue
			}
			task := &p.Tasks[len(p.Tasks)-1]
			if m := planDependsRe.FindStringSubmatch(line); m != nil && dependsAllowed {
				deps, err := parsePlanDepends(m[1], len(p.Tasks))
				if err != nil {
					return Plan{}, err
				}
				task.Deps, dependsAllowed = deps, false
				continue
			}
			if m := planChunkRe.FindStringSubmatch(line); m != nil {
				if m[1] == "" {
					return Plan{}, fmt.Errorf("task %d: **Chunk:** is empty; write the exact chunk label", len(p.Tasks))
				}
				if slices.Contains(task.Chunks, m[1]) {
					return Plan{}, fmt.Errorf("task %d lists chunk %q twice", len(p.Tasks), m[1])
				}
				task.Chunks, dependsAllowed = append(task.Chunks, m[1]), false
				continue
			}
			inTaskHead = false
		}
		body = append(body, line)
	}
	flush()
	if len(p.Tasks) == 0 {
		return Plan{}, fmt.Errorf("plan has no tasks: expected headings like \"### Task 1: <title>\"")
	}
	if p.EffortOID == "" {
		for i, t := range p.Tasks {
			if len(t.Chunks) > 0 {
				return Plan{}, fmt.Errorf("task %d (%s) names a chunk but the plan has no **Effort:** line to say which effort it belongs to", i+1, t.Label)
			}
		}
	}
	p.Preamble = strings.Join(trimBlankLines(preamble), "\n")
	return p, nil
}

// trimBlankLines drops leading and trailing blank lines, keeping any blank-line run in the middle.
func trimBlankLines(lines []string) []string {
	start := 0
	for start < len(lines) && strings.TrimSpace(lines[start]) == "" {
		start++
	}
	end := len(lines)
	for end > start && strings.TrimSpace(lines[end-1]) == "" {
		end--
	}
	return lines[start:end]
}

// readPlanPreamble reads the title and the Effort/Verify/Setup/Check/Final/Prototype lines into p, reporting
// whether line was one of those (and so must not also be kept in Plan.Preamble).
func readPlanPreamble(p *Plan, line string) (bool, error) {
	if m := planTitleRe.FindStringSubmatch(line); m != nil && p.Title == "" {
		p.Title = m[1]
		return true, nil
	}
	if m := planEffortRe.FindStringSubmatch(line); m != nil {
		oid := strings.TrimPrefix(m[1], "effort:")
		if oid == "" || strings.ContainsAny(oid, "` 	") {
			return false, fmt.Errorf("plan **Effort:** line must be effort:<oid> or a bare oid, not in backticks, got %q", m[1])
		}
		if p.EffortOID != "" {
			return false, fmt.Errorf("plan has more than one **Effort:** line")
		}
		p.EffortOID = oid
		return true, nil
	}
	if m := planPrototypeRe.FindStringSubmatch(line); m != nil {
		if m[1] == "" || strings.Contains(m[1], "`") {
			return false, fmt.Errorf("plan **Prototype:** line must be a path, not in backticks, got %q", m[1])
		}
		if p.Prototype != "" {
			return false, fmt.Errorf("plan has more than one **Prototype:** line")
		}
		p.Prototype = m[1]
		return true, nil
	}
	m := planCommandRe.FindStringSubmatch(line)
	if m == nil {
		return false, nil
	}
	cmd := planBacktickRe.FindStringSubmatch(m[2])
	if cmd == nil {
		return false, fmt.Errorf("plan **%s:** line must hold one command in backticks, got %q", m[1], m[2])
	}
	field := &p.Verify
	switch m[1] {
	case "Setup":
		field = &p.Setup
	case "Check":
		field = &p.Check
	case "Final":
		field = &p.Final
	}
	if *field != "" {
		return false, fmt.Errorf("plan has more than one **%s:** line", m[1])
	}
	*field = cmd[1]
	return true, nil
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
