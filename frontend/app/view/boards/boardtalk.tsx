// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// A board's talk column (boards B1, B4-B7, B11, A2, W2): About, the turns and the ask box, on the Boards surface and
// in the agent's workspace tab expanded. A turn is drawn or sent to the board's agent, and each of yours can go the
// other way. Thin render: the items and the ask box's words come from boardtalkmodel.ts, and every action is the
// caller's. The workspace tab passes no ask: its ask bar sits under the canvas.

import { useChangeFlash } from "@/app/element/motionhooks";
import { cardVariants, changeFlashClass, settleClass } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { CircleAlert, Shapes, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AgentChoiceList, RuntimeDot } from "./boardagentpicker";
import type { AgentChoice, AskState, TalkItem } from "./boardtalkmodel";

export { RuntimeDot };

const SMALL_BTN =
    "cursor-pointer rounded-md border border-edge-mid bg-surface-raised px-[9px] py-[3px] text-[12px] font-semibold text-secondary hover:border-edge-strong hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const PRIMARY_BTN =
    "cursor-pointer rounded-lg border-0 bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-background hover:bg-accenthover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const SECONDARY_BTN =
    "cursor-pointer rounded-lg border border-edge-mid bg-surface-raised px-3 py-1.5 text-[12.5px] font-semibold text-secondary hover:border-edge-strong hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const ERROR_BTN =
    "cursor-pointer rounded-md border border-error/40 bg-transparent px-2.5 py-[3px] text-[12px] font-semibold text-error-soft hover:bg-error/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
// Ask and the Stop that takes its place while an answer runs share a size, so the box doesn't shift between them
const SEND_BTN =
    "inline-flex min-w-18 items-center justify-center gap-1.5 rounded-lg border-0 px-3.5 py-1.5 text-[12.5px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
// Send to the agent, Draw instead, Open agent: quiet text actions under a turn
export const TEXT_BTN =
    "cursor-pointer rounded border-0 bg-transparent p-0 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const REROUTE_LABEL = { agent: "Send to the agent", draw: "Draw instead" } as const;
// the briefing's sender is "<runtime> · <project>", so its first word names the runtime's dot
const FROM_SEPARATOR = " · ";

export interface BoardTalkProps {
    about: string; // the About chip's title: "the waveterm code", "claude · waveterm"
    items: TalkItem[];
    ask?: AskState; // the ask box under the turns; none where the caller asks elsewhere
    shownTurnId: string | null; // whose Show is on
    onAsk: (question: string) => void; // Enter asks, Shift Enter new line; empty does nothing
    onShow: (turnId: string, shapeIds: string[]) => void;
    onStop: () => void;
    onRetry: (turnId: string) => void;
    onChoice: (turnId: string, choice: "keep" | "new") => void;
    onReroute: (turnId: string) => void; // send the other way
    onOpenAgent: (tabId: string) => void;
    onBack?: () => void; // Back to the transcript, where the talk is expanded over it
    // a turn that needs an agent: the project's live claude and pi agents, picking one, or starting one
    agentChoices: AgentChoice[];
    project: string;
    onPickAgent: (tabId: string) => void;
    onStartAgent: () => void;
}

export function AboutChip({ title, className }: { title: string; className?: string }) {
    return (
        <span
            data-board-about
            className={cn(
                "inline-flex min-w-0 items-center gap-1.5 rounded-md border border-edge-mid bg-surface-raised px-2 py-[3px] text-[12px] text-secondary",
                className
            )}
        >
            <span className="text-muted">About</span>
            <span className="truncate">{title}</span>
        </span>
    );
}

function Question({ item }: { item: Extract<TalkItem, { kind: "question" }> }) {
    return (
        <div className="flex max-w-[85%] flex-col items-end gap-1 self-end">
            <div className="whitespace-pre-wrap rounded-xl bg-surface-selected px-3 py-2 text-primary">{item.text}</div>
            {item.on ? (
                <span className="text-[11.5px] text-muted">
                    on <span className="font-mono text-ink-mid">{item.on}</span>
                </span>
            ) : null}
            {item.rerouted ? (
                <span data-board-rerouted className="text-[11.5px] text-muted">
                    {item.rerouted}
                </span>
            ) : null}
        </div>
    );
}

export function RerouteButton({
    turnId,
    to,
    onReroute,
}: {
    turnId: string;
    to: "agent" | "draw";
    onReroute: () => void;
}) {
    return (
        <button
            type="button"
            data-board-reroute={turnId}
            onClick={onReroute}
            className={cn(TEXT_BTN, "text-muted hover:text-secondary")}
        >
            {REROUTE_LABEL[to]}
        </button>
    );
}

