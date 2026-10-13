// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The wavesrv socket's state, for anything that must say the backend is unreachable. ws.ts is the only
// writer. A drop shorter than the grace (a wavesrv restart, a reconnect blip) never reads as lost, and
// a socket that has never opened is a boot failure, which is shown elsewhere.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, type PrimitiveAtom } from "jotai";

export type WsLink = { connected: boolean; everConnected: boolean; lostAt: number | null };

export const LINK_GRACE_MS = 3000;

export const INITIAL_LINK: WsLink = { connected: false, everConnected: false, lostAt: null };

export function linkOpened(link: WsLink): WsLink {
    return { ...link, connected: true, everConnected: true, lostAt: null };
}

// a failed retry closes again while already down; keeping the first drop time keeps "since" honest
export function linkClosed(link: WsLink, nowMs: number): WsLink {
    return { ...link, connected: false, lostAt: link.lostAt ?? nowMs };
}

export function linkLostSince(link: WsLink, nowMs: number): number | null {
    if (!link.everConnected || link.connected || link.lostAt == null) {
        return null;
    }
    return nowMs - link.lostAt >= LINK_GRACE_MS ? link.lostAt : null;
}

export const wsLinkAtom = atom<WsLink>(INITIAL_LINK) as PrimitiveAtom<WsLink>;

// cdp cannot stop wavesrv without stopping the dev app with it. Compiled out of production builds.
if (import.meta.env.DEV) {
    (globalThis as Record<string, unknown>).__waveLink = {
        get: (): WsLink => globalStore.get(wsLinkAtom),
        set: (link: WsLink) => globalStore.set(wsLinkAtom, link),
    };
}
