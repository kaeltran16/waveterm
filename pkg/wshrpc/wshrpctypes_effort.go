// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// EffortCommands is the tracker surface: one atomic create, one atomic op-union mutate, plus
// lightweight list/get for the CLI (independent of the heavy WorkState ledger query).
type EffortCommands interface {
	EffortCreateCommand(ctx context.Context, data CommandEffortCreateData) (*CommandEffortCreateRtnData, error)
	EffortMutateCommand(ctx context.Context, data CommandEffortMutateData) (*CommandEffortMutateRtnData, error)
	EffortListCommand(ctx context.Context, data CommandEffortListData) (*CommandEffortListRtnData, error)
	EffortGetCommand(ctx context.Context, data CommandEffortGetData) (*CommandEffortGetRtnData, error)
}

type CommandEffortCreateData struct {
	Title     string                   `json:"title"`
	Project   string                   `json:"project,omitempty"`
	Ticket    string                   `json:"ticket,omitempty"`
	ParentOID string                   `json:"parentoid,omitempty"`
	Chunks    []CommandEffortChunkSeed `json:"chunks,omitempty"` // may be empty; chunks can be added later
}

type CommandEffortChunkSeed struct {
	Label string `json:"label"`
	Owner string `json:"owner,omitempty"`
}

type CommandEffortCreateRtnData struct {
	EffortOID string `json:"effortoid"`
}

// CommandEffortMutateData carries one atomic batch: all ops validate, then all apply. A failing op
// aborts the whole command.
type CommandEffortMutateData struct {
	EffortOID string     `json:"effortoid"`
	Ops       []EffortOp `json:"ops"`
	Note      string     `json:"note,omitempty"` // appended to the affected trail as the batch's note
}

type CommandEffortMutateRtnData struct {
	Effort *waveobj.Effort `json:"effort"` // post-mutation object
}

type CommandEffortListData struct {
	Project string `json:"project,omitempty"` // "" = all non-archived efforts
}

type CommandEffortListRtnData struct {
	Efforts []EffortSummary `json:"efforts"`
}

type CommandEffortGetData struct {
	EffortOID string `json:"effortoid"`
}

type CommandEffortGetRtnData struct {
	Effort *waveobj.Effort `json:"effort"`
}

// EffortOp is one typed mutation. Op selects the behavior; the remaining fields are the op's
// arguments (validation picks which are required per op).
type EffortOp struct {
	Op        string `json:"op"`                  // rename | setProject | setTicket | setStatus | link | addChunk | removeChunk | renameChunk | moveChunk | setChunkStatus | appendNote | setOwner | advance | reopen
	Title     string `json:"title,omitempty"`     // rename
	Project   string `json:"project,omitempty"`   // setProject ("" clears)
	Ticket    string `json:"ticket,omitempty"`    // setTicket ("" clears)
	Status    string `json:"status,omitempty"`    // setStatus (effort) | setChunkStatus (chunk)
	ParentOID string `json:"parentoid,omitempty"` // link ("" = unlink)
	Chunk     string `json:"chunk,omitempty"`     // chunk ref: exact label or 1-based index string
	Label     string `json:"label,omitempty"`     // addChunk label / renameChunk new label
	At        *int   `json:"at,omitempty"`        // addChunk insert position / moveChunk target (1-based)
	Owner     string `json:"owner,omitempty"`     // addChunk / setOwner ("" clears)
	Note      string `json:"note,omitempty"`      // appendNote text; also honored by setChunkStatus/advance/reopen as extra text
	Kind      string `json:"kind,omitempty"`      // attachWork: "run" | "agent"
	ORef      string `json:"oref,omitempty"`      // attachWork/detachWork: "run:<oid>" | "agent:<tabid>"
}

// EffortSummary is the ledger-friendly projection of an effort (no note trails).
type EffortSummary struct {
	ORef        string               `json:"oref"`
	Title       string               `json:"title"`
	Project     string               `json:"project,omitempty"`
	Ticket      string               `json:"ticket,omitempty"`
	Status      string               `json:"status"`
	ParentOID   string               `json:"parentoid,omitempty"`
	Chunks      []EffortChunkSummary `json:"chunks,omitempty"`
	Done        int                  `json:"done"`
	Total       int                  `json:"total"`
	ActiveChunk string               `json:"activechunk,omitempty"` // first chunk with status active, else first non-done label
	UpdatedTs   int64                `json:"updatedts"`
}

type EffortChunkSummary struct {
	Label    string                `json:"label"`
	Status   string                `json:"status"`
	Owner    string                `json:"owner,omitempty"`
	WorkRefs []waveobj.ChunkWorkRef `json:"workrefs,omitempty"`
}
