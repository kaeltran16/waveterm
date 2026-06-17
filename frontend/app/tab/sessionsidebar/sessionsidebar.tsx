// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import { createBlock, createTab, getApi, setActiveTab } from "@/app/store/global";
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { MOCK_AGENTS } from "@/app/view/agents/agentsmockdata";
import { askingCount } from "@/app/view/agents/agentsviewmodel";
import { fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { setupAgentStatusSubscription, toggleSubagentExpand } from "./agentstatusstore";
import { ensureSessionGroupLabels } from "./sessiongroupstore";
import { SessionGroup, SessionRow, SubagentRow } from "./sessionrow";
import { collapsedGroupsAtom, duplicateSession, renameSession, reorderSession, sessionCwdsAtom, sessionSidebarViewModelAtom, setCollapsedGroups, togglePin } from "./sessionsidebarmodel";
import { aggregateStatus, toggleCollapsed, type SessionRowVM } from "./sessionviewmodel";

const PINNED_LABEL = "Pinned";

function buildSessionRowMenu(row: SessionRowVM, renameRef: React.RefObject<(() => void) | null>): ContextMenuItem[] {
    const ws = globalStore.get(atoms.workspace);
    const menu: ContextMenuItem[] = [
        { label: "Rename", click: () => renameRef.current?.() },
        { label: row.pinned ? "Unpin" : "Pin", click: () => togglePin(row.tabId, row.pinned) },
    ];
    if (row.termBlockOref) {
        menu.push({ label: "Duplicate session", click: () => duplicateSession(row.tabId) });
    }
    menu.push({ type: "separator" });
    menu.push({
        label: "Close tab",
        click: () => {
            if (ws?.oid == null) {
                return;
            }
            fireAndForget(() => getApi().closeTab(ws.oid, row.tabId, false));
        },
    });
    return menu;
}

function SessionRowTree({
    row,
    memberIds,
    drag,
    setDrag,
}: {
    row: SessionRowVM;
    memberIds: string[];
    drag: { draggedId: string; overId: string; placeBefore: boolean };
    setDrag: (d: { draggedId: string; overId: string; placeBefore: boolean }) => void;
}) {
    const renameRef = useRef<(() => void) | null>(null);
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        ContextMenuModel.getInstance().showContextMenu(buildSessionRowMenu(row, renameRef), e);
    };
    const canDrop = drag != null && memberIds.includes(drag.draggedId);
    const isSource = drag?.draggedId === row.tabId;
    const dropIndicator = !isSource && drag?.overId === row.tabId ? (drag.placeBefore ? "top" : "bottom") : undefined;
    const onDragStart = () => setDrag({ draggedId: row.tabId, overId: row.tabId, placeBefore: true });
    const onDragOver = (e: React.DragEvent) => {
        if (!canDrop) {
            return;
        }
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const placeBefore = e.clientY < rect.top + rect.height / 2;
        if (drag.overId !== row.tabId || drag.placeBefore !== placeBefore) {
            setDrag({ draggedId: drag.draggedId, overId: row.tabId, placeBefore });
        }
    };
    const onDrop = (e: React.DragEvent) => {
        if (!canDrop) {
            return;
        }
        e.preventDefault();
        reorderSession(memberIds, drag.draggedId, row.tabId, drag.placeBefore);
        setDrag(null);
    };
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
                renameRef={renameRef}
                onContextMenu={onContextMenu}
                onDuplicate={row.termBlockOref ? () => duplicateSession(row.tabId) : undefined}
                onToggleExpand={() => toggleSubagentExpand(row.termBlockOref, row.subagentsExpanded)}
                onRename={(name) => renameSession(row.tabId, name)}
                onSelect={() => setActiveTab(row.tabId)}
                onTogglePin={() => togglePin(row.tabId, row.pinned)}
                onDragStart={onDragStart}
                onDragOver={onDragOver}
                onDrop={onDrop}
                onDragEnd={() => setDrag(null)}
                dropIndicator={dropIndicator}
                model={row.model}
            />
            {row.subagentsExpanded &&
                row.subagents.map((sa, i) => (
                    <SubagentRow
                        key={sa.id}
                        type={sa.type}
                        state={sa.state}
                        last={i === row.subagents.length - 1}
                        model={sa.model}
                        parentModel={row.model}
                    />
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
    const [drag, setDrag] = useState<{ draggedId: string; overId: string; placeBefore: boolean }>(null);

    useEffect(() => {
        setupAgentStatusSubscription();
    }, []);

    useEffect(() => {
        ensureSessionGroupLabels(cwds);
    }, [cwds.join("|")]);

    const toggle = (label: string) => setCollapsedGroups(toggleCollapsed(collapsedGroups, label));
    const asking = askingCount(MOCK_AGENTS); // Plan 3 swaps MOCK_AGENTS for the live asking count

    return (
        <div
            className="flex h-full flex-col overflow-y-auto rounded-[10px] border border-[#20242b] shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
            style={{ backdropFilter: "blur(20px)", background: "rgba(0, 0, 0, 0.55)" }}
        >
            <button
                type="button"
                className="group flex w-full shrink-0 cursor-pointer items-center gap-2 px-2 py-2 text-[13.5px] text-[#e6edf3] transition-colors hover:bg-[#d29922]/10"
                onClick={() => fireAndForget(() => createBlock({ meta: { view: "agents" } }, true))}
                aria-label="Open Agents"
            >
                <span className="text-[#d29922]">⬤</span>
                <span className="font-semibold">Agents</span>
                {asking > 0 && (
                    <span className="ml-auto rounded-[9px] bg-[#d29922] px-2 text-[10px] font-bold text-black">{asking} asking</span>
                )}
            </button>
            <div className="h-px shrink-0 bg-[#20242b]" />
            <button
                type="button"
                className="group flex w-full shrink-0 cursor-pointer items-center gap-1.5 px-2 py-[7px] text-xs text-[#8b949e] transition-colors hover:text-primary"
                onClick={() => createTab()}
                aria-label="New Tab"
            >
                <i className={makeIconClass("regular@plus", true) + " text-[10px]"} />
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
                        <SessionRowTree
                            key={r.tabId}
                            row={r}
                            memberIds={vm.pinned.map((p) => p.tabId)}
                            drag={drag}
                            setDrag={setDrag}
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
                        <SessionRowTree
                            key={r.tabId}
                            row={r}
                            memberIds={g.sessions.map((s) => s.tabId)}
                            drag={drag}
                            setDrag={setDrag}
                        />
                    ))}
                </SessionGroup>
            ))}
        </div>
    );
}
