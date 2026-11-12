// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import "github.com/wavetermdev/waveterm/pkg/pisession"

// TurnsSince is a claude or pi session's digest turns stamped after sinceTs (UnixMilli), oldest first. Claude
// writes one record per text block, so the agent's consecutive replies read as one turn stamped with the last.
// Other runtimes, and a file that cannot be read, have none.
func TurnsSince(path, runtime string, sinceTs int64) []Turn {
	var all []Turn
	switch runtime {
	case "claude":
		all = claudeTurns(parseClaudeLines(readLines(path)))
	case "pi":
		file, err := pisession.Read(path)
		if err != nil {
			return nil
		}
		all = piTurns(file)
	}
	var out []Turn
	for _, t := range all {
		if t.Ts <= sinceTs {
			continue
		}
		if n := len(out); n > 0 && t.Speaker == speakerAgent && out[n-1].Speaker == speakerAgent {
			out[n-1].Text += "\n" + t.Text
			out[n-1].Ts = t.Ts
			continue
		}
		out = append(out, t)
	}
	return out
}
