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

export interface DestinationInput {
    // the panel's own choice, once the user has made one
    picked: string | null;
    // the Jarvis surface's selection, which may be null for a whole session
    active: string | null;
    channels: Channel[] | null;
}

// Where the reply lands. A ladder rather than a single read, because the peek opens over every surface and
// must never be dead: the panel's own pick wins, the surface's selection is the next best guess, and
// failing both any channel beats none. An oid that no longer resolves falls through instead of blanking —
// channels outlive neither reloads nor deletion, and a remembered pick must not be able to kill the field.
export function resolveDestination(input: DestinationInput): Channel | null {
    const channels = input.channels ?? [];
    const find = (oid: string | null) => (oid == null ? undefined : channels.find((c) => c.oid === oid));
    // newest by createdts rather than first in the list: a cockpit accumulates a per-task channel for every
    // run and scan, so "whatever the backend listed first" reliably lands the reply somewhere months stale.
    const newest = channels.reduce<Channel | null>(
        (best, candidate) => (best == null || candidate.createdts > best.createdts ? candidate : best),
        null
    );
    return find(input.picked) ?? find(input.active) ?? newest;
}