function Briefing({ item }: { item: Extract<TalkItem, { kind: "briefing" }> }) {
    if (item.asked) {
        return (
            <div className="flex flex-col gap-1">
                <span className="text-[11.5px] text-muted">the agent asked · {item.time}</span>
                {item.ask ? <span className="text-[12.5px] text-ink-mid">{item.ask}</span> : null}
            </div>
        );
    }
    return (
        <div className="flex flex-col gap-2 rounded-lg border border-edge-mid px-[11px] py-[9px]">
            <span className="flex items-center gap-[7px] text-[12px]">
                <RuntimeDot runtime={item.from.split(FROM_SEPARATOR)[0]} />
                <span className="truncate font-semibold text-primary">{item.from}</span>
                <span className="shrink-0 text-muted">sent a briefing · {item.time}</span>
            </span>
            <span className="whitespace-pre-wrap text-[12.5px] leading-[1.5] text-secondary">{item.text}</span>
            {item.ask ? <span className="text-[12.5px] text-ink-mid">Ask: {item.ask}</span> : null}
        </div>
    );
}

function Reply({
    item,
    shown,
    settle,
    onShow,
    onReroute,
}: {
    item: Extract<TalkItem, { kind: "reply" }>;
    shown: boolean;
    settle: boolean;
    onShow: () => void;
    onReroute: () => void;
}) {
    const card = item.card;
    return (
        <div className="flex flex-col gap-2.5">
            {item.text ? <span className="whitespace-pre-wrap text-ink-hi">{item.text}</span> : null}
            {card != null ? (
                <div
                    data-board-card={item.turnId}
                    className={cn(
                        "flex items-center gap-2.5 rounded-lg border border-edge-mid bg-surface-raised px-2.5 py-2",
                        settle && settleClass
                    )}
                >
                    <Shapes size={16} strokeWidth={1.5} aria-hidden className="shrink-0 text-ink-mid" />
                    <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[12.5px] font-semibold text-primary">{card.title}</span>
                        <span className="text-[11.5px] text-muted">{card.summary}</span>
                    </span>
                    <button
                        type="button"
                        data-board-show={item.turnId}
                        aria-pressed={shown}
                        onClick={onShow}
                        className={cn(SMALL_BTN, "bg-surface", shown && "border-accent text-accent-soft")}
                    >
                        Show
                    </button>
                </div>
            ) : null}
            {item.reroute != null ? (
                <span className="flex justify-end">
                    <RerouteButton turnId={item.turnId} to={item.reroute} onReroute={onReroute} />
                </span>
            ) : null}
        </div>
    );
}

function Forward({
    item,
    props,
}: {
    item: Extract<TalkItem, { kind: "forward" }>;
    props: Pick<
        BoardTalkProps,
        "onReroute" | "onOpenAgent" | "onBack" | "agentChoices" | "project" | "onPickAgent" | "onStartAgent"
    >;
}) {
    // the line changing under you (waiting to sent, sent to answered) flashes once (moment 14)
    const flash = useChangeFlash(item.line);
    const needs = item.state === "needsagent";
    const reroute = (
        <RerouteButton turnId={item.turnId} to={item.reroute} onReroute={() => props.onReroute(item.turnId)} />
    );
    return (
        <div
            data-board-forward={item.state}
            className={cn(
                "flex flex-col gap-2",
                // a question waiting for an agent breathes until one is picked (moment 3)
                needs && "pulse-glow rounded-lg border border-warning/40 bg-surface px-[11px] py-[9px]"
            )}
        >
            <span
                data-board-forward-line
                className={cn(
                    "self-start rounded text-[11.5px]",
                    needs ? "font-semibold text-warning" : "text-muted",
                    flash && changeFlashClass
                )}
            >
                {item.line}
            </span>
            {item.reason ? <span className="text-[12.5px] text-secondary">{item.reason}</span> : null}
            {item.reply != null ? (
                <span data-board-forward-reply className="whitespace-pre-wrap text-ink-hi">
                    {item.reply}
                </span>
            ) : null}
            {needs ? (
                <AgentChoiceList
                    choices={props.agentChoices}
                    project={props.project}
                    onPick={props.onPickAgent}
                    onStart={props.onStartAgent}
                />
            ) : null}
            <span className="flex items-center gap-3">
                {item.way === "open" && item.agentTabId ? (
                    <button
                        type="button"
                        data-board-open-agent={item.agentTabId}
                        onClick={() => props.onOpenAgent(item.agentTabId)}
                        className={cn(TEXT_BTN, "text-accent-soft hover:text-primary")}
                    >
                        Open agent
                    </button>
                ) : null}
                {item.way === "back" && props.onBack != null ? (
                    <button
                        type="button"
                        data-board-back
                        onClick={props.onBack}
                        className={cn(TEXT_BTN, "text-accent-soft hover:text-primary")}
                    >
                        Back to the transcript
                    </button>
                ) : null}
                {reroute}
            </span>
        </div>
    );
}

