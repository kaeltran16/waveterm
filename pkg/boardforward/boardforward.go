// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardforward

import "strings"

// Marker is the text typed into the agent for a forwarded turn: a first line naming the board, the selected labels
// and the turn, then the question. The frontend's parser mirrors this format. The first line starts with "[", so a
// board named like a command can never make the message a slash command.
func Marker(board, on, turnId, question string) string {
	head := `[From board "` + oneLine(board) + `"`
	if on = oneLine(on); on != "" {
		head += " · on " + on
	}
	return head + " · turn " + turnId + "]\n" + question
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }
