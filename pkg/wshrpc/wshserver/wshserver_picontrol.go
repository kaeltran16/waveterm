// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const piControlDirName = "pi-control"

var validPiControlCommands = map[string]bool{
	"steer": true, "follow_up": true, "set_session_name": true,
	"compact": true, "abort": true, "new_session": true, "switch_session": true,
}

func validateNotifyData(data wshrpc.NotifyCommandData) error {
	if data.Title == "" {
		return fmt.Errorf("notify title is required")
	}
	if data.Level != "" && data.Level != "info" && data.Level != "warn" && data.Level != "error" {
		return fmt.Errorf("invalid notify level %q (want info, warn, or error)", data.Level)
	}
	return nil
}

func validatePiControlData(data wshrpc.PiControlCommandData) error {
	if data.SessionId == "" {
		return fmt.Errorf("pi control: sessionid is required")
	}
	if !validPiControlCommands[data.Command] {
		return fmt.Errorf("pi control: unknown command %q", data.Command)
	}
	return nil
}

// controlFile mirrors the extension's JSON protocol: {cmd, content, name, path}.
type controlFile struct {
	Cmd     string `json:"cmd"`
	Content string `json:"content,omitempty"`
	Name    string `json:"name,omitempty"`
	Path    string `json:"path,omitempty"`
}

// writeControlFile writes <dir>/<sessionId>.json atomically (temp file + rename).
func writeControlFile(dir string, data wshrpc.PiControlCommandData) error {
	payload, err := json.Marshal(controlFile{Cmd: data.Command, Content: data.Content, Name: data.Name, Path: data.Path})
	if err != nil {
		return fmt.Errorf("marshaling control command: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "*.tmp")
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return fmt.Errorf("writing temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing temp file: %w", err)
	}
	if err := os.Rename(tmp.Name(), filepath.Join(dir, data.SessionId+".json")); err != nil {
		return fmt.Errorf("moving control file into place: %w", err)
	}
	return nil
}

func (ws *WshServer) NotifyCommand(ctx context.Context, data wshrpc.NotifyCommandData) error {
	if err := validateNotifyData(data); err != nil {
		return err
	}
	if data.Level == "" {
		data.Level = "info"
	}
	wps.Broker.Publish(wps.WaveEvent{Event: wps.Event_Notify, Data: data})
	return nil
}

func (ws *WshServer) PiSendControlCommand(ctx context.Context, data wshrpc.PiControlCommandData) error {
	if err := validatePiControlData(data); err != nil {
		return err
	}
	dir := filepath.Join(wavebase.DataHome_VarCache, piControlDirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("creating pi control dir: %w", err)
	}
	return writeControlFile(dir, data)
}
