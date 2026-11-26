// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentsessions

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

// RunningBackgroundTasks counts the background shell tasks and monitors a claude session started and that still run
// at now, read from its transcript. It reads the records extractShellTasks in
// frontend/app/view/agents/shelltasks.ts reads for the Agent tree's "standing by", so the two agree. Other runtimes
// and a file that cannot be read give 0.
func RunningBackgroundTasks(path, runtime string, now time.Time) int {
	if runtime != "claude" {
		return 0
	}
	return claudeRunningTasks(readLines(path), now.UnixMilli())
}

// bgTaskLine is the part of a claude transcript line a background task's start or finish is read from.
type bgTaskLine struct {
	Type          string          `json:"type"`
	Timestamp     string          `json:"timestamp"`
	Operation     string          `json:"operation"`
	Content       json.RawMessage `json:"content"`
	ToolUseResult json.RawMessage `json:"toolUseResult"`
	Message       struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// bgTaskResult is a tool result that starts a task (a Bash run_in_background, a Monitor) or stops one (TaskStop).
type bgTaskResult struct {
	BackgroundTaskId string   `json:"backgroundTaskId"`
	TaskId           string   `json:"taskId"`
	TimeoutMs        *float64 `json:"timeoutMs"`
	Persistent       bool     `json:"persistent"`
	StoppedTaskId    string   `json:"task_id"`
}

// bgTaskMarkers are substrings one of which every start, stop and finish record carries, so other lines skip parsing.
var bgTaskMarkers = []string{"askId", "task_id", "task-notification"}

var taskIdsListRe = regexp.MustCompile(`Task ids: ([\s\S]*)$`)

// claudeRunningTasks is the running task count in a claude transcript's lines. A finish (a task-notification with a
// status, or a TaskStop's result) drops its task, also when written before the task's start; a monitor that is not
// persistent also ends at its timeout, which writes no record.
func claudeRunningTasks(lines []string, now int64) int {
	// per running task, when it times out; 0 for never
	running := map[string]int64{}
	finishedEarly := map[string]bool{}
	for _, line := range lines {
		if !hasAnySubstring(line, bgTaskMarkers) {
			continue
		}
		var rec bgTaskLine
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		var res bgTaskResult
		// a failed tool's toolUseResult is an error string, which neither starts nor stops a task
		if rec.Type == "user" && json.Unmarshal(rec.ToolUseResult, &res) == nil {
			if _, ok := running[res.StoppedTaskId]; ok {
				delete(running, res.StoppedTaskId)
				continue
			}
			if id, expires := startedTask(res, rec.Timestamp); id != "" {
				if !finishedEarly[id] {
					running[id] = expires
				}
				continue
			}
		}
		for _, id := range finishedTaskIds(notificationText(rec)) {
			if _, ok := running[id]; ok {
				delete(running, id)
			} else {
				finishedEarly[id] = true
			}
		}
	}
	n := 0
	for _, expires := range running {
		if expires == 0 || now < expires {
			n++
		}
	}
	return n
}

// startedTask is the id of the task a tool result starts and when it times out (0 for never); "" when it starts none.
// Another tool's result can carry a taskId too; only a Monitor's has a timeout.
func startedTask(res bgTaskResult, timestamp string) (id string, expires int64) {
	if res.BackgroundTaskId != "" {
		return res.BackgroundTaskId, 0
	}
	if res.TaskId == "" || res.TimeoutMs == nil {
		return "", 0
	}
	started := parseTs(timestamp)
	if res.Persistent || started == 0 {
		return res.TaskId, 0
	}
	return res.TaskId, started + int64(*res.TimeoutMs)
}

// notificationText is the text of a record that can carry a task notification: a queued enqueue, or a user message
// whose content is a plain string. "" for any other record.
func notificationText(rec bgTaskLine) string {
	var raw json.RawMessage
	switch {
	case rec.Type == "queue-operation" && rec.Operation == "enqueue":
		raw = rec.Content
	case rec.Type == "user":
		raw = rec.Message.Content
	default:
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

// finishedTaskIds are the ids a notification with a status ends, whatever the status: a failed or killed task has
// ended too. A session that died with tasks running names them all in one notification's summary, with no task-id. A
// monitor's event carries no status, so it ends nothing.
func finishedTaskIds(content string) []string {
	if !strings.Contains(content, "<task-notification>") {
		return nil
	}
	if _, ok := xmlTag(content, "status"); !ok {
		return nil
	}
	if id, ok := xmlTag(content, "task-id"); ok {
		return []string{id}
	}
	summary, _ := xmlTag(content, "summary")
	m := taskIdsListRe.FindStringSubmatch(summary)
	if m == nil {
		return nil
	}
	var ids []string
	for _, f := range strings.FieldsFunc(m[1], func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' || r == '\r' }) {
		if id := strings.TrimSuffix(f, "."); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

// xmlTag is the trimmed text of content's first <name>...</name>.
func xmlTag(content, name string) (string, bool) {
	_, rest, ok := strings.Cut(content, "<"+name+">")
	if !ok {
		return "", false
	}
	text, _, ok := strings.Cut(rest, "</"+name+">")
	if !ok {
		return "", false
	}
	return strings.TrimSpace(text), true
}

func hasAnySubstring(s string, subs []string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
