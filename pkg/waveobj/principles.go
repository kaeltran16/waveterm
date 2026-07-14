package waveobj

import (
	"bytes"
	"encoding/json"
)

const (
	LegacyGlobalPrincipleID  = "legacy-global"
	LegacyProjectPrincipleID = "legacy-project"
)

type Principle struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

type PrincipleDiagnostic struct {
	Code        string `json:"code"`
	PrincipleID string `json:"principleid"`
}

type PrincipleList []Principle

type PrinciplePatch struct {
	Additions    []Principle       `json:"additions,omitempty"`
	Replacements map[string]string `json:"replacements,omitempty"`
	Disabled     []string          `json:"disabled,omitempty"`

	legacyReplacement *string
}

func (p *PrincipleList) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var legacy string
		if err := json.Unmarshal(trimmed, &legacy); err != nil {
			return err
		}
		*p = PrincipleList{{ID: LegacyGlobalPrincipleID, Text: legacy}}
		return nil
	}

	var structured []Principle
	if err := json.Unmarshal(trimmed, &structured); err != nil {
		return err
	}
	*p = structured
	return nil
}

func (p *PrinciplePatch) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var legacy string
		if err := json.Unmarshal(trimmed, &legacy); err != nil {
			return err
		}
		*p = PrinciplePatch{legacyReplacement: &legacy}
		return nil
	}

	type structuredPatch PrinciplePatch
	var structured structuredPatch
	if err := json.Unmarshal(trimmed, &structured); err != nil {
		return err
	}
	*p = PrinciplePatch(structured)
	return nil
}

func (p PrinciplePatch) MarshalJSON() ([]byte, error) {
	type structuredPatch PrinciplePatch
	return json.Marshal(structuredPatch(p))
}

func (p PrinciplePatch) LegacyReplacement() (string, bool) {
	if p.legacyReplacement == nil {
		return "", false
	}
	return *p.legacyReplacement, true
}

// IsEmpty reports whether a structured patch carries no additions, replacements, or disables. Callers
// normalize a legacy marker into structured fields first, so a legacy patch is never empty here.
func (p *PrinciplePatch) IsEmpty() bool {
	if p == nil {
		return true
	}
	return len(p.Additions) == 0 && len(p.Replacements) == 0 && len(p.Disabled) == 0
}
