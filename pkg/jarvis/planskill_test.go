// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import "testing"

func TestNewRunPlanSkill(t *testing.T) {
	cases := []struct{ name, setting, want string }{
		{"unset takes the shipped default", "", PlanSkill_Plan},
		{"plan", "plan", PlanSkill_Plan},
		{"writing-plans", "writing-plans", PlanSkill_WritingPlans},
		{"unknown falls back to the default", "superpowers:writing-plans", PlanSkill_Plan},
		{"case matters", "Plan", PlanSkill_Plan},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NewRunPlanSkill(tc.setting); got != tc.want {
				t.Fatalf("NewRunPlanSkill(%q) = %q, want %q", tc.setting, got, tc.want)
			}
		})
	}
}

func TestEffectivePlanSkill(t *testing.T) {
	cases := []struct{ name, stored, want string }{
		{"a run from before the setting reads as writing-plans", "", PlanSkill_WritingPlans},
		{"plan", "plan", PlanSkill_Plan},
		{"writing-plans", "writing-plans", PlanSkill_WritingPlans},
		{"unknown reads as the legacy contract", "other", PlanSkill_WritingPlans},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := EffectivePlanSkill(tc.stored); got != tc.want {
				t.Fatalf("EffectivePlanSkill(%q) = %q, want %q", tc.stored, got, tc.want)
			}
		})
	}
}
