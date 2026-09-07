// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Pure geometry and persistence rules for the Code sidebar. The component owns DOM events; this
// module keeps bounds and external values deterministic and testable.

export const CODE_SIDEBAR_MIN_WIDTH = 200;
export const CODE_SIDEBAR_MAX_WIDTH = 480;
export const CODE_SIDEBAR_EDITOR_FLOOR = 280;
export const CODE_SIDEBAR_COMPACT_WIDTH = 36;
export const CODE_SIDEBAR_SEPARATOR_WIDTH = 8;

export const CODE_SIDEBAR_DEFAULT_WIDTHS = {
    files: 280,
    search: 380,
    changed: 380,
} as const;

export type CodeSidebarMode = keyof typeof CODE_SIDEBAR_DEFAULT_WIDTHS;

export type CodeSidebarWidths = Record<CodeSidebarMode, number>;

export type CodeSidebarPrefs = {
    widths: CodeSidebarWidths;
    open: boolean;
};

export type CodeSidebarVisibility = {
    temporary: boolean;
    compact: boolean;
};

export function defaultCodeSidebarPrefs(): CodeSidebarPrefs {
    return { widths: { ...CODE_SIDEBAR_DEFAULT_WIDTHS }, open: true };
}

export function clampCodeSidebarWidth(value: number, max = CODE_SIDEBAR_MAX_WIDTH): number {
    const safeMax = Math.max(CODE_SIDEBAR_MIN_WIDTH, Math.min(CODE_SIDEBAR_MAX_WIDTH, max));
    return Number.isFinite(value) ? Math.min(safeMax, Math.max(CODE_SIDEBAR_MIN_WIDTH, value)) : CODE_SIDEBAR_MIN_WIDTH;
}

export function codeSidebarMaxWidth(workspaceWidth: number): number {
    if (!Number.isFinite(workspaceWidth) || workspaceWidth <= 0) {
        return CODE_SIDEBAR_MAX_WIDTH;
    }
    return Math.max(
        CODE_SIDEBAR_MIN_WIDTH,
        Math.min(CODE_SIDEBAR_MAX_WIDTH, workspaceWidth - CODE_SIDEBAR_EDITOR_FLOOR - CODE_SIDEBAR_SEPARATOR_WIDTH)
    );
}

export function codeSidebarVisibility(workspaceWidth: number, open: boolean): CodeSidebarVisibility {
    const temporary =
        workspaceWidth > 0 &&
        workspaceWidth < CODE_SIDEBAR_MIN_WIDTH + CODE_SIDEBAR_EDITOR_FLOOR + CODE_SIDEBAR_SEPARATOR_WIDTH;
    return { temporary, compact: temporary || !open };
}

export function codeSidebarWidthFor(mode: CodeSidebarMode, widths: CodeSidebarWidths, workspaceWidth: number): number {
    return clampCodeSidebarWidth(widths[mode], codeSidebarMaxWidth(workspaceWidth));
}

export function codeSidebarWidthAfterPointer(start: number, deltaX: number, max: number): number {
    return clampCodeSidebarWidth(start + deltaX, max);
}

export function codeSidebarDragWidthForWorkspace(width: number, workspaceWidth: number): number {
    return clampCodeSidebarWidth(width, codeSidebarMaxWidth(workspaceWidth));
}

export function codeSidebarDragEndWidth(width: number, workspaceWidth: number, commit: boolean): number | null {
    return commit ? codeSidebarDragWidthForWorkspace(width, workspaceWidth) : null;
}

export function nextCodeSidebarWidth(
    current: number,
    key: "ArrowLeft" | "ArrowRight" | "Home" | "End",
    shiftKey: boolean,
    max: number
): number {
    if (key === "Home") {
        return CODE_SIDEBAR_MIN_WIDTH;
    }
    if (key === "End") {
        return clampCodeSidebarWidth(max, max);
    }
    const step = shiftKey ? 40 : 16;
    const delta = key === "ArrowRight" ? step : -step;
    return clampCodeSidebarWidth(current + delta, max);
}

function validWidth(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? clampCodeSidebarWidth(value) : fallback;
}

export function parseCodeSidebarPrefs(raw: string | null): CodeSidebarPrefs {
    const defaults = defaultCodeSidebarPrefs();
    if (raw == null) {
        return defaults;
    }
    try {
        const value: unknown = JSON.parse(raw);
        if (value == null || typeof value !== "object" || Array.isArray(value)) {
            return defaults;
        }
        const record = value as { widths?: unknown; open?: unknown };
        const widths = record.widths;
        const widthRecord = widths != null && typeof widths === "object" && !Array.isArray(widths) ? widths : {};
        const storedWidths = widthRecord as Partial<Record<CodeSidebarMode, unknown>>;
        return {
            widths: {
                files: validWidth(storedWidths.files, defaults.widths.files),
                search: validWidth(storedWidths.search, defaults.widths.search),
                changed: validWidth(storedWidths.changed, defaults.widths.changed),
            },
            open: typeof record.open === "boolean" ? record.open : defaults.open,
        };
    } catch {
        return defaults;
    }
}

export function codeSidebarPrefsJson(prefs: CodeSidebarPrefs): string {
    return JSON.stringify({
        widths: {
            files: clampCodeSidebarWidth(prefs.widths.files),
            search: clampCodeSidebarWidth(prefs.widths.search),
            changed: clampCodeSidebarWidth(prefs.widths.changed),
        },
        open: prefs.open,
    });
}
