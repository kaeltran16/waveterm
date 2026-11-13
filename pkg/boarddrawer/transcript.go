// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package boarddrawer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

const transcriptExt = ".jsonl"

// claudeProjectsDir is where claude keeps its session transcripts, one folder per working directory.
func claudeProjectsDir() (string, error) {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return filepath.Join(d, "projects"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", "projects"), nil
}

// RemoveSession deletes the transcript of a session the drawer made, with the folder of tool results claude keeps
// beside it. It looks under every project folder, since the folder name is claude's encoding of the cwd; a session
// id is a uuid, so the name alone picks the file.
var RemoveSession = func(sessionId string) error {
	if _, err := uuid.Parse(sessionId); err != nil {
		return fmt.Errorf("not a session id: %q", sessionId)
	}
	dir, err := claudeProjectsDir()
	if err != nil {
		return err
	}
	files, err := filepath.Glob(filepath.Join(dir, "*", sessionId+transcriptExt))
	if err != nil {
		return err
	}
	var errs []error
	for _, f := range files {
		errs = append(errs, os.Remove(f), os.RemoveAll(strings.TrimSuffix(f, transcriptExt)))
	}
	return errors.Join(errs...)
}
