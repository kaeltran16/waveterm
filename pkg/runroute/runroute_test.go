package runroute

import (
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

func TestResolveV1Capabilities(t *testing.T) {
	tests := []struct {
		runtime string
		tier    consult.Tier
		model   string
		args    []string
	}{
		{"pi", consult.TierCheap, consult.PiCheapModel, []string{"--model", consult.PiCheapModel}},
		{"pi", consult.TierMid, consult.PiMidModel, []string{"--model", consult.PiMidModel}},
		{"pi", consult.TierCapable, consult.PiMidModel, []string{"--model", consult.PiMidModel}},
		{"claude", consult.TierCheap, consult.CheapModel, []string{"--model", consult.CheapModel}},
		{"claude", consult.TierMid, consult.MidModel, []string{"--model", consult.MidModel}},
		{"claude", consult.TierCapable, "operator default", nil},
		{"codex", consult.TierCapable, "operator default", nil},
		{"opencode", consult.TierCapable, "operator default", nil},
	}
	for _, tt := range tests {
		t.Run(tt.runtime+"/"+string(tt.tier), func(t *testing.T) {
			got, err := Resolve(waveobj.RoutePin{Runtime: tt.runtime, Tier: string(tt.tier)})
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			if got.Runtime != tt.runtime || got.Tier != tt.tier || got.ResolvedModel != tt.model {
				t.Fatalf("got %+v", got)
			}
			if !reflect.DeepEqual(got.ModelArgs, tt.args) {
				t.Fatalf("args = %v, want %v", got.ModelArgs, tt.args)
			}
		})
	}
}

func TestResolveRejectsInvalidPins(t *testing.T) {
	for _, pin := range []waveobj.RoutePin{
		{Runtime: "openrouter", Tier: string(consult.TierCheap)},
		{Runtime: "", Tier: string(consult.TierCapable)},
		{Runtime: "mystery", Tier: string(consult.TierCapable)},
		{Runtime: "claude", Tier: ""},
		{Runtime: "claude", Tier: "unknown"},
		{Runtime: "codex", Tier: string(consult.TierCheap)},
		{Runtime: "codex", Tier: string(consult.TierMid)},
		{Runtime: "opencode", Tier: string(consult.TierCheap)},
		{Runtime: "opencode", Tier: string(consult.TierMid)},
	} {
		_, err := Resolve(pin)
		if err == nil {
			t.Fatalf("Resolve(%+v) succeeded", pin)
		}
		if !strings.Contains(err.Error(), pin.Runtime) || !strings.Contains(err.Error(), pin.Tier) {
			t.Errorf("Resolve(%+v) error = %q, want runtime and tier", pin, err)
		}
	}
}

func TestCapabilitiesReturnsIndependentSlices(t *testing.T) {
	first := Capabilities("pi")
	if len(first) == 0 {
		t.Fatal("Capabilities(pi) is empty")
	}
	first[0].ModelArgs[0] = "mutated"
	first[0].ModelArgs = append(first[0].ModelArgs, "extra")

	second := Capabilities("pi")
	if second[0].ModelArgs[0] == "mutated" || reflect.DeepEqual(first[0].ModelArgs, second[0].ModelArgs) {
		t.Fatalf("capability slices share mutable state: first=%v second=%v", first[0].ModelArgs, second[0].ModelArgs)
	}

	resolved, err := Resolve(waveobj.RoutePin{Runtime: "pi", Tier: string(consult.TierCheap)})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	resolved.ModelArgs[0] = "mutated"
	again, err := Resolve(waveobj.RoutePin{Runtime: "pi", Tier: string(consult.TierCheap)})
	if err != nil {
		t.Fatalf("Resolve again: %v", err)
	}
	if again.ModelArgs[0] == "mutated" {
		t.Fatal("Resolve returned a capability sharing mutable state")
	}
}

func TestNormalizeLegacy(t *testing.T) {
	if got := NormalizeLegacy("", ""); got != (waveobj.RoutePin{Runtime: "claude", Tier: "capable"}) {
		t.Fatalf("NormalizeLegacy empty = %+v", got)
	}
	if got := NormalizeLegacy("pi", ""); got != (waveobj.RoutePin{Runtime: "pi", Tier: "capable"}) {
		t.Fatalf("NormalizeLegacy tier empty = %+v", got)
	}
	if got := NormalizeLegacy("", "cheap"); got != (waveobj.RoutePin{Runtime: "claude", Tier: "cheap"}) {
		t.Fatalf("NormalizeLegacy runtime empty = %+v", got)
	}
}
