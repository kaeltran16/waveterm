// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	_ "embed"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	KindProject  = "project"
	KindBriefing = "briefing"

	keptLine       = "You asked whether the briefing belongs on a new board, and the person chose to keep it here. Answer the briefing on this board."
	elsewhereLines = "This briefing arrived on a board that already has a talk. If it is about something other than this talk, " +
		"set `elsewhere` to true, leave `add`, `update` and `remove` empty, and in `reply` ask whether to start a new board " +
		"for it. If it belongs here, answer it as any turn."

	// summaryPrompt goes to a forked copy of the earlier board's session, so its talk stays as it was.
	summaryPrompt = "This board's talk is being handed over to a new board, whose drawer starts fresh. For this one reply, " +
		"answer in plain prose, not the JSON object: sum up this conversation for that drawer in at most 10 short " +
		"sentences: what was asked, what the drawing shows, and what was concluded."
)

//go:embed drawer-prompt.md
var promptTemplate string

// firstInput is what only a session's first prompt carries.
type firstInput struct {
	BoardName string
	About     wshrpc.BoardSource
	ThingText string // the thing's text, read once, for agent, session, run, effort and record
	Handoff   *wshrpc.BoardHandoff
}

// turnInput is what every turn's prompt carries.
type turnInput struct {
	Scene       Scene
	SelectedIds []string
	On          string
	Question    string
	Briefing    *wshrpc.BoardBriefing
	Kept        bool
	Elsewhere   bool // the drawer may answer that the briefing belongs elsewhere
}

// readsThing is whether a talk about src starts from a thing boardthings reads.
func readsThing(src wshrpc.BoardSource) bool {
	return src.Kind != "" && src.Kind != KindProject && src.Kind != KindBriefing
}

// firstPrompt fills the drawer prompt. One replacer pass, so a placeholder inside the material stays literal.
func firstPrompt(f firstInput, t turnInput) string {
	return strings.NewReplacer(
		"[BOARD]", f.BoardName,
		"[ABOUT]", aboutSection(f, t),
		"[HANDOFF]", handoffSection(f.Handoff),
		"[TURN]", turnPrompt(t),
	).Replace(promptTemplate)
}

func aboutSection(f firstInput, t turnInput) string {
	switch {
	case f.About.Kind == KindBriefing && t.Briefing != nil && t.Briefing.Text == f.About.Text:
		return fmt.Sprintf("The briefing %s sent, in this turn below, and the project's code.\n", f.About.Title)
	case f.About.Kind == KindBriefing:
		return fmt.Sprintf("A briefing %s sent, and the project's code:\n\n<briefing>\n%s\n</briefing>\n", f.About.Title, f.About.Text)
	case readsThing(f.About) && strings.TrimSpace(f.ThingText) == "":
		return fmt.Sprintf("%s, which had nothing to read yet, and the project's code.\n", f.About.Title)
	case readsThing(f.About):
		return fmt.Sprintf("%s, read for you below, and the project's code, to check what it mentions:\n\n<material>\n%s\n</material>\n",
			f.About.Title, f.ThingText)
	}
	return "The project's code. Nothing else was handed to you.\n"
}

func handoffSection(h *wshrpc.BoardHandoff) string {
	if h == nil {
		return ""
	}
	s := fmt.Sprintf("\n## Where this talk comes from\n\nThis board was started from the board %q, and its drawing was copied onto "+
		"this one (%d shapes).", h.FromName, h.Shapes)
	if strings.TrimSpace(h.Summary) != "" {
		s += " Its drawer summed up that talk:\n\n" + strings.TrimSpace(h.Summary)
	}
	return s + "\n"
}

// turnPrompt is a turn's own section: the board as it is now, the selection, and the question or briefing.
func turnPrompt(t turnInput) string {
	var b strings.Builder
	b.WriteString("## This turn\n\nThe board now, one shape per line (`update` and `remove` name these ids):\n\n")
	if t.Scene.Text == "" {
		b.WriteString("The board is empty.\n")
	} else {
		b.WriteString(t.Scene.Text + "\n")
	}
	if len(t.SelectedIds) > 0 {
		on := t.On
		if on == "" {
			on = "shapes"
		}
		fmt.Fprintf(&b, "\nSelected: %s (ids %s, marked \"selected\" above). The question is about these shapes.\n",
			on, strings.Join(t.SelectedIds, ", "))
	}
	b.WriteString("\n")
	switch {
	case t.Kept:
		b.WriteString(keptLine + "\n")
		if q := strings.TrimSpace(t.Question); q != "" {
			b.WriteString("\nIts ask: " + q + "\n")
		}
	case t.Briefing != nil:
		ask := strings.TrimSpace(t.Briefing.Ask)
		if ask == "" {
			ask = "none given: draw what the briefing explains."
		}
		fmt.Fprintf(&b, "%s sent a briefing:\n\n<briefing>\n%s\n</briefing>\n\nIts ask: %s\n", t.Briefing.From, t.Briefing.Text, ask)
		if t.Elsewhere {
			b.WriteString("\n" + elsewhereLines + "\n")
		}
	default:
		b.WriteString("The question: " + strings.TrimSpace(t.Question) + "\n")
	}
	return b.String()
}
