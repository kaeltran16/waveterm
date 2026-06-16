// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getTabBadgeAtom } from "@/app/store/badge";
import { setActiveTab } from "@/app/store/global";
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { getAgentStatusAtom } from "./agentstatusstore";
import { sessionGroupLabelAtom } from "./sessiongroupstore";
import {
    badgeToStatus,
    buildSessionViewModel,
    cwdToServiceLabel,
    cycleTarget,
    needsYouTarget,
    type SessionInput,
    type SessionStatus,
    type SidebarViewModel,
} from "./sessionviewmodel";

/** Derived: collect per-tab data reactively and build the grouped view model. */
export const sessionSidebarViewModelAtom = atom<SidebarViewModel>((get) => {
    const ws = get(atoms.workspace);
    const tabIds = ws?.tabids ?? [];
    const activeId = ws?.activetabid;
    const labelMap = get(sessionGroupLabelAtom);

    const sessions: SessionInput[] = tabIds.map((tabId) => {
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        const badges = get(getTabBadgeAtom(tabId));

        let cwd: string | undefined;
        let termBlockId: string | undefined;
        for (const blockId of tab?.blockids ?? []) {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
                cwd = block.meta["cmd:cwd"];
                termBlockId = blockId;
                break;
            }
        }

        const badgeStatus = badgeToStatus(badges?.[0]);
        let status: SessionStatus = badgeStatus;
        let detail: string | undefined;
        if (termBlockId) {
            const agentStatus = get(getAgentStatusAtom(WOS.makeORef("block", termBlockId)));
            if (agentStatus?.state) {
                status = agentStatus.state as SessionStatus;
                detail = agentStatus.detail;
            }
        }

        const meta = tab?.meta ?? {};
        return {
            tabId,
            name: tab?.name ?? "",
            agent: meta["session:agent"],
            pinned: meta["session:pinned"] === true,
            cwd,
            serviceLabel: (cwd && labelMap.get(cwd)) || cwdToServiceLabel(cwd),
            status,
            detail,
            active: tabId === activeId,
        };
    });

    return buildSessionViewModel(sessions);
});

export const sessionCwdsAtom = atom<string[]>((get) => {
    const ws = get(atoms.workspace);
    const tabIds = ws?.tabids ?? [];
    const cwds: string[] = [];
    for (const tabId of tabIds) {
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        for (const blockId of tab?.blockids ?? []) {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
                cwds.push(block.meta["cmd:cwd"]);
                break;
            }
        }
    }
    return cwds;
});

export function togglePin(tabId: string, pinned: boolean) {
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("tab", tabId),
            meta: { "session:pinned": !pinned },
        })
    );
}

/** Reactive: the collapsed group labels persisted on the workspace. */
export const collapsedGroupsAtom = atom<string[]>((get) => {
    const ws = get(atoms.workspace);
    return ws?.meta?.["session:collapsedgroups"] ?? [];
});

export function setCollapsedGroups(groups: string[]) {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("workspace", ws.oid),
            meta: { "session:collapsedgroups": groups },
        })
    );
}

export function cycleSession(offset: number) {
    const vm = globalStore.get(sessionSidebarViewModelAtom);
    const target = cycleTarget(vm, offset);
    if (target != null) {
        setActiveTab(target);
    }
}

export function jumpToNeedsYou() {
    const vm = globalStore.get(sessionSidebarViewModelAtom);
    const target = needsYouTarget(vm);
    if (target != null) {
        setActiveTab(target);
    }
}

/** The active session's terminal block id + cwd (the block the diff-split targets). */
export function findActiveSessionTermBlock(): { blockId: string; cwd: string } | undefined {
    const ws = globalStore.get(atoms.workspace);
    const activeId = ws?.activetabid;
    if (activeId == null) {
        return undefined;
    }
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", activeId)));
    for (const blockId of tab?.blockids ?? []) {
        const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
        if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
            return { blockId, cwd: block.meta["cmd:cwd"] };
        }
    }
    return undefined;
}
