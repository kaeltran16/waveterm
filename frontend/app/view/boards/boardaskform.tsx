// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The ask forms (boards B3, B8, B9, B12): a name and a first question for a new board, with what it is about and,
// for a handoff, what it starts with. Thin render: the words come from the caller, the ask is the surface's.

import { errorNudge, paneReveal } from "@/app/element/motiontokens";
import { cn } from "@/util/util";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AboutChip, RuntimeDot } from "./boardtalk";
import { aboutLine } from "./boardtalkmodel";

const SMALL_BTN =
    "cursor-pointer rounded-md border border-edge-mid bg-surface-raised px-2.5 py-1 text-[12px] font-semibold text-secondary hover:border-edge-strong hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const ASK_BTN =
    "cursor-pointer rounded-lg border-0 bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-background hover:bg-accenthover disabled:cursor-default disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const LABEL = "text-[11.5px] font-semibold text-ink-mid";
const FIELD =
    "rounded-md border border-edge-mid bg-background text-primary outline-none placeholder:text-muted focus:border-accent";
const NAME_PLACEHOLDER = "Name this board";
const QUESTION_PLACEHOLDER = "How does a run go from plan to landing?";
const AGENT_QUESTION_PLACEHOLDER = "What did this agent change, and why?";

export interface BoardAskFormProps {
    title: string; // "Ask something new" | "Ask a board about this" | "New board from <board>"
    about: { title: string; line: string; runtime?: string }; // runtime: the agent's runtime dot
    startsWith?: { summary: string | null; drawing: string | null; keep: string }; // handoff only
    initialQuestion?: string;
    variant: "column" | "empty"; // empty: B12's order (First question, Name, About, Ask) and no Cancel
    onAsk: (name: string, question: string) => Promise<void>; // a rejection shows its message in the form (moment 13)
    onCancel?: () => void;
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// what a new board from <board> starts with (B8): its drawer's summary when it has questions, its drawing unless
// the new board starts from a briefing (copiedShapes null), and that <board> stays as it is
export function startsWithLines(
    board: string,
    questions: number,
    copiedShapes: number | null
): NonNullable<BoardAskFormProps["startsWith"]> {
    return {
        summary:
            questions > 0 ? `A summary of ${board}'s ${plural(questions, "question")}, written by its drawer` : null,
        drawing: copiedShapes != null ? `Its drawing, copied: ${plural(copiedShapes, "shape")}, free to change` : null,
        keep: `${board} and its talk stay as they are.`,
    };
}

// a refused ask, said where you asked; each refusal nudges again (moment 13)
function FormError({ error, refused }: { error: string | null; refused: number }) {
    return (
        <AnimatePresence initial={false} mode="wait">
            {error != null ? (
                <motion.span
                    key={`refused-${refused}`}
                    role="alert"
                    data-board-form-error
                    variants={errorNudge}
                    initial="initial"
                    animate="animate"
                    className="text-[11.5px] text-error"
                >
                    {error}
                </motion.span>
            ) : null}
        </AnimatePresence>
    );
}

function StartsWith({ startsWith }: { startsWith: NonNullable<BoardAskFormProps["startsWith"]> }) {
    return (
        <div className="flex flex-col gap-2">
            <span className={LABEL}>It starts with</span>
            <div
                data-board-starts-with
                className="flex flex-col gap-1.5 rounded-lg border border-edge-mid bg-surface-raised px-[11px] py-[9px] text-[12.5px] leading-[1.45]"
            >
                {startsWith.summary ? <span className="text-secondary">{startsWith.summary}</span> : null}
                {startsWith.drawing ? <span className="text-secondary">{startsWith.drawing}</span> : null}
                <span className="text-muted">{startsWith.keep}</span>
            </div>
        </div>
    );
}

// a thing's About (B9): what it is, then what the drawer does with it
function ThingAbout({ about }: { about: BoardAskFormProps["about"] }) {
    return (
        <div
            data-board-about
            className="flex flex-col gap-2 rounded-lg border border-edge-mid bg-surface-raised px-[11px] py-[9px]"
        >
            <span className="flex min-w-0 items-center gap-[7px] text-[12px]">
                <span className="text-muted">About</span>
                {about.runtime ? <RuntimeDot runtime={about.runtime} /> : null}
                <span className="truncate font-semibold text-primary">{about.title}</span>
            </span>
            <span className="text-[12.5px] leading-[1.45] text-ink-mid">{about.line}</span>
        </div>
    );
}

export function BoardAskForm(props: BoardAskFormProps) {
    const { title, about, startsWith, variant } = props;
    const [name, setName] = useState("");
    const [question, setQuestion] = useState(props.initialQuestion ?? "");
    const [error, setError] = useState<string | null>(null);
    // counts the refused tries, so each one nudges again
    const [refused, setRefused] = useState(0);
    const [busy, setBusy] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);
    const questionRef = useRef<HTMLTextAreaElement>(null);
    const nameId = useId();
    const questionId = useId();
    const fromThing = about.line !== aboutLine(undefined);
    // the field you type first: the question when the thing already says what the board is about, else its name
    const focusQuestion = variant === "empty" || (fromThing && !props.initialQuestion);
    useEffect(() => {
        (focusQuestion ? questionRef.current : nameRef.current)?.focus();
    }, []);

