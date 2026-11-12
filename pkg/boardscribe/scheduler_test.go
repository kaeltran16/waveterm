// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardscribe

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const waitFor = 5 * time.Second

// fakeDeps records what a scheduler does; reply decides each Run's answer by call number (1-based).
type fakeDeps struct {
	mu        sync.Mutex
	reads     []int64
	prompts   []string
	delivered chan wshrpc.BoardDraw
	updates   []wshrpc.BoardUpdateData
	text      string
	cursor    int64 // Previous's cursor
	reply     func(n int) (string, error)
}

func newFake() *fakeDeps {
	return &fakeDeps{delivered: make(chan wshrpc.BoardDraw, 10), text: "a turn", cursor: 100,
		reply: func(int) (string, error) { return `{"skeleton":` + goodSkeleton + `}`, nil }}
}

func (f *fakeDeps) deps() Deps {
	return Deps{
		ReadThing: func(_ context.Context, _ wshrpc.BoardSource, since int64) (string, string, int64, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.reads = append(f.reads, since)
			return f.text, "the turn end", since + 10, nil
		},
		Previous: func(string, string, string) (string, int64, error) { return "", f.cursor, nil },
		Deliver:  func(d wshrpc.BoardDraw) error { f.delivered <- d; return nil },
		Publish: func(u wshrpc.BoardUpdateData) {
			f.mu.Lock()
			f.updates = append(f.updates, u)
			f.mu.Unlock()
		},
		Run: func(_ context.Context, _ string, prompt string) (string, error) {
			f.mu.Lock()
			f.prompts = append(f.prompts, prompt)
			n := len(f.prompts)
			f.mu.Unlock()
			return f.reply(n)
		},
		Now: func() int64 { return 1 },
	}
}

func (f *fakeDeps) runs() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.prompts)
}

func (f *fakeDeps) published(what string) []wshrpc.BoardUpdateData {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []wshrpc.BoardUpdateData
	for _, u := range f.updates {
		if u.What == what {
			out = append(out, u)
		}
	}
	return out
}

func agentPass() Pass {
	return Pass{ChannelId: "c1", BoardId: "abcd1234", BoardName: "Data model", ProjectPath: "/repo",
		Source: wshrpc.BoardSource{Kind: "agent", Ref: "t1", Title: "claude · waveterm"}}
}

