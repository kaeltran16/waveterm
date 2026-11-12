// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boardscribe

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const (
	StateDrawing = "drawing"
	StateFailed  = "failed"

	updateStatus = "status"
	updateDraw   = "draw"
	updateFailed = "failed"
)

// Pass is one draw of a source onto a board.
type Pass struct {
	ChannelId, BoardId, BoardName, ProjectPath, Key string
	Source                                          wshrpc.BoardSource
	Ask                                             string
	Follow                                          bool
	FromTs                                          int64 // > 0: read from here instead of the source's cursor (wsh board draw's first pass)
}

// Deps is everything a pass touches outside this package.
type Deps struct {
	ReadThing func(ctx context.Context, src wshrpc.BoardSource, sinceTs int64) (text, reading string, cursorTs int64, err error)
	Previous  func(channelId, boardId, key string) (skeleton string, cursorTs int64, err error)
	Deliver   func(d wshrpc.BoardDraw) error
	Publish   func(u wshrpc.BoardUpdateData)
	Run       func(ctx context.Context, cwd, prompt string) (string, error)
	Now       func() int64
}

type slotKey struct{ channelId, boardId, key string }

// slot is one (board, source): at most one pass runs, and wakes during it merge into one more pass.
type slot struct {
	running  bool
	queued   int
	next     *Pass // the newest wake that came in during the pass
	last     Pass  // kept for Retry
	status   *wshrpc.BoardSourceStatus
	loaded   bool // skeleton and cursor read from the board, then remembered
	skeleton string
	cursor   int64
}

// Scheduler runs scribe passes. Its status lives in memory only: a restart cannot resume a pass.
type Scheduler struct {
	d     Deps
	mu    sync.Mutex
	slots map[slotKey]*slot
}

func NewScheduler(d Deps) *Scheduler {
	if d.Run == nil {
		d.Run = RunModel
	}
	if d.Now == nil {
		d.Now = func() int64 { return time.Now().UnixMilli() }
	}
	return &Scheduler{d: d, slots: map[slotKey]*slot{}}
}

// Wake starts a pass for p's source, or queues one behind the pass already drawing it.
func (s *Scheduler) Wake(p Pass) {
	if p.Key == "" {
		p.Key = SourceKey(p.Source, p.Ask)
	}
	k := slotKey{p.ChannelId, p.BoardId, p.Key}
	s.mu.Lock()
	sl := s.slots[k]
	if sl == nil {
		sl = &slot{}
		s.slots[k] = sl
	}
	if sl.running {
		sl.queued++
		sl.next = &p
		if sl.status != nil {
			sl.status.Queued = sl.queued
		}
		s.mu.Unlock()
		s.publish(p, updateStatus, "")
		return
	}
	sl.running = true
	s.mu.Unlock()
	go s.loop(k, p)
}

func (s *Scheduler) loop(k slotKey, p Pass) {
	for {
		s.runPass(k, p)
		s.mu.Lock()
		sl := s.slots[k]
		if sl.next == nil {
			sl.running = false
			s.mu.Unlock()
			return
		}
		p = *sl.next
		sl.next = nil
		sl.queued = 0
		s.mu.Unlock()
	}
}

