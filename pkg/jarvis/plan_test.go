// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func mustParsePlan(t *testing.T, src string) Plan {
	t.Helper()
	p, err := ParsePlan(src)
	if err != nil {
		t.Fatalf("ParsePlan: %v", err)
	}
	return p
}

// depLists renders each task as "id:dep,dep" so nil and empty deps compare equal.
func depLists(tasks []waveobj.TaskNode) []string {
	out := make([]string, len(tasks))
	for i, t := range tasks {
		out[i] = t.ID + ":" + strings.Join(t.Deps, ",")
	}
	return out
}

func TestParsePlanDependencies(t *testing.T) {
	t.Run("a task with no Depends line follows the previous task", func(t *testing.T) {
		p := mustParsePlan(t, "### Task 1: a\ndo a\n\n### Task 2: b\ndo b\n")
		want := []string{"t-1:", "t-2:t-1"}
		if got := depLists(p.Tasks); !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
		if p.Verify != "" || p.Setup != "" {
			t.Fatalf("Verify and Setup are optional, got %q / %q", p.Verify, p.Setup)
		}
	})
	t.Run("none and lists", func(t *testing.T) {
		p := mustParsePlan(t, "### Task 1: a\n### Task 2: b\n**Depends on:** none\n### Task 3: c\n\n**Depends on:** Task 1, Task 2\n")
		want := []string{"t-1:", "t-2:", "t-3:t-1,t-2"}
		if got := depLists(p.Tasks); !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v, want %v", got, want)
		}
	})
}

func TestParsePlanRejects(t *testing.T) {
	cases := []struct {
		name    string
		src     string
		errPart string
	}{
		{"no tasks", "# Plan\n\nJust prose.\n", "no tasks"},
		{"forward reference", "### Task 1: a\n**Depends on:** Task 2\n### Task 2: b\n", "Task 2"},
		{"unknown reference", "### Task 1: a\n### Task 2: b\n**Depends on:** Task 0\n", "Task 0"},
		{"malformed reference", "### Task 1: a\n### Task 2: b\n**Depends on:** the first one\n", "the first one"},
		{"duplicate reference", "### Task 1: a\n### Task 2: b\n### Task 3: c\n**Depends on:** Task 1, Task 1\n", "Task 1"},
		{"empty Depends", "### Task 1: a\n### Task 2: b\n**Depends on:**\n", "Depends on"},
		{"out-of-order number", "### Task 1: a\n### Task 3: c\n", "Task 3"},
		{"Verify without backticks", "**Verify:** task test\n\n### Task 1: a\n", "Verify"},
		{"a second Verify line", "**Verify:** `a`\n**Verify:** `b`\n\n### Task 1: a\n", "Verify"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ParsePlan(c.src)
			if err == nil {
				t.Fatal("want an error")
			}
			if !strings.Contains(err.Error(), c.errPart) {
				t.Fatalf("error %q should name %q", err, c.errPart)
			}
		})
	}
}

func TestParsePlanPlanLevelLinesOnlyBeforeTheFirstTask(t *testing.T) {
	src := "# Coupon codes\n\n**Verify:** `task test`\n**Setup:** `task worktree:prepare`\n\n### Task 1: a\n**Verify:** `not plan level`\ndo a\n"
	p := mustParsePlan(t, src)
	if p.Title != "Coupon codes" || p.Verify != "task test" || p.Setup != "task worktree:prepare" {
		t.Fatalf("got title %q, verify %q, setup %q", p.Title, p.Verify, p.Setup)
	}
	if !strings.Contains(p.Tasks[0].Description, "**Verify:** `not plan level`") {
		t.Fatalf("a Verify line inside a task is task text, got %q", p.Tasks[0].Description)
	}
}

func TestParsePlanTaskText(t *testing.T) {
	src := "## Task 1: first\n**Depends on:** none\n\nline one\nline two\n\n### Task 2\nsecond body\n"
	p := mustParsePlan(t, src)
	if len(p.Tasks) != 2 {
		t.Fatalf("both heading levels are tasks, got %d", len(p.Tasks))
	}
	if p.Tasks[0].Label != "first" || p.Tasks[0].Description != "line one\nline two" {
		t.Fatalf("task 1 = %q / %q", p.Tasks[0].Label, p.Tasks[0].Description)
	}
	if p.Tasks[1].Label != "Task 2" || p.Tasks[1].Description != "second body" {
		t.Fatalf("task 2 = %q / %q", p.Tasks[1].Label, p.Tasks[1].Description)
	}
}

