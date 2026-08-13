// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// pure availability derivation for Pet Errand. No channel or an in-flight reply locks the field;
// draft and harness validity block dispatch without blocking composition. Keeping those decisions separate
// prevents an empty draft from disabling the very field needed to make it non-empty.

import { supportsOperation } from "@/app/view/agents/harnesspicker";

export interface PetErrandStateInput {
    channel: boolean;
    draft: string;
    busy: boolean;
    runtime: string;
    saving: boolean;
    harnesses: HarnessInfo[];
}

export interface PetErrandState {
    inputDisabled: boolean;
    submitDisabled: boolean;
    reason: string | null;
    runtime: string;
}

export function petErrandState(input: PetErrandStateInput): PetErrandState {
    if (!input.channel) {
        return {
            inputDisabled: true,
            submitDisabled: true,
            reason: "no channel active",
            runtime: input.runtime,
        };
    }
    if (input.busy) {
        return {
            inputDisabled: true,
            submitDisabled: true,
            reason: "busy",
            runtime: input.runtime,
        };
    }
    if (input.runtime === "") {
        return {
            inputDisabled: false,
            submitDisabled: true,
            reason: "Choose a harness",
            runtime: input.runtime,
        };
    }
    if (input.saving) {
        return {
            inputDisabled: false,
            submitDisabled: true,
            reason: "saving harness preference…",
            runtime: input.runtime,
        };
    }
    const harness = input.harnesses.find((candidate) => candidate.runtime === input.runtime);
    if (harness == null || !harness.installed || !supportsOperation(harness, "consult")) {
        return {
            inputDisabled: false,
            submitDisabled: true,
            reason: "Choose a harness",
            runtime: input.runtime,
        };
    }
    if (input.draft.trim() === "") {
        return {
            inputDisabled: false,
            submitDisabled: true,
            reason: "empty draft",
            runtime: input.runtime,
        };
    }
    return {
        inputDisabled: false,
        submitDisabled: false,
        reason: null,
        runtime: input.runtime,
    };
}
