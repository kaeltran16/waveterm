// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import "github.com/wavetermdev/waveterm/pkg/pisession"

const (
	speakerUser  = "user"
	speakerAgent = "agent"
)

// Turn is one entry of a session's text digest: a prompt a person typed or a text reply of the agent. The
// digest is what search reads, so it keeps what a person reads in the conversation and skips tool calls,
// tool output, thinking and subagent turns.
type Turn struct {
	Speaker string // "user" | "agent"
	Text    string
}

// claudeTurns is a claude transcript's digest, by HumanPrompts' rules for prompts and LastAnswer's for replies.
func claudeTurns(recs []claudeLine) []Turn {
	var out []Turn
	for _, rec := range recs {
		if text := claudeTypedText(rec); text != "" {
			out = append(out, Turn{Speaker: speakerUser, Text: text})
		} else if text := claudeReplyText(rec); text != "" {
			out = append(out, Turn{Speaker: speakerAgent, Text: text})
		}
	}
	return out
}

// piTurns is a pi session's digest, read off the active branch as HumanPrompts and LastAnswer read it.
func piTurns(file *pisession.File) []Turn {
	branch, err := file.ActiveBranch()
	if err != nil {
		return nil
	}
	var out []Turn
	for _, e := range branch {
		if text := piTypedText(e); text != "" {
			out = append(out, Turn{Speaker: speakerUser, Text: text})
		} else if text := piReplyText(e); text != "" {
			out = append(out, Turn{Speaker: speakerAgent, Text: text})
		}
	}
	return out
}
