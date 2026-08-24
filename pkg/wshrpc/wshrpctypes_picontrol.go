// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshrpc

import "context"

// NotifyCommandData is the payload for wsh notify and the wave_notify tool.
type NotifyCommandData struct {
	Title   string `json:"title"`
	Message string `json:"message"`
	Level   string `json:"level"` // info | warn | error (default info)
}

// OpenFileData is the payload for wsh open/view/edit: route a path into the cockpit's code surface.
type OpenFileData struct {
	Path string `json:"path"`
	Edit bool   `json:"edit,omitempty"`
}

// PiControlCommandData is a steering command for a live pi session. The extension
// consumes {cmd, content, name, path} from the control file (see writeControlFile).
type PiControlCommandData struct {
	SessionId string `json:"sessionid"`
	Command   string `json:"command"` // steer | follow_up | set_session_name | compact | abort | new_session | switch_session
	Content   string `json:"content"` // steer / follow_up message text
	Name      string `json:"name"`    // set_session_name target
	Path      string `json:"path"`    // switch_session target session file
}

// PiControlCommands is the wshrpc domain for pi steering and notifications.
type PiControlCommands interface {
	NotifyCommand(ctx context.Context, data NotifyCommandData) error
	PiSendControlCommand(ctx context.Context, data PiControlCommandData) error
}
