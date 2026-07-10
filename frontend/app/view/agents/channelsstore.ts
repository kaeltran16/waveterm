// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type Atom, type PrimitiveAtom } from "jotai";

export const channelsAtom = atom<Channel[] | null>(null) as PrimitiveAtom<Channel[] | null>;
export const activeChannelIdAtom = atom<string | undefined>(undefined) as PrimitiveAtom<string | undefined>;

export const activeChannelAtom: Atom<Channel | null> = atom((get) => {
    const id = get(activeChannelIdAtom);
    if (!id) {
        return null;
    }
    return get(WOS.getWaveObjectAtom<Channel>(WOS.makeORef("channel", id))) ?? null;
});

let loading = false;

// fetch the channel list into the snapshot atom (sorted newest-first). shared by loadChannels (which then
// auto-selects) and primeChannels (which must not select).
async function fetchChannelsInto(): Promise<Channel[]> {
    const rtn = await RpcApi.GetChannelsCommand(TabRpcClient);
    const list = (rtn.channels ?? []).sort((a, b) => b.createdts - a.createdts);
    globalStore.set(channelsAtom, list);
    return list;
}

export async function loadChannels(): Promise<void> {
    if (loading) {
        return;
    }
    loading = true;
    try {
        const list = await fetchChannelsInto();
        const cur = globalStore.get(activeChannelIdAtom);
        if (!cur && list.length > 0) {
            await selectChannel(list[0].oid);
        }
    } catch (err) {
        console.error("loading channels failed", err);
        globalStore.set(channelsAtom, []);
    } finally {
        loading = false;
    }
}

// prime the channel snapshot at boot so the nav-rail badge + Cockpit "need you" counters dedup against
// Jarvis-answered asks before the Channels surface is ever opened. deliberately does NOT auto-select a
// channel (selection belongs to entering the surface, and would prematurely stamp read-ts).
export async function primeChannels(): Promise<void> {
    try {
        await fetchChannelsInto();
    } catch (err) {
        console.error("priming channels failed", err);
    }
}

export async function selectChannel(channelId: string): Promise<void> {
    await WOS.loadAndPinWaveObject<Channel>(WOS.makeORef("channel", channelId));
    globalStore.set(activeChannelIdAtom, channelId);
    // stamp last-read so the rail unread badge clears (fire-and-forget; failure is non-fatal)
    RpcApi.SetChannelReadCommand(TabRpcClient, { channelid: channelId, ts: Date.now() }).catch(() => {});
}

export async function createChannel(name: string, projectPath: string): Promise<string> {
    const ch = await RpcApi.CreateChannelCommand(TabRpcClient, { name, projectpath: projectPath });
    await loadChannels();
    await selectChannel(ch.oid);
    return ch.oid;
}

export async function deleteChannel(channelId: string): Promise<void> {
    const wasActive = globalStore.get(activeChannelIdAtom) === channelId;
    await RpcApi.DeleteChannelCommand(TabRpcClient, { channelid: channelId });
    // clear the active id first so loadChannels reselects the first surviving channel
    if (wasActive) {
        globalStore.set(activeChannelIdAtom, undefined);
    }
    await loadChannels();
}

// Persist a channel's autonomy tier, then refresh the snapshot-fed rail so its badge updates
// immediately. The rail reads the channelsAtom snapshot (not live WOS), so a tier change is
// invisible until loadChannels() re-fetches — mirrors how create/delete already refresh.
export async function setChannelTier(channelId: string, tier: string, mode: string): Promise<void> {
    await RpcApi.SetChannelTierCommand(TabRpcClient, { channelid: channelId, tier, mode });
    await loadChannels();
}

export async function renameChannel(channelId: string, name: string): Promise<void> {
    await RpcApi.RenameChannelCommand(TabRpcClient, { channelid: channelId, name });
    await loadChannels();
}

// Archive/unarchive a channel (a Channel.Meta flag), then refresh the snapshot-fed rail. Mirrors
// setChannelTier/renameChannel — the rail reads the channelsAtom snapshot, so it needs a re-fetch.
export async function archiveChannel(channelId: string, archived: boolean): Promise<void> {
    await RpcApi.ArchiveChannelCommand(TabRpcClient, { channelid: channelId, archived });
    await loadChannels();
}

// Ephemeral live consult streams, keyed `${consultId}:${runtime}`. Not persisted — superseded by the
// consult-reply message (matched by RefORef `consult:<consultId>` + author) once it arrives via WOS.
export interface ConsultStream {
    text: string;
    status: "streaming" | "done" | "error";
}
export const consultStreamsAtom = atom<Record<string, ConsultStream>>({}) as PrimitiveAtom<
    Record<string, ConsultStream>
>;

export function consultStreamKey(consultId: string, runtime: string): string {
    return `${consultId}:${runtime}`;
}

export function setConsultStream(consultId: string, runtime: string, stream: ConsultStream): void {
    const key = consultStreamKey(consultId, runtime);
    globalStore.set(consultStreamsAtom, { ...globalStore.get(consultStreamsAtom), [key]: stream });
}