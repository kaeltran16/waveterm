// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// capSection bounds one report section to reportSectionMaxLen runes. Over it, the text is cut at the last line
// boundary at or below the limit (at the limit when the first line is longer) and ends with the command that reads
// the rest, so nothing reaches a reader shortened without saying so. An empty key names the whole report.
func capSection(taskID, key, text string) string {
	runes := []rune(text)
	if len(runes) <= reportSectionMaxLen {
		return text
	}
	cut := reportSectionMaxLen
	if runes[cut] != '\n' {
		for i := cut - 1; i > 0; i-- {
			if runes[i] == '\n' {
				cut = i
				break
			}
		}
	}
	cmd := strings.TrimSpace(fmt.Sprintf("wsh jarvis dag report %s %s", taskID, key))
	return strings.TrimRight(string(runes[:cut]), " \t\n") + fmt.Sprintf("\n… %d more characters: %s", len(runes)-cut, cmd)
}

// workerReportOf reads a run's sealed report: sections when it parses, the trimmed text when it predates the format.
func workerReportOf(run *waveobj.Run) (rep jarvis.WorkerReport, unstructured string) {
	if run == nil || run.Evidence == nil {
		return jarvis.WorkerReport{}, ""
	}
	return jarvis.ReadWorkerReport(run.Evidence.Summary)
}

// leadSectionLines are the sections the lead acts on, one line each; Done and For later tasks go elsewhere.
func leadSectionLines(taskID string, run *waveobj.Run) []string {
	rep, unstructured := workerReportOf(run)
	if unstructured != "" {
		return []string{fmt.Sprintf("%s unstructured report: %s", taskID, capSection(taskID, "", unstructured))}
	}
	var lines []string
	for _, key := range []string{"differs", "not-verified", "found-not-fixed"} {
		body, _ := rep.Section(key)
		if body == "" {
			continue
		}
		lines = append(lines, fmt.Sprintf("%s %s: %s", taskID, sectionHeading(key), capSection(taskID, key, body)))
	}
	return lines
}

func sectionHeading(key string) string {
	for _, s := range jarvis.WorkerReportSections {
		if s.Key == key {
			return s.Heading
		}
	}
	return key
}
