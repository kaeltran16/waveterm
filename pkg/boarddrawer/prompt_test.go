// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const elsewhereMarker = "set `elsewhere` to true"

func mustScene(t *testing.T, file string, selected []string) Scene {
	t.Helper()
	s, err := SceneSummary([]byte(file), selected)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestPrompt(t *testing.T) {
	agent := wshrpc.BoardSource{Kind: "agent", Ref: "t1", Title: "claude · waveterm"}
	handoff := &wshrpc.BoardHandoff{FromBoardId: "b0", FromName: "Data model", Summary: "They asked how wavesrv stores boards.", Shapes: 14}
	scene := mustScene(t, sceneFile, nil)
	first := firstPrompt(
		firstInput{BoardName: "Board talk", About: agent, ThingText: "turn text [BOARD] [TURN]", Handoff: handoff},
		turnInput{Scene: scene, Question: "How does wavesrv talk to the frontend?"},
	)
	for _, want := range []string{
		`"Board talk"`, "claude · waveterm", "turn text [BOARD] [TURN]", // material stays literal
		`"Data model"`, "14 shapes", "They asked how wavesrv stores boards.",
		`{"title":"...","add":[],"update":[],"remove":[]}`, `{"question":true}`,
		"## This turn", `"id":"box"`, "The question: How does wavesrv talk to the frontend?",
	} {
		if !strings.Contains(first, want) {
			t.Errorf("first prompt lacks %q", want)
		}
	}
	if strings.Contains(first, elsewhereMarker) {
		t.Errorf("a turn that is not a briefing must not carry the elsewhere instruction")
	}

	// a follow-up is the turn section alone, with the board as it is now
	added := strings.Replace(sceneFile, `"elements":[`, `"elements":[{"id":"mine","type":"diamond","x":5,"y":500,"width":40,"height":40},`, 1)
	follow := turnPrompt(turnInput{Scene: mustScene(t, added, []string{"box", "mine"}), SelectedIds: []string{"box", "mine"}, On: "wavesrv and 1 more", Question: "Open this up."})
	for _, want := range []string{`"id":"mine"`, `"id":"box","type":"rectangle","x":10,"y":20,"w":180,"h":60,"label":"wavesrv","stroke":"#1e1e1e","selected":true`,
		"Selected: wavesrv and 1 more (ids box, mine", "The question: Open this up."} {
		if !strings.Contains(follow, want) {
			t.Errorf("follow-up lacks %q:\n%s", want, follow)
		}
	}
	for _, not := range []string{"## Your reply", "What this talk is about", "claude · waveterm"} {
		if strings.Contains(follow, not) {
			t.Errorf("a follow-up must carry only the turn section, found %q", not)
		}
	}
	if strings.Contains(turnPrompt(turnInput{Scene: scene, Question: "q"}), "Selected:") {
		t.Errorf("no selection must list no selected shapes")
	}

	brief := &wshrpc.BoardBriefing{From: "claude · waveterm", Text: "The store keeps talks in sidecars.", Ask: "Draw the store."}
	onTalk := turnPrompt(turnInput{Scene: scene, Briefing: brief, Question: brief.Ask, Elsewhere: true})
	if !strings.Contains(onTalk, elsewhereMarker) || !strings.Contains(onTalk, brief.Text) || !strings.Contains(onTalk, "Its ask: Draw the store.") {
		t.Errorf("a briefing on a board with turns lacks the briefing or the elsewhere instruction:\n%s", onTalk)
	}
	briefAbout := wshrpc.BoardSource{Kind: KindBriefing, Ref: "t1", Title: "claude · waveterm", Text: brief.Text}
	newBoard := firstPrompt(firstInput{BoardName: "Store", About: briefAbout}, turnInput{Scene: Scene{}, Briefing: brief, Question: brief.Ask})
	if strings.Contains(newBoard, elsewhereMarker) {
		t.Errorf("a briefing on a new board must not carry the elsewhere instruction")
	}
	if strings.Count(newBoard, brief.Text) != 1 || !strings.Contains(newBoard, "The board is empty.") {
		t.Errorf("a new board from a briefing carries the briefing once and an empty board:\n%s", newBoard)
	}

	kept := turnPrompt(turnInput{Scene: scene, Kept: true, Question: brief.Ask})
	if !strings.Contains(kept, "chose to keep it here") || !strings.Contains(kept, "Its ask: Draw the store.") || strings.Contains(kept, elsewhereMarker) {
		t.Errorf("a kept turn must say you chose to keep it here:\n%s", kept)
	}

	// a later request from the agent is one line: the ask, with no briefing block
	line := turnPrompt(turnInput{Scene: scene, Briefing: &wshrpc.BoardBriefing{From: "claude · waveterm", Ask: "Draw the retry loop."}, Question: "Draw the retry loop."})
	if !strings.Contains(line, "claude · waveterm") || !strings.Contains(line, "Draw the retry loop.") || strings.Contains(line, "<briefing>") {
		t.Errorf("a one-line request carries its sender and ask, and no briefing block:\n%s", line)
	}

	// the agent's turns since the drawer last read them: a section only when there is something to hand over
	plain := turnInput{Scene: scene, Question: "Draw what we just discussed."}
	withAgent := plain
	withAgent.AgentTitle, withAgent.AgentTurns = "claude · waveterm", "Agent: the retry loop backs off twice."
	if p := turnPrompt(withAgent); !strings.Contains(p, withAgent.AgentTurns) || !strings.Contains(p, withAgent.AgentTitle) {
		t.Errorf("the turn lacks the agent's turns:\n%s", p)
	}
	silent := plain
	silent.AgentTitle = "claude · waveterm"
	if turnPrompt(silent) != turnPrompt(plain) {
		t.Errorf("an agent with nothing new must add nothing:\n%s", turnPrompt(silent))
	}

	project := firstPrompt(firstInput{BoardName: "x", About: wshrpc.BoardSource{}}, turnInput{Question: "q"})
	if !strings.Contains(project, "The project's code. Nothing else") || strings.Contains(project, "Where this talk comes from") {
		t.Errorf("a project talk with no handoff:\n%s", project)
	}
}
