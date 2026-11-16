// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package jarvis

import "log"

// The plan skill is the contract an orchestrator run's plan is written and worked by. The run:planskill
// setting chooses it for a new run; the run records it so a later change of the setting never moves a
// run whose plan is already written.
const (
	PlanSkill_Plan         = "plan"
	PlanSkill_WritingPlans = "writing-plans"
)

// NewRunPlanSkill is the contract a new run starts with, from the run:planskill setting. Empty is the shipped
// default; an unknown value is a typo in settings.json, so it is logged rather than silently kept.
func NewRunPlanSkill(setting string) string {
	switch setting {
	case PlanSkill_Plan, PlanSkill_WritingPlans:
		return setting
	case "":
		return PlanSkill_Plan
	}
	log.Printf("run:planskill %q is not %q or %q; using %q", setting, PlanSkill_Plan, PlanSkill_WritingPlans, PlanSkill_Plan)
	return PlanSkill_Plan
}

// EffectivePlanSkill is the contract a stored run or dag works by. An empty value is every run and dag from
// before the setting existed, whose plan was written under writing-plans, so it reads as that and not as the
// current default.
func EffectivePlanSkill(stored string) string {
	switch stored {
	case PlanSkill_Plan, PlanSkill_WritingPlans:
		return stored
	}
	return PlanSkill_WritingPlans
}
