// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import (
	"context"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

// NoteCommands is the user's notes: an agent adds one with `wsh note add`, the cockpit lists, edits
// and deletes them.
type NoteCommands interface {
	NoteAddCommand(ctx context.Context, data CommandNoteAddData) (*waveobj.UserNote, error)
	NoteListCommand(ctx context.Context) ([]*waveobj.UserNote, error)
	NoteUpdateCommand(ctx context.Context, data CommandNoteUpdateData) (*CommandNoteUpdateRtnData, error)
	NoteDeleteCommand(ctx context.Context, data CommandNoteDeleteData) error
}

type CommandNoteAddData struct {
	Title string `json:"title"`
	Body  string `json:"body,omitempty"`
}

type CommandNoteUpdateData struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body,omitempty"`
	// the rev the editor read; set, an update of a note changed since is refused. empty overwrites
	BaseRev string `json:"baserev,omitempty"`
}

type CommandNoteUpdateRtnData struct {
	Rev string `json:"rev"`
}

type CommandNoteDeleteData struct {
	ID string `json:"id"`
}
