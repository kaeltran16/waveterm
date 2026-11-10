// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package agentask

import (
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"
)

// ErrNoPendingPermission is DeliverPermission's refusal when the named request is not waiting: it was
// answered in the terminal, retired, or never raised.
var ErrNoPendingPermission = errors.New("no pending permission prompt")

// ErrPermissionQueued is DeliverPermission's refusal when more than one request waits on the block. The
// TUI shows only one of them, and keys typed for another would answer the one on screen.
var ErrPermissionQueued = errors.New("more than one permission prompt waiting")

const (
	permChoiceYes        = "Yes"
	permChoiceNo         = "No, tell Claude what to do"
	permChoiceEditsAll   = "Yes, allow edits this session"
	permChoiceBashAll    = "Yes, don't ask again for this command"
	permChoiceSessionAll = "Yes, don't ask again this session"
	toolExitPlanMode     = "ExitPlanMode"
)

var planApprovalChoices = []string{"Yes, and use auto mode", "Yes, manually approve edits", "No, keep planning"}

// escape rejects Claude's permission prompt, as its last "No" option does
var escape = []byte{0x1b}

var editTools = map[string]bool{"Edit": true, "Write": true, "MultiEdit": true, "NotebookEdit": true}

// PermissionChoices is the option list Claude Code's permission prompt shows for a tool, in its order, so
// the band's labels and the index typed into the prompt come from one place. The middle "don't ask again"
// option appears only when the request carried permission_suggestions; plan approval always has three.
func PermissionChoices(toolName string, hasSuggestions bool) []string {
	if toolName == toolExitPlanMode {
		return slices.Clone(planApprovalChoices)
	}
	if !hasSuggestions {
		return []string{permChoiceYes, permChoiceNo}
	}
	middle := permChoiceSessionAll
	switch {
	case editTools[toolName]:
		middle = permChoiceEditsAll
	case toolName == "Bash":
		middle = permChoiceBashAll
	}
	return []string{permChoiceYes, middle, permChoiceNo}
}

// PendingPermission is one permission prompt raised by the PermissionRequest hook and not yet answered.
type PendingPermission struct {
	PermId    string
	BlockId   string
	ToolName  string
	ToolInput string
	// ToolKey matches the PostToolUse status of the same tool call, which proves it was answered elsewhere.
	ToolKey string
	Choices []string
	// Ts is the UnixMilli the request was raised; only a status at or after it can retire it.
	Ts int64
}

// PermissionRegistry holds a FIFO queue of pending permission requests per block oref: parallel subagents
// can raise prompts at once, and the TUI answers them in turn.
type PermissionRegistry struct {
	lock    sync.Mutex
	pending map[string][]PendingPermission
}

func MakePermissionRegistry() *PermissionRegistry {
	return &PermissionRegistry{pending: make(map[string][]PendingPermission)}
}

// GlobalPermissions is the process-wide instance used by the wsh server handlers.
var GlobalPermissions = MakePermissionRegistry()

func (r *PermissionRegistry) Raise(oref string, p PendingPermission) {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.pending[oref] = append(r.pending[oref], p)
}

// List returns a copy of the queue for oref, oldest first.
func (r *PermissionRegistry) List(oref string) []PendingPermission {
	r.lock.Lock()
	defer r.lock.Unlock()
	return slices.Clone(r.pending[oref])
}

// All returns a copy of every block's queue, keyed by oref, each oldest first.
func (r *PermissionRegistry) All() map[string][]PendingPermission {
	r.lock.Lock()
	defer r.lock.Unlock()
	all := make(map[string][]PendingPermission, len(r.pending))
	for oref, queue := range r.pending {
		all[oref] = slices.Clone(queue)
	}
	return all
}

// RetireKey removes the requests for oref whose tool call ran (its PostToolUse carried toolKey) at or
// after they were raised, and returns them.
func (r *PermissionRegistry) RetireKey(oref, toolKey string, ts int64) []PendingPermission {
	if toolKey == "" {
		return nil
	}
	return r.retire(oref, func(p PendingPermission) bool { return p.ToolKey == toolKey && p.Ts <= ts })
}

// RetireUpTo removes every request for oref raised at or before ts, and returns them: the agent moved on
// to a new prompt, a stop or a new session, so no earlier prompt is still on screen.
func (r *PermissionRegistry) RetireUpTo(oref string, ts int64) []PendingPermission {
	return r.retire(oref, func(p PendingPermission) bool { return p.Ts <= ts })
}

func (r *PermissionRegistry) retire(oref string, match func(PendingPermission) bool) []PendingPermission {
	r.lock.Lock()
	defer r.lock.Unlock()
	var retired, kept []PendingPermission
	for _, p := range r.pending[oref] {
		if match(p) {
			retired = append(retired, p)
		} else {
			kept = append(kept, p)
		}
	}
	r.setLocked(oref, kept)
	return retired
}

func (r *PermissionRegistry) setLocked(oref string, queue []PendingPermission) {
	if len(queue) == 0 {
		delete(r.pending, oref)
		return
	}
	r.pending[oref] = queue
}

// claim removes and returns the request permid when it is the only one waiting on oref and choice is one of
// its options. Every refusal leaves the queue as it was.
func (r *PermissionRegistry) claim(oref, permid string, choice int) (PendingPermission, error) {
	r.lock.Lock()
	defer r.lock.Unlock()
	queue := r.pending[oref]
	idx := slices.IndexFunc(queue, func(p PendingPermission) bool { return p.PermId == permid })
	if idx < 0 {
		return PendingPermission{}, fmt.Errorf("%w for %s (%s)", ErrNoPendingPermission, oref, permid)
	}
	if len(queue) > 1 {
		return PendingPermission{}, fmt.Errorf("%w for %s (%d)", ErrPermissionQueued, oref, len(queue))
	}
	p := queue[0]
	if choice < 0 || choice >= len(p.Choices) {
		return PendingPermission{}, fmt.Errorf("choice %d out of range: the prompt has %d options", choice, len(p.Choices))
	}
	delete(r.pending, oref)
	return p, nil
}

// DeliverPermission answers the request permid on oref by typing its 0-based choice into Claude's prompt,
// one key per write with KeystrokeDelay between each. The request is claimed before the first key, so
// concurrent deliveries type once; a mid-inject failure leaves it dropped, since a partial prefix was
// typed and a retry would double-send (injectAnswer's rule).
func DeliverPermission(oref, permid string, choice int) error {
	p, err := GlobalPermissions.claim(oref, permid, choice)
	if err != nil {
		return err
	}
	keys := singleSelectKeys(choice)
	// the prompt can show options the hook does not report (Bash adds "switch to auto mode" before No), so No
	// is typed as Escape, which rejects at any option count, never by its position
	if choice == len(p.Choices)-1 {
		keys = [][]byte{escape}
	}
	for i, k := range keys {
		if i > 0 {
			time.Sleep(KeystrokeDelay)
		}
		if err := sendInput(p.BlockId, k); err != nil {
			return fmt.Errorf("typing permission choice into %s: %w", oref, err)
		}
	}
	return nil
}
