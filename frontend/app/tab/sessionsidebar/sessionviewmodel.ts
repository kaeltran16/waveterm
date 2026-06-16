// Pure view-model logic for the session sidebar. No React, no Wave runtime imports.

export const NO_CWD_LABEL = "ungrouped";

export type SessionStatus = "working" | "waiting" | "idle";

export type SubagentState = "working" | "success" | "failure";

export interface SubagentVM {
    id: string;
    type: string;
    state: SubagentState;
}

/** A single subagent lifecycle transition, mapped from the AgentStatusData.subagent delta. */
export interface SubagentDelta {
    action: "start" | "stop";
    id: string;
    type: string;
    status?: "success" | "failure";
}

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
    customLabel?: string;
    pinned: boolean;
    cwd?: string;
    serviceLabel: string;
    status: SessionStatus;
    detail?: string;
    subagents?: SubagentVM[];
    subagentsExpanded?: boolean;
    termBlockOref?: string;
    active: boolean;
}

export interface SessionRowVM {
    tabId: string;
    label: string;
    customLabel?: string;
    status: SessionStatus;
    active: boolean;
    blocked: boolean;
    pinned: boolean;
    detail?: string;
    subagents: SubagentVM[];
    subagentsExpanded: boolean;
    termBlockOref?: string;
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
    const custom = s.customLabel && s.customLabel.length > 0 ? s.customLabel : undefined;
    const agent = s.agent && s.agent.length > 0 ? s.agent : s.name;
    const base = custom ?? (agent && agent.length > 0 ? agent : "session");
    return includeService ? `${base} · ${s.serviceLabel}` : base;
}

function toRow(s: SessionInput, includeService: boolean): SessionRowVM {
    const subagents = s.subagents ?? [];
    const status = rollUpStatus(s.status, subagents);
    return {
        tabId: s.tabId,
        label: rowLabel(s, includeService),
        customLabel: s.customLabel,
        status,
        active: s.active,
        blocked: status === "waiting",
        pinned: s.pinned,
        detail: s.detail,
        subagents,
        subagentsExpanded: s.subagentsExpanded ?? false,
        termBlockOref: s.termBlockOref,
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
        const label = s.serviceLabel;
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

/** Pure: add the label if absent, remove it if present. Never mutates the input. */
export function toggleCollapsed(groups: string[], label: string): string[] {
    return groups.includes(label) ? groups.filter((g) => g !== label) : [...groups, label];
}

/** Sidebar visual order: pinned rows first, then each group's rows top-to-bottom. */
export function flattenVisualOrder(vm: SidebarViewModel): SessionRowVM[] {
    return [...vm.pinned, ...vm.groups.flatMap((g) => g.sessions)];
}

/** Pure: the tabId to switch to when cycling by offset (+1 next, -1 prev) in visual order, wrapping. */
export function cycleTarget(vm: SidebarViewModel, offset: number): string | undefined {
    const order = flattenVisualOrder(vm);
    if (order.length === 0) {
        return undefined;
    }
    const activeIdx = order.findIndex((r) => r.active);
    // no active row: next starts at the top, prev at the bottom
    const base = activeIdx === -1 ? (offset > 0 ? -1 : 0) : activeIdx;
    const nextIdx = (base + offset + order.length) % order.length;
    return order[nextIdx].tabId;
}

/** Pure: the next waiting (needs-you) session after the active one in visual order, wrapping. */
export function needsYouTarget(vm: SidebarViewModel): string | undefined {
    const order = flattenVisualOrder(vm);
    if (order.length === 0) {
        return undefined;
    }
    const activeIdx = order.findIndex((r) => r.active);
    for (let i = 1; i <= order.length; i++) {
        const idx = (activeIdx + i + order.length) % order.length;
        if (order[idx].status === "waiting") {
            return order[idx].tabId;
        }
    }
    return undefined;
}

/** Pure: reduce a subagent start/stop delta into the per-block list. Never mutates the input.
 *  start is idempotent by id; stop flips the matching entry (or appends if the start was missed). */
export function reduceSubagents(list: SubagentVM[], delta: SubagentDelta): SubagentVM[] {
    if (delta.action === "start") {
        if (list.some((s) => s.id === delta.id)) {
            return list;
        }
        return [...list, { id: delta.id, type: delta.type, state: "working" }];
    }
    const state: SubagentState = delta.status === "failure" ? "failure" : "success";
    if (!list.some((s) => s.id === delta.id)) {
        return [...list, { id: delta.id, type: delta.type, state }];
    }
    return list.map((s) => (s.id === delta.id ? { ...s, state } : s));
}

/** Pure: the row's dot reflects children — the parent's own waiting (amber) dominates;
 *  otherwise any working child lifts an idle/working parent to working. */
export function rollUpStatus(parent: SessionStatus, subagents: SubagentVM[]): SessionStatus {
    if (parent === "waiting") {
        return "waiting";
    }
    if (subagents.some((s) => s.state === "working")) {
        return "working";
    }
    return parent;
}

/** Pure: auto-expand while a child is working; a manual override (set this turn) wins.
 *  An empty list is never expanded (nothing to show). */
export function subagentExpanded(subagents: SubagentVM[], manualOverride?: boolean): boolean {
    if (subagents.length === 0) {
        return false;
    }
    if (manualOverride != null) {
        return manualOverride;
    }
    return subagents.some((s) => s.state === "working");
}
