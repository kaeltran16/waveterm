// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestParsePlanModelLine(t *testing.T) {
	cases := []struct {
		name   string
		task2  string
		model  string
		source string
		deps   []string
		chunks []string
		desc   string
	}{
		{
			name:   "after Depends",
			task2:  "**Depends on:** none\n**Model:** sonnet\ndo b",
			model:  "sonnet",
			source: waveobj.TaskModelSource_Plan,
			desc:   "do b",
		},
		{
			name:   "first under the heading, with no Depends",
			task2:  "**Model:**   claude-opus-5-5  \ndo b",
			model:  "claude-opus-5-5",
			source: waveobj.TaskModelSource_Plan,
			deps:   []string{"t-1"},
			desc:   "do b",
		},
		{
			name:   "between two Chunk lines",
			task2:  "**Chunk:** one\n**Model:** openai/gpt-5\n**Chunk:** two\ndo b",
			model:  "openai/gpt-5",
			source: waveobj.TaskModelSource_Plan,
			deps:   []string{"t-1"},
			chunks: []string{"one", "two"},
			desc:   "do b",
		},
		{
			name:  "after body text is task text",
			task2: "do b\n**Model:** sonnet",
			deps:  []string{"t-1"},
			desc:  "do b\n**Model:** sonnet",
		},
		{
			name:  "a Depends line after Model is task text",
			task2: "**Model:** sonnet\n**Depends on:** none\ndo b",
			model: "sonnet", source: waveobj.TaskModelSource_Plan,
			deps: []string{"t-1"},
			desc: "**Depends on:** none\ndo b",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := mustParsePlan(t, "**Effort:** effort:abc\n\n### Task 1: a\ndo a\n\n### Task 2: b\n"+c.task2+"\n")
			if first := p.Tasks[0]; first.RunSpec.Model != "" || first.ModelSource != "" {
				t.Fatalf("task 1 has no Model line, got %q / %q", first.RunSpec.Model, first.ModelSource)
			}
			got := p.Tasks[1]
			if got.RunSpec.Model != c.model || got.ModelSource != c.source {
				t.Fatalf("model = %q / %q, want %q / %q", got.RunSpec.Model, got.ModelSource, c.model, c.source)
			}
			if got.RunSpec.Runtime != "" {
				t.Fatalf("a Model line must leave the runtime to the run, got %q", got.RunSpec.Runtime)
			}
			if !reflect.DeepEqual(got.Deps, c.deps) {
				t.Fatalf("deps = %v, want %v", got.Deps, c.deps)
			}
			if !reflect.DeepEqual(got.Chunks, c.chunks) {
				t.Fatalf("chunks = %v, want %v", got.Chunks, c.chunks)
			}
			if got.Description != c.desc {
				t.Fatalf("description = %q, want %q", got.Description, c.desc)
			}
		})
	}
}

func TestParsePlanModelLineRefused(t *testing.T) {
	cases := []struct {
		name  string
		task2 string
		want  string
	}{
		{"empty", "**Model:**   \ndo b", "task 2: **Model:**"},
		{"backticked", "**Model:** `sonnet`\ndo b", "task 2: **Model:**"},
		{"a value with a space", "**Model:** claude opus\ndo b", "task 2: **Model:**"},
		{"two Model lines", "**Model:** sonnet\n**Model:** opus\ndo b", "task 2: **Model:**"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ParsePlan("### Task 1: a\ndo a\n\n### Task 2: b\n" + c.task2 + "\n")
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want one containing %q", err, c.want)
			}
		})
	}
}

// the format's example is what a plan writer copies, so it must show a Model line that parses
func TestPlanFormatShowsModelLine(t *testing.T) {
	p := mustParsePlan(t, PlanFormat)
	if got := p.Tasks[0]; got.RunSpec.Model != "<model-id>" || got.ModelSource != waveobj.TaskModelSource_Plan {
		t.Fatalf("task 1 of the example shows a Model line, got %q / %q", got.RunSpec.Model, got.ModelSource)
	}
	if !strings.Contains(PlanFormat, "**Model:** <model id> line") {
		t.Fatalf("the format must state the Model rule:\n%s", PlanFormat)
	}
}
