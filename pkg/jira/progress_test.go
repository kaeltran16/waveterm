// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"slices"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const boardReport = "Deliveries that get a 429 are retried with exponential backoff, honouring Retry-After. Tests cover the 429 and Retry-After paths."

func boardEffort() *waveobj.Effort {
	return &waveobj.Effort{
		Title:  "Webhook retries",
		Ticket: "PAY-318",
		Chunks: []waveobj.EffortChunk{
			{Label: "Retry with backoff", Status: "done"},
			{Label: "Give up after 6 attempts", Status: "active"},
			{Label: "Failed state on the partner dashboard", Status: "pending"},
		},
	}
}

func boardFinishers() map[string]Finisher {
	return map[string]Finisher{"Retry with backoff": {Report: boardReport, Commit: "3e91a0c", Branch: "main"}}
}

func TestDoneSincePostSkipsPosted(t *testing.T) {
	e := &waveobj.Effort{Chunks: []waveobj.EffortChunk{
		{Label: "one", Status: "done", Notes: []waveobj.EffortNote{{Text: "In a post to PAY-318", JiraPost: "https://x/1"}}},
		{Label: "two", Status: "done", Notes: []waveobj.EffortNote{{Text: "landed"}}},
		{Label: "three", Status: "active"},
		{Label: "four", Status: "done"},
	}}
	if got, want := DoneSincePost(e), []string{"two", "four"}; !slices.Equal(got, want) {
		t.Errorf("got %v want %v", got, want)
	}
}

func TestCodeDraftMatchesBoard(t *testing.T) {
	want := "Progress: 1 of 3 parts done.\n\nDone\n- Retry with backoff. Deliveries that get a 429 are retried with exponential backoff, honouring Retry-After. Tests cover the 429 and Retry-After paths. Merged into main as 3e91a0c.\n\nIn progress\n- Give up after 6 attempts\n\nNext\n- Failed state on the partner dashboard"
	if got := CodeDraft(boardEffort(), boardFinishers()); got != want {
		t.Errorf("got:\n%s\n\nwant:\n%s", got, want)
	}
}

func TestCodeDraftOmitsEmptySectionsAndDeferred(t *testing.T) {
	e := &waveobj.Effort{Chunks: []waveobj.EffortChunk{
		{Label: "posted", Status: "done", Notes: []waveobj.EffortNote{{Text: "In a post", JiraPost: "https://x/1"}}},
		{Label: "waiting on infra", Status: "blocked"},
		{Label: "later", Status: "deferred"},
		{Label: "dropped", Status: "skipped"},
		{Label: "building", Status: "active"},
	}}
	// skipped leaves the count, deferred stays in it; nothing new is done and nothing is pending
	want := "Progress: 1 of 4 parts done.\n\nIn progress\n- waiting on infra (blocked)\n- building"
	if got := CodeDraft(e, nil); got != want {
		t.Errorf("got:\n%s\n\nwant:\n%s", got, want)
	}
}

func TestCodeDraftFallsBackToNote(t *testing.T) {
	e := &waveobj.Effort{Chunks: []waveobj.EffortChunk{
		{Label: "Ticked by hand", Status: "done", Notes: []waveobj.EffortNote{
			{Ts: 1, Text: "older note"},
			{Ts: 2, Text: "Checked the retry path by hand\nsecond line is dropped"},
		}},
	}}
	want := "Progress: 1 of 1 parts done.\n\nDone\n- Ticked by hand. Checked the retry path by hand."
	if got := CodeDraft(e, nil); got != want {
		t.Errorf("got:\n%s\n\nwant:\n%s", got, want)
	}
}

func TestCodeSummaryFirstParagraph(t *testing.T) {
	report := "## Done\n\n**Retries** land with _exponential_ backoff\nand honour Retry-After.\n\nSecond paragraph is dropped."
	if got, want := CodeSummary(report), "Retries land with exponential backoff and honour Retry-After."; got != want {
		t.Errorf("got %q want %q", got, want)
	}
	if got, want := CodeSummary("# Title\nkeeps snake_case_names intact"), "keeps snake_case_names intact"; got != want {
		t.Errorf("got %q want %q", got, want)
	}
	if got := CodeSummary("  \n## Only a heading\n"); got != "" {
		t.Errorf("heading-only report: got %q want empty", got)
	}
}

func TestParseSummariesFenced(t *testing.T) {
	reply := "Here you go:\n```json\n{\"Retry with backoff\": \"Retries back off.\"}\n```\n"
	got, err := ParseSummaries(reply)
	if err != nil {
		t.Fatalf("err %v", err)
	}
	if got["Retry with backoff"] != "Retries back off." || len(got) != 1 {
		t.Errorf("got %v", got)
	}
}

func TestParseSummariesGarbage(t *testing.T) {
	for _, reply := range []string{"", "no json here", "{not json}"} {
		if _, err := ParseSummaries(reply); err == nil {
			t.Errorf("%q: want an error", reply)
		}
	}
}

func TestDraftWithSummariesKeepsMerge(t *testing.T) {
	got := DraftWithSummaries(boardEffort(), boardFinishers(), map[string]string{"Retry with backoff": "Webhook deliveries now retry on 429s"})
	if !strings.Contains(got, "- Retry with backoff. Webhook deliveries now retry on 429s. Merged into main as 3e91a0c.\n") {
		t.Errorf("summary or merge sentence missing:\n%s", got)
	}
	if strings.Contains(got, "honouring") {
		t.Errorf("code summary not replaced:\n%s", got)
	}
}

func TestSummariesPromptCarriesSources(t *testing.T) {
	e := boardEffort()
	e.Chunks[0].Notes = nil
	e.Chunks = append(e.Chunks, waveobj.EffortChunk{Label: "By hand", Status: "done", Notes: []waveobj.EffortNote{{Text: "verified manually"}}})
	got := SummariesPrompt(e, []string{"Retry with backoff", "By hand"}, boardFinishers())
	for _, want := range []string{"PAY-318", "Retry with backoff", boardReport, "By hand", "verified manually", "JSON"} {
		if !strings.Contains(got, want) {
			t.Errorf("prompt lacks %q:\n%s", want, got)
		}
	}
}
