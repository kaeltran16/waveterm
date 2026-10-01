// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wavevault

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"reflect"

	"github.com/wavetermdev/waveterm/pkg/wconfig"
)

// SettingsSyncPath is the vault's settings layer, the one file sync merges key by key.
const SettingsSyncPath = wconfig.VaultConfigDir + "/" + wconfig.SettingsFile

// MergeSettings three-way merges two versions of the vault settings file against their common
// ancestor (base, nil when there is none). Per key: changed on one side → that side, a deletion
// counting as a change; changed on both → ours, unless ours deleted it and theirs still has it (an
// edit outlives a concurrent delete). Values compare by JSON value, not formatting. Any malformed
// input is an error. The output is indented with sorted keys and a trailing newline.
func MergeSettings(base, ours, theirs []byte) ([]byte, error) {
	baseM := map[string]any{}
	if len(base) > 0 {
		var err error
		if baseM, err = parseSettingsObject("base", base); err != nil {
			return nil, err
		}
	}
	oursM, err := parseSettingsObject("ours", ours)
	if err != nil {
		return nil, err
	}
	theirsM, err := parseSettingsObject("theirs", theirs)
	if err != nil {
		return nil, err
	}

	merged := make(map[string]any)
	for _, m := range []map[string]any{baseM, oursM, theirsM} {
		for k := range m {
			if _, done := merged[k]; done {
				continue
			}
			if v, keep := mergeSettingKey(baseM, oursM, theirsM, k); keep {
				merged[k] = v
			}
		}
	}
	out, err := json.MarshalIndent(merged, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("merge settings: %w", err)
	}
	return append(out, '\n'), nil
}

func mergeSettingKey(baseM, oursM, theirsM map[string]any, k string) (any, bool) {
	b, inBase := baseM[k]
	o, inOurs := oursM[k]
	t, inTheirs := theirsM[k]
	oursChanged := inOurs != inBase || !reflect.DeepEqual(o, b)
	theirsChanged := inTheirs != inBase || !reflect.DeepEqual(t, b)
	switch {
	case oursChanged && (inOurs || !theirsChanged):
		return o, inOurs
	case theirsChanged:
		return t, inTheirs
	default:
		return b, inBase
	}
}

// parseSettingsObject decodes with UseNumber so a number keeps its literal through the merge.
func parseSettingsObject(side string, b []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("parse %s settings: %w", side, err)
	}
	if m == nil {
		return nil, fmt.Errorf("parse %s settings: not a JSON object", side)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("parse %s settings: trailing data after the object", side)
	}
	return m, nil
}
