// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure logic of the header's model and permission-mode controls. Claude Code has no command that sets the permission
// mode, so the control types Shift+Tab around the cycle the TUI itself walks.

export const MODEL_ALIASES = ["default", "opus", "sonnet", "haiku"];

const BASE_CYCLE = ["default", "acceptEdits", "plan"];
export const AUTO_PERMISSION_MODE = "auto";

export const SHIFT_TAB = "\x1b[Z";

export function modelCommand(alias: string): string {
    return `/model ${alias}`;
}

// The modes Shift+Tab walks in this session. Auto mode sits after plan only when the user has it enabled, which no
// hook states outright; the hooks do report the mode itself. Auto is an account/model gate, not per session, so any
// session ever reporting it (autoSeenAnywhere, persisted) puts it in every session's cycle.
export function permissionCycle(seenModes: ReadonlySet<string>, autoSeenAnywhere: boolean): string[] {
    return autoSeenAnywhere || seenModes.has(AUTO_PERMISSION_MODE) ? [...BASE_CYCLE, AUTO_PERMISSION_MODE] : BASE_CYCLE;
}

// the Shift+Tab writes that move the TUI from one mode to another; null when either mode is off the cycle
// (bypassPermissions, or a mode this build does not know), where typing blind could land anywhere
export function permissionModeKeys(cycle: string[], current: string, target: string): string[] | null {
    const from = cycle.indexOf(current);
    const to = cycle.indexOf(target);
    if (from < 0 || to < 0) {
        return null;
    }
    const steps = (to - from + cycle.length) % cycle.length;
    return Array.from({ length: steps }, () => SHIFT_TAB);
}

// a mode the header typed toward, held until the next hook lands with the mode the TUI really has
export interface OptimisticMode {
    mode: string;
    hookTs?: number;
}

export function shownPermissionMode(
    optimistic: OptimisticMode | null,
    lastHookTs: number | undefined,
    reported: string | null
): string | null {
    return optimistic != null && optimistic.hookTs === lastHookTs ? optimistic.mode : reported;
}

const MODE_LABELS: Record<string, string> = {
    default: "default permissions",
    acceptEdits: "accept edits",
    plan: "plan mode",
    auto: "auto mode",
};

export function permissionModeLabel(mode?: string): string {
    if (!mode) {
        return "";
    }
    return MODE_LABELS[mode] ?? mode;
}
