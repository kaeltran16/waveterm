// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The desktop popup's page: the attention bubble in a window of its own. It draws what the main window
// sends and opens no wavesrv connection, so it imports the card and the contract, never the cockpit.

import {
    POPUP_HIDE_EVENT,
    POPUP_OPEN_EVENT,
    POPUP_SHOW_EVENT,
    popupPlacement,
    type PopupBubble,
} from "@/app/view/agents/attentionpopup";
import { useApplyCockpitTheme } from "@/app/view/agents/themestore";
import { BUBBLE_MS, BubbleCard } from "@/app/view/jarvis/bubblecard";
import { loadFonts } from "@/util/fontutil";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition, PhysicalSize, primaryMonitor } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./tailwind.css";

const MAIN_WINDOW_LABEL = "main";

function logFailure(what: string) {
    return (e: unknown) => console.error(`attention popup: ${what} failed`, e);
}

// sizes the window to the frame and puts the card in the primary screen's corner: the placement is the
// card's, so the frame's shadow room reaches past the work area's edges. The contract's placement is in
// logical pixels (its margin is), the window api here in physical ones.
async function placeWindow(frame: HTMLElement, card: HTMLElement): Promise<void> {
    const monitor = await primaryMonitor();
    if (monitor == null) {
        throw new Error("no primary monitor");
    }
    const scale = monitor.scaleFactor;
    const frameRect = frame.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const size = { width: Math.ceil(frameRect.width), height: Math.ceil(frameRect.height) };
    const { position, size: areaSize } = monitor.workArea;
    const spot = popupPlacement(
        {
            x: position.x / scale,
            y: position.y / scale,
            width: areaSize.width / scale,
            height: areaSize.height / scale,
        },
        { width: cardRect.width, height: cardRect.height }
    );
    const x = spot.x - (cardRect.left - frameRect.left);
    const y = spot.y - (cardRect.top - frameRect.top);
    const win = getCurrentWindow();
    await win.setSize(new PhysicalSize(Math.round(size.width * scale), Math.round(size.height * scale)));
    await win.setPosition(new PhysicalPosition(Math.round(x * scale), Math.round(y * scale)));
}

function Popup() {
    useApplyCockpitTheme();
    const [bubble, setBubble] = useState<PopupBubble | null>(null);
    const frame = useRef<HTMLDivElement>(null);

    // a hidden popup holds no card
    const hide = () => {
        setBubble(null);
        getCurrentWindow().hide().catch(logFailure("hide"));
    };

    useEffect(() => {
        const offShow = listen<PopupBubble>(POPUP_SHOW_EVENT, (e) => setBubble(e.payload));
        const offHide = listen(POPUP_HIDE_EVENT, hide);
        offShow.catch(logFailure("listen for show"));
        offHide.catch(logFailure("listen for hide"));
        return () => {
            offShow.then(
                (off) => off(),
                () => {}
            );
            offHide.then(
                (off) => off(),
                () => {}
            );
        };
    }, []);

    // keyed on the payload object, so a second show replaces the first and restarts the timer
    useEffect(() => {
        const card = frame.current?.firstElementChild;
        if (bubble == null || !(card instanceof HTMLElement)) {
            return;
        }
        let replaced = false;
        placeWindow(frame.current, card)
            .then(() => (replaced ? undefined : getCurrentWindow().show()))
            .catch(logFailure("show"));
        const t = setTimeout(hide, BUBBLE_MS);
        return () => {
            replaced = true;
            clearTimeout(t);
        };
    }, [bubble]);

    if (bubble == null) {
        return null;
    }
    const open = () => {
        emitTo(MAIN_WINDOW_LABEL, POPUP_OPEN_EVENT, { key: bubble.key }).catch(logFailure("open"));
        hide();
    };
    return (
        // the padding is the window's room for the card's shadow
        <div ref={frame} className="w-fit p-6">
            <BubbleCard
                marker="attention-popup"
                label={bubble.label}
                dot="bg-accent"
                tone="text-muted"
                name={bubble.name}
                text={bubble.text}
                more={bubble.more}
                onClick={open}
            />
        </div>
    );
}

loadFonts();
createRoot(document.getElementById("main")).render(<Popup />);
