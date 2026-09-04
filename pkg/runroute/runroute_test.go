package runroute

import (
	"reflect"
	"slices"
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
		{"pi", consult.TierCapable, "operator default", nil},
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
			if got.Runtime != tt.runtime || got.Tier != string(tt.tier) || got.ResolvedModel != tt.model {
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
		{Runtime: "pi", Tier: string(consult.TierCheap)},
		{Runtime: "pi", Tier: string(consult.TierMid)},
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
	first := Capabilities("claude")
	if len(first) == 0 {
		t.Fatal("Capabilities(claude) is empty")
	}
	first[0].ModelArgs[0] = "mutated"
	first[0].ModelArgs = append(first[0].ModelArgs, "extra")

	second := Capabilities("claude")
	if second[0].ModelArgs[0] == "mutated" || reflect.DeepEqual(first[0].ModelArgs, second[0].ModelArgs) {
		t.Fatalf("capability slices share mutable state: first=%v second=%v", first[0].ModelArgs, second[0].ModelArgs)
	}

	resolved, err := Resolve(waveobj.RoutePin{Runtime: "claude", Tier: string(consult.TierCheap)})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	resolved.ModelArgs[0] = "mutated"
	again, err := Resolve(waveobj.RoutePin{Runtime: "claude", Tier: string(consult.TierCheap)})
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

func TestResolveModelPinClaudeAlias(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "claude", Model: "opus[1m]"})
	if err != nil {
		t.Fatal(err)
	}
	if cap.ResolvedModel != "opus[1m]" || !slices.Equal(cap.ModelArgs, []string{"--model", "opus[1m]"}) {
		t.Fatalf("claude alias pin resolved wrong: %+v", cap)
	}
}

func TestResolveModelPinPiProviderID(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-pro"})
	if err != nil {
		t.Fatal(err)
	}
	if cap.Model != "opencode/deepseek-v4-pro" || cap.ResolvedModel != "opencode/deepseek-v4-pro" {
		t.Fatalf("pi provider pin resolved wrong: %+v", cap)
	}
}

func TestResolveModelPinOpenCode(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "opencode", Model: "openai/gpt-5.4"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cap.ModelArgs, []string{"--model", "openai/gpt-5.4"}) {
		t.Fatalf("opencode args wrong: %+v", cap.ModelArgs)
	}
}

func TestResolveModelPinCodex(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "codex", Model: "gpt-5.6-sol"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cap.ModelArgs, []string{"--model", "gpt-5.6-sol"}) {
		t.Fatalf("codex args wrong: %+v", cap.ModelArgs)
	}
}

func TestResolveRejectsCrossRuntimeNamespace(t *testing.T) {
	for _, pin := range []waveobj.RoutePin{
		{Runtime: "claude", Model: "gpt-5.4"},
		{Runtime: "opencode", Model: "deepseek-v4-pro"},
		{Runtime: "codex", Model: "a;b"}, // shell metacharacter reject
		{Runtime: "pi", Model: "has space/deepseek"},
	} {
		if _, err := Resolve(pin); err == nil {
			t.Errorf("expected reject for %+v", pin)
		}
	}
}

func TestResolveModelWinsOverTier(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "pi", Tier: "cheap", Model: "opencode/claude-opus-4-8"})
	if err != nil {
		t.Fatal(err)
	}
	if cap.Model != "opencode/claude-opus-4-8" {
		t.Fatalf("model must win over tier: %+v", cap)
	}
}

// legacy tier pins never carry a Model: the tier is the whole selector, and Resolve fills the args.
func TestResolveLegacyTableUnchanged(t *testing.T) {
	for _, pin := range []waveobj.RoutePin{
		{Runtime: "pi", Tier: "capable"},
		{Runtime: "claude", Tier: "cheap"}, {Runtime: "claude", Tier: "mid"}, {Runtime: "claude", Tier: "capable"},
		{Runtime: "codex", Tier: "capable"}, {Runtime: "opencode", Tier: "capable"},
	} {
		cap, err := Resolve(pin)
		if err != nil {
			t.Fatalf("legacy %+v: %v", pin, err)
		}
		if cap.Model != "" {
			t.Fatalf("legacy pin must not set Model: %+v", cap)
		}
	}
}

func TestIsValidModelCapability(t *testing.T) {
	cap, err := Resolve(waveobj.RoutePin{Runtime: "pi", Model: "opencode/deepseek-v4-flash"})
	if err != nil {
		t.Fatal(err)
	}
	if !IsValid(cap) {
		t.Fatal("resolved model capability must be valid")
	}
	forged := cap
	forged.ModelArgs = []string{"--model", "not-the-resolved-model"}
	if IsValid(forged) {
		t.Fatal("forged ModelArgs must be rejected")
	}
}

// pi's id space is provider-namespaced: a bare id means "whichever authenticated provider serves it",
// which pi refuses to guess at spawn. Wave must not be able to represent that route at all.
func TestResolveRejectsBarePiModel(t *testing.T) {
	for _, model := range []string{"deepseek-v4-pro", "deepseek-v4-flash", "claude-opus-4-8"} {
		if _, err := Resolve(waveobj.RoutePin{Runtime: "pi", Model: model}); err == nil {
			t.Errorf("Resolve(pi, %q) succeeded; bare ids are ambiguous across providers", model)
		}
	}
}

// Tier never meant anything for pi (its ids are provider-namespaced, not aliases), so a pin persisted
// at an old pi tier normalizes to capable rather than stranding the run on an unresolvable route.
func TestNormalizeLegacyPiTierAlwaysCapable(t *testing.T) {
	for _, tier := range []string{"", "cheap", "mid", "capable"} {
		got := NormalizeLegacy("pi", tier)
		if got != (waveobj.RoutePin{Runtime: "pi", Tier: "capable"}) {
			t.Errorf("NormalizeLegacy(pi, %q) = %+v, want capable", tier, got)
		}
	}
}
