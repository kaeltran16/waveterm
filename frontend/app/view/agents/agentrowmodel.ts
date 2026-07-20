// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure glue for AgentRow: transcript-entry fallback, question-index clamp, mute-action mode,
// the finish (working -> idle) settle trigger, and the context-menu item assembly. Extracted so
// the card's branching is unit-testable without rendering. The component maps each menu item's
// `key` to its icon + click handler; this module owns which items appear, their labels, and order.

import type { AgentState } from "./agentsviewmodel";

export function entriesToShow<T>(liveEntries: T[], previousInfo: T[] | undefined): T[] {
    return liveEntries.length > 0 ? liveEntries : (previousInfo ?? []);
}

export function clampQuestionIndex(activeQuestion: number | undefined, questionCount: number): number {
    return Math.min(activeQuestion ?? 0, Math.max(0, questionCount - 1));
}

export function muteMode(state: AgentState): "dismiss" | "background" {
    return state === "idle" ? "dismiss" : "background";
}

// one-shot settle animation fires when an agent finishes (working -> idle).
export function isFinishTransition(prev: AgentState, next: AgentState): boolean {
    return prev === "working" && next === "idle";
}

export type AgentRowMenuItem =
    | { key: "open" | "terminal" | "diff" | "fullwidth" | "mute" | "copy" | "close"; label: string; danger?: boolean }
    | { separator: true };

export function agentRowMenuItems(flags: {
    hasDiff: boolean;
    canToggleFullWidth: boolean;
    fullWidth: boolean;
    hasMute: boolean;
}): AgentRowMenuItem[] {
    const items: AgentRowMenuItem[] = [
        { key: "open", label: "Open" },
        { key: "terminal", label: "Open terminal" },
    ];
    if (flags.hasDiff) {
        items.push({ key: "diff", label: "Review changes" });
    }
    if (flags.canToggleFullWidth) {
        items.push({ key: "fullwidth", label: flags.fullWidth ? "Exit full width" : "Full width" });
    }
    if (flags.hasMute) {
        items.push({ key: "mute", label: "Move to background" });
    }
    items.push({ key: "copy", label: "Copy name" });
    items.push({ separator: true });
    items.push({ key: "close", label: "Close agent", danger: true });
    return items;
}