func (s *Scheduler) runPass(k slotKey, p Pass) {
	ctx := context.Background()
	s.mu.Lock()
	sl := s.slots[k]
	sl.last = p
	sl.status = &wshrpc.BoardSourceStatus{
		SourceKey: p.Key, Source: p.Source, Ask: p.Ask, State: StateDrawing, Queued: sl.queued, Ts: s.d.Now(),
	}
	loaded, previous, since := sl.loaded, sl.skeleton, sl.cursor
	s.mu.Unlock()
	s.publish(p, updateStatus, "")

	if !loaded {
		skel, cursor, err := s.d.Previous(p.ChannelId, p.BoardId, p.Key)
		if err != nil {
			s.fail(k, p, err.Error())
			return
		}
		previous, since = skel, cursor
		s.mu.Lock()
		sl.loaded, sl.skeleton, sl.cursor = true, skel, cursor
		s.mu.Unlock()
	}
	if p.FromTs > 0 {
		since = p.FromTs
	}
	text, reading, cursorTs, err := s.d.ReadThing(ctx, p.Source, since)
	if err != nil {
		s.fail(k, p, err.Error())
		return
	}
	if strings.TrimSpace(text) == "" {
		s.clear(k, p)
		return
	}
	s.mu.Lock()
	sl.status.Reading = reading
	s.mu.Unlock()
	s.publish(p, updateStatus, "")

	reply, err := s.d.Run(ctx, p.ProjectPath, Prompt(PromptInput{
		BoardName: p.BoardName, Ask: p.Ask, SourceTitle: p.Source.Title, ThingText: text, Reading: reading, Previous: previous,
	}))
	if err != nil {
		s.fail(k, p, err.Error())
		return
	}
	skeleton, shapes, err := CheckReply(reply)
	if err != nil {
		s.fail(k, p, err.Error())
		return
	}
	draw := wshrpc.BoardDraw{
		ID: uuid.NewString(), ChannelId: p.ChannelId, BoardId: p.BoardId, SourceKey: p.Key, Source: p.Source, Ask: p.Ask,
		Skeleton: skeleton, Shapes: shapes, CursorTs: cursorTs, Follow: p.Follow, Ts: s.d.Now(),
	}
	if err := s.d.Deliver(draw); err != nil {
		s.fail(k, p, err.Error())
		return
	}
	s.mu.Lock()
	sl.skeleton, sl.cursor, sl.status = skeleton, cursorTs, nil
	s.mu.Unlock()
	s.publish(p, updateDraw, "")
}

func (s *Scheduler) fail(k slotKey, p Pass, reason string) {
	s.mu.Lock()
	sl := s.slots[k]
	sl.status = &wshrpc.BoardSourceStatus{
		SourceKey: p.Key, Source: p.Source, Ask: p.Ask, State: StateFailed, Reason: reason, Ts: s.d.Now(),
	}
	s.mu.Unlock()
	s.publish(p, updateFailed, reason)
}

// clear ends a pass that found nothing new: no draw, no failure.
func (s *Scheduler) clear(k slotKey, p Pass) {
	s.mu.Lock()
	s.slots[k].status = nil
	s.mu.Unlock()
	s.publish(p, updateStatus, "")
}

func (s *Scheduler) publish(p Pass, what, reason string) {
	if s.d.Publish == nil {
		return
	}
	s.d.Publish(wshrpc.BoardUpdateData{ChannelId: p.ChannelId, BoardId: p.BoardId, What: what, SourceKey: p.Key, Reason: reason})
}

// Retry runs a failed source's last pass again.
func (s *Scheduler) Retry(channelId, boardId, key string) error {
	s.mu.Lock()
	sl := s.slots[slotKey{channelId, boardId, key}]
	if sl == nil || sl.running || sl.status == nil || sl.status.State != StateFailed {
		s.mu.Unlock()
		return errors.New("this source has no failed draw to retry")
	}
	p := sl.last
	s.mu.Unlock()
	s.Wake(p)
	return nil
}

// Status lists the sources of a board that are drawing or failed, by key.
func (s *Scheduler) Status(channelId, boardId string) []wshrpc.BoardSourceStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []wshrpc.BoardSourceStatus
	for k, sl := range s.slots {
		if k.channelId == channelId && k.boardId == boardId && sl.status != nil {
			out = append(out, *sl.status)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SourceKey < out[j].SourceKey })
	return out
}

// BoardState is "drawing" if any source draws, else "failed" if any failed, else "".
func (s *Scheduler) BoardState(channelId, boardId string) string {
	state := ""
	for _, st := range s.Status(channelId, boardId) {
		if st.State == StateDrawing {
			return StateDrawing
		}
		state = StateFailed
	}
	return state
}
