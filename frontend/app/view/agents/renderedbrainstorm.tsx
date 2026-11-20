// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Rendered transcript's live brainstorm card: one card at the end of the transcript, the one renderedCard picks
// from the agent's brainstorm. A canvas with no brainstorm has its Mockup card on its reveal row instead, and a run has
// its Started run row. Each card kind is its own slice (renderedbs*.tsx); this host picks it, measures the column for
// the compact sizes, and fades a trade of cards. CardFrame is the shell every card draws in.

import { AutoHeight } from "@/app/element/autoheight";
import { MOTION, viewFade } from "@/app/element/motiontokens";
import { ViewSwap } from "@/app/element/viewswap";
import { useDimensionsWithCallbackRef } from "@/app/hook/useDimensions";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { ArrowUpRight, Lightbulb } from "lucide-react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { createContext, useContext, type ReactNode } from "react";
import { usePaneShown } from "./agentpanes";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { builderCheckView, type BrainstormFile } from "./brainstormmodel";
import { brainstormAtom, openBrainstormAt, shownBrainstormFile, type BrainstormState } from "./brainstormstore";
import { SMALL_DOT } from "./brainstormui";
import {
    cardStatus,
    COMPACT_CARD_PX,
    renderedCard,
    type CardProps,
    type RenderedCard,
} from "./renderedbrainstormmodel";
import { CheckCard } from "./renderedbscheck";
import { DesignCard } from "./renderedbsdesign";
import { QuestionCard } from "./renderedbsquestion";
import { ReviewCard } from "./renderedbsreview";
import { GoneCard } from "./renderedbsrun";

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

// true while the Brainstorm tab is on screen (agentpanes.ts's shownPane, the rule its digit keys use): the tab already
// shows what the card would, so each card draws only CardFrame's one row
const CardRowContext = createContext(false);

export function useCardRow(): boolean {
    return useContext(CardRowContext);
}

// a header icon's size, as the boards draw it wide and narrow
export function headIconSize(compact: boolean): number {
    return compact ? 14 : 15;
}

// the boards' .head: icon, kind and subject; children are the rest of the row (chip, gap, status, links). Compact,
// the row may wrap, so a header can put its trailing pieces on a second line
export function CardHead(p: {
    icon: ReactNode;
    kind: string;
    subject: ReactNode;
    mono?: boolean;
    compact: boolean;
    children?: ReactNode;
}) {
    return (
        <div
            data-rendered-bs-head
            className={cn(
                "flex min-w-0 items-center gap-x-[10px]",
                p.compact ? "flex-wrap gap-y-1.5 px-[14px] py-[10px] text-[12.5px]" : "px-4 py-[11px] text-[13.5px]"
            )}
        >
            <span className="inline-flex flex-none text-ink-mid">{p.icon}</span>
            <span className="whitespace-nowrap text-ink-mid">{p.kind}</span>
            {/* the status gives way first (it truncates); a long subject still truncates at half the row */}
            <span
                data-rendered-bs-subject
                className={cn(
                    "max-w-[50%] shrink-0 truncate font-semibold text-primary",
                    p.mono && (p.compact ? "font-mono text-[12px]" : "font-mono text-[12.5px]")
                )}
            >
                {p.subject}
            </span>
            {p.children}
        </div>
    );
}

// wide, the row runs chip, gap, status, link; compact, the link ends the first line and the chip and status take
// the second (Narrow)
function HeadTail({
    chip,
    status,
    link,
    compact,
}: {
    chip: ReactNode;
    status: ReactNode;
    link: ReactNode;
    compact: boolean;
}) {
    if (!compact) {
        return (
            <>
                {chip}
                <span className="flex-1" />
                {status}
                {link}
            </>
        );
    }
    return (
        <>
            <span className="flex-1" />
            {link}
            {chip || status ? (
                <div className="flex min-w-0 basis-full items-center gap-[10px]">
                    {chip}
                    {status}
                </div>
            ) : null}
        </>
    );
}

const NEEDS_INPUT = "Needs your input";

