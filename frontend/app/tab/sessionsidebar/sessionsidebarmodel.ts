// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getTabBadgeAtom } from "@/app/store/badge";
import { getApi, setActiveTab } from "@/app/store/global";
import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { WorkspaceService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { getAgentStatusAtom, getSubagentExpandAtom, getSubagentsAtom } from "./agentstatusstore";
import { sessionGroupLabelAtom } from "./sessiongroupstore";
import {
    badgeToStatus,
    buildDuplicateBlockMeta,
    buildSessionViewModel,
    cwdToServiceLabel,
    cycleTarget,
    flattenVisualOrder,
    needsYouTarget,
    reorderWithinGroup,
    subagentExpanded,
    waitingTarget,
    type SessionInput,
    type SessionStatus,
    type SidebarViewModel,
    type SubagentVM,
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
        let isAgentsTab = false;
        for (const blockId of tab?.blockids ?? []) {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === "agents") {
                isAgentsTab = true;
            }
            if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
                cwd = block.meta["cmd:cwd"];
                termBlockId = blockId;
                break;
            }
        }

        const badgeStatus = badgeToStatus(badges?.[0]);
        let status: SessionStatus = badgeStatus;
        let detail: string | undefined;
        let model: string | undefined;
        let title: string | undefined;
        let subagents: SubagentVM[] = [];
        let subagentsExpanded = false;
        let termBlockOref: string | undefined;
        if (termBlockId) {
            termBlockOref = WOS.makeORef("block", termBlockId);
            const agentStatus = get(getAgentStatusAtom(termBlockOref));
            if (agentStatus?.state) {
                status = agentStatus.state as SessionStatus;
                detail = agentStatus.detail;
            }
            model = agentStatus?.model;
            title = agentStatus?.title;
            subagents = get(getSubagentsAtom(termBlockOref));
            subagentsExpanded = subagentExpanded(subagents, get(getSubagentExpandAtom(termBlockOref)));
        }

        const meta = tab?.meta ?? {};
        return {
            tabId,
            name: tab?.name ?? "",
            agent: meta["session:agent"],
            customLabel: meta["session:label"],
            title,
            pinned: meta["session:pinned"] === true,
            isAgentsTab,
            cwd,
            serviceLabel: (cwd && labelMap.get(cwd)) || cwdToServiceLabel(cwd),
            status,
            detail,
            model,
            subagents,
            subagentsExpanded,
            termBlockOref,
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

/** Set (or clear, when empty) the session's custom label. Null reverts the row to its auto label. */
export function renameSession(tabId: string, name: string) {
    const trimmed = name.trim();
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("tab", tabId),
            meta: { "session:label": trimmed.length > 0 ? trimmed : null },
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

export function cycleWaiting(offset: number) {
    const vm = globalStore.get(sessionSidebarViewModelAtom);
    const target = waitingTarget(vm, offset);
    if (target != null) {
        setActiveTab(target);
    }
}

/** Switch to the 1-based Nth row in sidebar visual order (Ctrl:1-9). */
export function switchToVisualIndex(index: number) {
    const vm = globalStore.get(sessionSidebarViewModelAtom);
    const target = flattenVisualOrder(vm)[index - 1];
    if (target != null) {
        setActiveTab(target.tabId);
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

/** Resolve a tab's terminal block (the session block) — same rule the sidebar groups on. */
function findSessionTermBlock(tabId: string): { blockId: string; meta: Record<string, any> } | undefined {
    const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    for (const blockId of tab?.blockids ?? []) {
        const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
        if (block?.meta?.view === "term" && block.meta["cmd:cwd"]) {
            return { blockId, meta: block.meta };
        }
    }
    return undefined;
}

/** Reorder a session within its group by rewriting the workspace tab order (shared with the tab bar).
 *  No-op when the computed order is unchanged or the workspace is missing. */
export function reorderSession(memberIds: string[], draggedId: string, targetId: string, placeBefore: boolean) {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    const tabIds = ws.tabids ?? [];
    const next = reorderWithinGroup(tabIds, memberIds, draggedId, targetId, placeBefore);
    if (next.length === tabIds.length && next.every((id, i) => id === tabIds[i])) {
        return;
    }
    fireAndForget(() => RpcApi.UpdateWorkspaceTabIdsCommand(TabRpcClient, ws.oid, next));
}

/** Close every tab in a group after a single confirmation. Callers pass only cwd groups (never the
 *  pinned group), so the Agents tab is never bulk-closed. */
export function closeGroup(label: string, memberIds: string[]) {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null || memberIds.length === 0) {
        return;
    }
    const noun = memberIds.length === 1 ? "tab" : "tabs";
    modalsModel.pushModal("ConfirmModal", {
        title: "Close group",
        message: `Close ${memberIds.length} ${noun} in "${label}"? This can't be undone.`,
        confirmLabel: `Close ${noun}`,
        destructive: true,
        onConfirm: () => {
            for (const tabId of memberIds) {
                fireAndForget(() => getApi().closeTab(ws.oid, tabId, false));
            }
        },
    });
}

/** Duplicate a session: open a new tab running the same agent in the same cwd as the source.
 *  Reconfigures the new tab's default shell block *before* activating it, so the controller starts
 *  with the cloned cmd:cwd/cmd (the backend doesn't start the controller until the tab renders). */
export function duplicateSession(sourceTabId: string) {
    const source = findSessionTermBlock(sourceTabId);
    if (source == null) {
        return;
    }
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    const srcTab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", sourceTabId)));
    const agent = srcTab?.meta?.["session:agent"];
    const blockMeta = buildDuplicateBlockMeta(source.meta);
    fireAndForget(async () => {
        const newTabId = await WorkspaceService.CreateTab(ws.oid, "", false);
        const newTab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", newTabId)));
        const defaultBlockId = newTab?.blockids?.[0];
        if (defaultBlockId != null) {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", defaultBlockId),
                meta: blockMeta,
            });
        }
        if (agent != null) {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("tab", newTabId),
                meta: { "session:agent": agent },
            });
        }
        setActiveTab(newTabId);
    });
}

const AGENTS_TAB_NAME = "Agents";

/** Open the Agents view in its own dedicated full-tab block. Focuses the existing
 *  "Agents" tab if one is open; otherwise creates it and repurposes the new tab's
 *  default shell block into the agents view *before* activating, so no shell controller
 *  starts (the backend defers the controller until the tab renders). */
export function openAgentsTab() {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    for (const tabId of ws.tabids ?? []) {
        const tab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        if (tab?.name === AGENTS_TAB_NAME) {
            setActiveTab(tabId);
            return;
        }
    }
    fireAndForget(async () => {
        const newTabId = await WorkspaceService.CreateTab(ws.oid, AGENTS_TAB_NAME, false);
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("tab", newTabId),
            meta: { "session:pinned": true },
        });
        const newTab = globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", newTabId)));
        const defaultBlockId = newTab?.blockids?.[0];
        if (defaultBlockId != null) {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("block", defaultBlockId),
                meta: { view: "agents", controller: null, "cmd:cwd": null },
            });
        }
        setActiveTab(newTabId);
    });
}
