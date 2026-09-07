// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package runroute owns the supported run-runtime and model-tier authority.
package runroute

import (
	"fmt"
	"regexp"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const operatorDefault = "operator default"

var (
	claudeAliasRe    = regexp.MustCompile(`^(opus|sonnet|haiku|fable|best)(\[[0-9]+m\])?$`)
	claudeFullRe     = regexp.MustCompile(`^claude-[a-zA-Z0-9-]+$`)
	providerModelRe  = regexp.MustCompile(`^[a-zA-Z0-9_-]+/[a-zA-Z0-9._:+-]+$`)
	codexForbiddenRe = regexp.MustCompile(`[\s;&|` + "`" + `$<>'"]`)
)

func codexSafe(model string) bool {
	if model == "" {
		return false
	}
	return !codexForbiddenRe.MatchString(model)
}

type Capability struct {
	Runtime       string `json:"runtime"`
	Tier          string `json:"tier,omitempty"`        // legacy tier pin only; "" for model pins
	Model         string `json:"model,omitempty"`       // set on model pins; "" for legacy tier pins
	ResolvedModel string `json:"resolvedmodel"`
	Provider      string `json:"provider,omitempty"`   // catalog metadata, informational
	ContextHint   string `json:"contexthint,omitempty"` // catalog metadata, informational
	Default       bool   `json:"default,omitempty"`     // catalog metadata: the harness's own default model
	ModelArgs     []string `json:"-"`
}

var capabilityTable = []Capability{
	// pi has no tiers: its ids are provider-namespaced (provider/model), not aliases, so there is no
	// bare id Wave can pin that pi can resolve on its own. A tier pin means "pi's configured default".
	{Runtime: "pi", Tier: string(consult.TierCapable), ResolvedModel: operatorDefault},
	{Runtime: "claude", Tier: string(consult.TierCheap), ResolvedModel: consult.CheapModel, ModelArgs: []string{"--model", consult.CheapModel}},
	{Runtime: "claude", Tier: string(consult.TierMid), ResolvedModel: consult.MidModel, ModelArgs: []string{"--model", consult.MidModel}},
	{Runtime: "claude", Tier: string(consult.TierCapable), ResolvedModel: operatorDefault},
	{Runtime: "codex", Tier: string(consult.TierCapable), ResolvedModel: operatorDefault},
	{Runtime: "opencode", Tier: string(consult.TierCapable), ResolvedModel: operatorDefault},
}

func Capabilities(runtime string) []Capability {
	capabilities := make([]Capability, 0, len(capabilityTable))
	for _, capability := range capabilityTable {
		if capability.Runtime != runtime {
			continue
		}
		capabilities = append(capabilities, clone(capability))
	}
	return capabilities
}

func Resolve(pin waveobj.RoutePin) (Capability, error) {
	if pin.Model != "" {
		return resolveModelPin(pin)
	}
	return resolveLegacyTier(pin)
}

func resolveLegacyTier(pin waveobj.RoutePin) (Capability, error) {
	for _, capability := range capabilityTable {
		if capability.Runtime == pin.Runtime && capability.Tier == pin.Tier {
			return clone(capability), nil
		}
	}
	return Capability{}, fmt.Errorf("unsupported route runtime %q tier %q", pin.Runtime, pin.Tier)
}

func resolveModelPin(pin waveobj.RoutePin) (Capability, error) {
	if pin.Runtime == "" {
		return Capability{}, fmt.Errorf("model route requires a runtime")
	}
	if !modelNamespaceValid(pin.Runtime, pin.Model) {
		return Capability{}, fmt.Errorf("model %q is not a valid %s model id", pin.Model, pin.Runtime)
	}
	return Capability{
		Runtime:       pin.Runtime,
		Model:         pin.Model,
		ResolvedModel: pin.Model,
		ModelArgs:     modelArgsFor(pin.Runtime, pin.Model),
	}, nil
}

// modelNamespaceValid is the hard submit gate. Presence in the catalog is advisory (the harness is
// the ultimate validator at spawn); namespace membership is deterministic and cheap.
func modelNamespaceValid(runtime, model string) bool {
	switch runtime {
	case "claude":
		return claudeAliasRe.MatchString(model) || claudeFullRe.MatchString(model)
	case "pi":
		return providerModelRe.MatchString(model)
	case "opencode":
		return providerModelRe.MatchString(model)
	case "codex":
		return codexSafe(model)
	}
	return false
}

func modelArgsFor(runtime, model string) []string {
	switch runtime {
	case "claude", "codex", "opencode", "pi":
		return []string{"--model", model}
	}
	return nil
}

func NormalizeLegacy(runtime, tier string) waveobj.RoutePin {
	if runtime == "" {
		runtime = "claude"
	}
	if tier == "" || runtime == "pi" {
		// pi never had meaningful tiers; a pin persisted at one still has to resolve.
		tier = string(consult.TierCapable)
	}
	return waveobj.RoutePin{Runtime: runtime, Tier: tier}
}

// IsValid reports whether a capability is an unmodified value returned by Resolve. Consumers pass
// capabilities across package boundaries, so this keeps adapters from launching a hand-built route.
func IsValid(capability Capability) bool {
	resolved, err := Resolve(waveobj.RoutePin{Runtime: capability.Runtime, Tier: capability.Tier, Model: capability.Model})
	return err == nil && resolved.ResolvedModel == capability.ResolvedModel && slices.Equal(resolved.ModelArgs, capability.ModelArgs)
}

func clone(capability Capability) Capability {
	capability.ModelArgs = append([]string(nil), capability.ModelArgs...)
	return capability
}