export function CardFrame(p: {
    agent: AgentVM;
    s: BrainstormState;
    f: BrainstormFile | null;
    // the warning border and the chip
    asking: boolean;
    chip?: string;
    tone?: "error";
    icon?: ReactNode;
    kind?: string;
    subject?: ReactNode;
    // "" for none
    status?: ReactNode;
    // null for none
    link?: ReactNode | null;
    // the one-row card's status words
    title: string;
    compact: boolean;
    attr: string;
    children?: ReactNode;
}) {
    const row = useCardRow();
    const open = (
        <button
            type="button"
            data-rendered-bs-open
            onClick={() => openBrainstormAt(p.agent.id, {})}
            className="inline-flex flex-none cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0 text-[12px] text-accent-soft hover:underline"
        >
            Open brainstorm
            <ArrowUpRight size={11} strokeWidth={2.2} aria-hidden />
        </button>
    );
    const chip = p.asking ? (
        <span
            data-rendered-bs-chip
            className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full bg-warning/12 py-0.5 pl-2 pr-[9px] text-[12px] font-semibold text-warning"
        >
            <span className={cn(SMALL_DOT, "bg-warning")} />
            {p.chip ?? NEEDS_INPUT}
        </span>
    ) : null;
    const lightbulb = <Lightbulb size={headIconSize(p.compact)} strokeWidth={2} aria-hidden />;
    const status = row ? p.title : (p.status ?? (p.f != null ? cardStatus(p.f) : ""));
    // the one row is the Brainstorm header whatever the card's own kind: the tab beside it shows the rest
    const head = (
        <CardHead
            icon={row ? lightbulb : (p.icon ?? lightbulb)}
            kind={row ? "Brainstorm" : (p.kind ?? "Brainstorm")}
            subject={row || p.subject == null ? p.s.topic : p.subject}
            mono={row || p.subject == null}
            compact={p.compact}
        >
            <HeadTail
                chip={chip}
                status={
                    status ? (
                        <span
                            {...{ [row ? "data-rendered-bs-row-title" : "data-rendered-bs-status"]: "" }}
                            className="min-w-0 truncate text-[12px] text-muted"
                        >
                            {status}
                        </span>
                    ) : null
                }
                link={row || p.link === undefined ? open : p.link}
                compact={p.compact}
            />
        </CardHead>
    );
    return (
        <div className="flex flex-col" {...{ [p.attr]: "" }}>
            <div
                data-rendered-bs-frame
                data-rendered-bs-row={row ? "" : undefined}
                className={cn(
                    "flex flex-col overflow-hidden rounded-[10px] border bg-surface",
                    p.tone === "error" ? "border-error/45" : p.asking ? "border-warning/45" : "border-edge-mid"
                )}
            >
                {head}
                {!row && p.children != null ? (
                    <div
                        data-rendered-bs-body
                        className={cn(
                            "flex flex-col gap-3 border-t border-edge-faint",
                            p.compact ? "px-[14px] pb-[14px] pt-3" : "px-4 pb-4 pt-[14px]"
                        )}
                    >
                        {p.children}
                    </div>
                ) : null}
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
        default:
            return null;
    }
}

export function RenderedBrainstorm({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const s = useAtomValue(brainstormAtom(agent.id));
    const [measure, , rect] = useDimensionsWithCallbackRef<HTMLDivElement>();
    const compact = rect != null && rect.width < COMPACT_CARD_PX;
    const row = usePaneShown(model, agent.id) === "brainstorm";
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
            data-rendered-bs-card={card.kind}
            data-compact={compact ? "" : undefined}
            className="flex w-full flex-col"
        >
            <AnimatePresence initial={false}>
                {s != null && card.kind !== "none" ? (
                    <motion.div
                        key="card"
                        variants={CARD_FADE}
                        initial="initial"
                        animate="animate"
                        exit="exit"
                        className="mt-1 pb-2"
                    >
                        {/* a swap (the card folding to its row as the pane opens) changes its height: followed, so the
                            feed above slides with it rather than jumping the reader by the difference */}
                        <AutoHeight>
                            <ViewSwap swapKey={`${cardKey(card, f)}${row ? ":row" : ""}`}>
                                <CardRowContext.Provider value={row}>
                                    <CardBody card={card} p={props} agent={agent} s={s} compact={compact} />
                                </CardRowContext.Provider>
                            </ViewSwap>
                        </AutoHeight>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}
