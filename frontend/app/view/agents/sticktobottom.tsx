// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared stick-to-bottom behavior for streaming NarrationTimeline feeds. Extracted from agentrow.tsx
// so the subagent interior and runs worker cards get the same auto-follow + jump-to-latest pill.

import { PopoverReveal } from "@/app/element/popoverreveal";
import { useLayoutEffect, useRef, useState } from "react";
import { followGlides, isNearBottom, stuckAfterScroll } from "./agentsviewmodel";

// the row at the top of the viewport: its place counted from the end of the feed's rows, which rows prepended above it
// do not move, and the offset of its top under the viewport's
interface RowPlace {
    fromEnd: number;
    offset: number;
}

function rowPlace(scroller: Element, rows: Element): RowPlace | null {
    const top = scroller.getBoundingClientRect().top;
    const kids = rows.children;
    for (let i = 0; i < kids.length; i++) {
        const box = kids[i].getBoundingClientRect();
        if (box.bottom > top) {
            return { fromEnd: kids.length - i, offset: box.top - top };
        }
    }
    return null;
}

function restoreRowPlace(scroller: HTMLElement, rows: Element, place: RowPlace): void {
    const row = rows.children[rows.children.length - place.fromEnd];
    if (row != null) {
        scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - place.offset;
    }
}

function reducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// A feed the host remounts (a new `mount`) has all new nodes, which the browser's scroll anchoring cannot follow, so
// the row that was at the top of the viewport is put back where it was. `rows` returns the element whose children are
// the feed's rows.
export interface HoldPlace {
    rows: () => Element | null | undefined;
    mount: unknown;
}

// A scroll region that sticks to the tail while the user is at the bottom, releases when they scroll
// up to read history, and re-sticks on jumpToBottom or on scrolling back down to the end; new content glides in
// while stuck. `entries` is the dependency that triggers the re-pin: pass the same array the feed renders.
// layout-effect (not effect) so the pin lands before paint — otherwise a taller feed paints at the old scrollTop
// then snaps down a frame later.
export function useStickToBottom(entries: unknown[], hold?: HoldPlace) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    // the reader's place while released from the tail, taken after each layout and scroll
    const placeRef = useRef<RowPlace | null>(null);
    const mountRef = useRef(hold?.mount);
    // the first pin, and the first after a remount, lands at once: opening a feed must not glide through it
    const placedRef = useRef(false);
    const lastTopRef = useRef(0);
    const lastHeightRef = useRef(0);
    const [atBottom, setAtBottom] = useState(true);

    const remember = () => {
        const el = scrollRef.current;
        const rows = hold?.rows();
        placeRef.current = el != null && rows != null && !stickRef.current ? rowPlace(el, rows) : null;
    };

    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        if (mountRef.current !== hold?.mount) {
            mountRef.current = hold?.mount;
            placedRef.current = false;
            const rows = hold?.rows();
            if (!stickRef.current && rows != null && placeRef.current != null) {
                restoreRowPlace(el, rows, placeRef.current);
            }
        }
        const pin = () => {
            if (!stickRef.current) {
                return;
            }
            const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (placedRef.current && !reducedMotion() && followGlides(gap, el.clientHeight)) {
                el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            } else {
                el.scrollTop = el.scrollHeight;
            }
            placedRef.current = true;
            // a scroll up from here, even one coalesced with this pin's own event, still reads as up
            lastTopRef.current = el.scrollTop;
            lastHeightRef.current = el.scrollHeight;
        };
        pin();
        remember();
        // content that grows without a new entry (an opened composer, a reply that wraps) must not push
        // the tail of a stuck region out of view; nor may the region itself shrinking (a band docking under it)
        const ro = new ResizeObserver(pin);
        ro.observe(el);
        for (const child of el.children) {
            ro.observe(child);
        }
        return () => ro.disconnect();
    }, [entries, hold?.mount]);

    const onScroll = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        const near = isNearBottom(el);
        const top = el.scrollTop;
        const wentUp = top < lastTopRef.current;
        const resized = el.scrollHeight !== lastHeightRef.current;
        lastTopRef.current = top;
        lastHeightRef.current = el.scrollHeight;
        const stuck = stuckAfterScroll({ stuck: stickRef.current, near, wentUp, resized });
        stickRef.current = stuck;
        setAtBottom(stuck);
        remember();
    };

    const jumpToBottom = () => {
        const el = scrollRef.current;
        if (!el) {
            return;
        }
        stickRef.current = true;
        setAtBottom(true);
        lastTopRef.current = el.scrollTop;
        lastHeightRef.current = el.scrollHeight;
        if (reducedMotion() || isNearBottom(el)) {
            el.scrollTop = el.scrollHeight;
            return;
        }
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    };

    return { scrollRef, onScroll, atBottom, jumpToBottom };
}

// The jump-to-latest pill. Render inside a `relative` parent of the scroll region so it anchors to the
// viewport bottom and does not scroll with the feed. Stops click propagation (callers are often inside
// a clickable card). Render it unconditionally and pass `show`, so it can leave as it came.
export function JumpToLatestPill({ show, onClick }: { show: boolean; onClick: () => void }) {
    return (
        <PopoverReveal open={show} origin="bottom" className="absolute bottom-3.5 left-1/2 z-20 -translate-x-1/2">
            <button
                type="button"
                data-latest-pill
                onClick={(e) => {
                    e.stopPropagation();
                    onClick();
                }}
                title="Jump to latest"
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-edge-strong bg-surface-raised px-3 py-1.5 text-[12px] text-secondary shadow-popover-sm hover:border-accent hover:text-primary"
            >
                <span aria-hidden="true">↓</span>Latest
            </button>
        </PopoverReveal>
    );
}
