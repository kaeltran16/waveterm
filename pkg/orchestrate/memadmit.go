// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package orchestrate

import (
	"context"
	"log"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvis"
	"github.com/wavetermdev/waveterm/pkg/memgate"
	"github.com/wavetermdev/waveterm/pkg/util/jobobject"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

// memEventTimeout bounds one memory event's store write: they are delivered in order on memgate's goroutine.
const memEventTimeout = 10 * time.Second

// MemProjectKey is the project a tree's learned peaks are kept under: its main checkout, so a run's worktrees key
// to the project and nothing is lost when they are deleted.
func MemProjectKey(path string) string {
	if path == "" {
		return ""
	}
	p := filepath.Clean(jarvis.MainCheckout(path))
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

type gateAdmittedKey struct{}

// WithGateAdmitted marks ctx's plan commands as already admitted, so they never wait at the memory gate: the
// dispatch Setup runs on its worker's admission, and the commands an RPC runs inline must not hold the RPC.
func WithGateAdmitted(ctx context.Context) context.Context {
	return context.WithValue(ctx, gateAdmittedKey{}, true)
}

func gateAdmitted(ctx context.Context) bool {
	admitted, _ := ctx.Value(gateAdmittedKey{}).(bool)
	return admitted
}

// admitPlanCommand waits at the memory gate for a run's plan command run in dir. A ctx with no run-command owner or
// marked admitted is not gated (nil claim).
func admitPlanCommand(ctx context.Context, dir string) (*memgate.Claim, error) {
	owner, ok := jobobject.OwnerFrom(ctx)
	if !ok || owner.Kind != jobobject.OwnerKind_RunCmd || gateAdmitted(ctx) {
		return nil, nil
	}
	return memgate.Wait(ctx, memgate.Request{
		Key:   memgate.Key{Project: MemProjectKey(dir), Role: owner.Cmd},
		Tag:   memgate.Tag{RunId: owner.Id, TaskId: owner.Task, Role: owner.Cmd},
		Owner: owner,
	})
}

// workerRequest is the gate request for taskID's worker. A worker carries its tree's Setup, which runs on its
// admission under the dag lock, so its need covers the larger of the two.
func workerRequest(g *waveobj.TaskGroup, owner *waveobj.Run, taskID string) memgate.Request {
	project := MemProjectKey(owner.ProjectPath)
	key := memgate.Key{Project: project, Role: memgate.RoleWorker}
	need := memgate.Estimate(key)
	if g.Setup != "" {
		need = max(need, memgate.Estimate(memgate.Key{Project: project, Role: PlanCmd_Setup}))
	}
	return memgate.Request{Key: key, Need: need, Tag: memgate.Tag{RunId: g.RunID, TaskId: taskID, Role: memgate.RoleWorker}}
}

// bindClaim ties a started worker's or reviewer's claim to its block's job, whose close releases it. A var so
// tests can release what they bound: no job closes in a test.
var bindClaim = func(c *memgate.Claim, o jobobject.Owner) { c.Bind(o) }

func bindToBlock(c *memgate.Claim, blockId string) {
	if c == nil || blockId == "" {
		return
	}
	bindClaim(c, jobobject.Owner{Kind: jobobject.OwnerKind_Block, Id: blockId})
}

var memEventKinds = map[memgate.EventKind]string{
	memgate.EventHeld:     waveobj.RunEventKindMemoryHeld,
	memgate.EventAdmitted: waveobj.RunEventKindMemoryAdmitted,
	memgate.EventPaused:   waveobj.RunEventKindMemoryPaused,
	memgate.EventResumed:  waveobj.RunEventKindMemoryResumed,
}

// RecordMemoryEvent writes a gate event on the run its tag names: the dag owner's.
func RecordMemoryEvent(ev memgate.Event) {
	kind, ok := memEventKinds[ev.Kind]
	if !ok || ev.Tag.RunId == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), memEventTimeout)
	defer cancel()
	run, err := wstore.DBGet[*waveobj.Run](ctx, ev.Tag.RunId)
	if err != nil || run == nil {
		log.Printf("memgate: %s event for run %s: loading the run: %v", ev.Kind, ev.Tag.RunId, err)
		return
	}
	detail := map[string]any{"taskid": ev.Tag.TaskId, "role": ev.Tag.Role}
	switch ev.Kind {
	case memgate.EventHeld, memgate.EventPaused:
		detail["free"], detail["need"] = ev.Free, ev.Need
	case memgate.EventAdmitted:
		detail["ms"] = ev.Ms
	case memgate.EventResumed:
		detail["reason"], detail["ms"] = ev.Reason, ev.Ms
	}
	appendRunEvent(ctx, run.ChannelOID, run.ID, kind, nil, detail)
}

// KickHeldRuns ticks the dags of runs with a tree held at the gate, once room frees, rather than waiting out the
// watchdog. A run that ended keeps its held tags in the gate, so a terminal dag is skipped.
func KickHeldRuns(runIds []string) {
	ctx, cancel := context.WithTimeout(context.Background(), memEventTimeout)
	defer cancel()
	for _, runId := range runIds {
		run, err := wstore.DBGet[*waveobj.Run](ctx, runId)
		if err != nil || run == nil || run.DagORef == "" {
			continue
		}
		g, err := wstore.GetDag(ctx, run.DagORef)
		if err != nil {
			log.Printf("memgate: kicking run %s: loading dag: %v", runId, err)
			continue
		}
		if !slices.Contains(watchdogStatuses, g.Status) {
			continue
		}
		go tickDag(context.Background(), g)
	}
}
