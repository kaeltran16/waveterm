// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// the tool a child calls to hand its report back: bookkeeping, not one of its calls
const subagentHandbackTool = "SubagentHandback"

// the text Claude Code writes as a user record when the user stops a turn
const userInterruptMarker = "[Request interrupted by user"

const subagentScanBufSize = 64 * 1024

// subagentMeta is the agent-<id>.meta.json Claude Code writes beside a subagent transcript.
type subagentMeta struct {
	AgentType     string `json:"agentType"`
	Description   string `json:"description"`
	ToolUseId     string `json:"toolUseId"`
	RequestShape  string `json:"requestShape"`
	Finished      bool   `json:"finished"`
	StoppedByUser bool   `json:"stoppedByUser"`
}

type openCall struct {
	id   string
	call wshrpc.SubagentCall
}

// subagentScan is what one subagent file's records have shown so far, up to offset: the end of its last
// complete line. Subagent files reach 65 MB (api-request-blob records replay whole requests), so a
// listing reads only what was appended since the last one.
type subagentScan struct {
	mu sync.Mutex
	subagentRecords

	metaSize int64
	metaMod  time.Time
	meta     subagentMeta
}

// subagentRecords is what the transcript's records up to offset showed; a file that shrank starts it over.
type subagentRecords struct {
	offset      int64
	records     int // user and assistant records
	firstPrompt string
	firstAtMs   int64
	lastAtMs    int64
	toolIds     map[string]struct{}
	open        []openCall // tool_uses with no tool_result yet, in call order
	terminal    bool       // the last record is an assistant text turn with no tool_use: how a finished child ends (checked 2026-07-10 over 619 files)
	interrupted bool       // the last record is the user's interrupt marker
}

type subagentScanCache struct {
	mu        sync.Mutex
	scans     map[string]*subagentScan
	bytesRead atomic.Int64 // transcript bytes read, so tests can prove a listing reads only what was appended
}

var subagentScans = &subagentScanCache{scans: map[string]*subagentScan{}}

func (c *subagentScanCache) get(path string) *subagentScan {
	c.mu.Lock()
	defer c.mu.Unlock()
	scan := c.scans[path]
	if scan == nil {
		scan = &subagentScan{}
		c.scans[path] = scan
	}
	return scan
}

// prune drops the scans of dir's files that are no longer on disk.
func (c *subagentScanCache) prune(dir string, onDisk []string) {
	keep := make(map[string]bool, len(onDisk))
	for _, p := range onDisk {
		keep[p] = true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for p := range c.scans {
		if filepath.Dir(p) == dir && !keep[p] {
			delete(c.scans, p)
		}
	}
}

// subagentInfo reads what was appended to the subagent file at path since its last listing and returns
// its facts; ok is false while it holds no user or assistant record yet.
func (c *subagentScanCache) subagentInfo(path string) (wshrpc.SubagentFileInfo, bool, error) {
	scan := c.get(path)
	scan.mu.Lock()
	defer scan.mu.Unlock()
	st, err := os.Stat(path)
	if err != nil {
		return wshrpc.SubagentFileInfo{}, false, fmt.Errorf("stat subagent transcript: %w", err)
	}
	if st.Size() < scan.offset {
		scan.subagentRecords = subagentRecords{}
	}
	if st.Size() > scan.offset {
		if err := scan.readFrom(path, st.Size(), &c.bytesRead); err != nil {
			return wshrpc.SubagentFileInfo{}, false, err
		}
	}
	scan.refreshMeta(strings.TrimSuffix(path, ".jsonl") + ".meta.json")
	if scan.records == 0 {
		return wshrpc.SubagentFileInfo{}, false, nil
	}
	return scan.info(path, st.ModTime()), true, nil
}

// readFrom applies the complete lines between scan.offset and size; a trailing partial line (a write in
// progress) is left for the next listing.
func (scan *subagentScan) readFrom(path string, size int64, bytesRead *atomic.Int64) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("read subagent transcript: %w", err)
	}
	defer f.Close()
	bytesRead.Add(size - scan.offset)
	r := bufio.NewReaderSize(io.NewSectionReader(f, scan.offset, size-scan.offset), subagentScanBufSize)
	var long []byte // a line longer than the read buffer, joined
	for {
		chunk, err := r.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			long = append(long, chunk...)
			continue
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read subagent transcript: %w", err)
		}
		line := chunk
		if len(long) > 0 {
			long = append(long, chunk...)
			line = long
		}
		scan.offset += int64(len(line))
		scan.apply(line)
		long = long[:0]
	}
}

type subagentBlock struct {
	Type      string         `json:"type"`
	Id        string         `json:"id"`
	Name      string         `json:"name"`
	Input     map[string]any `json:"input"`
	ToolUseId string         `json:"tool_use_id"`
	Text      string         `json:"text"`
}

// apply folds one record into the scan. Only user and assistant records count; the rest are skipped on
// their top-level type alone, so a multi-MB api-request-blob is never decoded.
func (scan *subagentScan) apply(line []byte) {
	typ := topLevelType(line)
	if typ != "user" && typ != "assistant" {
		return
	}
	var rec struct {
		Timestamp string `json:"timestamp"`
		Message   struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &rec) != nil {
		return
	}
	scan.records++
	if scan.records == 1 {
		scan.firstPrompt = firstPromptOf(string(line))
	}
	if ts, err := time.Parse(time.RFC3339Nano, rec.Timestamp); err == nil {
		if scan.firstAtMs == 0 {
			scan.firstAtMs = ts.UnixMilli()
		}
		scan.lastAtMs = ts.UnixMilli()
	}
	var blocks []subagentBlock
	if json.Unmarshal(rec.Message.Content, &blocks) != nil {
		blocks = nil // a bare-string content: a prompt, which holds no call, result or marker
	}
	scan.terminal, scan.interrupted = false, false
	if typ == "user" {
		scan.applyUser(blocks)
		return
	}
	scan.applyAssistant(blocks, scan.lastAtMs)
}

