// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Claude's pending permission prompts per block, projected by the PermissionRequest hook. The server does not
// persist agent:permission events, so a boot reads the requests already open from AgentPermissionListCommand and
// the live subscription keeps them current from there.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, type PrimitiveAtom } from "jotai";
import type { PermissionMark } from "./permissionmodel";

// keyed by block ORef string ("block:<uuid>"), oldest first
const permissionAtoms = new Map<string, PrimitiveAtom<AgentPermissionData[]>>();
const logAtoms = new Map<string, PrimitiveAtom<PermissionMark[]>>();

export function getAgentPermissionsAtom(oref: string): PrimitiveAtom<AgentPermissionData[]> {
    let a = permissionAtoms.get(oref);
    if (a == null) {
        a = atom<AgentPermissionData[]>([]);
        permissionAtoms.set(oref, a);
    }
    return a;
}

// the band's answers this session, drawn as "allowed" rows in the timeline; not in the transcript, so a reload loses
// them
export function permissionLogAtom(agentId: string): PrimitiveAtom<PermissionMark[]> {
    let a = logAtoms.get(agentId);
    if (a == null) {
        a = atom<PermissionMark[]>([]);
        logAtoms.set(agentId, a);
    }
    return a;
}

export function removeAgentPermission(oref: string, permid: string) {
    const a = getAgentPermissionsAtom(oref);
    const list = globalStore.get(a);
    if (list.some((p) => p.permid === permid)) {
        globalStore.set(
            a,
            list.filter((p) => p.permid !== permid)
        );
    }
}

function raisePermission(data: AgentPermissionData) {
    const a = getAgentPermissionsAtom(data.oref);
    const list = globalStore.get(a);
    const at = list.findIndex((p) => p.permid === data.permid);
    globalStore.set(a, at < 0 ? [...list, data] : list.map((p, i) => (i === at ? data : p)));
}

// merges requests read from the server into a block's queue: a permid already there keeps the live copy, and the
// queue stays oldest first since the read can land after newer live raises
export function mergeOpenPermissions(list: AgentPermissionData[], open: AgentPermissionData[]): AgentPermissionData[] {
    const missing = open.filter((p) => !list.some((q) => q.permid === p.permid));
    if (missing.length === 0) {
        return list;
    }
    return [...list, ...missing].sort((a, b) => a.ts - b.ts);
}

// permids cleared while the open-request read is in flight: the read may predate their clear
let clearedWhileReading: Set<string> | null = null;

function readOpenPermissions() {
    const cleared = new Set<string>();
    clearedWhileReading = cleared;
    fireAndForget(async () => {
        try {
            const open = (await RpcApi.AgentPermissionListCommand(TabRpcClient)) ?? [];
            const byOref = new Map<string, AgentPermissionData[]>();
            for (const p of open) {
                if (!cleared.has(p.permid)) {
                    byOref.set(p.oref, [...(byOref.get(p.oref) ?? []), p]);
                }
            }
            for (const [oref, perms] of byOref) {
                globalStore.set(getAgentPermissionsAtom(oref), (list) => mergeOpenPermissions(list, perms));
            }
        } catch (err) {
            console.warn("reading the open permission requests failed", err);
        } finally {
            clearedWhileReading = null;
        }
    });
}

let subscribed = false;
export function setupAgentPermissionSubscription() {
    if (subscribed) {
        return;
    }
    subscribed = true;
    waveEventSubscribeSingle({
        eventType: "agent:permission",
        handler: (event) => {
            const data = event.data as AgentPermissionData;
            if (data?.oref == null || !data.permid) {
                return;
            }
            if (data.cleared) {
                clearedWhileReading?.add(data.permid);
                removeAgentPermission(data.oref, data.permid);
                return;
            }
            raisePermission(data);
        },
    });
    readOpenPermissions();
}
