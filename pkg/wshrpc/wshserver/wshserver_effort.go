// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/jarvisstate"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func (ws *WshServer) EffortCreateCommand(ctx context.Context, data wshrpc.CommandEffortCreateData) (*wshrpc.CommandEffortCreateRtnData, error) {
	title := strings.TrimSpace(data.Title)
	if title == "" {
		return nil, fmt.Errorf("EC-INVALID-TITLE: title cannot be empty")
	}
	if len(title) > 200 {
		return nil, fmt.Errorf("EC-INVALID-TITLE: title exceeds 200 chars")
	}
	if data.ParentOID != "" {
		if _, err := wstore.GetEffort(ctx, data.ParentOID); err != nil {
			return nil, fmt.Errorf("EC-BAD-PARENT: parent effort not found: %v", err)
		}
	}
	e := &waveobj.Effort{
		Title: title, Project: data.Project, Ticket: data.Ticket, Status: "active",
		ParentOID: data.ParentOID,
	}
	seen := map[string]bool{}
	for _, seed := range data.Chunks {
		label := strings.TrimSpace(seed.Label)
		if label == "" {
			return nil, fmt.Errorf("EC-INVALID-LABEL: chunk label cannot be empty")
		}
		if len(label) > 200 {
			return nil, fmt.Errorf("EC-INVALID-LABEL: chunk label exceeds 200 chars")
		}
		if seen[label] {
			return nil, fmt.Errorf("EC-DUPLICATE-LABEL: chunk %q already exists", label)
		}
		seen[label] = true
		e.Chunks = append(e.Chunks, waveobj.EffortChunk{Label: label, Status: "pending", Owner: seed.Owner})
	}
	if err := wstore.CreateEffort(ctx, e); err != nil {
		return nil, err
	}
	// the created event is the delta source; the trail note documents it for humans
	e.Notes = append(e.Notes, waveobj.EffortNote{Ts: e.CreatedTs, Text: "effort created"})
	if len(e.Chunks) > 0 {
		e.Events = append(e.Events, waveobj.EffortEvent{Ts: e.CreatedTs, Kind: "effort-created", Text: fmt.Sprintf("%d chunks", len(e.Chunks))})
	} else {
		e.Events = append(e.Events, waveobj.EffortEvent{Ts: e.CreatedTs, Kind: "effort-created"})
	}
	if err := wstore.UpdateEffort(ctx, e.OID, func(store *waveobj.Effort) error {
		store.Notes = e.Notes
		store.Events = e.Events
		return nil
	}); err != nil {
		return nil, err
	}
	return &wshrpc.CommandEffortCreateRtnData{EffortOID: e.OID}, nil
}

func (ws *WshServer) EffortMutateCommand(ctx context.Context, data wshrpc.CommandEffortMutateData) (*wshrpc.CommandEffortMutateRtnData, error) {
	if _, err := wstore.GetEffort(ctx, data.EffortOID); err != nil {
		return nil, err
	}
	// link op: parent must exist and not be self — pre-validated outside the txn so the error is
	// deterministic and cheap; a parent deleted mid-flight fails the same lookup below.
	for _, op := range data.Ops {
		if op.Op == "link" && op.ParentOID != "" {
			if op.ParentOID == data.EffortOID {
				return nil, fmt.Errorf("EC-BAD-PARENT: cannot link an effort to itself")
			}
			if _, err := wstore.GetEffort(ctx, op.ParentOID); err != nil {
				return nil, fmt.Errorf("EC-BAD-PARENT: parent effort not found")
			}
		}
	}
	var updated *waveobj.Effort
	err := wstore.UpdateEffort(ctx, data.EffortOID, func(e *waveobj.Effort) error {
		if err := jarvisstate.ApplyEffortOps(e, data.Ops, data.Note, time.Now().UnixMilli()); err != nil {
			return err
		}
		updated = e
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandEffortMutateRtnData{Effort: updated}, nil
}

func (ws *WshServer) EffortListCommand(ctx context.Context, data wshrpc.CommandEffortListData) (*wshrpc.CommandEffortListRtnData, error) {
	all, err := wstore.GetAllEfforts(ctx)
	if err != nil {
		return nil, err
	}
	var out []wshrpc.EffortSummary
	for _, e := range all {
		if e.Status == "archived" && !data.IncludeArchived {
			continue
		}
		if data.Project != "" && e.Project != data.Project {
			continue
		}
		out = append(out, jarvisstate.EffortSummaryOf(e))
	}
	return &wshrpc.CommandEffortListRtnData{Efforts: out}, nil
}

func (ws *WshServer) EffortGetCommand(ctx context.Context, data wshrpc.CommandEffortGetData) (*wshrpc.CommandEffortGetRtnData, error) {
	e, err := wstore.GetEffort(ctx, data.EffortOID)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandEffortGetRtnData{Effort: e}, nil
}

func (ws *WshServer) EffortDeleteCommand(ctx context.Context, data wshrpc.CommandEffortDeleteData) error {
	return wstore.DBDelete(ctx, waveobj.OType_Effort, data.EffortOID)
}
