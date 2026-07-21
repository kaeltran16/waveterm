// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agentobserve"
	"github.com/wavetermdev/waveterm/pkg/gitinfo"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// verifPattern matches a shell command that is a verification step (test / lint / typecheck / build).
// Evidence-only: a command that does not match is simply not reported (we never invent expected steps).
var verifPattern = regexp.MustCompile(`\b(test|typecheck|tsc|lint|vitest|jest|pytest|go test|cargo test|build|e2e|smoke)\b`)

// classifyVerif reports whether command is a verification step and, if so, its pass/fail/unknown result.
// resultText is the tool_result body; isError is the tool_result flag.
func classifyVerif(command, resultText string, isError bool) (cmd string, result string, ok bool) {
	command = strings.TrimSpace(command)
	if command == "" || !verifPattern.MatchString(command) {
		return "", "", false
	}
	switch {
	case isError:
		return command, "fail", true
	case strings.TrimSpace(resultText) == "":
		return command, "unknown", true // ran but produced no captured result
	default:
		return command, "pass", true
	}
}

// evBlock is a content block with the fields evidence needs (superset of agentobserve's internal block).
type evBlock struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Text      string          `json:"text"`
	ToolUseID string          `json:"tool_use_id"`
	IsError   bool            `json:"is_error"`
	Content   json.RawMessage `json:"content"` // tool_result body (string or blocks)
	Input     struct {
		Command string `json:"command"`
	} `json:"input"`
}

type evRecord struct {
	Type    string `json:"type"`
	Message struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

func evBlocks(line string) (string, []evBlock) {
	var rec evRecord
	if json.Unmarshal([]byte(strings.TrimSpace(line)), &rec) != nil {
		return "", nil
	}
	var blocks []evBlock
	if json.Unmarshal(rec.Message.Content, &blocks) != nil {
		return rec.Type, nil
	}
	return rec.Type, blocks
}

// finalAssistantText returns the text of the last assistant message that carried a text block.
func finalAssistantText(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		typ, blocks := evBlocks(lines[i])
		if typ != "assistant" {
			continue
		}
		var text strings.Builder
		for _, b := range blocks {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				if text.Len() > 0 {
					text.WriteString("\n")
				}
				text.WriteString(strings.TrimSpace(b.Text))
			}
		}
		if text.Len() > 0 {
			return text.String()
		}
	}
	return ""
}

// resultText flattens a tool_result content (string or [{type:text,text}]) to plain text.
func resultText(raw json.RawMessage) (string, bool) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, false
	}
	var blocks []evBlock
	if json.Unmarshal(raw, &blocks) == nil {
		var b strings.Builder
		for _, blk := range blocks {
			b.WriteString(blk.Text)
		}
		return b.String(), false
	}
	return "", false
}

