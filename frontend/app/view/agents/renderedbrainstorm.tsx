// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered transcript's live brainstorm card: one card at the end of the transcript, the one renderedCard picks
// from the agent's brainstorm, or the standalone Mockup card for an agent with a canvas and no brainstorm. Each card
// kind is its own slice (renderedbs*.tsx); this host picks it, measures the column for the compact sizes, and fades a
// trade of cards. CardFrame is the shell every card draws in.

import { MOTION, viewFade } from "@/app/element/motiontokens";
import { ViewSwap } from "@/app/element/viewswap";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight } from "lucide-react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { builderCheckView, type BrainstormFile } from "./brainstormmodel";
import { brainstormAtom, openBrainstormAt, shownBrainstormFile, type BrainstormState } from "./brainstormstore";
import {
    cardStatus,
    COMPACT_CARD_PX,
    renderedCard,
    type CardProps,
    type RenderedCard,
} from "./renderedbrainstormmodel";
import { MockupCard } from "./renderedbsboards";
import { CheckCard } from "./renderedbscheck";
import { DesignCard } from "./renderedbsdesign";
import { QuestionCard } from "./renderedbsquestion";
import { ReviewCard } from "./renderedbsreview";
import { GoneCard, RunCard } from "./renderedbsrun";

// the card arriving or trading fades as ViewSwap does; leaving while the agent works, it fades out
const CARD_FADE: Variants = {
    ...viewFade,
    exit: { opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } },
};

// the label over a card that asks, as over the agent's own question (AskCard)
export function NeedsInputPill() {
    return (
        <div
            data-needs-input
            className="mb-3 inline-flex items-center gap-[7px] self-start rounded-full bg-warning/12 py-[3px] pl-1.5 pr-2.5 text-[12.5px] font-semibold text-warning"
        >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <circle cx="7" cy="7" r="5.5" fill="none" strokeWidth="1.5" className="stroke-warning" />
                <circle cx="7" cy="7" r="2.6" className="fill-warning" />
            </svg>
            Needs your input
        </div>
    );
}

export function CardFrame(p: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile | null;
    asking: boolean;
    head: ReactNode;
    status?: string;
    compact: boolean;
    attr: string;
    children: ReactNode;
}) {
    const status = p.status ?? (p.f != null ? cardStatus(p.f) : "");
    return (
        <div className="flex flex-col" {...{ [p.attr]: "" }}>
            {p.asking ? <NeedsInputPill /> : null}
            <div
                data-rendered-bs-frame
                className={cn(
                    "flex flex-col rounded-[10px] border bg-surface",
                    p.compact ? "gap-3 px-[14px] py-3" : "gap-[14px] px-[18px] py-4",
                    p.asking ? "border-warning/45" : "border-edge-mid"
                )}
            >
                <div
                    data-rendered-bs-head
                    className={cn(
                        "flex min-w-0 items-center gap-x-[10px] gap-y-1",
                        p.compact ? "flex-wrap text-[12px]" : "text-[12.5px]",
                        p.asking ? "text-warning" : "text-ink-mid"
                    )}
                >
                    <span className="whitespace-nowrap font-mono font-semibold">Brainstorm ·</span>
                    {p.head}
                    <span className="flex-1" />
                    {status ? (
                        <span data-rendered-bs-status className="whitespace-nowrap text-[12px] text-muted">
                            {status}
                        </span>
                    ) : null}
                    <button
                        type="button"
                        data-rendered-bs-open
                        onClick={() => openBrainstormAt(p.agent.id, {})}
                        className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[12px] text-accent-soft hover:underline"
                    >
                        Open brainstorm
                        <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
                    </button>
                </div>
                {p.children}
            </div>
        </div>
    );
}

// a trade of question numbers is a new card as much as a trade of kinds
function cardKey(card: RenderedCard, f: BrainstormFile | null): string {
    return card.kind === "question" ? `question:${f?.question?.n ?? ""}` : card.kind;
}

// p is null while no file has been read: only the gone card draws then
function CardBody({
    card,
    p,
    agent,
    s,
    compact,
}: {
    card: RenderedCard;
    p: CardProps | null;
    agent: AgentVM;
    s: BrainstormState;
    compact: boolean;
}) {
    if (card.kind === "gone") {
        return <GoneCard agent={agent} s={s} why={card.why} compact={compact} />;
    }
    if (p == null) {
        return null;
    }
    switch (card.kind) {
        case "question":
            return <QuestionCard {...p} judging={card.judging} />;
        case "design":
            return <DesignCard {...p} />;
        case "check":
            return <CheckCard {...p} />;
        case "review":
            return <ReviewCard {...p} />;
        case "run":
            return <RunCard {...p} />;
        default:
            return null;
    }
}

export function RenderedBrainstorm({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const s = useAtomValue(brainstormAtom(agent.id));
    const [measure, , rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const compact = rect != null && rect.width < COMPACT_CARD_PX;
    const check =
        s != null
            ? builderCheckView(
                  agent.builderCheck,
                  s.sentCheckAt,
                  s.file,
                  s.modifiedMs,
                  agent,
                  s.turnStartMs,
                  s.checkTakenTs
              )
            : null;
    const card: RenderedCard = s != null && check != null ? renderedCard(s, check) : { kind: "none" };
    const f = shownBrainstormFile(s);
    const props: CardProps | null = s != null && f != null ? { model, agent, s, f, compact } : null;
    return (
        <div
            ref={measure}
            data-rendered-brainstorm
            data-rendered-bs-card={s == null ? "mockup" : card.kind}
            data-compact={compact ? "" : undefined}
            className="flex w-full flex-col"
        >
            {s == null ? (
                <MockupCard model={model} agent={agent} compact={compact} />
            ) : (
                <AnimatePresence initial={false}>
                    {card.kind !== "none" ? (
                        <motion.div
                            key="card"
                            variants={CARD_FADE}
                            initial="initial"
                            animate="animate"
                            exit="exit"
                            className="mt-1 pb-2"
                        >
                            <ViewSwap swapKey={cardKey(card, f)}>
                                <CardBody card={card} p={props} agent={agent} s={s} compact={compact} />
                            </ViewSwap>
                        </motion.div>
                    ) : null}
                </AnimatePresence>
            )}
        </div>
    );
}
