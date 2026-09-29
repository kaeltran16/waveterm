// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The model as a narrow column or chip names it. Only the claude- prefix goes: every claude id carries it, so it
// says nothing, while a pi provider/model keeps its provider because that is what tells two routes apart.
export function shortModel(model: string | undefined | null): string {
    if (!model) {
        return "default";
    }
    return model.startsWith("claude-") ? model.slice("claude-".length) : model;
}
