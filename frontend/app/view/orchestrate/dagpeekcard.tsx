// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The selected node's peek: a card floating beside the node inside the graph pane, so opening, growing or
// closing it never resizes the pane under the graph. The task and final-stage bodies fill it.

import { cn } from "@/util/util";
import { autoUpdate, useFloating } from "@floating-ui/react";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode, type SyntheticEvent } from "react";
import type { RunEventsStatus } from "../agents/runeventstore";
import type { GlyphKind } from "./dagcanvas";
import type { Rect } from "./daglayout";
import { StateGlyph } from "./dagnodes";
import { PEEK_PLACEMENT, PEEK_W_PX, peekMiddleware } from "./dagpeek";
import { eventsCountText, type LifecycleRow } from "./peeklifecycle";

export type PeekPlace = {
    anchor: HTMLElement;
    boundary: HTMLElement;
    rightInsetPx: number;
    onClose: () => void;
    onPlaced?: (card: Rect) => void;
};

const BTN = "cursor-pointer rounded-[8px] border px-3 py-[5px] text-[12.5px] font-semibold";
export const PEEK_BTN = `${BTN} border-edge-mid bg-transparent text-secondary hover:border-edge-strong hover:text-primary`;
export const PEEK_BTN_PRIMARY = `${BTN} border-accent bg-accent text-background hover:bg-accenthover`;
export const PEEK_BTN_ACCENT = `${BTN} border-edge-mid bg-transparent text-accent-soft hover:border-edge-strong`;
export const PEEK_BTN_ACCENT_OPEN = `${BTN} border-accent/50 bg-accent/12 text-accent-soft`;

// ReactFlow pans and zooms with a CSS transform, which none of autoUpdate's scroll or resize observers see
function followAnchor(reference: HTMLElement, floating: HTMLElement, update: () => void) {
    return autoUpdate(reference, floating, update, { animationFrame: true });
}

// the graph's pane clears the selection on a click, and a node drag starts on a pointer-down
const keepInside = (e: SyntheticEvent) => e.stopPropagation();

export function DagPeekCard({
    place,
    attrs,
    label,
    closeLabel,
    glyph,
    title,
    meta,
    children,
    panel,
    actions,
    hint,
}: {
    place: PeekPlace;
    attrs: Record<string, string>;
    label: string;
    closeLabel: string;
    glyph: GlyphKind;
    title: ReactNode;
    meta: ReactNode;
    children: ReactNode;
    panel?: ReactNode;
    actions?: ReactNode;
    hint: string;
}) {
    const { refs, elements, floatingStyles, isPositioned, middlewareData } = useFloating({
        open: true,
        elements: { reference: place.anchor },
        placement: PEEK_PLACEMENT,
        strategy: "absolute",
        middleware: peekMiddleware(place.boundary, place.rightInsetPx),
        whileElementsMounted: followAnchor,
    });

    const placedFor = useRef<HTMLElement | null>(null);
    useEffect(() => {
        const card = elements.floating;
        if (!isPositioned || card == null || placedFor.current === place.anchor) return;
        placedFor.current = place.anchor;
        const r = card.getBoundingClientRect();
        const pane = place.boundary.getBoundingClientRect();
        place.onPlaced?.({ x: r.left - pane.left, y: r.top - pane.top, w: r.width, h: r.height });
    }, [isPositioned, place.anchor]);

    const hidden = !isPositioned || middlewareData.hide?.referenceHidden;
    return (
        // floating-ui measures the section, so it renders before it is placed: invisible, and without the data
        // attribute that names it, so nothing finds a card still sitting at 0,0
        <section
            ref={refs.setFloating}
            {...(isPositioned ? attrs : {})}
            aria-label={label}
            onClick={keepInside}
            onPointerDown={keepInside}
            style={{ ...floatingStyles, width: PEEK_W_PX, visibility: hidden ? "hidden" : undefined }}
            className="z-[6] flex flex-col overflow-hidden rounded-[9px] border border-edge-strong bg-surface-raised shadow-popover-lg"
        >
            <div className="flex flex-none items-start gap-2.5 border-b border-edge-mid pb-2.5 pl-[13px] pr-2 pt-[11px]">
                <div className="mt-0.5 flex-none">
                    <StateGlyph kind={glyph} />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <div className="text-[15px] font-semibold leading-5 text-ink-hi">{title}</div>
                    <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-[12px] text-ink-mid">
                        {meta}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={place.onClose}
                    aria-label={closeLabel}
                    className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-[6px] text-ink-mid hover:text-secondary"
                >
                    <X size={13} aria-hidden />
                </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto pb-3.5 pl-[13px] pr-[13px] pt-3">
                {children}
            </div>
            {panel != null ? <div className="flex flex-none flex-col">{panel}</div> : null}
            <div className="flex flex-none items-center gap-1.5 border-t border-edge-mid bg-surface px-[13px] py-2">
                {actions}
                <span className="flex-1" />
                <span className="text-[12px] text-ink-mid">{hint}</span>
            </div>
        </section>
    );
}

// PeekLifecycle is a popup's history: one flat row per event, newest first, from peeklifecycle.ts. An attention
// row is amber with a ringed dot; every other dot takes the rail's tone.
export function PeekLifecycle({
    rows,
    status,
    emptyText,
}: {
    rows: LifecycleRow[];
    status: RunEventsStatus;
    emptyText: string;
}) {
    let empty = emptyText;
    if (status === "loading") {
        empty = "Loading…";
    } else if (status === "error") {
        empty = "History unavailable";
    }
    return (
        <section data-dag-peek-lifecycle className="flex flex-col">
            <div className="flex items-baseline gap-2 border-b border-edge-faint pb-1.5">
                <span className="text-[13px] font-bold text-ink-hi">Lifecycle</span>
                {status === "live" ? (
                    <span data-dag-peek-lifecycle-count className="text-[12px] text-ink-mid">
                        {eventsCountText(rows.length)}
                    </span>
                ) : null}
            </div>
            {rows.length === 0 ? (
                <div data-dag-peek-lifecycle-empty className="py-2 text-[12.5px] text-ink-mid">
                    {empty}
                </div>
            ) : (
                rows.map((r) => (
                    <div
                        key={r.id}
                        data-dag-peek-lifecycle-row={r.attention ? "attention" : ""}
                        className="grid grid-cols-[40px_8px_minmax(0,1fr)] gap-x-2.5 border-b border-edge-faint py-2"
                    >
                        <span className="font-mono text-[11.5px] leading-[18px] text-ink-mid">{r.time}</span>
                        <span
                            aria-hidden
                            className={cn(
                                "mt-[5px] size-2 rounded-full",
                                r.attention ? "border-2 border-warning" : cn("bg-current", r.tone)
                            )}
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                            <span
                                className={cn(
                                    "truncate text-[13px] font-semibold leading-[18px]",
                                    r.attention ? "text-warning" : "text-ink-hi"
                                )}
                            >
                                {r.title}
                            </span>
                            {r.detail ? (
                                <span className="line-clamp-3 whitespace-pre-line break-words text-[12px] leading-[17px] text-ink-mid">
                                    {r.detail}
                                </span>
                            ) : null}
                        </span>
                    </div>
                ))
            )}
        </section>
    );
}
