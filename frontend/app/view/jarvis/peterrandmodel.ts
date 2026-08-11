// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure disabled-state derivation for Pet Errand. The input row never silently picks the first
// installed harness — dispatch is only allowed for the operator's visible, persisted, consult-capable
// choice. Exact reasons let the UI say precisely why the Ask button is blocked.

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
    disabled: boolean;
    reason: string | null;
    runtime: string;
}

export function petErrandState(input: PetErrandStateInput): PetErrandState {
    if (!input.channel) {
        return { disabled: true, reason: "no channel active", runtime: input.runtime };
    }
    if (input.busy) {
        return { disabled: true, reason: "busy", runtime: input.runtime };
    }
    if (input.runtime === "") {
        return { disabled: true, reason: "Choose a harness", runtime: input.runtime };
    }
    if (input.saving) {
        return { disabled: true, reason: "saving harness preference…", runtime: input.runtime };
    }
    const h = input.harnesses.find((x) => x.runtime === input.runtime);
    if (h == null || !h.installed || !supportsOperation(h, "consult")) {
        return { disabled: true, reason: "Choose a harness", runtime: input.runtime };
    }
    if (input.draft.trim() === "") {
        return { disabled: true, reason: "empty draft", runtime: input.runtime };
    }
    return { disabled: false, reason: null, runtime: input.runtime };
}
