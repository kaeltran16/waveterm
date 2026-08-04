// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The peek: what Jarvis's condition actually is, and everything it has said. Anchored to the creature
// rather than taking the screen, because the point of clicking the creature is to stay on the surface
// you were already on (design §4 decision 3).
//
// It reads the raw signals, not just the winning expression. The strict precedence in petcondition.ts
// shows one thing at a time on the creature's face, which is right for a glance and wrong for a panel —
// this is the one place where "the system knows a great deal it never says" gets answered in full, so a
// reading with no source yet says so instead of being omitted.
//
// Anchoring follows autonomyladderview.tsx; the Escape/outside-press dismissal follows graphpeek.tsx —
// explicit listeners rather than useDismiss, because the creature is only a POSITION reference here and
// floating-ui would read a click on it as an outside press.

import { PopoverReveal } from "@/app/element/popoverreveal";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatReset } from "@/app/view/agents/agentsviewmodel";
import { cn } from "@/util/util";
import { autoUpdate, offset, shift, useFloating, type Placement } from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { useEffect, type ReactNode } from "react";
import { conditionLine, postureLine, type PetExpression, type PetPosture, type PetSignals } from "./petcondition";
import { recallLine } from "./petjoin";
import { petIndexAtom, petPeekOpenAtom, petPocketAtom, petSaidAtom, type PetCorner } from "./petstore";
import { ageLabel } from "./recallderive";

const PLACEMENT: Record<PetCorner, Placement> = {
    "bottom-right": "top-end",
    "bottom-left": "top-start",
    "top-right": "bottom-end",
    "top-left": "bottom-start",
};

const ORIGIN: Record<PetCorner, string> = {
    "bottom-right": "bottom right",
    "bottom-left": "bottom left",
    "top-right": "top right",
    "top-left": "top left",
};

const TONE: Record<PetExpression["kind"], string> = {
    "cannot-see": "text-error",
    tired: "text-warning",
    drifting: "text-muted",
    "at-rest": "text-accent-soft",
};

function Row({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
    return (
        <div className="flex items-baseline gap-2">
            <span className="w-[52px] flex-none font-mono text-[9.5px] font-semibold uppercase tracking-[.09em] text-muted">
                {label}
            </span>
            <span className={cn("min-w-0 flex-1 text-[11.5px] leading-[1.45]", dim ? "text-muted" : "text-secondary")}>
                {value}
            </span>
        </div>
    );
}

function SectionLabel({ children }: { children: ReactNode }) {
    return (
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">{children}</span>
    );
}

export function PetPeek({
    model,
    anchor,
    corner,
    signals,
    expression,
    posture,
}: {
    model: AgentsViewModel;
    anchor: HTMLElement | null;
    corner: PetCorner;
    signals: PetSignals;
    expression: PetExpression;
    posture: PetPosture;
}) {
    const open = useAtomValue(petPeekOpenAtom);
    const said = useAtomValue(petSaidAtom);
    const pocket = useAtomValue(petPocketAtom);
    // the raw status, not signals.index: the panel wants the reason and the drift count, which the narrowed
    // signal deliberately drops
    const recall = recallLine(useAtomValue(petIndexAtom));
    const now = useAtomValue(model.nowAtom);
    const close = () => globalStore.set(petPeekOpenAtom, false);

    const { refs, floatingStyles } = useFloating({
        open,
        placement: PLACEMENT[corner],
        strategy: "fixed", // as in petbubble: the cockpit body clips its overflow
        middleware: [offset(12), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    useEffect(() => {
        refs.setPositionReference(anchor);
    }, [anchor, refs]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                globalStore.set(petPeekOpenAtom, false);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    const rl = signals.rateLimit;
    const decay = signals.decay;
    const openJarvis = () => {
        globalStore.set(model.surfaceAtom, "jarvis");
        close();
    };

    return (
        <>
            {/* the outside-press catcher, above the creature so clicking it closes rather than re-opens */}
            {open ? <div className="fixed inset-0 z-[64]" onClick={close} /> : null}
            <div ref={refs.setFloating} style={floatingStyles} className="z-[65]">
                <PopoverReveal
                    open={open}
                    origin={ORIGIN[corner]}
                    className="flex w-[326px] flex-col gap-3 rounded-[12px] border border-border bg-surface-raised p-[13px] shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
                >
                    <div className="flex items-center gap-2">
                        <span className="text-[13px] font-bold text-primary">Jarvis</span>
                        <span className={cn("font-mono text-[10.5px]", TONE[expression.kind])}>{expression.kind}</span>
                        <div className="flex-1" />
                        <button
                            type="button"
                            onClick={close}
                            className="cursor-pointer rounded-[6px] border border-border px-2 py-0.5 font-mono text-[10px] text-muted hover:text-primary"
                        >
                            Esc
                        </button>
                    </div>

                    <p className={cn("text-[12.5px] font-semibold leading-[1.4]", TONE[expression.kind])}>
                        {conditionLine(expression, now)}
                    </p>

                    <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
                        {/* absent rather than omitted: "not read yet" is itself something the system knows
                            and never said, which is the whole argument for the creature (design §1). The
                            reason, not just the state — that is the diagnostic half (design §3). */}
                        <Row label="Recall" value={recall.text} dim={recall.dim} />
                        <Row
                            label="Window"
                            value={
                                rl == null
                                    ? "no reading"
                                    : rl.resetAt != null
                                      ? `${Math.round(rl.pct)}% used · back in ${formatReset(rl.resetAt, now)}`
                                      : `${Math.round(rl.pct)}% used`
                            }
                            dim={rl == null}
                        />
                        <Row
                            label="Vault"
                            value={
                                decay == null
                                    ? "no reading"
                                    : decay.queueDepth === 0
                                      ? "clear"
                                      : `${decay.queueDepth} queued for cleanup · ${decay.staleNotes} stale`
                            }
                            dim={decay == null || decay.queueDepth === 0}
                        />
                        <Row
                            label="Waiting"
                            value={posture === "none" ? "nothing waiting" : postureLine(posture)}
                            dim={posture === "none"}
                        />
                    </div>

                    <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                        <SectionLabel>What I've said</SectionLabel>
                        {said.length === 0 ? (
                            <span className="text-[11.5px] text-muted">Nothing yet.</span>
                        ) : (
                            <div className="flex max-h-[168px] flex-col gap-2 overflow-y-auto">
                                {said.map((e) => (
                                    <div key={e.id} className="flex flex-col gap-0.5">
                                        <span className="font-mono text-[9.5px] text-muted">
                                            {e.kind} · {ageLabel(Math.max(0, now - e.at))}
                                        </span>
                                        <span className="text-[11.5px] leading-[1.45] text-secondary">{e.text}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* absent when empty — a section drawn with nothing in it is worse than no section */}
                    {pocket.length > 0 ? (
                        <div className="flex flex-col gap-2 border-t border-border pt-2.5">
                            <SectionLabel>Pocket</SectionLabel>
                            {pocket.map((item) => (
                                <div key={item.id} className="flex items-center gap-2">
                                    <span className="flex-none font-mono text-[9.5px] text-muted">{item.kind}</span>
                                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-secondary">
                                        {item.label}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : null}

                    <button
                        type="button"
                        onClick={openJarvis}
                        className="w-full cursor-pointer rounded-[8px] bg-accent px-2 py-2 text-[11.5px] font-bold text-background hover:bg-accenthover"
                    >
                        Open Jarvis
                    </button>
                </PopoverReveal>
            </div>
        </>
    );
}
