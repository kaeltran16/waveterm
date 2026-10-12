// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The creature's speech. One bubble, anchored to whichever corner the creature is sitting in, gone after
// a few seconds (design §4 decision 8): a bubble that persists until acknowledged is the thing you come
// to resent over a live terminal. Auto-dismiss loses nothing — the peek reads back everything it said,
// and the creature keeps an unread marker until you look.

import { PopoverReveal } from "@/app/element/popoverreveal";
import type { AgentVM } from "@/app/view/agents/agentsviewmodel";
import { InlineMarkdown } from "@/app/view/agents/inlinemarkdown";
import { autoUpdate, offset, shift, useFloating, type Placement } from "@floating-ui/react";
import { useEffect, useRef, useState } from "react";
import { BUBBLE_MS, BubbleCard, BubbleLabel } from "./bubblecard";
import { bubbleAgent } from "./petjoin";
import type { PetCorner } from "./petstore";
import { eventLabel, type NotifyLevel, type PetEvent } from "./petvoice";

export { BUBBLE_MS };

// speak away from the edge the creature is pinned to, aligned with it
const PLACEMENT: Record<PetCorner, Placement> = {
    "bottom-right": "top-end",
    "bottom-left": "top-start",
};

const ORIGIN: Record<PetCorner, string> = {
    "bottom-right": "bottom right",
    "bottom-left": "bottom left",
};

// Only a notification's level and a question get a dot, because those are the ones asking for something.
// Accent stays reserved for things you can act on, so every other label reads muted.
const LEVEL_TONE: Record<NotifyLevel, { dot: string; label: string }> = {
    info: { dot: "bg-edge-strong", label: "text-muted" },
    warn: { dot: "bg-warning", label: "text-warning-soft" },
    error: { dot: "bg-error", label: "text-error-soft" },
};

export function eventTone(event: PetEvent): { dot: string | null; label: string } {
    if (event.kind === "notify") {
        return LEVEL_TONE[event.level ?? "info"];
    }
    return { dot: event.kind === "ask" ? "bg-accent" : null, label: "text-muted" };
}

// the register as a label: the dot (when the kind earns one) and the words, one grammar for bubble and peek
export function EventLabel({ event, className }: { event: PetEvent; className?: string }) {
    const tone = eventTone(event);
    return <BubbleLabel label={eventLabel(event)} dot={tone.dot} tone={tone.label} className={className} />;
}

export function PetBubble({
    event,
    agents,
    anchor,
    corner,
    onOpen,
    onDismiss,
}: {
    event: PetEvent | null;
    agents: ReadonlyArray<AgentVM>;
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
    const agent = bubbleAgent(said, agents);
    const tone = said != null ? eventTone(said) : null;

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
            <PopoverReveal open={event != null} origin={ORIGIN[corner]}>
                {said != null && tone != null ? (
                    <BubbleCard
                        marker="pet-bubble"
                        label={eventLabel(said)}
                        dot={tone.dot}
                        tone={tone.label}
                        name={agent?.name}
                        project={agent?.project}
                        // inline only, and links as plain text: the bubble is one button
                        text={<InlineMarkdown text={said.text} plainLinks />}
                        onClick={onOpen}
                    />
                ) : null}
            </PopoverReveal>
        </div>
    );
}
