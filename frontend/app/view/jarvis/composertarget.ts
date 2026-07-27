// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Who the composer is talking to. The user must never be unsure whether a keystroke reaches a running
// worker or Jarvis, so this is one pure decision consumed by the chip, the placeholder and the send path.

import { parseComposerCommand } from "@/app/view/agents/composercommand";
import type { StageComposition } from "./stagecompose";

export interface TargetInput {
    composerTarget: StageComposition["composerTarget"];
    draft: string;
    workerName?: string;
    runLabel?: string;
}

export interface ComposerTarget {
    audience: "worker" | "jarvis";
    label: string;
    needsChannelPicker: boolean;
}

// parseComposerCommand defaults a bare goal to @run — right on a channel, where a bare goal starts a run,
// but off-channel there is no run to start. So a dispatch off-channel must be TYPED: otherwise every plain
// sentence aimed at Jarvis would demand a channel before it could be answered.
const EXPLICIT_DISPATCH = /^@(quick|run)\b/i;

export function resolveComposerTarget(input: TargetInput): ComposerTarget {
    const draft = input.draft ?? "";
    const dispatching = EXPLICIT_DISPATCH.test(draft.trim());
    const cmd = parseComposerCommand(draft);

    if (input.composerTarget === "worker-or-jarvis") {
        // an explicit @ask beats the live worker: typing it is the user asking Jarvis, not the worker.
        if (cmd.mode === "ask" || input.workerName == null) {
            return { audience: "jarvis", label: "Jarvis", needsChannelPicker: false };
        }
        return {
            audience: "worker",
            label: input.runLabel ? `${input.workerName} · ${input.runLabel}` : input.workerName,
            needsChannelPicker: false,
        };
    }
    // off-channel subjects have no channel to dispatch into, so a dispatch must pick one first.
    const label = input.composerTarget === "jarvis-record" ? "Jarvis · scoped to this record" : "Jarvis · this thread";
    return { audience: "jarvis", label, needsChannelPicker: dispatching };
}
