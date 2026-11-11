// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"unicode"

	"github.com/fsnotify/fsnotify"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const defaultTranscriptTailLines = 200

// tailBlockSize is how far back each step of the bounded tail read goes
const tailBlockSize = 64 * 1024

// openTranscript opens the JSONL transcript at path for reading, refusing an empty path or a directory.
func openTranscript(path string) (*os.File, int64, error) {
	if path == "" {
		return nil, 0, fmt.Errorf("transcript path is required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, fmt.Errorf("stat transcript: %w", err)
	}
	if info.IsDir() {
		return nil, 0, fmt.Errorf("transcript path is a directory: %s", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, fmt.Errorf("read transcript: %w", err)
	}
	return f, info.Size(), nil
}

// nonEmptyLines splits data on newlines and drops blank lines.
func nonEmptyLines(data string) []string {
	var lines []string
	for _, ln := range strings.Split(data, "\n") {
		if strings.TrimSpace(ln) == "" {
			continue
		}
		lines = append(lines, ln)
	}
	return lines
}

// readTranscriptLines returns all non-empty lines of the JSONL transcript at path, reading it whole: only
// Pi's full-history read needs every line.
func readTranscriptLines(path string) ([]string, error) {
	f, _, err := openTranscript(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, fmt.Errorf("read transcript: %w", err)
	}
	return nonEmptyLines(string(data)), nil
}

// readTail reads back from the end of the first size bytes of f in doubling blocks until it holds n
// non-empty lines that start on a line boundary, or the whole file. It returns that boundary and the bytes
// from it on, so a tail read costs the tail, not the file: subagent transcripts reach tens of MB. An
// unterminated last line counts, as in nonEmptyLines.
func readTail(f *os.File, size int64, n int) (int64, []byte, error) {
	var data []byte
	pos := size
	for block := int64(tailBlockSize); pos > 0; block *= 2 {
		step := min(block, pos)
		pos -= step
		chunk := make([]byte, step+int64(len(data)))
		if _, err := f.ReadAt(chunk[:step], pos); err != nil {
			return 0, nil, fmt.Errorf("read transcript: %w", err)
		}
		copy(chunk[step:], data)
		data = chunk
		if pos == 0 {
			break
		}
		if nl := bytes.IndexByte(data, '\n'); nl >= 0 && countNonEmptyLines(data[nl+1:]) >= n {
			return pos + int64(nl) + 1, data[nl+1:], nil
		}
	}
	return 0, data, nil
}

// countNonEmptyLines counts what nonEmptyLines would return, without building the strings.
func countNonEmptyLines(data []byte) int {
	count := 0
	for len(data) > 0 {
		end := bytes.IndexByte(data, '\n')
		if end < 0 {
			end = len(data)
		}
		if len(bytes.TrimSpace(data[:end])) > 0 {
			count++
		}
		data = data[min(end+1, len(data)):]
	}
	return count
}

// transcriptTailOffset is the line boundary readTail finds for the transcript at path as it is now.
func transcriptTailOffset(path string, n int) (int64, error) {
	f, size, err := openTranscript(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	off, _, err := readTail(f, size, n)
	return off, err
}

// readTranscriptLastLines returns the last n (> 0) non-empty lines of the transcript at path.
func readTranscriptLastLines(path string, n int) ([]string, error) {
	f, size, err := openTranscript(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	_, data, err := readTail(f, size, n)
	if err != nil {
		return nil, err
	}
	lines := nonEmptyLines(string(data))
	return lines[max(0, len(lines)-n):], nil
}

// gitBashPath turns the Git Bash path forms an agent's shell writes to (/tmp/..., /c/...) into Windows
// paths, given the directory Git Bash mounts as /tmp. Any other path is returned unchanged.
func gitBashPath(path, tempDir string) string {
	native := func(rest string) string { return strings.ReplaceAll(rest, "/", `\`) }
	if path == "/tmp" || strings.HasPrefix(path, "/tmp/") {
		return tempDir + native(path[len("/tmp"):])
	}
	if len(path) >= 2 && path[0] == '/' && unicode.IsLetter(rune(path[1])) && (len(path) == 2 || path[2] == '/') {
		return strings.ToUpper(path[1:2]) + `:\` + native(strings.TrimPrefix(path[2:], "/"))
	}
	return path
}

// agents redirect a shell task's output to the temp dir by variable ("$TEMP/dev.log"); each names it
var tempVarPrefix = regexp.MustCompile(`^\$\{?(?:TEMP|TMP|TMPDIR)\}?([/\\]|$)`)

// tempVarPath swaps a leading temp-dir variable for tempDir. Any other path is returned unchanged.
func tempVarPath(path, tempDir string) string {
	loc := tempVarPrefix.FindStringSubmatchIndex(path)
	if loc == nil {
		return path
	}
	return filepath.Join(tempDir, path[loc[2]:])
}

// nativeReadPath resolves a ~, a leading temp-dir variable and, on Windows, a Git Bash form: a shell task's
// output can be a file the agent redirected to from Git Bash
func nativeReadPath(path string) string {
	if strings.HasPrefix(path, "$") {
		return tempVarPath(path, os.TempDir())
	}
	if strings.HasPrefix(path, "~") {
		return wavebase.ExpandHomeDirSafe(path)
	}
	if runtime.GOOS == "windows" {
		return gitBashPath(path, os.TempDir())
	}
	return path
}

// readTranscriptTail returns the last maxLines non-empty lines of the transcript at path.
// maxLines == 0 keeps the default tail size; a negative maxLines returns every line (the
// full-history read Pi alone requests — its parent-linked active branch can't be reconstructed
// from a bounded tail).
func readTranscriptTail(path string, maxLines int) ([]string, error) {
	if maxLines < 0 {
		return readTranscriptLines(path)
	}
	if maxLines == 0 {
		maxLines = defaultTranscriptTailLines
	}
	return readTranscriptLastLines(path, maxLines)
}

// readTranscriptHead returns the first maxLines non-empty lines of the transcript at path. Codex's
// cwd lives only on the first-line session_meta record, so the head read resolves cwd for Codex
// sessions too long to fit the tail (see docs/deferred.md, Files surface).
func readTranscriptHead(path string, maxLines int) ([]string, error) {
	f, _, err := openTranscript(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if maxLines <= 0 {
		maxLines = defaultTranscriptTailLines
	}
	// a Reader, not a Scanner: a transcript line can run to MBs, past any Scanner buffer
	r := bufio.NewReaderSize(f, tailBlockSize)
	var lines []string
	for len(lines) < maxLines {
		ln, err := r.ReadString('\n')
		if trimmed := strings.TrimSuffix(ln, "\n"); strings.TrimSpace(trimmed) != "" {
			lines = append(lines, trimmed)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read transcript: %w", err)
		}
	}
	return lines, nil
}

// transcriptTailer reads only the lines appended to a file since the last call.
// It buffers a partial (non-newline-terminated) trailing line until its newline
// arrives, and resets on truncation/rotation (size shrinks below the read offset).
// The transcript is append-only JSONL; the projection tolerates the rare malformed
// line, so this stays deliberately simple.
type transcriptTailer struct {
	offset  int64
	partial []byte
}

func (t *transcriptTailer) readNew(path string) ([]string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	size := info.Size()
	if size < t.offset {
		t.offset = 0
		t.partial = nil
	}
	if size == t.offset {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(t.offset, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	// advance by what was read, not by size: ReadAll runs to the current end, past bytes appended since Stat
	t.offset += int64(len(data))
	buf := append(t.partial, data...)
	var lines []string
	start := 0
	for i := 0; i < len(buf); i++ {
		if buf[i] != '\n' {
			continue
		}
		line := strings.TrimRight(string(buf[start:i]), "\r")
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
		start = i + 1
	}
	t.partial = append([]byte(nil), buf[start:]...)
	return lines, nil
}

// streamTranscript emits the transcript backlog (last tailLines, or the whole file for a negative
// tailLines — Pi's full-history stream) then watches the containing directory and pushes
// newly-appended lines as they arrive. Returns when ctx is cancelled or on a fatal error (the
// caller forwards the error onto the channel).
func streamTranscript(ctx context.Context, path string, tailLines int, ch chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate]) error {
	if path == "" {
		return fmt.Errorf("transcript path is required")
	}
	if tailLines == 0 {
		tailLines = defaultTranscriptTailLines
	}

	// Establish the watch before snapshotting the backlog so no append between the two
	// is lost: a write during setup is captured by the backlog read (the queued event then
	// yields a no-op readNew), and every write after it is guaranteed to fire an event.
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return fmt.Errorf("creating watcher: %w", err)
	}
	defer watcher.Close()
	target := filepath.Clean(path)
	dir := filepath.Dir(target)
	// a run member reports its transcript path before Claude creates its project folder, so watch the
	// nearest existing ancestor and move the watch down as each missing folder appears.
	watched, err := nearestExistingDir(dir)
	if err != nil {
		return fmt.Errorf("watching transcript dir: %w", err)
	}
	if err := watcher.Add(watched); err != nil {
		return fmt.Errorf("watching transcript dir: %w", err)
	}
	if watched != dir {
		if watched, err = descendWatch(watcher, watched, dir); err != nil {
			return err
		}
	}

	tailer := &transcriptTailer{}
	sendBacklog := func() error {
		if tailLines > 0 && tailer.offset == 0 {
			// one extra line: readTail counts an unterminated last line, which readNew holds back
			if off, err := transcriptTailOffset(path, tailLines+1); err == nil {
				tailer.offset = off
			}
		}
		backlog, err := tailer.readNew(path)
		// a not-yet-existing file is expected: a freshly-spawned worker reports its transcript path before
		// Claude creates the JSONL. Stay open with an empty backlog and let the dir watch pick up the file's
		// Create event — don't abort, or the stream dies permanently until the panel remounts.
		if err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("reading transcript: %w", err)
		}
		if tailLines > 0 && len(backlog) > tailLines {
			backlog = backlog[len(backlog)-tailLines:]
		}
		ch <- wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate]{Response: wshrpc.AgentTranscriptUpdate{Lines: backlog}}
		return nil
	}
	if watched == dir {
		if err := sendBacklog(); err != nil {
			return err
		}
	} else {
		// the caller sees an open stream at once, as for a missing file
		ch <- wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate]{Response: wshrpc.AgentTranscriptUpdate{Lines: nil}}
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-watcher.Events:
			if !ok {
				return nil
			}
			if watched != dir {
				if event.Op&fsnotify.Create == 0 || filepath.Clean(event.Name) != nextPathDir(watched, dir) {
					continue
				}
				if watched, err = descendWatch(watcher, watched, dir); err != nil {
					return err
				}
				// lines written before the final watch arrived are read from offset 0 here
				if watched == dir {
					if err := sendBacklog(); err != nil {
						return err
					}
				}
				continue
			}
			if filepath.Clean(event.Name) != target {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create) == 0 {
				continue
			}
			lines, err := tailer.readNew(path)
			if err != nil {
				log.Printf("transcript tail read: %v\n", err)
				continue
			}
			if len(lines) == 0 {
				continue
			}
			ch <- wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate]{Response: wshrpc.AgentTranscriptUpdate{Lines: lines}}
		case werr, ok := <-watcher.Errors:
			if !ok {
				return nil
			}
			log.Printf("transcript watcher error: %v\n", werr)
		}
	}
}

// nearestExistingDir returns dir or its closest existing ancestor. A path with no existing ancestor at
// all is broken, so it errors rather than leaving a stream waiting forever.
func nearestExistingDir(dir string) (string, error) {
	for p := dir; ; {
		info, err := os.Stat(p)
		if err == nil {
			if !info.IsDir() {
				return "", fmt.Errorf("%s is not a directory", p)
			}
			return p, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(p)
		if parent == p {
			return "", fmt.Errorf("no existing ancestor of %s", dir)
		}
		p = parent
	}
}

// nextPathDir returns the child of ancestor on the way down to dir.
func nextPathDir(ancestor, dir string) string {
	p := dir
	for parent := filepath.Dir(p); parent != ancestor && parent != p; parent = filepath.Dir(p) {
		p = parent
	}
	return p
}

// descendWatch moves the watch from watched down toward dir through every folder that exists by now, and
// returns the deepest one watched. The deeper watch is added before the old one goes, so a failed add
// keeps the stream watching where it was.
func descendWatch(watcher *fsnotify.Watcher, watched, dir string) (string, error) {
	for watched != dir {
		next := nextPathDir(watched, dir)
		info, err := os.Stat(next)
		if os.IsNotExist(err) {
			return watched, nil
		}
		if err != nil {
			return watched, fmt.Errorf("watching transcript dir: %w", err)
		}
		if !info.IsDir() {
			return watched, fmt.Errorf("watching transcript dir: %s is not a directory", next)
		}
		if err := watcher.Add(next); err != nil {
			// removed again between the stat and the add: keep waiting on the current level
			if os.IsNotExist(err) {
				return watched, nil
			}
			return watched, fmt.Errorf("watching transcript dir: %w", err)
		}
		if err := watcher.Remove(watched); err != nil {
			log.Printf("transcript watcher: removing watch on %s: %v\n", watched, err)
		}
		watched = next
	}
	return watched, nil
}

// subagentsDir derives the Claude Code subagents directory for a parent transcript path:
// <dir>/<basename without .jsonl>/subagents.
func subagentsDir(parentPath string) string {
	base := strings.TrimSuffix(filepath.Base(parentPath), ".jsonl")
	return filepath.Join(filepath.Dir(parentPath), base, "subagents")
}

// firstPromptOf extracts the human prompt from a subagent transcript's first record. That record is a
// user turn whose message.content is either a bare string or an array of {type,text} blocks.
func firstPromptOf(line string) string {
	var rec struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &rec) != nil {
		return ""
	}
	var s string
	if json.Unmarshal(rec.Message.Content, &s) == nil {
		return strings.TrimSpace(s)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(rec.Message.Content, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" && strings.TrimSpace(b.Text) != "" {
				return strings.TrimSpace(b.Text)
			}
		}
	}
	return ""
}

// lastRecordTerminal reports whether the transcript's last record is a terminal assistant turn: an
// assistant message with a text block and no pending tool_use. Verified 2026-07-10 across 619 real
// subagent files — a finished child always ends this way (end_turn/stop_sequence); a live child's last
// record is a pending tool_use or a mid-flight tool_result. Read error / no records / non-assistant -> false.
func lastRecordTerminal(path string) bool {
	tail, err := readTranscriptTail(path, 1)
	if err != nil || len(tail) == 0 {
		return false
	}
	var rec struct {
		Type    string `json:"type"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(tail[0]), &rec) != nil || rec.Type != "assistant" {
		return false
	}
	var blocks []struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(rec.Message.Content, &blocks) != nil {
		return false
	}
	hasText := false
	for _, b := range blocks {
		if b.Type == "tool_use" {
			return false // a tool call awaits its result: still working
		}
		if b.Type == "text" {
			hasText = true
		}
	}
	return hasText
}

// listSubagents returns one SubagentFileInfo per agent-*.jsonl in the parent's subagents dir, sorted by
// StartedAtMs ascending. A missing dir yields an empty slice (not an error) — a parent that never
// spawned a subagent has no dir.
func listSubagents(parentPath string) ([]wshrpc.SubagentFileInfo, error) {
	if parentPath == "" {
		return nil, fmt.Errorf("parent transcript path is required")
	}
	matches, err := filepath.Glob(filepath.Join(subagentsDir(parentPath), "agent-*.jsonl"))
	if err != nil {
		return nil, fmt.Errorf("globbing subagents: %w", err)
	}
	infos := make([]wshrpc.SubagentFileInfo, 0, len(matches))
	for _, path := range matches {
		head, err := readTranscriptHead(path, 1)
		if err != nil || len(head) == 0 {
			continue
		}
		info := wshrpc.SubagentFileInfo{
			AgentId:        strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "agent-"), ".jsonl"),
			TranscriptPath: path,
			FirstPrompt:    firstPromptOf(head[0]),
			Done:           lastRecordTerminal(path),
		}
		if st, statErr := os.Stat(path); statErr == nil {
			info.StartedAtMs = st.ModTime().UnixMilli()
		}
		infos = append(infos, info)
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].StartedAtMs < infos[j].StartedAtMs })
	return infos, nil
}
