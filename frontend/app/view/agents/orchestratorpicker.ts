// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { modelFace } from "./route";

export function orchestratorPickerState(input: {
    shape: string;
    mode: string;
    pending: boolean;
    hasWorkerCallback: boolean;
}): { showTightRow: boolean; showWorkerPicker: boolean } {
    const show = input.shape === "orchestrator" && input.mode !== "ask" && !input.pending && input.hasWorkerCallback;
    return { showTightRow: show, showWorkerPicker: show };
}

export function workerPickerFace(workerRoute: RoutePin | null): string {
    if (workerRoute == null) {
        return "Same as lead";
    }
    return modelFace(workerRoute);
}
