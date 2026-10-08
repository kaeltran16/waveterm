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
// the desktop popup window, whose click it answers.

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
import { attentionAtom, loadAttention, taskbarSignal } from "./attentionstore";

async function bringForward(): Promise<void> {
    const win = getCurrentWindow();
    await win.unminimize();
    await win.show();
    await win.setFocus();
}

export function AttentionPoller({ model }: { model: AgentsViewModel }) {
    useEffect(() => {
        void loadAttention();
        const t = setInterval(() => void loadAttention(), 10_000);
        return () => clearInterval(t);
    }, []);
    const attention = useAtomValue(attentionAtom);
    const seen = useRef<AttentionItem[]>([]);
    useEffect(() => {
        const focused = document.hasFocus();
        const signal = taskbarSignal(seen.current, attention, focused);
        const bubble = popupBubble(seen.current, attention, focused);
        seen.current = attention;
        if (signal != null) {
            const request = signal === "flash" ? UserAttentionType.Informational : null;
            fireAndForget(() => getCurrentWindow().requestUserAttention(request));
        }
        if (bubble != null) {
            fireAndForget(() => emitTo(POPUP_WINDOW_LABEL, POPUP_SHOW_EVENT, bubble));
        }
    }, [attention]);
    useEffect(() => {
        const hide = () => fireAndForget(() => emitTo(POPUP_WINDOW_LABEL, POPUP_HIDE_EVENT));
        window.addEventListener("focus", hide);
        return () => window.removeEventListener("focus", hide);
    }, []);
    useEffect(() => {
        const unlisten = listen<{ key: string }>(POPUP_OPEN_EVENT, (event) => {
            // apart from the open, so a refused window call still lands the click
            fireAndForget(bringForward);
            const item = globalStore.get(attentionAtom).find((i) => i.key === event.payload.key);
            const target = item != null ? popupTarget(item, globalStore.get(model.agentsAtom)) : null;
            if (target != null) {
                fireAndForget(() => openTarget(model, target));
            }
        });
        return () => fireAndForget(async () => (await unlisten)());
    }, [model]);
    return null;
}