function Working({ item, onStop }: { item: Extract<TalkItem, { kind: "working" }>; onStop: () => void }) {
    if (item.waiting) {
        return (
            <div role="status" className="flex items-center gap-2 text-[12.5px] text-muted">
                <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-ink-faint" />
                Waits for the answer above
            </div>
        );
    }
    const status = (
        <span className="flex items-center gap-2 text-[12.5px]">
            <span className="pulse-dot h-[7px] w-[7px] shrink-0 rounded-full bg-working" />
            <span className="font-semibold text-working">{item.slow ? "Still answering" : "Answering"}</span>
            <span className="text-muted">{item.elapsed}</span>
        </span>
    );
    if (!item.slow) {
        return <div role="status">{status}</div>;
    }
    return (
        <div
            role="status"
            className="flex flex-col gap-2 rounded-lg border border-edge-strong bg-surface-raised px-[11px] py-[9px]"
        >
            {status}
            <span className="text-[12.5px] leading-[1.45] text-secondary">
                This is taking longer than most answers. Stop it to ask something narrower; nothing on the board
                changes.
            </span>
            <span className="flex justify-end">
                <button type="button" data-board-stop onClick={onStop} className={SMALL_BTN}>
                    Stop
                </button>
            </span>
        </div>
    );
}

function Failed({ item, onRetry }: { item: Extract<TalkItem, { kind: "failed" }>; onRetry: () => void }) {
    return (
        <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg border border-error/40 bg-error/10 px-[11px] py-[9px]"
        >
            <span className="flex items-center gap-2 text-[12.5px]">
                <CircleAlert size={14} strokeWidth={1.6} aria-label="Error" className="shrink-0 text-error" />
                <span className="font-semibold text-error">Couldn't answer</span>
                <span className="text-muted">{item.time}</span>
            </span>
            <span className="text-[12.5px] leading-[1.45] text-error-soft">{item.text}</span>
            <span className="flex justify-end">
                <button type="button" data-board-retry={item.turnId} onClick={onRetry} className={ERROR_BTN}>
                    Retry
                </button>
            </span>
        </div>
    );
}

const CHOICE_LINE: Record<"keep" | "new", string> = { keep: "Kept here", new: "Moved to a new board" };

function Asks({
    item,
    onChoice,
}: {
    item: Extract<TalkItem, { kind: "asks" }>;
    onChoice: (choice: "keep" | "new") => void;
}) {
    // an unanswered ask breathes until you choose (moment 3)
    const choice = item.choice;
    const open = choice == null;
    return (
        <div
            data-board-asks={item.turnId}
            className={cn(
                "flex flex-col gap-2.5",
                open && "pulse-glow rounded-lg border border-warning/40 bg-surface px-[11px] py-[9px]"
            )}
        >
            <span className="whitespace-pre-wrap text-ink-hi">{item.text}</span>
            {open ? (
                <span className="flex gap-2">
                    <button
                        type="button"
                        data-board-choice="new"
                        onClick={() => onChoice("new")}
                        className={PRIMARY_BTN}
                    >
                        New board from this
                    </button>
                    <button
                        type="button"
                        data-board-choice="keep"
                        onClick={() => onChoice("keep")}
                        className={SECONDARY_BTN}
                    >
                        Keep it here
                    </button>
                </span>
            ) : (
                <span className="text-[12px] text-muted">{CHOICE_LINE[choice]}</span>
            )}
        </div>
    );
}

function itemKey(item: TalkItem): string {
    return `${item.kind}:${item.turnId}`;
}

