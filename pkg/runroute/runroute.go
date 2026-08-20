// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Package runroute owns the supported run-runtime and model-tier authority.
package runroute

import (
	"fmt"
	"slices"

	"github.com/wavetermdev/waveterm/pkg/consult"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const operatorDefault = "operator default"

type Capability struct {
	Runtime       string       `json:"runtime"`
	Tier          consult.Tier `json:"tier"`
	ResolvedModel string       `json:"resolvedmodel"`
	ModelArgs     []string     `json:"-"`
}

var capabilityTable = []Capability{
	{Runtime: "pi", Tier: consult.TierCheap, ResolvedModel: consult.PiCheapModel, ModelArgs: []string{"--model", consult.PiCheapModel}},
	{Runtime: "pi", Tier: consult.TierMid, ResolvedModel: consult.PiMidModel, ModelArgs: []string{"--model", consult.PiMidModel}},
	{Runtime: "pi", Tier: consult.TierCapable, ResolvedModel: consult.PiMidModel, ModelArgs: []string{"--model", consult.PiMidModel}},
	{Runtime: "claude", Tier: consult.TierCheap, ResolvedModel: consult.CheapModel, ModelArgs: []string{"--model", consult.CheapModel}},
	{Runtime: "claude", Tier: consult.TierMid, ResolvedModel: consult.MidModel, ModelArgs: []string{"--model", consult.MidModel}},
	{Runtime: "claude", Tier: consult.TierCapable, ResolvedModel: operatorDefault},
	{Runtime: "codex", Tier: consult.TierCapable, ResolvedModel: operatorDefault},
	{Runtime: "opencode", Tier: consult.TierCapable, ResolvedModel: operatorDefault},
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
	for _, capability := range capabilityTable {
		if capability.Runtime == pin.Runtime && string(capability.Tier) == pin.Tier {
			return clone(capability), nil
		}
	}
	return Capability{}, fmt.Errorf("unsupported route runtime %q tier %q", pin.Runtime, pin.Tier)
}

func NormalizeLegacy(runtime, tier string) waveobj.RoutePin {
	if runtime == "" {
		runtime = "claude"
	}
	if tier == "" {
		tier = string(consult.TierCapable)
	}
	return waveobj.RoutePin{Runtime: runtime, Tier: tier}
}

// IsValid reports whether a capability is an unmodified value returned by Resolve. Consumers pass
// capabilities across package boundaries, so this keeps adapters from launching a hand-built route.
func IsValid(capability Capability) bool {
	resolved, err := Resolve(waveobj.RoutePin{Runtime: capability.Runtime, Tier: string(capability.Tier)})
	return err == nil && resolved.ResolvedModel == capability.ResolvedModel && slices.Equal(resolved.ModelArgs, capability.ModelArgs)
}

func clone(capability Capability) Capability {
	capability.ModelArgs = append([]string(nil), capability.ModelArgs...)
	return capability
}
