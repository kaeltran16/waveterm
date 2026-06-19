// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/fsnotify/fsnotify"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const defaultTranscriptTailLines = 200

// readTranscriptTail returns the last maxLines non-empty lines of the JSONL transcript at path.
// The whole file is read then tailed in memory; session transcripts are MB-scale at most, so this
// stays simple (KISS) — switch to a seek-from-end read only if a real file proves too large.
func readTranscriptTail(path string, maxLines int) ([]string, error) {
	if path == "" {
		return nil, fmt.Errorf("transcript path is required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat transcript: %w", err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("transcript path is a directory: %s", path)
	}
	if maxLines <= 0 {
		maxLines = defaultTranscriptTailLines
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read transcript: %w", err)
	}
	var lines []string
	for _, ln := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(ln) == "" {
			continue
		}
		lines = append(lines, ln)
	}
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
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
	t.offset = size
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

// streamTranscript emits the transcript backlog (last tailLines) then watches the
// containing directory and pushes newly-appended lines as they arrive. Returns when
// ctx is cancelled or on a fatal error (the caller forwards the error onto the channel).
func streamTranscript(ctx context.Context, path string, tailLines int, ch chan wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate]) error {
	if path == "" {
		return fmt.Errorf("transcript path is required")
	}
	if tailLines <= 0 {
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
	if err := watcher.Add(filepath.Dir(path)); err != nil {
		return fmt.Errorf("watching transcript dir: %w", err)
	}

	tailer := &transcriptTailer{}
	backlog, err := tailer.readNew(path)
	if err != nil {
		return fmt.Errorf("reading transcript: %w", err)
	}
	if len(backlog) > tailLines {
		backlog = backlog[len(backlog)-tailLines:]
	}
	ch <- wshrpc.RespOrErrorUnion[wshrpc.AgentTranscriptUpdate]{Response: wshrpc.AgentTranscriptUpdate{Lines: backlog}}

	target := filepath.Clean(path)
	for {
		select {
		case <-ctx.Done():
			return nil
		case event, ok := <-watcher.Events:
			if !ok {
				return nil
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
