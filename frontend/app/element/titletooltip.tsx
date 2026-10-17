// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Every title attribute in the app shows in the one tooltip look instead of the OS's grey box. The browser draws
// its own tooltip for any element with a title under the mouse, and only the attribute's absence stops it, so the
// host parks the title in a data attribute while the pointer rests on its element and puts it back on leave.
// Keyboard focus never draws the native one, so focus shows ours and leaves the title where a screen reader reads it.

import { cn } from "@/util/util";
import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating } from "@floating-ui/react";
import { useEffect, useLayoutEffect, useState } from "react";
import { TOOLTIP_SURFACE } from "./tooltip";

const OPEN_DELAY_MS = 300; // the Tooltip primitive's default
const PARKED_ATTR = "data-arc-title";
// these manage their own title attributes, and moving one aside would fight the library that owns it
const SKIP_INSIDE = ".monaco-editor, .xterm";

function titledFrom(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) {
        return null;
    }
    const el = target.closest<HTMLElement>(`[title]:not([title=""]), [${PARKED_ATTR}]`);
    return el == null || el.closest(SKIP_INSIDE) != null ? null : el;
}

function textOf(el: HTMLElement): string {
    return el.getAttribute("title") || el.getAttribute(PARKED_ATTR) || "";
}

export function TitleTooltipHost() {
    const [tip, setTip] = useState<{ el: HTMLElement; text: string } | null>(null);
    const { refs, floatingStyles } = useFloating({
        open: tip != null,
        placement: "top",
        middleware: [offset(8), flip(), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });

    useLayoutEffect(() => {
        refs.setReference(tip?.el ?? null);
    }, [tip, refs]);

    useEffect(() => {
        let parked: HTMLElement | null = null;
        let timer: number | undefined;
        // React re-sets a title whose prop changed while it was parked: park the new value and show it
        const observer = new MutationObserver(() => {
            const fresh = parked?.getAttribute("title");
            if (parked == null || !fresh) {
                return;
            }
            parked.setAttribute(PARKED_ATTR, fresh);
            parked.removeAttribute("title");
            setTip((t) => (t?.el === parked ? { el: parked, text: fresh } : t));
        });

        const hide = () => {
            window.clearTimeout(timer);
            setTip(null);
        };
        const showAfterDelay = (el: HTMLElement) => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                const text = textOf(el);
                if (el.isConnected && text) {
                    setTip({ el, text });
                }
            }, OPEN_DELAY_MS);
        };
        const park = (el: HTMLElement) => {
            const title = el.getAttribute("title");
            if (title) {
                el.setAttribute(PARKED_ATTR, title);
                el.removeAttribute("title");
            }
            parked = el;
            observer.observe(el, { attributes: true, attributeFilter: ["title"] });
        };
        const unpark = () => {
            observer.disconnect();
            if (parked == null) {
                return;
            }
            const title = parked.getAttribute(PARKED_ATTR);
            parked.removeAttribute(PARKED_ATTR);
            if (title != null && !parked.hasAttribute("title")) {
                parked.setAttribute("title", title);
            }
            parked = null;
        };

        const onPointerOver = (e: PointerEvent) => {
            if (e.pointerType === "touch") {
                return;
            }
            const el = titledFrom(e.target);
            if (el != null && el === parked) {
                return;
            }
            unpark();
            hide();
            if (el != null) {
                park(el);
                showAfterDelay(el);
            }
        };
        const onPointerOut = (e: PointerEvent) => {
            // the pointer left the window: no pointerover follows to move the tip on
            if (e.relatedTarget == null) {
                unpark();
                hide();
            }
        };
        const onFocusIn = (e: FocusEvent) => {
            const el = titledFrom(e.target);
            if (el != null && el === e.target && el.matches(":focus-visible")) {
                showAfterDelay(el);
            }
        };
        const onFocusOut = () => {
            if (parked == null) {
                hide();
            }
        };
        const onBlur = () => {
            unpark();
            hide();
        };

        document.addEventListener("pointerover", onPointerOver, true);
        document.addEventListener("pointerout", onPointerOut, true);
        // a press or a key is the user acting on what the tip named, as with the native one
        document.addEventListener("pointerdown", hide, true);
        document.addEventListener("keydown", hide, true);
        document.addEventListener("focusin", onFocusIn);
        document.addEventListener("focusout", onFocusOut);
        window.addEventListener("blur", onBlur);
        return () => {
            document.removeEventListener("pointerover", onPointerOver, true);
            document.removeEventListener("pointerout", onPointerOut, true);
            document.removeEventListener("pointerdown", hide, true);
            document.removeEventListener("keydown", hide, true);
            document.removeEventListener("focusin", onFocusIn);
            document.removeEventListener("focusout", onFocusOut);
            window.removeEventListener("blur", onBlur);
            window.clearTimeout(timer);
            unpark();
        };
    }, []);

    if (tip == null) {
        return null;
    }
    return (
        <FloatingPortal>
            <div
                ref={refs.setFloating}
                style={floatingStyles}
                data-tooltip=""
                data-title-tooltip=""
                // above modals (z-[70]): a title inside a dialog shows over it
                className={cn(
                    TOOLTIP_SURFACE,
                    "pointer-events-none z-[90] max-w-[min(420px,calc(100vw-16px))] whitespace-pre-line break-words"
                )}
            >
                {tip.text}
            </div>
        </FloatingPortal>
    );
}
