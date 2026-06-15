// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getTabBadgeAtom } from "@/app/store/badge";
import { atoms } from "@/app/store/global-atoms";
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

        const meta = (tab?.meta ?? {}) as Record<string, any>;
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
            // session:pinned is not yet in MetaType (spec §6: meta-as-any for v1).
            meta: { "session:pinned": !pinned } as any,
        })
    );
}
