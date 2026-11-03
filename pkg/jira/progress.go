// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jira

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// Finisher is the landed run that finished a chunk: its report, its merge commit (already 7 chars)
// and the branch it merged into. Commit is empty when no run landed the chunk.
type Finisher struct {
	Report string
	Commit string
	Branch string
}

func postedToJira(c waveobj.EffortChunk) bool {
	for _, n := range c.Notes {
		if n.JiraPost != "" {
			return true
		}
	}
	return false
}

// DoneSincePost is the done chunks no earlier post reported, in plan order.
func DoneSincePost(e *waveobj.Effort) []string {
	var labels []string
	for _, c := range e.Chunks {
		if c.Status == "done" && !postedToJira(c) {
			labels = append(labels, c.Label)
		}
	}
	return labels
}

var (
	headingRe    = regexp.MustCompile(`^\s{0,3}#{1,6}(\s|$)`)
	strongStarRe = regexp.MustCompile(`\*\*(.+?)\*\*`)
	strongUndRe  = regexp.MustCompile(`\b__(.+?)__\b`)
	emStarRe     = regexp.MustCompile(`\*([^*\n]+?)\*`)
	// \b keeps snake_case identifiers whole: an underscore inside a word is not emphasis
	emUndRe = regexp.MustCompile(`\b_([^_\n]+?)_\b`)
)

// CodeSummary is a report's first paragraph on one line, with markdown headings and emphasis
// stripped; "" when the report has no prose.
func CodeSummary(report string) string {
	var para []string
	for _, line := range strings.Split(report, "\n") {
		blank := strings.TrimSpace(line) == ""
		if headingRe.MatchString(line) || blank {
			if len(para) > 0 {
				break
			}
			continue
		}
		para = append(para, line)
	}
	text := strings.Join(para, " ")
	for _, re := range []*regexp.Regexp{strongStarRe, strongUndRe, emStarRe, emUndRe} {
		text = re.ReplaceAllString(text, "$1")
	}
	return strings.Join(strings.Fields(text), " ")
}

func newestNoteLine(c waveobj.EffortChunk) string {
	var newest *waveobj.EffortNote
	for i := range c.Notes {
		if newest == nil || c.Notes[i].Ts >= newest.Ts {
			newest = &c.Notes[i]
		}
	}
	if newest == nil {
		return ""
	}
	first, _, _ := strings.Cut(newest.Text, "\n")
	return strings.TrimSpace(first)
}

func codeItemSummary(c waveobj.EffortChunk, fin map[string]Finisher) string {
	if s := CodeSummary(fin[c.Label].Report); s != "" {
		return s
	}
	return newestNoteLine(c)
}

// sentence ends s with a full stop unless it already ends a sentence.
func sentence(s string) string {
	s = strings.TrimSpace(s)
	if s == "" || strings.HasSuffix(s, ".") || strings.HasSuffix(s, "!") || strings.HasSuffix(s, "?") {
		return s
	}
	return s + "."
}

// CodeDraft is the progress comment drafted from the plan and the finishing runs' reports alone.
func CodeDraft(e *waveobj.Effort, fin map[string]Finisher) string {
	return DraftWithSummaries(e, fin, nil)
}

// DraftWithSummaries is CodeDraft with each Done item's summary replaced by sums[label] when present.
// Format: a progress line, then Done (chunks done since the last post), In progress (active and
// blocked) and Next (pending); deferred and skipped chunks and empty sections are left out.
func DraftWithSummaries(e *waveobj.Effort, fin map[string]Finisher, sums map[string]string) string {
	var done, inProgress, next []string
	doneCount, counted := 0, 0
	for _, c := range e.Chunks {
		if c.Status != "skipped" {
			counted++
		}
		switch c.Status {
		case "done":
			doneCount++
			if !postedToJira(c) {
				done = append(done, doneItem(c, fin, sums))
			}
		case "active":
			inProgress = append(inProgress, "- "+c.Label)
		case "blocked":
			inProgress = append(inProgress, "- "+c.Label+" (blocked)")
		case "pending":
			next = append(next, "- "+c.Label)
		}
	}
	parts := []string{fmt.Sprintf("Progress: %d of %d parts done.", doneCount, counted)}
	for _, s := range []struct {
		title string
		items []string
	}{{"Done", done}, {"In progress", inProgress}, {"Next", next}} {
		if len(s.items) > 0 {
			parts = append(parts, s.title+"\n"+strings.Join(s.items, "\n"))
		}
	}
	return strings.Join(parts, "\n\n")
}

func doneItem(c waveobj.EffortChunk, fin map[string]Finisher, sums map[string]string) string {
	summary := strings.TrimSpace(sums[c.Label])
	if summary == "" {
		summary = codeItemSummary(c, fin)
	}
	item := []string{"- " + sentence(c.Label)}
	if summary != "" {
		item = append(item, sentence(summary))
	}
	if f := fin[c.Label]; f.Commit != "" {
		item = append(item, fmt.Sprintf("Merged into %s as %s.", f.Branch, f.Commit))
	}
	return strings.Join(item, " ")
}

// SummariesPrompt asks the Headless AI for one summary per Done label, from the finishing run's
// report or, without one, the chunk's notes. The reply is parsed with ParseSummaries.
func SummariesPrompt(e *waveobj.Effort, labels []string, fin map[string]Finisher) string {
	var b strings.Builder
	fmt.Fprintf(&b, "You are writing the Done section of a progress comment on Jira ticket %s (initiative %q).\n", e.Ticket, e.Title)
	b.WriteString("For each part below, write one or two sentences saying what was delivered, in plain prose for the ticket's readers: no markdown, and no merge or commit details (those are added separately).\n")
	b.WriteString("Reply with only a JSON object mapping each part's label, exactly as given, to its summary.\n")
	for _, label := range labels {
		fmt.Fprintf(&b, "\nPart: %s\n", label)
		if report := strings.TrimSpace(fin[label].Report); report != "" {
			fmt.Fprintf(&b, "Report of the run that finished it:\n%s\n", report)
			continue
		}
		b.WriteString("Notes on the part, oldest first:\n")
		for _, c := range e.Chunks {
			if c.Label != label {
				continue
			}
			for _, n := range c.Notes {
				fmt.Fprintf(&b, "- %s\n", strings.TrimSpace(n.Text))
			}
		}
	}
	return b.String()
}

// ParseSummaries reads the model's {"<label>": "<summary>"} reply, tolerating prose or a code fence
// around the object.
func ParseSummaries(reply string) (map[string]string, error) {
	start, end := strings.Index(reply, "{"), strings.LastIndex(reply, "}")
	if start < 0 || end < start {
		return nil, errors.New("no JSON object in the summaries reply")
	}
	var sums map[string]string
	if err := json.Unmarshal([]byte(reply[start:end+1]), &sums); err != nil {
		return nil, fmt.Errorf("reading the summaries reply: %w", err)
	}
	return sums, nil
}
