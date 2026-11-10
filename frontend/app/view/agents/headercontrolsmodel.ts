// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure logic of the header's model and permission-mode controls. Claude Code has no command that sets the permission
// mode, so the control types Shift+Tab around the cycle the TUI itself walks.

export const MODEL_ALIASES = ["default", "opus", "sonnet", "haiku"];

export const PERMISSION_CYCLE = ["default", "acceptEdits", "plan"];

export const SHIFT_TAB = "\x1b[Z";

export function modelCommand(alias: string): string {
    return `/model ${alias}`;
}

// the Shift+Tab writes that move the TUI from one mode to another; null when either mode is off the cycle
// (bypassPermissions, or a mode this build does not know), where typing blind could land anywhere
export function permissionModeKeys(current: string, target: string): string[] | null {
    const from = PERMISSION_CYCLE.indexOf(current);
    const to = PERMISSION_CYCLE.indexOf(target);
    if (from < 0 || to < 0) {
        return null;
    }
    const steps = (to - from + PERMISSION_CYCLE.length) % PERMISSION_CYCLE.length;
    return Array.from({ length: steps }, () => SHIFT_TAB);
}

const MODE_LABELS: Record<string, string> = {
    default: "default permissions",
    acceptEdits: "accept edits",
    plan: "plan mode",
};

export function permissionModeLabel(mode?: string): string {
    if (!mode) {
        return "";
    }
    return MODE_LABELS[mode] ?? mode;
}