func (scan *subagentScan) applyUser(blocks []subagentBlock) {
	for _, b := range blocks {
		switch b.Type {
		case "tool_result":
			scan.closeCall(b.ToolUseId)
		case "text":
			if strings.HasPrefix(strings.TrimSpace(b.Text), userInterruptMarker) {
				scan.interrupted = true
			}
		}
	}
}

func (scan *subagentScan) applyAssistant(blocks []subagentBlock, atMs int64) {
	hasText, hasToolUse := false, false
	for _, b := range blocks {
		switch b.Type {
		case "text":
			hasText = true
		case "tool_use":
			hasToolUse = true
			if b.Name == subagentHandbackTool || b.Id == "" {
				continue
			}
			if _, seen := scan.toolIds[b.Id]; seen {
				continue
			}
			if scan.toolIds == nil {
				scan.toolIds = map[string]struct{}{}
			}
			scan.toolIds[b.Id] = struct{}{}
			scan.open = append(scan.open, openCall{id: b.Id, call: wshrpc.SubagentCall{Name: b.Name, Input: b.Input, StartedAtMs: atMs}})
		}
	}
	scan.terminal = hasText && !hasToolUse
}

func (scan *subagentScan) closeCall(id string) {
	for i, c := range scan.open {
		if c.id == id {
			scan.open = append(scan.open[:i], scan.open[i+1:]...)
			return
		}
	}
}

// refreshMeta re-reads the meta file only when its size or mtime changed, so a malformed one is logged
// once per change rather than on every poll. A missing or malformed meta leaves the meta facts empty.
func (scan *subagentScan) refreshMeta(metaPath string) {
	st, err := os.Stat(metaPath)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("subagent meta: stat %s: %v\n", metaPath, err)
		}
		scan.metaSize, scan.metaMod, scan.meta = 0, time.Time{}, subagentMeta{}
		return
	}
	if st.Size() == scan.metaSize && st.ModTime().Equal(scan.metaMod) {
		return
	}
	scan.metaSize, scan.metaMod, scan.meta = st.Size(), st.ModTime(), subagentMeta{}
	data, err := os.ReadFile(metaPath)
	if err != nil {
		log.Printf("subagent meta: reading %s: %v\n", metaPath, err)
		return
	}
	if err := json.Unmarshal(data, &scan.meta); err != nil {
		log.Printf("subagent meta: parsing %s: %v\n", metaPath, err)
		scan.meta = subagentMeta{}
	}
}

func (scan *subagentScan) info(path string, modTime time.Time) wshrpc.SubagentFileInfo {
	info := wshrpc.SubagentFileInfo{
		AgentId:        strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "agent-"), ".jsonl"),
		TranscriptPath: path,
		FirstPrompt:    scan.firstPrompt,
		StartedAtMs:    scan.firstAtMs,
		Done:           scan.terminal || scan.meta.Finished,
		Stopped:        scan.interrupted || scan.meta.StoppedByUser,
		ToolUseId:      scan.meta.ToolUseId,
		AgentType:      scan.meta.AgentType,
		Description:    scan.meta.Description,
		Background:     scan.meta.RequestShape == "background",
		ToolCount:      len(scan.toolIds),
	}
	if info.StartedAtMs == 0 {
		info.StartedAtMs = modTime.UnixMilli()
	}
	if info.Done || info.Stopped {
		info.EndedAtMs = scan.lastAtMs
	} else if len(scan.open) > 0 {
		call := scan.open[len(scan.open)-1].call
		info.CurrentCall = &call
	}
	return info
}

// topLevelType returns the string value of a JSON object's top-level "type" key, walking only its
// top-level keys and skipping nested values without decoding them. "" when there is none.
func topLevelType(line []byte) string {
	depth, inStr, expectKey, keyStart := 0, false, false, -1
	for i := 0; i < len(line); i++ {
		c := line[i]
		if inStr {
			if c == '\\' {
				i++
			} else if c == '"' {
				inStr = false
				if keyStart >= 0 {
					if string(line[keyStart:i]) == "type" {
						return stringValueAfter(line[i+1:])
					}
					keyStart = -1
				}
			}
			continue
		}
		switch c {
		case '"':
			inStr = true
			if depth == 1 && expectKey {
				keyStart, expectKey = i+1, false
			}
		case '{', '[':
			depth++
			expectKey = depth == 1 && c == '{'
		case '}', ']':
			depth--
		case ',':
			expectKey = depth == 1
		}
	}
	return ""
}

// stringValueAfter reads the string after a key's closing quote (`: "value"`), or "" if the value is not
// an escape-free string.
func stringValueAfter(rest []byte) string {
	i := 0
	for i < len(rest) && (rest[i] == ' ' || rest[i] == '\t' || rest[i] == ':') {
		i++
	}
	if i >= len(rest) || rest[i] != '"' {
		return ""
	}
	end := strings.IndexAny(string(rest[i+1:min(len(rest), i+1+64)]), `"\`)
	if end < 0 || rest[i+1+end] != '"' {
		return ""
	}
	return string(rest[i+1 : i+1+end])
}