function AskBox({ ask, onAsk, onStop }: { ask: AskState; onAsk: (question: string) => void; onStop: () => void }) {
    const [text, setText] = useState("");
    const id = useId();
    const empty = text.trim() === "";
    const send = () => {
        if (ask.disabled || empty) {
            return;
        }
        onAsk(text.trim());
        setText("");
    };
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) {
            return;
        }
        e.preventDefault();
        send();
    };
    const selected = ask.selected;
    return (
        <div className="px-3.5 pb-3.5 pt-3">
            <div
                data-board-ask-box
                aria-disabled={ask.disabled}
                className="flex flex-col gap-2 rounded-xl border border-edge-mid bg-surface-raised pb-2 pl-3 pr-2.5 pt-2.5"
            >
                <label htmlFor={id} className="sr-only">
                    {ask.placeholder}
                </label>
                <textarea
                    id={id}
                    rows={2}
                    value={text}
                    placeholder={ask.placeholder}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={onKeyDown}
                    className="resize-none border-0 bg-transparent p-0 text-[13.5px] leading-[1.5] text-primary outline-none placeholder:text-muted"
                />
                <div className="flex items-center gap-2">
                    {selected != null ? (
                        <span
                            data-board-ask-hint
                            className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-accentbg px-2 py-[3px] text-[12px] text-accent-soft"
                        >
                            <span>Selected</span>
                            <span className="truncate font-mono">{selected}</span>
                        </span>
                    ) : (
                        <span data-board-ask-hint className="text-[11.5px] text-muted">
                            {ask.hint}
                        </span>
                    )}
                    <span className="flex-1" />
                    {ask.stoppable ? (
                        <button
                            type="button"
                            data-board-ask-stop
                            onClick={onStop}
                            className={cn(SEND_BTN, "cursor-pointer bg-edge-mid text-secondary hover:bg-edge-strong")}
                        >
                            <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden />
                            Stop
                        </button>
                    ) : (
                        <button
                            type="button"
                            disabled={ask.disabled}
                            onClick={send}
                            className={cn(
                                SEND_BTN,
                                ask.disabled
                                    ? "cursor-default bg-edge-mid text-muted"
                                    : empty
                                      ? "cursor-pointer bg-edge-mid text-secondary"
                                      : "cursor-pointer bg-accent text-background hover:bg-accenthover"
                            )}
                        >
                            Ask
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

export function BoardTalk(props: BoardTalkProps) {
    const { about, items, ask, shownTurnId } = props;
    const scroller = useRef<HTMLDivElement>(null);
    // turns seen answering in this mount: their card settles when it lands (moment 4); a talk opened answered doesn't
    const seenWorking = useRef(new Set<string>());
    for (const item of items) {
        if (item.kind === "working") {
            seenWorking.current.add(item.turnId);
        }
    }
    const lastKey = items.length > 0 ? itemKey(items[items.length - 1]) : "";
    useEffect(() => {
        const el = scroller.current;
        if (el != null) {
            el.scrollTop = el.scrollHeight;
        }
    }, [lastKey]);
    const render = (item: TalkItem) => {
        switch (item.kind) {
            case "question":
                return <Question item={item} />;
            case "briefing":
                return <Briefing item={item} />;
            case "reply":
                return (
                    <Reply
                        item={item}
                        shown={shownTurnId === item.turnId}
                        settle={seenWorking.current.has(item.turnId)}
                        onShow={() => props.onShow(item.turnId, item.card?.shapeIds ?? [])}
                        onReroute={() => props.onReroute(item.turnId)}
                    />
                );
            case "forward":
                return <Forward item={item} props={props} />;
            case "working":
                return <Working item={item} onStop={props.onStop} />;
            case "failed":
                return <Failed item={item} onRetry={() => props.onRetry(item.turnId)} />;
            case "stopped":
                return <span className="text-[12.5px] text-muted">Stopped. Nothing on the board changed.</span>;
            case "asks":
                return <Asks item={item} onChoice={(choice) => props.onChoice(item.turnId, choice)} />;
        }
    };
    return (
        <aside
            data-board-talk
            aria-label="Talk with the drawer"
            className="flex w-[400px] shrink-0 flex-col border-r border-border bg-surface"
        >
            <div className="px-[18px] pt-3">
                <AboutChip title={about} className="max-w-full" />
            </div>
            {items.length === 0 ? (
                <div
                    data-board-talk-empty
                    className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 p-[18px] text-center"
                >
                    <span className="text-[13.5px] font-semibold text-secondary">Nothing asked on this board yet</span>
                    <span className="max-w-[280px] text-[12.5px] leading-[1.5] text-muted">
                        Ask below. To ask about something you drew, press Edit and select it.
                    </span>
                </div>
            ) : (
                <div
                    ref={scroller}
                    aria-live="polite"
                    className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto px-[18px] py-4 text-[13.5px] leading-[1.55]"
                >
                    {/* items there on open land settled; one arriving later enters (moment 1) */}
                    <AnimatePresence initial={false}>
                        {items.map((item) => (
                            <motion.div
                                key={itemKey(item)}
                                data-board-turn={item.turnId}
                                data-board-item={item.kind}
                                variants={cardVariants}
                                initial="initial"
                                animate="animate"
                                className="flex flex-col"
                            >
                                {render(item)}
                            </motion.div>
                        ))}
                    </AnimatePresence>
                </div>
            )}
            {ask != null ? <AskBox ask={ask} onAsk={props.onAsk} onStop={props.onStop} /> : null}
        </aside>
    );
}
