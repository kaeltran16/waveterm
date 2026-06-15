// Pure view-model logic for the session sidebar. No React, no Wave runtime imports.

export const NO_CWD_LABEL = "ungrouped";

export type SessionStatus = "working" | "waiting" | "idle";

// Couples to the Phase 0 reporter's color constants. Phase 2 replaces this with an explicit
// `state` field carried by the `wsh agentstatus` event.
export const COLOR_WORKING = "#3fb950";
export const COLOR_WAITING = "#d29922";

/** Map a tab's primary badge (set by the Phase 0 reporter) to a status. */
export function badgeToStatus(badge?: { color?: string } | null): SessionStatus {
    const color = badge?.color?.toLowerCase();
    if (color === COLOR_WORKING) {
        return "working";
    }
    if (color === COLOR_WAITING) {
        return "waiting";
    }
    return "idle";
}

/** Priority for a collapsed group's aggregate dot: waiting > working > idle. */
export function aggregateStatus(statuses: SessionStatus[]): SessionStatus {
    if (statuses.includes("waiting")) {
        return "waiting";
    }
    if (statuses.includes("working")) {
        return "working";
    }
    return "idle";
}

/** Per-tab data collected by the container atom and fed to the builder. */
export interface SessionInput {
    tabId: string;
    name: string;
    agent?: string;
    pinned: boolean;
    cwd?: string;
    status: SessionStatus;
    active: boolean;
}

export interface SessionRowVM {
    tabId: string;
    label: string;
    status: SessionStatus;
    active: boolean;
    blocked: boolean;
    pinned: boolean;
}

export interface SessionGroupVM {
    label: string;
    sessions: SessionRowVM[];
    aggregateStatus: SessionStatus;
}

export interface SidebarViewModel {
    pinned: SessionRowVM[];
    groups: SessionGroupVM[];
}

function rowLabel(s: SessionInput, includeService: boolean): string {
    const agent = s.agent && s.agent.length > 0 ? s.agent : s.name;
    const base = agent && agent.length > 0 ? agent : "session";
    return includeService ? `${base} · ${cwdToServiceLabel(s.cwd)}` : base;
}

function toRow(s: SessionInput, includeService: boolean): SessionRowVM {
    return {
        tabId: s.tabId,
        label: rowLabel(s, includeService),
        status: s.status,
        active: s.active,
        blocked: s.status === "waiting",
        pinned: s.pinned,
    };
}

/** Pure: ordered session inputs -> pinned group + service groups (first-appearance order). */
export function buildSessionViewModel(sessions: SessionInput[]): SidebarViewModel {
    const pinned: SessionRowVM[] = [];
    const groupOrder: string[] = [];
    const groupMap = new Map<string, SessionInput[]>();

    for (const s of sessions) {
        if (s.pinned) {
            pinned.push(toRow(s, true));
            continue;
        }
        const label = cwdToServiceLabel(s.cwd);
        if (!groupMap.has(label)) {
            groupMap.set(label, []);
            groupOrder.push(label);
        }
        groupMap.get(label)!.push(s);
    }

    const groups: SessionGroupVM[] = groupOrder.map((label) => {
        const rows = groupMap.get(label)!.map((s) => toRow(s, false));
        return { label, sessions: rows, aggregateStatus: aggregateStatus(rows.map((r) => r.status)) };
    });

    return { pinned, groups };
}

/** Phase 1 grouping: the last path segment of the terminal cwd (Phase 2 replaces this with the marker walk-up RPC). */
export function cwdToServiceLabel(cwd?: string): string {
    if (!cwd) {
        return NO_CWD_LABEL;
    }
    const trimmed = cwd.replace(/[\\/]+$/, "");
    const segments = trimmed.split(/[\\/]+/);
    const last = segments[segments.length - 1];
    return last && last.length > 0 ? last : NO_CWD_LABEL;
}
