// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// DesignSessionPrompt is the first prompt of a design session a run waits on: kind picks how the human
// designs the goal with it (waveobj.RunDesignKind_*).
func DesignSessionPrompt(goal, kind string) string {
	if kind == waveobj.RunDesignKind_Canvas {
		return "Mock up this goal with arc:design: " + goal + "\n\n" +
			"A run waits on this session: when the human approves the mockup (Build this… on the canvas), the run takes it and its lead plans from it."
	}
	return "Brainstorm this goal with the human with superpowers:brainstorming: " + goal + "\n\n" +
		"A run waits on this session: when the human approves the design (Approve in the brainstorm pane), the run takes it and its lead plans from it."
}

// DesignSessionOptions are the spawn options of a run's design session: a normal session named after the run.
func DesignSessionOptions(goal string) RunWorkerOptions {
	return RunWorkerOptions{DesignSession: true, SessionId: uuid.NewString(), Label: runLabel(goal)}
}