func TestParsePlanIgnoresFencedLines(t *testing.T) {
	src := "### Task 1: write the parser test\n\n```markdown\n### Task 2: sample\n**Depends on:** none\n```\n\n### Task 2: real\n"
	p := mustParsePlan(t, src)
	if len(p.Tasks) != 2 || p.Tasks[1].Label != "real" {
		t.Fatalf("a fenced heading is not a task, got %v", depLists(p.Tasks))
	}
	if !strings.Contains(p.Tasks[0].Description, "### Task 2: sample") {
		t.Fatalf("fenced lines stay in the task text, got %q", p.Tasks[0].Description)
	}
	if want := []string{"t-1:", "t-2:t-1"}; !reflect.DeepEqual(depLists(p.Tasks), want) {
		t.Fatalf("got %v, want %v", depLists(p.Tasks), want)
	}
}

func TestParsePlanCRLF(t *testing.T) {
	p := mustParsePlan(t, "**Verify:** `go test ./...`\r\n\r\n### Task 1: a\r\nbody\r\n### Task 2: b\r\n**Depends on:** none\r\n")
	if p.Verify != "go test ./..." || p.Tasks[0].Label != "a" || p.Tasks[0].Description != "body" {
		t.Fatalf("got verify %q, task 1 %q / %q", p.Verify, p.Tasks[0].Label, p.Tasks[0].Description)
	}
	if want := []string{"t-1:", "t-2:"}; !reflect.DeepEqual(depLists(p.Tasks), want) {
		t.Fatalf("got %v, want %v", depLists(p.Tasks), want)
	}
}

func TestPlanFormatParses(t *testing.T) {
	p := mustParsePlan(t, PlanFormat)
	if want := []string{"t-1:", "t-2:t-1", "t-3:t-1"}; !reflect.DeepEqual(depLists(p.Tasks), want) {
		t.Fatalf("the format's own example must parse as documented, got %v", depLists(p.Tasks))
	}
	if p.Verify == "" || p.Setup == "" {
		t.Fatalf("the example shows Verify and Setup, got %q / %q", p.Verify, p.Setup)
	}
}

func node(id string, deps ...string) waveobj.TaskNode {
	return waveobj.TaskNode{ID: id, Label: id, Deps: deps}
}

func TestLanes(t *testing.T) {
	cases := []struct {
		name    string
		tasks   []waveobj.TaskNode
		lanes   [][]string
		longest int
	}{
		{"chain", []waveobj.TaskNode{node("t-1"), node("t-2", "t-1"), node("t-3", "t-2")}, [][]string{{"t-1", "t-2", "t-3"}}, 3},
		{"fork", []waveobj.TaskNode{node("t-1"), node("t-2", "t-1"), node("t-3", "t-1")}, [][]string{{"t-1"}, {"t-2"}, {"t-3"}}, 2},
		{"join", []waveobj.TaskNode{node("t-1"), node("t-2"), node("t-3", "t-1", "t-2")}, [][]string{{"t-1"}, {"t-2"}, {"t-3"}}, 2},
		{"independent", []waveobj.TaskNode{node("t-1"), node("t-2"), node("t-3", "t-2")}, [][]string{{"t-1"}, {"t-2", "t-3"}}, 2},
		{"a fork branch continues as its own chain", []waveobj.TaskNode{node("t-1"), node("t-2", "t-1"), node("t-3", "t-1"), node("t-4", "t-3")}, [][]string{{"t-1"}, {"t-2"}, {"t-3", "t-4"}}, 3},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Lanes(c.tasks); !reflect.DeepEqual(got, c.lanes) {
				t.Fatalf("lanes = %v, want %v", got, c.lanes)
			}
			if got := LongestChain(c.tasks); got != c.longest {
				t.Fatalf("longest chain = %d, want %d", got, c.longest)
			}
		})
	}
}
