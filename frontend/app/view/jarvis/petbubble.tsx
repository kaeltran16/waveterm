// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The creature's speech. One bubble, anchored to whichever corner the creature is sitting in, gone after
// a few seconds (design §4 decision 8): a bubble that persists until acknowledged is the thing you come
// to resent over a live terminal. Auto-dismiss loses nothing — the peek reads back everything it said,
// and the creature keeps an unread marker until you look.

import { PopoverReveal } from "@/app/element/popoverreveal";
import { autoUpdate, offset, shift, useFloating, type Placement } from "@floating-ui/react";
import { useEffect, useRef, useState } from "react";
import type { PetCorner } from "./petstore";
import type { PetEvent } from "./petvoice";

const BUBBLE_MS = 6_000;

// speak away from the edge the creature is pinned to, aligned with it
const PLACEMENT: Record<PetCorner, Placement> = {
    "bottom-right": "top-end",
    "bottom-left": "top-start",
};

const ORIGIN: Record<PetCorner, string> = {
    "bottom-right": "bottom right",
    "bottom-left": "bottom left",
};

// what register the utterance came from, in the design's own words
const KIND_LABEL: Record<PetEvent["kind"], string> = {
    resume: "Where we were",
    sweep: "While you were out",
    "distill-batch": "While you were out",
    "notes-written": "What I wrote down",
    "bg-agent-done": "While you were out",
};

export function PetBubble({
    event,
    anchor,
    corner,
    onOpen,
    onDismiss,
}: {
    event: PetEvent | null;
    anchor: HTMLElement | null;
    corner: PetCorner;
    onOpen: () => void;
    onDismiss: () => void;
}) {
    // the exit animation still needs something to draw after `event` clears, so the last utterance is
    // latched rather than read live
    const [said, setSaid] = useState<PetEvent | null>(null);
    useEffect(() => {
        if (event != null) {
            setSaid(event);
        }
    }, [event]);

    // held in a ref, not in the dep list: the creature re-renders on every nowAtom tick, and a callback
    // identity in the deps would restart this timer each second so the bubble never dismissed.
    const dismissRef = useRef(onDismiss);
    dismissRef.current = onDismiss;
    const id = event?.id;
    useEffect(() => {
        if (id == null) {
            return;
        }
        const t = setTimeout(() => dismissRef.current(), BUBBLE_MS);
        return () => clearTimeout(t);
    }, [id]);

    const { refs, floatingStyles } = useFloating({
        open: event != null,
        placement: PLACEMENT[corner],
        // fixed, like the creature it hangs off: the cockpit body clips its overflow, and an
        // absolutely-positioned bubble in a corner is exactly what that clip would cut in half
        strategy: "fixed",
        middleware: [offset(10), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    useEffect(() => {
        refs.setPositionReference(anchor);
    }, [anchor, refs]);

    return (
        <div ref={refs.setFloating} style={floatingStyles} className="z-[61]">
            {/* unconditional, driven by `open` — a `{open ? … : null}` caller defeats PopoverReveal's
                AnimatePresence and the exit never plays */}
            <PopoverReveal
                open={event != null}
                origin={ORIGIN[corner]}
                className="w-[268px] rounded-[11px] border border-border bg-surface-raised p-[11px] shadow-[0_12px_34px_rgba(0,0,0,0.5)]"
            >
                {said != null ? (
                    <button
                        type="button"
                        onClick={onOpen}
                        className="flex w-full cursor-pointer flex-col gap-1.5 text-left"
                    >
                        <span className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-accent-soft">
                            {KIND_LABEL[said.kind]}
                        </span>
                        <span className="text-[12px] leading-[1.45] text-secondary">{said.text}</span>
                    </button>
                ) : null}
            </PopoverReveal>
        </div>
    );
}
