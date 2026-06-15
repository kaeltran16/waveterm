// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getTabBadgeAtom } from "@/app/store/badge";
import { createTab, setActiveTab } from "@/app/store/global";
import { atoms } from "@/app/store/global-atoms";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget, makeIconClass } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { useState } from "react";
import { SessionGroup, SessionRow } from "./sessionrow";
import {
    aggregateStatus,
    badgeToStatus,
    buildSessionViewModel,
    type SessionInput,
    type SidebarViewModel,
} from "./sessionviewmodel";

const PINNED_LABEL = "Pinned";

/** Derived: collect per-tab data reactively and build the grouped view model. */
export const sessionSidebarViewModelAtom = atom<SidebarViewModel>((get) => {
    const ws = get(atoms.workspace);
    const tabIds = ws?.tabids ?? [];
    const activeId = ws?.activetabid;

    const sessions: SessionInput[] = tabIds.map((tabId) => {
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        const badges = get(getTabBadgeAtom(tabId));
        const status = badgeToStatus(badges?.[0]);

        let cwd: string | undefined;
        for (const blockId of tab?.blockids ?? []) {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
                cwd = block.meta["cmd:cwd"];
                break;
            }
        }

        const meta = (tab?.meta ?? {}) as Record<string, any>;
        return {
            tabId,
            name: tab?.name ?? "",
            agent: meta["session:agent"],
            pinned: meta["session:pinned"] === true,
            cwd,
            status,
            active: tabId === activeId,
        };
    });

    return buildSessionViewModel(sessions);
});

function togglePin(tabId: string, pinned: boolean) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("tab", tabId),
            // session:pinned is not yet in MetaType (spec §6: meta-as-any for v1).
            meta: { "session:pinned": !pinned } as any,
        })
    );
}

export function SessionSidebar({ workspace }: { workspace: Workspace }) {
    void workspace; // tab list is read reactively from the atom; prop kept to match the mount seam
    const vm = useAtomValue(sessionSidebarViewModelAtom);
    const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

    const toggle = (label: string) =>
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(label)) {
                next.delete(label);
            } else {
                next.add(label);
            }
            return next;
        });

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
                            onSelect={() => setActiveTab(r.tabId)}
                            onTogglePin={() => togglePin(r.tabId, r.pinned)}
                        />
                    ))}
                </SessionGroup>
            ))}
        </div>
    );
}
