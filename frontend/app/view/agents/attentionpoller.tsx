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
import { wsLinkAtom } from "@/app/store/wslink";
import { openTarget } from "@/app/view/jarvis/openref";
import { expressionFor, postureFor } from "@/app/view/jarvis/petcondition";
import { petSignalsFrom } from "@/app/view/jarvis/petsignals";
import { fireAndForget } from "@/util/util";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { atom, useAtomValue, type Atom } from "jotai";
import { useEffect, useMemo, useRef } from "react";
import type { AgentsViewModel } from "./agents";
import {
    POPUP_HIDE_EVENT,
    POPUP_OPEN_EVENT,
    POPUP_SHOW_EVENT,
    POPUP_WINDOW_LABEL,
    popupBubble,
    type PopupFace,
} from "./attentionpopup";
import { popupTarget } from "./attentionpopuptarget";
import { attentionAtom, loadAttention, taskbarSignal } from "./attentionstore";
import { asksUser, brainstormAttention } from "./brainstormmodel";
import { brainstormsAtom, shownBrainstormFile } from "./brainstormstore";
import { savedRateLimitsAtom } from "./ratelimitstore";

// the face the main window's avatar wears with this list, derived here rather than read back from PetView:
// PetView mounts after the poller, so its render for this list has not happened yet
function popupFaceFor(model: AgentsViewModel, attention: AttentionItem[]): PopupFace {
    const signals = petSignalsFrom({
        agents: globalStore.get(model.agentsAtom),
        savedRateLimits: globalStore.get(savedRateLimitsAtom),
        now: Date.now(),
        attention,
        link: globalStore.get(wsLinkAtom),
    });
    return { expression: expressionFor(signals), posture: postureFor(signals) };
}

// the un-overlaid roster: the overlay already reads an asking brainstorm as "asking", which asksUser would refuse
function brainstormItemsAtom(model: AgentsViewModel): Atom<AttentionItem[]> {
    return atom((get) => {
        const brainstorms = get(brainstormsAtom);
        const items: AttentionItem[] = [];
        for (const agent of get(model.baseRosterAtom)) {
            const b = brainstorms[agent.id];
            const f = shownBrainstormFile(b);
            if (f != null && asksUser(f, agent)) {
                items.push(brainstormAttention({ agentId: agent.id, agentName: agent.name, topic: b.topic }, f));
            }
        }
        return items;
    });
}

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
    const brainstormItems = useAtomValue(useMemo(() => brainstormItemsAtom(model), [model]));
    // server items first, so their rank wins; the in-app lists stay the server's alone
    const outward = useMemo(() => [...attention, ...brainstormItems], [attention, brainstormItems]);
    const seen = useRef<AttentionItem[]>([]);
    useEffect(() => {
        const focused = document.hasFocus();
        const signal = taskbarSignal(seen.current, outward, focused);
        const bubble = popupBubble(seen.current, outward, focused, popupFaceFor(model, attention));
        seen.current = outward;
        if (signal != null) {
            const request = signal === "flash" ? UserAttentionType.Informational : null;
            fireAndForget(() => getCurrentWindow().requestUserAttention(request));
        }
        if (bubble != null) {
            fireAndForget(() => emitTo(POPUP_WINDOW_LABEL, POPUP_SHOW_EVENT, bubble));
        }
    }, [outward, attention, model]);
    useEffect(() => {
        const hide = () => fireAndForget(() => emitTo(POPUP_WINDOW_LABEL, POPUP_HIDE_EVENT));
        window.addEventListener("focus", hide);
        return () => window.removeEventListener("focus", hide);
    }, []);
    useEffect(() => {
        const unlisten = listen<{ key: string }>(POPUP_OPEN_EVENT, (event) => {
            // apart from the open, so a refused window call still lands the click
            fireAndForget(bringForward);
            const item = [...globalStore.get(attentionAtom), ...globalStore.get(brainstormItemsAtom(model))].find(
                (i) => i.key === event.payload.key
            );
            const target = item != null ? popupTarget(item, globalStore.get(model.agentsAtom)) : null;
            if (target != null) {
                fireAndForget(() => openTarget(model, target));
            }
        });
        return () => fireAndForget(async () => (await unlisten)());
    }, [model]);
    return null;
}
