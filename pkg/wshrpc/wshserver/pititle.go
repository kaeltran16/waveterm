// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
)

const piTitleMax = 72 // matches the Claude hook's head-text fallback cap

// piMessageText extracts the text of a pi message entry: a bare string, or the joined text blocks.
// Mirrors the pi status extension's messageText so tool_result-only user turns yield "".
func piMessageText(message map[string]any) string {
	content, ok := message["content"]
	if !ok {
		return ""
	}
	if s, ok := content.(string); ok {
		return s
	}
	blocks, ok := content.([]any)
	if !ok {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		bm, ok := b.(map[string]any)
		if !ok || bm["type"] != "text" {
			continue
		}
		if s, ok := bm["text"].(string); ok && s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, " ")
}

// piFirstUserMessage returns the text of the first user message in a pi session jsonl, or "".
func piFirstUserMessage(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var rec struct {
			Type    string         `json:"type"`
			Message map[string]any `json:"message"`
		}
		if json.Unmarshal([]byte(line), &rec) != nil || rec.Type != "message" {
			continue
		}
		if role, _ := rec.Message["role"].(string); role != "user" {
			continue
		}
		if text := piMessageText(rec.Message); text != "" {
			return text
		}
	}
	return ""
}

// piHeadTitle is the first non-empty line of text, rune-truncated — the fallback when the LLM
// cannot produce a title (no key, error, empty reply).
func piHeadTitle(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		r := []rune(line)
		if len(r) > piTitleMax {
			r = r[:piTitleMax]
		}
		return string(r)
	}
	return ""
}

// piTitlePrompt asks the model for a short task title — the same shape as Claude Code's ai-title
// request (a concise 2-8 word summary, not the raw prompt).
func piTitlePrompt(taskText string) string {
	return "Write a concise title (2-8 words) for this coding task. Reply with only the title.\n\nTask:\n" + taskText
}

// titleGenerator is the LLM seam: production uses consult.Run (openrouter cheap tier); tests inject
// a fake.
type titleGenerator func(ctx context.Context, prompt string) (string, error)

func defaultTitleGenerator(ctx context.Context, prompt string) (string, error) {
	spec, ok := consult.HeadlessSpecForTier(consult.TierCheap)
	if !ok {
		return "", nil
	}
	return consult.Run(ctx, spec, "", prompt, func(string) {})
}

// PiTitleProvider generates one LLM title per pi session (keyed by transcript path) and attaches it
// to agent:status events. Best-effort and async: generation never blocks the hook event path; on LLM
// failure the first-message head text is the fallback. An explicit user session name (non-empty
// Title on the event) always wins and is never overwritten.
type PiTitleProvider struct {
	gen titleGenerator

	mu sync.Mutex
	// transcriptPath -> settled title (only non-empty; an empty transcript stays un-cached
	// so a later event can retry once the first user message exists); inFlight guards concurrent generation
	cache     map[string]string
	inFlight  map[string]bool
	lastState map[string]string // block oref -> most recent state, for the generated event
}

func NewPiTitleProvider(gen titleGenerator) *PiTitleProvider {
	return &PiTitleProvider{
		gen:       gen,
		cache:     make(map[string]string),
		inFlight:  make(map[string]bool),
		lastState: make(map[string]string),
	}
}

// NoteEvent observes one agent:status event. With an explicit title the event passes through
// untouched (a user rename wins over any cached title). Otherwise a cached title is attached
// synchronously; a cache miss kicks off async generation.
func (p *PiTitleProvider) NoteEvent(ev *wps.WaveEvent) {
	if ev == nil || ev.Event != wps.Event_AgentStatus {
		return
	}
	// events arrive over the RPC wire with Data as a raw JSON map (WaveEvent has no runtime
	// event-data registry), so decode like wcore/badge.go — a type assertion would only match
	// in-process events and silently drop every real one.
	var data baseds.AgentStatusData
	if err := utilfn.ReUnmarshal(&data, ev.Data); err != nil {
		return
	}
	if data.Agent != "pi" || data.TranscriptPath == "" {
		return
	}
	p.mu.Lock()
	if data.State != "" {
		p.lastState[data.ORef] = data.State
	}
	if data.Title != "" {
		p.mu.Unlock()
		return // explicit name — the user wins
	}
	cached, has := p.cache[data.TranscriptPath]
	if has {
		p.mu.Unlock()
		if cached != "" {
			data.Title = cached
			ev.Data = data
		}
		return
	}
	if p.inFlight[data.TranscriptPath] {
		p.mu.Unlock()
		return
	}
	p.inFlight[data.TranscriptPath] = true
	p.mu.Unlock()

	go p.generate(data)
}

// generate runs the LLM call, falls back to head text, caches, and publishes the titled event so the
// row updates without waiting for the next natural hook event.
func (p *PiTitleProvider) generate(data baseds.AgentStatusData) {
	defer func() {
		p.mu.Lock()
		delete(p.inFlight, data.TranscriptPath)
		p.mu.Unlock()
	}()
	task := piFirstUserMessage(data.TranscriptPath)
	title := ""
	if task != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		if gen, err := p.gen(ctx, piTitlePrompt(task)); err == nil {
			title = strings.TrimSpace(gen)
		}
		cancel()
		if title == "" {
			title = piHeadTitle(task)
		}
	}
	// cache only a settled (non-empty) title. An empty transcript means the first user
	// message has not been written yet (session_start fires at pi boot) — leave the path
	// un-cached so a later event retries once the message exists.
	p.mu.Lock()
	if title != "" {
		p.cache[data.TranscriptPath] = title
	}
	state := p.lastState[data.ORef]
	p.mu.Unlock()
	if title == "" || state == "" {
		return // nothing to show, or we never saw a real state for this block
	}
	data.Title = title
	data.State = state
	data.Ts = time.Now().UnixMilli()
	wps.Broker.Publish(wps.WaveEvent{
		Event:   wps.Event_AgentStatus,
		Scopes:  []string{data.ORef},
		Persist: 1,
		Data:    data,
	})
}

// Result returns the settled title for a transcript path (tests, with a wait for async generation).
func (p *PiTitleProvider) Result(transcriptPath string, wait time.Duration) string {
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		title, ok := p.cache[transcriptPath]
		p.mu.Unlock()
		if ok {
			return title
		}
		time.Sleep(10 * time.Millisecond)
	}
	return ""
}

// PiTitleProviderInstance is the title provider for agent runtimes that do not self-title (pi).
// Wired to the real openrouter generator; tests build their own via NewPiTitleProvider.
var PiTitleProviderInstance = NewPiTitleProvider(defaultTitleGenerator)
