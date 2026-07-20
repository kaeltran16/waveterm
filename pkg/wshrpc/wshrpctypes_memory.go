// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

type MemoryCommands interface {
	MemoryScanCommand(ctx context.Context) (*CommandMemoryScanRtnData, error)
	MemoryReadCommand(ctx context.Context, data CommandMemoryReadData) (*CommandMemoryReadRtnData, error)
	MemoryWriteCommand(ctx context.Context, data CommandMemoryWriteData) (*CommandMemoryWriteRtnData, error)
	MemoryCreateCommand(ctx context.Context, data CommandMemoryCreateData) (*CommandMemoryCreateRtnData, error)
	MemoryDeleteCommand(ctx context.Context, data CommandMemoryDeleteData) error
	MemoryProjectCommand(ctx context.Context, data CommandMemoryProjectData) error
	MemoryProjectionStatusCommand(ctx context.Context) (*CommandMemoryProjectionStatusRtnData, error)
	MemoryHarvestCommand(ctx context.Context, data CommandMemoryHarvestData) (*CommandMemoryHarvestRtnData, error)
	MemoryLearnCommand(ctx context.Context, data CommandMemoryLearnData) (*CommandMemoryLearnRtnData, error)
	MemoryEnqueueSessionCommand(ctx context.Context, data CommandMemoryEnqueueSessionData) error
	MemoryReviewListCommand(ctx context.Context) (*CommandMemoryReviewListRtnData, error)
	MemoryReviewAcceptCommand(ctx context.Context, data CommandMemoryReviewAcceptData) error
	MemoryPruneListCommand(ctx context.Context) (*CommandMemoryPruneListRtnData, error)
	MemoryArchiveListCommand(ctx context.Context) (*CommandMemoryArchiveListRtnData, error)
	MemoryRestoreCommand(ctx context.Context, data CommandMemoryRestoreData) error
}

type CommandMemoryScanRtnData struct {
	Notes []MemoryNote `json:"notes"`
	Edges []MemoryEdge `json:"edges"`
}

type CommandMemoryReadData struct {
	Path   string `json:"path"`
	Source string `json:"source"`
}

type CommandMemoryReadRtnData struct {
	Note MemoryNote `json:"note"`
	Body string     `json:"body"`
}

type CommandMemoryWriteData struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	BaseMtime int64  `json:"basemtime,omitempty"`
}

type CommandMemoryWriteRtnData struct {
	Mtime    int64 `json:"mtime"`
	Conflict bool  `json:"conflict"`
}

type CommandMemoryCreateData struct {
	Name  string `json:"name"`
	Type  string `json:"type,omitempty"`
	Scope string `json:"scope,omitempty"`
	Body  string `json:"body,omitempty"`
	Cwd   string `json:"cwd,omitempty"` // write into this project's Claude hub; empty -> dedicated vault
}

type CommandMemoryCreateRtnData struct {
	Path string `json:"path"`
}

type CommandMemoryDeleteData struct {
	Path string `json:"path"`
}

type CommandMemoryProjectData struct {
	Cwd string `json:"cwd"`
}

type CommandMemoryProjectionStatusRtnData struct {
	// Runtimes maps a lackey runtime ("codex" | "antigravity") to the project label its steering
	// file currently reflects. A runtime missing from the map has no projection yet.
	Runtimes map[string]string `json:"runtimes"`
}

type CommandMemoryHarvestData struct {
	Cwd string `json:"cwd"`
}

type CommandMemoryHarvestRtnData struct {
	Ingested int `json:"ingested"`
	Skipped  int `json:"skipped"`
}

type CommandMemoryLearnData struct {
	Cwd        string                 `json:"cwd"`
	Candidates []MemoryLearnCandidate `json:"candidates"`
	References []string               `json:"references,omitempty"` // slugs of existing notes the session used
}

type CommandMemoryLearnRtnData struct {
	Committed int `json:"committed"`
	Queued    int `json:"queued"`
}

type CommandMemoryEnqueueSessionData struct {
	Cwd            string `json:"cwd"`
	TranscriptPath string `json:"transcriptpath"`
	ClaudePath     string `json:"claudepath"`
}

type CommandMemoryReviewListRtnData struct {
	Pending []MemoryPendingNote `json:"pending"`
}

type CommandMemoryReviewAcceptData struct {
	Path string `json:"path"`
}

type CommandMemoryPruneListRtnData struct {
	Candidates []MemoryPruneCandidate `json:"candidates"`
}

type CommandMemoryArchiveListRtnData struct {
	Archived []MemoryArchivedNote `json:"archived"`
}

type CommandMemoryRestoreData struct {
	Path string `json:"path"`
}
