package waveobj

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestPrincipleListUnmarshalJSON(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want PrincipleList
	}{
		{
			name: "structured",
			raw:  `[{"id":"simple","text":"Prefer simple solutions."}]`,
			want: PrincipleList{{ID: "simple", Text: "Prefer simple solutions."}},
		},
		{
			name: "legacy string",
			raw:  `"preserve\nthis exact text"`,
			want: PrincipleList{{ID: LegacyGlobalPrincipleID, Text: "preserve\nthis exact text"}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got PrincipleList
			if err := json.Unmarshal([]byte(tt.raw), &got); err != nil {
				t.Fatalf("unmarshal principles: %v", err)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("principles mismatch: got %#v, want %#v", got, tt.want)
			}

			encoded, err := json.Marshal(got)
			if err != nil {
				t.Fatalf("marshal principles: %v", err)
			}
			if len(encoded) == 0 || encoded[0] != '[' {
				t.Fatalf("principles must marshal as an array, got %s", encoded)
			}
		})
	}
}

func TestPrinciplePatchUnmarshalLegacyString(t *testing.T) {
	var patch PrinciplePatch
	if err := json.Unmarshal([]byte(`"project-only text"`), &patch); err != nil {
		t.Fatalf("unmarshal legacy patch: %v", err)
	}
	text, ok := patch.LegacyReplacement()
	if !ok {
		t.Fatal("legacy patch marker is missing")
	}
	if text != "project-only text" {
		t.Fatalf("legacy replacement mismatch: got %q", text)
	}

	encoded, err := json.Marshal(patch)
	if err != nil {
		t.Fatalf("marshal legacy patch: %v", err)
	}
	if len(encoded) == 0 || encoded[0] != '{' {
		t.Fatalf("patch must marshal as an object, got %s", encoded)
	}
}

func TestPrinciplePatchStructuredRoundTrip(t *testing.T) {
	want := PrinciplePatch{
		Additions:    []Principle{{ID: "simple", Text: "Prefer simple solutions."}},
		Replacements: map[string]string{"existing": "Updated text."},
		Disabled:     []string{"obsolete"},
	}
	encoded, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal structured patch: %v", err)
	}
	if len(encoded) == 0 || encoded[0] != '{' {
		t.Fatalf("patch must marshal as an object, got %s", encoded)
	}

	var got PrinciplePatch
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatalf("unmarshal structured patch: %v", err)
	}
	if _, ok := got.LegacyReplacement(); ok {
		t.Fatal("structured patch unexpectedly has a legacy marker")
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("patch mismatch: got %#v, want %#v", got, want)
	}
}