// verificationCommands scans a transcript for Bash verification calls and pairs each with its result.
// Deduped by command (last result wins). Order preserved by first appearance.
func verificationCommands(lines []string) []waveobj.EvidenceVerif {
	type pending struct{ command string }
	byToolID := map[string]pending{} // tool_use id -> command awaiting a result
	idx := map[string]int{}          // command -> position in out
	var out []waveobj.EvidenceVerif
	for _, line := range lines {
		_, blocks := evBlocks(line)
		for _, b := range blocks {
			switch b.Type {
			case "tool_use":
				if b.Name == "Bash" && verifPattern.MatchString(b.Input.Command) {
					byToolID[b.ID] = pending{command: strings.TrimSpace(b.Input.Command)}
				}
			case "tool_result":
				p, live := byToolID[b.ToolUseID]
				if !live {
					continue
				}
				delete(byToolID, b.ToolUseID)
				txt, _ := resultText(b.Content)
				cmd, res, ok := classifyVerif(p.command, txt, b.IsError)
				if !ok {
					continue
				}
				// tool output is captured with a TTY attached, so it carries ANSI color codes
				detail := firstLine(utilfn.StripANSI(txt))
				if i, seen := idx[cmd]; seen {
					out[i] = waveobj.EvidenceVerif{Cmd: cmd, Result: res, Detail: detail}
				} else {
					idx[cmd] = len(out)
					out = append(out, waveobj.EvidenceVerif{Cmd: cmd, Result: res, Detail: detail})
				}
			}
		}
	}
	// a verification tool_use with no result at all -> unknown (ran, indeterminate)
	for _, p := range byToolID {
		if _, seen := idx[p.command]; !seen {
			idx[p.command] = len(out)
			out = append(out, waveobj.EvidenceVerif{Cmd: p.command, Result: "unknown"})
		}
	}
	return out
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

// parseNumstatStatus joins `git diff --numstat` rows (adds\tdels\tpath) with `git status --porcelain -z`
// entries (XY path) into per-file evidence. Numstat drives the file set (it covers tracked + the
// synthetic untracked rows gitinfo appends); status supplies the A/M/D letter. Binary numstat ("-")
// counts as 0.
func parseNumstatStatus(numstat, statusZ string) []waveobj.EvidenceFile {
	stat := map[string]string{}
	for _, entry := range strings.Split(statusZ, "\x00") {
		if len(entry) < 3 {
			continue
		}
		xy, path := entry[:2], entry[3:]
		stat[path] = statusLetter(xy)
	}
	var out []waveobj.EvidenceFile
	for _, row := range strings.Split(numstat, "\n") {
		cols := strings.SplitN(row, "\t", 3)
		if len(cols) != 3 {
			continue
		}
		add, _ := strconv.Atoi(cols[0]) // "-" (binary) -> 0
		del, _ := strconv.Atoi(cols[1])
		path := cols[2]
		letter := stat[path]
		if letter == "" {
			letter = "M"
		}
		out = append(out, waveobj.EvidenceFile{Path: path, Stat: letter, Add: add, Del: del})
	}
	return out
}

func statusLetter(xy string) string {
	for _, c := range xy {
		switch c {
		case 'A', '?':
			return "A"
		case 'D':
			return "D"
		case 'M', 'R', 'C':
			return "M"
		}
	}
	return "M"
}

var imageExt = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".svg": true, ".webp": true}

func artifactKind(path string) string {
	switch ext := strings.ToLower(filepath.Ext(path)); {
	case ext == ".md" || ext == ".txt":
		return "doc"
	case ext == ".html" || ext == ".htm":
		return "report"
	case imageExt[ext]:
		return "image"
	default:
		return "file"
	}
}

func evidenceHash(ev waveobj.RunEvidence) string {
	ev.Hash = "" // hash excludes itself
	ev.CapturedTs = 0
	b, _ := json.Marshal(ev)
	sum := sha256.Sum256(b)
	return fmt.Sprintf("ev·%x", sum[:3])
}

// SealEvidence derives and freezes a run's evidence snapshot. Idempotent: a run that already has
// Evidence is left untouched (immutability). Locates transcripts from phase WorkerOrefs and git data
// from ProjectPath — everything it needs is on the run. A transcript I/O failure degrades that section
// to empty, but a git failure or a context timeout fails the seal (returns an error, leaves Evidence nil)
// so the backfill can retry rather than freezing an empty file list into the immutable snapshot.
func SealEvidence(ctx context.Context, run *waveobj.Run) error {
	if run == nil || run.Evidence != nil {
		return nil
	}
	completedTs := lastPhaseDoneTs(run)
	if completedTs == 0 {
		completedTs = time.Now().UnixMilli()
	}
	run.CompletedTs = completedTs

	// transcript-derived: summary (last worker) + verifications (all workers)
	var summary string
	var verifs []waveobj.EvidenceVerif
	worker, lines := lastWorkerTranscript(run)
	if len(lines) > 0 {
		summary = finalAssistantText(lines)
		verifs = verificationCommands(lines)
	}

	// git-derived: files touched. a git failure or a context timeout must NOT seal an empty file list into
	// the immutable snapshot — return an error and leave Evidence nil so the backfill (SealRunEvidenceCommand)
	// retries once git recovers. a clean non-repo result (IsRepo false, no error) is a legitimate empty.
	var files []waveobj.EvidenceFile
	var addTotal, delTotal int
	ch, gerr := gitinfo.GetChanges(ctx, run.ProjectPath, run.BaseCommit)
	if gerr != nil {
		return fmt.Errorf("evidence: computing git changes: %w", gerr)
	}
	if ctx.Err() != nil {
		return fmt.Errorf("evidence: computing git changes: %w", ctx.Err())
	}
	if ch.IsRepo {
		files = parseNumstatStatus(ch.Numstat, ch.StatusZ)
		for i := range files {
			if worker != "" {
				files[i].By = worker
			}
			addTotal += files[i].Add
			delTotal += files[i].Del
		}
	}

	// artifacts: aggregate phase artifacts, classify + size
	var artifacts []waveobj.EvidenceArtifact
	seen := map[string]bool{}
	for _, p := range run.Phases {
		for _, a := range p.Artifacts {
			if a == "" || seen[a] {
				continue
			}
			seen[a] = true
			art := waveobj.EvidenceArtifact{Path: a, Kind: artifactKind(a)}
			if info, err := os.Stat(resolveUnder(run.ProjectPath, a)); err == nil {
				art.Size = info.Size()
			}
			artifacts = append(artifacts, art)
		}
	}

	ev := waveobj.RunEvidence{
		CapturedTs: completedTs,
		Summary:    summary,
		Files:      files, AddTotal: addTotal, DelTotal: delTotal,
		Verifs:     verifs,
		Artifacts:  artifacts,
		RuntimeMs:  activeSpanMs(run),
		DurationMs: completedTs - run.CreatedTs,
	}
	ev.Hash = evidenceHash(ev)
	run.Evidence = &ev
	return nil
}

