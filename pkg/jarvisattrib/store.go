// pkg/jarvisattrib/store.go
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvisattrib

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/wavevault"
)

// overrideRecord is one human correction to an inferred attribution. The log is append-only; the latest
// record for a (DossierID, RunORef) pair wins. It is the only non-derivable state D commits.
type overrideRecord struct {
	DossierID string `json:"dossierID"`
	RunORef   string `json:"runORef"`
	Action    string `json:"action"` // "detach" | "accept"
	Actor     string `json:"actor"`
	Ts        int64  `json:"ts"`
}

// overridesPath is the D-owned log, outside A's four recall collections (so A does not index it as
// recall content) but inside the vault git repo (so A's Commit captures it).
func overridesPath(v *wavevault.Vault) string {
	return filepath.Join(v.Root, "attributions", "overrides.jsonl")
}

func appendOverride(v *wavevault.Vault, rec overrideRecord) error {
	p := overridesPath(v)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	_, err = f.Write(append(b, '\n'))
	return err
}

// readOverrides returns the latest action per "dossierID|runORef" key. A missing log is empty, not an
// error. Unparseable lines are skipped (tolerant).
func readOverrides(v *wavevault.Vault) (map[string]string, error) {
	data, err := os.ReadFile(overridesPath(v))
	if errors.Is(err, os.ErrNotExist) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var rec overrideRecord
		if json.Unmarshal([]byte(line), &rec) != nil {
			continue
		}
		out[rec.DossierID+"|"+rec.RunORef] = rec.Action
	}
	return out, nil
}
