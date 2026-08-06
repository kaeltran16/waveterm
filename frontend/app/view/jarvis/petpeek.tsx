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
import { providerLabel } from "@/app/view/agents/cockpitrailmodel";
import { memPruneAtom } from "@/app/view/agents/memstore";
import { cn, fireAndForget } from "@/util/util";
import { autoUpdate, offset, shift, useFloating, type Placement } from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { useEffect, type ReactNode } from "react";
import { askAboutSource } from "./jarvissubjectstore";
import { openORef } from "./openref";
import { runAct } from "./petactrun";
import { actsForRecall, actsForVault, type PetAct } from "./petacts";
import { conditionLine, postureLine, type PetExpression, type PetPosture, type PetSignals } from "./petcondition";
import { recallLine } from "./petjoin";
import { petActStateAtom, petIndexAtom, petPeekOpenAtom, petSaidAtom, type PetCorner } from "./petstore";
import { ageLabel } from "./recallderive";

const PLACEMENT: Record<PetCorner, Placement> = {
    "bottom-right": "top-end",
    "bottom-left": "top-start",
};

const ORIGIN: Record<PetCorner, string> = {
    "bottom-right": "bottom right",
    "bottom-left": "bottom left",
};

const TONE: Record<PetExpression["kind"], string> = {
    "cannot-see": "text-error",
    tired: "text-warning",
    drifting: "text-muted",
    "at-rest": "text-accent-soft",
};

// A button per act, and the act's own outcome beside it. The outcome sits here rather than in a toast
// because a failure that appeared somewhere else would spend the attention this panel exists to earn
// (design §9).
function Acts({ model, acts }: { model: AgentsViewModel; acts: PetAct[] }) {
    const state = useAtomValue(petActStateAtom);
    if (acts.length === 0) {
        return null;
    }
    return (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {acts.map((a) => {
                const st = state[a.id];
                return (
                    <span key={a.id} className="flex items-center gap-1.5">
                        <button
                            type="button"
                            data-pet-act={a.id}
                            disabled={st?.status === "running"}
                            onClick={() => fireAndForget(() => runAct(model, a))}
                            className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-accent-soft hover:bg-surface-hover disabled:cursor-default disabled:text-muted"
                        >
                            {a.label}
                        </button>
                        {st?.text != null ? (
                            <span className={cn("text-[11px]", st.status === "error" ? "text-error" : "text-muted")}>
                                {st.text}
                            </span>
                        ) : null}
                    </span>
                );
            })}
        </div>
    );
}

// `model` and `acts` are both optional so a row with honestly nothing to do — the rate-limit countdown —
// stays exactly the readout it was, rather than growing an empty act strip.
function Row({
    label,
    value,
    dim,
    model,
    acts,
}: {
    label: string;
    value: string;
    dim?: boolean;
    model?: AgentsViewModel;
    acts?: PetAct[];
}) {
    return (
        <div className="flex items-baseline gap-2">
            <span className="w-[52px] flex-none font-mono text-[9.5px] font-semibold uppercase tracking-[.09em] text-muted">
                {label}
            </span>
            <div className="min-w-0 flex-1">
                <span className={cn("text-[11.5px] leading-[1.45]", dim ? "text-muted" : "text-secondary")}>
                    {value}
                </span>
                {acts != null && acts.length > 0 && model != null ? <Acts model={model} acts={acts} /> : null}
            </div>
        </div>
    );
}

function SectionLabel({ children }: { children: ReactNode }) {
    return <span className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">{children}</span>;
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
    const pruneCandidates = useAtomValue(memPruneAtom);
    // the raw status, not signals.index: the panel wants the reason and the drift count, which the narrowed
    // signal deliberately drops — and actsForRecall keys off the same reason to pick its verb
    const indexStatus = useAtomValue(petIndexAtom);
    const recall = recallLine(indexStatus);
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
                    className="w-[326px] rounded-[12px] border border-border bg-surface-raised p-[13px] shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
                >
                    {/* one container the CDP scenario can scope to: a document-wide button query picks up
                        the app bar's own buttons instead of the panel's acts */}
                    <div data-pet-peek="1" className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <span className="text-[13px] font-bold text-primary">Jarvis</span>
                            <span className={cn("font-mono text-[10.5px]", TONE[expression.kind])}>
                                {expression.kind}
                            </span>
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
                            <Row
                                label="Recall"
                                value={recall.text}
                                dim={recall.dim}
                                model={model}
                                acts={actsForRecall(indexStatus)}
                            />
                            <Row
                                label="Window"
                                value={
                                    rl == null
                                        ? "no reading"
                                        : rl.resetAt != null
                                          ? `${providerLabel(rl.provider)} · ${Math.round(rl.pct)}% used · back in ${formatReset(rl.resetAt, now)}`
                                          : `${providerLabel(rl.provider)} · ${Math.round(rl.pct)}% used`
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
                                model={model}
                                acts={actsForVault(pruneCandidates)}
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
                                            <span className="text-[11.5px] leading-[1.45] text-secondary">
                                                {e.text}
                                            </span>
                                            {/* only volunteered knowledge has somewhere to go; a housekeeping
                                                utterance must not grow a dead button. The pair lives here rather
                                                than on the bubble because the bubble auto-dismisses after six
                                                seconds, and a click target that vanishes mid-reach is a worse
                                                trap than no target (design §8 decision 3). */}
                                            {e.source != null ? (
                                                <div className="mt-1.5 flex gap-2">
                                                    <button
                                                        type="button"
                                                        className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-accent-soft hover:bg-surface-hover"
                                                        onClick={() => {
                                                            // close first: an overlay anchored to the creature
                                                            // left open over a surface it just navigated away
                                                            // from is stranded
                                                            close();
                                                            fireAndForget(() =>
                                                                openORef(model, e.source!.ref, e.source!.anchor)
                                                            );
                                                        }}
                                                    >
                                                        Open
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-accent-soft hover:bg-surface-hover"
                                                        onClick={() => {
                                                            close();
                                                            askAboutSource(
                                                                e.source!.ref,
                                                                e.source!.sourceType,
                                                                e.source!.title,
                                                                `Tell me more about "${e.source!.title}".`
                                                            );
                                                            globalStore.set(model.surfaceAtom, "jarvis");
                                                        }}
                                                    >
                                                        Ask
                                                    </button>
                                                </div>
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* demoted from a filled button: a bare navigation is the least meaningful thing on the
                            panel, and presenting it as the headline is what made every row above it a readout */}
                        <button
                            type="button"
                            onClick={openJarvis}
                            className="cursor-pointer self-start px-1.5 py-0.5 text-[11px] text-muted hover:text-primary"
                        >
                            Open Jarvis
                        </button>
                    </div>
                </PopoverReveal>
            </div>
        </>
    );
}
