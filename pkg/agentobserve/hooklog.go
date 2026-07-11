// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentobserve

import (
	"strings"
	"time"
)

// HookState summarizes what the hook channel reported for one block, parsed from the hook debug log
// (~/.claude/arc-hook-debug.log, written when WAVETERM_HOOK_DEBUG=1). It is the pilot's "hook track":
// FirstMs/Count answer coverage (did the hook ever fire, how often), LastState/LastMs answer latency
// and staleness against the process anchor.
type HookState struct {
	LastState string `json:"laststate"`
	LastMs    int64  `json:"lastms"`
	FirstMs   int64  `json:"firstms"`
	Count     int    `json:"count"`
}

// parseRFC3339Ms parses an RFC3339 timestamp to ms epoch, or 0 on failure.
func parseRFC3339Ms(s string) int64 {
	ts, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0
	}
	return ts.UnixMilli()
}

// field returns the value of a `key=` token in a whitespace-split line, or "".
func field(fields []string, key string) string {
	for _, f := range fields {
		if strings.HasPrefix(f, key) {
			return strings.TrimPrefix(f, key)
		}
	}
	return ""
}

// ParseHookLog folds the hook debug log into per-block HookState, keyed by the normalized (bare)
// block UUID so it correlates with the process anchor. Only `published` lines count as a hook firing;
// `skip:` lines are ignored. A published line looks like:
//
//	2026-07-12T12:00:00Z published event=Stop state=idle oref=block:UUID
func ParseHookLog(content string) map[string]HookState {
	out := map[string]HookState{}
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, "published") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		ms := parseRFC3339Ms(fields[0])
		if ms == 0 {
			continue
		}
		oref := field(fields, "oref=")
		if oref == "" {
			continue
		}
		id := NormalizeBlockID(oref)
		hs := out[id]
		hs.Count++
		if hs.FirstMs == 0 || ms < hs.FirstMs {
			hs.FirstMs = ms
		}
		if ms >= hs.LastMs {
			hs.LastMs = ms
			hs.LastState = field(fields, "state=")
		}
		out[id] = hs
	}
	return out
}