func lastPhaseDoneTs(run *waveobj.Run) int64 {
	var ts int64
	for _, p := range run.Phases {
		if p.DoneTs > ts {
			ts = p.DoneTs
		}
	}
	return ts
}

// activeSpanMs sums each phase's [StartedTs, DoneTs] span — active compute vs wall clock.
func activeSpanMs(run *waveobj.Run) int64 {
	var sum int64
	for _, p := range run.Phases {
		if p.StartedTs > 0 && p.DoneTs > p.StartedTs {
			sum += p.DoneTs - p.StartedTs
		}
	}
	return sum
}

// lastWorkerTranscript returns the (worker tab id, transcript lines) of the last non-skipped phase's
// first worker. Empty when no worker/transcript is resolvable.
func lastWorkerTranscript(run *waveobj.Run) (string, []string) {
	for i := len(run.Phases) - 1; i >= 0; i-- {
		p := run.Phases[i]
		if p.State == PhaseState_Skipped {
			continue
		}
		for _, oref := range p.WorkerOrefs {
			if !strings.HasPrefix(oref, "tab:") {
				continue
			}
			id := strings.TrimPrefix(oref, "tab:")
			if path := TranscriptPathForTab(id); path != "" {
				if lines := readTranscriptLines(path); len(lines) > 0 {
					return id, lines
				}
			}
		}
	}
	return "", nil
}

func readTranscriptLines(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var lines []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024) // transcripts have long JSONL records
	for sc.Scan() {
		if t := strings.TrimSpace(sc.Text()); t != "" {
			lines = append(lines, t)
		}
	}
	return lines
}

func resolveUnder(projectPath, artifact string) string {
	if filepath.IsAbs(artifact) {
		return artifact
	}
	return filepath.Join(projectPath, artifact)
}

// TranscriptPathForTab resolves a worker tab's on-disk Claude transcript via the block's cwd. Returns ""
// when the tab/block/transcript can't be resolved (a torn-down worker) — the caller degrades gracefully.
func TranscriptPathForTab(tabId string) string {
	ctx := context.Background()
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabId)
	if err != nil || len(tab.BlockIds) == 0 {
		return ""
	}
	block, err := wstore.DBMustGet[*waveobj.Block](ctx, tab.BlockIds[0])
	if err != nil {
		return ""
	}
	cwd := block.Meta.GetString(waveobj.MetaKey_CmdCwd, "")
	if cwd == "" {
		cwd = block.Meta.GetString(waveobj.MetaKey_File, "")
	}
	if cwd == "" {
		return ""
	}
	projectsRoot := filepath.Join(wavebase.GetHomeDir(), ".claude", "projects")
	return agentobserve.ActiveTranscript(projectsRoot, cwd)
}
