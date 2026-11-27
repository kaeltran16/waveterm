// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Always-mounted (cockpit root) 10s poll driver for the cockpit-wide attention list. Renders nothing.
// 10s mirrors BackgroundAgentsPoller, which picked it so a blocked agent surfaces quickly; a review
// gate has the same urgency. Polling rather than server push is deliberate — a missed poll self-heals
// on the next tick, whereas a missed push event goes stale while still looking live.
//
// It also carries the list out of the app: the in-app badges are invisible while another window has
// focus, so a new item flashes the taskbar button until Arc is focused again, and shows as a bubble in
// the desktop popup window, whose click it answers. What goes out is the outward list: a run's wait is
// held back while its conductor has it, so it pops once, when it becomes the user's. The same tick
// refreshes the Cockpit's runs and steps each wait's escalation (cockpitsessionstore.ts).

import { globalStore } from "@/app/store/jotaiStore";
import { openTarget } from "@/app/view/jarvis/openref";
import { fireAndForget } from "@/util/util";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import type { AgentsViewModel } from "./agents";
import {
    POPUP_HIDE_EVENT,
    POPUP_OPEN_EVENT,
    POPUP_SHOW_EVENT,
    POPUP_WINDOW_LABEL,
    popupBubble,
} from "./attentionpopup";
import { popupTarget } from "./attentionpopuptarget";
import { loadAttention, taskbarSignal } from "./attentionstore";
import {
    outwardAttentionAtomFor,
    refreshCockpitRuns,
    sessionsAtomFor,
    stepCockpit,
    waitEntriesAtomFor,
} from "./cockpitsessionstore";

const POLL_MS = 10_000;

async function bringForward(): Promise<void> {
    const win = getCurrentWindow();
    await win.unminimize();
    await win.show();
    await win.setFocus();
}

export function AttentionPoller({ model }: { model: AgentsViewModel }) {
    useEffect(() => {
        const tick = () => {
            void loadAttention();
            void refreshCockpitRuns();
            stepCockpit(model);
        };
        tick();
        const t = setInterval(tick, POLL_MS);
        return () => clearInterval(t);
    }, [model]);
    // a session's state or a wait's conductor changing is stepped at once, not on the next tick
    const sessions = useAtomValue(sessionsAtomFor(model));
    const waits = useAtomValue(waitEntriesAtomFor(model));
    useEffect(() => stepCockpit(model), [model, sessions, waits]);
    // the in-app lists stay the server's alone
    const outward = useAtomValue(outwardAttentionAtomFor(model));
    const seen = useRef<AttentionItem[]>([]);
    useEffect(() => {
        const focused = document.hasFocus();
        const signal = taskbarSignal(seen.current, outward, focused);
        const bubble = popupBubble(seen.current, outward, focused);
        seen.current = outward;
        if (signal != null) {
            const request = signal === "flash" ? UserAttentionType.Informational : null;
            fireAndForget(() => getCurrentWindow().requestUserAttention(request));
        }
        if (bubble != null) {
            fireAndForget(() => emitTo(POPUP_WINDOW_LABEL, POPUP_SHOW_EVENT, bubble));
        }
    }, [outward]);
    useEffect(() => {
        const hide = () => fireAndForget(() => emitTo(POPUP_WINDOW_LABEL, POPUP_HIDE_EVENT));
        window.addEventListener("focus", hide);
        return () => window.removeEventListener("focus", hide);
    }, []);
    useEffect(() => {
        const unlisten = listen<{ key: string }>(POPUP_OPEN_EVENT, (event) => {
            // apart from the open, so a refused window call still lands the click
            fireAndForget(bringForward);
            const item = globalStore.get(outwardAttentionAtomFor(model)).find((i) => i.key === event.payload.key);
            const target = item != null ? popupTarget(item, globalStore.get(model.agentsAtom)) : null;
            if (target != null) {
                fireAndForget(() => openTarget(model, target));
            }
        });
        return () => fireAndForget(async () => (await unlisten)());
    }, [model]);
    return null;
}