// waitIdle waits until no pass runs for the pass's source.
func waitIdle(t *testing.T, s *Scheduler, p Pass) {
	t.Helper()
	k := slotKey{p.ChannelId, p.BoardId, SourceKey(p.Source, p.Ask)}
	deadline := time.Now().Add(waitFor)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		sl := s.slots[k]
		idle := sl != nil && !sl.running
		s.mu.Unlock()
		if idle {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("the scheduler did not go idle")
}

func receive(t *testing.T, ch chan wshrpc.BoardDraw) wshrpc.BoardDraw {
	t.Helper()
	select {
	case d := <-ch:
		return d
	case <-time.After(waitFor):
		t.Fatalf("no draw delivered")
		return wshrpc.BoardDraw{}
	}
}

func TestSchedulerMergesWakesDuringAPass(t *testing.T) {
	f := newFake()
	entered, release := make(chan struct{}), make(chan struct{})
	f.reply = func(n int) (string, error) {
		if n == 1 {
			close(entered)
			<-release
		}
		return `{"skeleton":` + goodSkeleton + `}`, nil
	}
	s := NewScheduler(f.deps())
	p := agentPass()
	s.Wake(p)
	<-entered
	for range 3 {
		s.Wake(p)
	}
	st := s.Status("c1", "abcd1234")
	if len(st) != 1 || st[0].State != StateDrawing || st[0].Queued != 3 || st[0].Reading != "the turn end" {
		t.Fatalf("status during the pass: %+v", st)
	}
	if s.BoardState("c1", "abcd1234") != StateDrawing {
		t.Errorf("board state should be drawing")
	}
	close(release)
	first, second := receive(t, f.delivered), receive(t, f.delivered)
	waitIdle(t, s, p)
	if n := f.runs(); n != 2 {
		t.Fatalf("want exactly two Run calls, got %d", n)
	}
	f.mu.Lock()
	reads, prompts := append([]int64{}, f.reads...), append([]string{}, f.prompts...)
	f.mu.Unlock()
	if len(reads) != 2 || reads[0] != 100 || reads[1] != first.CursorTs {
		t.Errorf("reads: got %v, want [100 %d]", reads, first.CursorTs)
	}
	if !strings.Contains(prompts[1], goodSkeleton) {
		t.Errorf("the second pass's prompt should carry the first pass's skeleton")
	}
	if first.SourceKey != "agent:t1" || first.Shapes != 3 || first.ID == "" || first.ID == second.ID {
		t.Errorf("draws: %+v / %+v", first, second)
	}
	if len(f.published("draw")) != 2 || len(s.Status("c1", "abcd1234")) != 0 || s.BoardState("c1", "abcd1234") != "" {
		t.Errorf("a delivered pass must publish draw and clear its status")
	}
}

func TestSchedulerNothingNewSkipsModel(t *testing.T) {
	f := newFake()
	f.text = "  \n"
	s := NewScheduler(f.deps())
	p := agentPass()
	s.Wake(p)
	waitIdle(t, s, p)
	if f.runs() != 0 || len(f.delivered) != 0 {
		t.Fatalf("nothing new must not run the model or deliver")
	}
	if len(f.published("draw"))+len(f.published("failed")) != 0 || len(s.Status("c1", "abcd1234")) != 0 {
		t.Errorf("nothing new must end silently")
	}
}

func TestSchedulerFailureAndRetry(t *testing.T) {
	f := newFake()
	f.reply = func(n int) (string, error) {
		if n == 1 {
			return "", nil
		}
		return `{"skeleton":` + goodSkeleton + `}`, nil
	}
	s := NewScheduler(f.deps())
	p := agentPass()
	p.Ask = "The store"
	s.Wake(p)
	waitIdle(t, s, p)
	st := s.Status("c1", "abcd1234")
	if len(st) != 1 || st[0].State != StateFailed || st[0].Reason != NoDrawingReason || st[0].SourceKey != "agent:t1|the store" {
		t.Fatalf("status after an empty reply: %+v", st)
	}
	failed := f.published("failed")
	if len(failed) != 1 || failed[0].Reason != NoDrawingReason || failed[0].SourceKey != "agent:t1|the store" {
		t.Fatalf("failed publish: %+v", failed)
	}
	if s.BoardState("c1", "abcd1234") != StateFailed {
		t.Errorf("board state should be failed")
	}
	if s.Retry("c1", "abcd1234", "agent:t1") == nil {
		t.Errorf("Retry of a key with no failed pass must error")
	}
	if err := s.Retry("c1", "abcd1234", "agent:t1|the store"); err != nil {
		t.Fatalf("Retry: %v", err)
	}
	d := receive(t, f.delivered)
	if d.Ask != "The store" || d.Shapes != 3 {
		t.Errorf("retried draw: %+v", d)
	}
	waitIdle(t, s, p)
	if len(s.Status("c1", "abcd1234")) != 0 {
		t.Errorf("a delivered retry must clear the failure")
	}
}

func TestSchedulerFromTsOverridesCursor(t *testing.T) {
	f := newFake()
	s := NewScheduler(f.deps())
	p := agentPass()
	p.FromTs = 50
	p.Follow = true
	s.Wake(p)
	d := receive(t, f.delivered)
	waitIdle(t, s, p)
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.reads) != 1 || f.reads[0] != 50 {
		t.Errorf("reads: got %v, want [50]", f.reads)
	}
	if !d.Follow || d.CursorTs != 60 {
		t.Errorf("draw: %+v", d)
	}
}
