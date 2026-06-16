// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createTab, setActiveTab } from "@/app/store/global";
import { makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { setupAgentStatusSubscription, toggleSubagentExpand } from "./agentstatusstore";
import { ensureSessionGroupLabels } from "./sessiongroupstore";
import { SessionGroup, SessionRow, SubagentRow } from "./sessionrow";
import { collapsedGroupsAtom, renameSession, sessionCwdsAtom, sessionSidebarViewModelAtom, setCollapsedGroups, togglePin } from "./sessionsidebarmodel";
import { aggregateStatus, toggleCollapsed, type SessionRowVM } from "./sessionviewmodel";

const PINNED_LABEL = "Pinned";

function SessionRowTree({ row }: { row: SessionRowVM }) {
    return (
        <>
            <SessionRow
                label={row.label}
                status={row.status}
                active={row.active}
                blocked={row.blocked}
                pinned={row.pinned}
                detail={row.detail}
                subagentCount={row.subagents.length}
                expanded={row.subagentsExpanded}
                editValue={row.customLabel}
                onToggleExpand={() => toggleSubagentExpand(row.termBlockOref, row.subagentsExpanded)}
                onRename={(name) => renameSession(row.tabId, name)}
                onSelect={() => setActiveTab(row.tabId)}
                onTogglePin={() => togglePin(row.tabId, row.pinned)}
            />
            {row.subagentsExpanded &&
                row.subagents.map((sa, i) => (
                    <SubagentRow key={sa.id} type={sa.type} state={sa.state} last={i === row.subagents.length - 1} />
                ))}
        </>
    );
}

export function SessionSidebar({ workspace }: { workspace: Workspace }) {
    void workspace; // tab list is read reactively from the atom; prop kept to match the mount seam
    const vm = useAtomValue(sessionSidebarViewModelAtom);
    const cwds = useAtomValue(sessionCwdsAtom);
    const collapsedGroups = useAtomValue(collapsedGroupsAtom);
    const collapsed = new Set(collapsedGroups);

    useEffect(() => {
        setupAgentStatusSubscription();
    }, []);

    useEffect(() => {
        ensureSessionGroupLabels(cwds);
    }, [cwds.join("|")]);

    const toggle = (label: string) => setCollapsedGroups(toggleCollapsed(collapsedGroups, label));

    return (
        <div
            className="flex h-full flex-col overflow-y-auto"
            style={{ backdropFilter: "blur(20px)", background: "rgba(0, 0, 0, 0.35)" }}
        >
            <button
                type="button"
                className="group flex h-9 w-full shrink-0 cursor-pointer items-center gap-1.5 px-3 text-xs text-secondary transition-colors hover:text-primary"
                onClick={() => createTab()}
                aria-label="New Tab"
            >
                <i className={makeIconClass("plus", true) + " text-[10px]"} />
                <span>New Tab</span>
            </button>

            {vm.pinned.length > 0 && (
                <SessionGroup
                    label={PINNED_LABEL}
                    count={vm.pinned.length}
                    collapsed={collapsed.has(PINNED_LABEL)}
                    aggregateStatus={aggregateStatus(vm.pinned.map((r) => r.status))}
                    onToggle={() => toggle(PINNED_LABEL)}
                >
                    {vm.pinned.map((r) => (
                        <SessionRowTree key={r.tabId} row={r} />
                    ))}
                </SessionGroup>
            )}

            {vm.groups.map((g) => (
                <SessionGroup
                    key={g.label}
                    label={g.label}
                    count={g.sessions.length}
                    collapsed={collapsed.has(g.label)}
                    aggregateStatus={g.aggregateStatus}
                    onToggle={() => toggle(g.label)}
                >
                    {g.sessions.map((r) => (
                        <SessionRowTree key={r.tabId} row={r} />
                    ))}
                </SessionGroup>
            ))}
        </div>
    );
}
