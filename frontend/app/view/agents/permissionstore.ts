// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Claude's pending permission prompts per block, projected by the PermissionRequest hook. The server does not
// persist agent:permission events, so this state is built from the live subscription only: after a reload a prompt
// already open shows in the terminal alone.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { atom, type PrimitiveAtom } from "jotai";
import type { TimelineMark } from "./permissionmodel";

// keyed by block ORef string ("block:<uuid>"), oldest first
const permissionAtoms = new Map<string, PrimitiveAtom<AgentPermissionData[]>>();
const logAtoms = new Map<string, PrimitiveAtom<TimelineMark[]>>();

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
export function permissionLogAtom(agentId: string): PrimitiveAtom<TimelineMark[]> {
    let a = logAtoms.get(agentId);
    if (a == null) {
        a = atom<TimelineMark[]>([]);
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
                removeAgentPermission(data.oref, data.permid);
                return;
            }
            raisePermission(data);
        },
    });
}
