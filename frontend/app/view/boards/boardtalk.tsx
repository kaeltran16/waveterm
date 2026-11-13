// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Boards surface's talk column (boards B1, B4-B7, B11): About, the conversation and the ask box. Thin render:
// the items and the ask box's words come from boardtalkmodel.ts, and every action is the surface's.

import { cardVariants, settleClass } from "@/app/element/motiontokens";
import { runtimeMeta } from "@/app/view/agents/runtimemeta";
import { cn } from "@/util/util";
import { CircleAlert, Shapes, Square } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { TalkItem } from "./boardtalkmodel";

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
const SELECTED_PREFIX = "Selected ";
// the briefing's sender is "<runtime> · <project>", so its first word names the runtime's dot
const FROM_SEPARATOR = " · ";

export interface BoardTalkProps {
    about: string; // the About chip's title: "the waveterm code", "claude · waveterm"
    items: TalkItem[];
    ask: { disabled: boolean; hint: string; placeholder: string; stoppable: boolean }; // stoppable: Stop takes Ask's place
    shownTurnId: string | null; // whose Show is on
    onAsk: (question: string) => void; // Enter asks, Shift Enter new line; empty does nothing
    onShow: (turnId: string, shapeIds: string[]) => void;
    onStop: () => void;
    onRetry: (turnId: string) => void;
    onChoice: (turnId: string, choice: "keep" | "new") => void;
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

export function RuntimeDot({ runtime }: { runtime: string | undefined }) {
    return <span className={cn("h-[7px] w-[7px] shrink-0 rounded-full bg-current", runtimeMeta(runtime).text)} />;
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
        </div>
    );
}

function Briefing({ item }: { item: Extract<TalkItem, { kind: "briefing" }> }) {
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
}: {
    item: Extract<TalkItem, { kind: "reply" }>;
    shown: boolean;
    settle: boolean;
    onShow: () => void;
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

function AskBox({
    ask,
    onAsk,
    onStop,
}: {
    ask: BoardTalkProps["ask"];
    onAsk: (question: string) => void;
    onStop: () => void;
}) {
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
    const selected = ask.hint.startsWith(SELECTED_PREFIX) ? ask.hint.slice(SELECTED_PREFIX.length) : null;
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
                    />
                );
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
                        Ask below. To ask about something you drew, select it first.
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
            <AskBox ask={ask} onAsk={props.onAsk} onStop={props.onStop} />
        </aside>
    );
}