    const refuse = (message: string) => {
        setError(message);
        setRefused((n) => n + 1);
    };
    const ask = async () => {
        if (busy) {
            return;
        }
        if (name.trim() === "") {
            refuse("Type a name first");
            nameRef.current?.focus();
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await props.onAsk(name.trim(), question.trim());
        } catch (e) {
            refuse(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void ask();
        } else if (e.key === "Escape" && props.onCancel != null) {
            // the form's Escape, not the surface's Escape-home
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
        }
    };
    const onNameChange = (value: string) => {
        setName(value);
        if (error != null && value.trim() !== "") {
            setError(null);
        }
    };

    const nameInput = (className: string) => (
        <input
            ref={nameRef}
            id={nameId}
            type="text"
            autoComplete="off"
            value={name}
            placeholder={NAME_PLACEHOLDER}
            onChange={(e) => onNameChange(e.target.value)}
            className={cn(FIELD, className)}
        />
    );
    const askButton = (
        <button type="button" data-board-form-ask disabled={busy} onClick={() => void ask()} className={ASK_BTN}>
            Ask
        </button>
    );

    if (variant === "empty") {
        return (
            <div data-board-ask-form="empty" onKeyDown={onKeyDown} className="flex w-full flex-col gap-2">
                <div className="flex w-full flex-col gap-2.5 rounded-xl border border-edge-mid bg-surface-raised pb-2.5 pl-3.5 pr-3 pt-3">
                    <label htmlFor={questionId} className="sr-only">
                        First question
                    </label>
                    <textarea
                        ref={questionRef}
                        id={questionId}
                        rows={3}
                        value={question}
                        placeholder={QUESTION_PLACEHOLDER}
                        onChange={(e) => setQuestion(e.target.value)}
                        className="resize-none border-0 bg-transparent p-0 text-[14px] leading-[1.5] text-primary outline-none placeholder:text-muted"
                    />
                    <div className="flex items-center gap-2">
                        <label htmlFor={nameId} className="text-[12px] text-ink-mid">
                            Name
                        </label>
                        {nameInput("w-[180px] bg-surface px-2 py-1 text-[12.5px]")}
                        <AboutChip title={about.title} className="bg-surface" />
                        <span className="flex-1" />
                        {askButton}
                    </div>
                </div>
                <FormError error={error} refused={refused} />
            </div>
        );
    }

    return (
        <aside
            data-board-ask-form="column"
            aria-label={title}
            onKeyDown={onKeyDown}
            className="flex w-[400px] shrink-0 flex-col border-r border-border bg-surface"
        >
            {/* the form reveals in the talk column (moment 6b) */}
            <motion.div
                variants={paneReveal}
                initial="initial"
                animate="animate"
                className="flex min-h-0 flex-col gap-4 overflow-hidden p-[18px]"
            >
                <h2 className="m-0 text-[14px] font-semibold text-primary">{title}</h2>
                {fromThing ? <ThingAbout about={about} /> : null}
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={nameId} className={LABEL}>
                        Name
                    </label>
                    {nameInput("px-[9px] py-1.5 text-[13px] font-medium")}
                </div>
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={questionId} className={LABEL}>
                        First question
                    </label>
                    <textarea
                        ref={questionRef}
                        id={questionId}
                        rows={4}
                        value={question}
                        placeholder={about.runtime ? AGENT_QUESTION_PLACEHOLDER : QUESTION_PLACEHOLDER}
                        onChange={(e) => setQuestion(e.target.value)}
                        className={cn(FIELD, "resize-none px-[9px] py-[7px] text-[13.5px] leading-[1.5]")}
                    />
                </div>
                {startsWith != null ? <StartsWith startsWith={startsWith} /> : null}
                {fromThing ? null : (
                    <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted">
                        <AboutChip title={about.title} />
                        {startsWith == null ? <span className="min-w-0 truncate">{about.line}</span> : null}
                    </div>
                )}
                <FormError error={error} refused={refused} />
                <div className="flex items-center gap-2">
                    <span className="text-[11.5px] text-muted">Ctrl Enter asks · Esc cancels</span>
                    <span className="flex-1" />
                    {props.onCancel != null ? (
                        <button type="button" data-board-form-cancel onClick={props.onCancel} className={SMALL_BTN}>
                            Cancel
                        </button>
                    ) : null}
                    {askButton}
                </div>
            </motion.div>
        </aside>
    );
}
