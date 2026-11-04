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

// one-shot settle animation fires when an agent finishes: idle and not standing by, after working or after standing
// by (its last shell task ended while it stayed idle). The Stop that begins standing by is not a finish.
export function isFinishTransition(
    prev: AgentState,
    next: AgentState,
    prevStandingBy = false,
    nextStandingBy = false
): boolean {
    if (next !== "idle" || nextStandingBy) {
        return false;
    }
    return prev === "working" || (prev === "idle" && prevStandingBy);
}

// a chip says what it counts
export function subagentsLabel(n: number): string {
    return `${n} subagent${n === 1 ? "" : "s"}`;
}

export function tasksLabel(done: number, total: number): string {
    return `${done}/${total} tasks`;
}

export type AgentRowMenuItem =
    | { key: "open" | "terminal" | "diff" | "mute" | "copy" | "close"; label: string; danger?: boolean }
    | { separator: true };

export type MuteMode = ReturnType<typeof muteMode>;

// dismissing an idle card parks it in the Idle section, so it says so rather than "background"
const MUTE_LABEL: Record<MuteMode, string> = { background: "Move to background", dismiss: "Move to Idle" };

export function muteTitle(mode: MuteMode): string {
    return mode === "background" ? `${MUTE_LABEL.background} (B)` : MUTE_LABEL.dismiss;
}

export function agentRowMenuItems(flags: { hasDiff: boolean; mute: MuteMode | null }): AgentRowMenuItem[] {
    const items: AgentRowMenuItem[] = [
        { key: "open", label: "Open" },
        { key: "terminal", label: "Open terminal" },
    ];
    if (flags.hasDiff) {
        items.push({ key: "diff", label: "Review changes" });
    }
    if (flags.mute != null) {
        items.push({ key: "mute", label: MUTE_LABEL[flags.mute] });
    }
    items.push({ key: "copy", label: "Copy name" });
    items.push({ separator: true });
    items.push({ key: "close", label: "Close agent", danger: true });
    return items;
}

// an asking card's scroll region sticks to its bottom, which in a short card leaves the answer band's first
// option above the view: the scrollTop that holds the band's top in view instead, or null when the bottom pin
// (bottomScrollTop = scrollHeight - clientHeight) already shows it
export function askScrollTop(answerTop: number, bottomScrollTop: number): number | null {
    return answerTop < bottomScrollTop ? answerTop : null;
}
