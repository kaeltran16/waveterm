// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createTab, setActiveTab } from "@/app/store/global";
import { makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { setupAgentStatusSubscription } from "./agentstatusstore";
import { ensureSessionGroupLabels } from "./sessiongroupstore";
import { SessionGroup, SessionRow } from "./sessionrow";
import { collapsedGroupsAtom, sessionCwdsAtom, sessionSidebarViewModelAtom, setCollapsedGroups, togglePin } from "./sessionsidebarmodel";
import { aggregateStatus, toggleCollapsed } from "./sessionviewmodel";

const PINNED_LABEL = "Pinned";

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
                        <SessionRow
                            key={r.tabId}
                            label={r.label}
                            status={r.status}
                            active={r.active}
                            blocked={r.blocked}
                            pinned={r.pinned}
                            detail={r.detail}
                            onSelect={() => setActiveTab(r.tabId)}
                            onTogglePin={() => togglePin(r.tabId, r.pinned)}
                        />
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
                        <SessionRow
                            key={r.tabId}
                            label={r.label}
                            status={r.status}
                            active={r.active}
                            blocked={r.blocked}
                            pinned={r.pinned}
                            detail={r.detail}
                            onSelect={() => setActiveTab(r.tabId)}
                            onTogglePin={() => togglePin(r.tabId, r.pinned)}
                        />
                    ))}
                </SessionGroup>
            ))}
        </div>
    );
}
