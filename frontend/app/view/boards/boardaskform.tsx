// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The ask forms (boards B3, B8, B9, B12): a name and a first question for a new board, with what it is about and,
// for a handoff, what it starts with. Thin render: the words come from the caller, the ask is the surface's.

import { errorNudge, paneReveal } from "@/app/element/motiontokens";
import { DialogButton } from "@/app/modals/dialogbutton";
import { ModalShell } from "@/app/modals/modalshell";
import { formatChordString } from "@/util/keysym";
import { cn } from "@/util/util";
import { X } from "lucide-react";
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
    onAsk: (name: string, question: string) => Promise<void>; // a rejection shows its message in the form (moment 13)
    onCancel: () => void;
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

// a name and a question, refused with "Type a name first" until the name has one; shared by the column form and
// the New board dialog
function useAskFields(onAsk: BoardAskFormProps["onAsk"], initialQuestion?: string) {
    const [name, setName] = useState("");
    const [question, setQuestion] = useState(initialQuestion ?? "");
    const [error, setError] = useState<string | null>(null);
    // counts the refused tries, so each one nudges again
    const [refused, setRefused] = useState(0);
    const [busy, setBusy] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);

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
            await onAsk(name.trim(), question.trim());
        } catch (e) {
            refuse(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    const onNameChange = (value: string) => {
        setName(value);
        if (error != null && value.trim() !== "") {
            setError(null);
        }
    };
    return { name, onNameChange, question, setQuestion, error, refused, busy, nameRef, ask };
}

export function BoardAskForm(props: BoardAskFormProps) {
    const { title, about, startsWith } = props;
    const { name, onNameChange, question, setQuestion, error, refused, busy, nameRef, ask } = useAskFields(
        props.onAsk,
        props.initialQuestion
    );
    const questionRef = useRef<HTMLTextAreaElement>(null);
    const nameId = useId();
    const questionId = useId();
    const fromThing = about.line !== aboutLine(undefined);
    // the field you type first: the question when the thing already says what the board is about, else its name
    const focusQuestion = fromThing && !props.initialQuestion;
    useEffect(() => {
        (focusQuestion ? questionRef.current : nameRef.current)?.focus();
    }, []);

    const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void ask();
        } else if (e.key === "Escape") {
            // the form's Escape, not the surface's Escape-home
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
        }
    };

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
                    <input
                        ref={nameRef}
                        id={nameId}
                        type="text"
                        autoComplete="off"
                        value={name}
                        placeholder={NAME_PLACEHOLDER}
                        onChange={(e) => onNameChange(e.target.value)}
                        className={cn(FIELD, "px-[9px] py-1.5 text-[13px] font-medium")}
                    />
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
                    <button type="button" data-board-form-cancel onClick={props.onCancel} className={SMALL_BTN}>
                        Cancel
                    </button>
                    <button
                        type="button"
                        data-board-form-ask
                        disabled={busy}
                        onClick={() => void ask()}
                        className={ASK_BTN}
                    >
                        Ask
                    </button>
                </div>
            </motion.div>
        </aside>
    );
}

// the field look of the New agent dialog (newagentmodal.tsx), so the two "New ..." dialogs read as one family
const DIALOG_LABEL = "mb-2 block font-mono text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted";
const DIALOG_FIELD =
    "block w-full border border-edge-mid bg-surface text-[13px] text-primary outline-none placeholder:text-muted focus:border-accent-700";

// New board from the empty state (B12): a project board, so there is no About to show; the footer names the project
export function NewBoardDialog(props: {
    open: boolean;
    project: string;
    onAsk: BoardAskFormProps["onAsk"];
    onClose: () => void;
}) {
    return (
        <ModalShell open={props.open} onClose={props.onClose} className="flex w-[min(640px,93vw)] flex-col">
            {/* mounted only while open, so each opening starts empty */}
            {props.open ? <NewBoardDialogBody {...props} /> : null}
        </ModalShell>
    );
}

function NewBoardDialogBody({
    project,
    onAsk,
    onClose,
}: {
    project: string;
    onAsk: BoardAskFormProps["onAsk"];
    onClose: () => void;
}) {
    const { name, onNameChange, question, setQuestion, error, refused, busy, nameRef, ask } = useAskFields(onAsk);
    const nameId = useId();
    const questionId = useId();
    const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
        // the body owns the ask, so it takes Ctrl+Enter here rather than through ModalShell's onSubmit
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.stopPropagation();
            void ask();
        }
    };
    return (
        <div data-new-board-dialog onKeyDown={onKeyDown} className="flex min-h-0 flex-col">
            <div className="flex shrink-0 items-center gap-[10px] border-b border-border py-[13px] pl-[18px] pr-3">
                <h2 className="m-0 flex-1 text-[15px] font-semibold text-primary">New board</h2>
                <button
                    type="button"
                    aria-label="Close"
                    onClick={onClose}
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[7px] text-muted hover:bg-surface-hover hover:text-primary"
                >
                    <X size={15} strokeWidth={2} />
                </button>
            </div>
            <div className="flex flex-col gap-[14px] px-[18px] pb-4 pt-[14px]">
                <div>
                    <label htmlFor={nameId} className={DIALOG_LABEL}>
                        Name
                    </label>
                    <input
                        ref={nameRef}
                        id={nameId}
                        type="text"
                        autoFocus
                        autoComplete="off"
                        value={name}
                        placeholder={NAME_PLACEHOLDER}
                        onChange={(e) => onNameChange(e.target.value)}
                        className={cn(DIALOG_FIELD, "min-h-[38px] rounded-[8px] px-3 py-[5px]")}
                    />
                </div>
                <div>
                    <label htmlFor={questionId} className={DIALOG_LABEL}>
                        First question
                    </label>
                    <textarea
                        id={questionId}
                        value={question}
                        placeholder={QUESTION_PLACEHOLDER}
                        onChange={(e) => setQuestion(e.target.value)}
                        className={cn(
                            DIALOG_FIELD,
                            "h-[72px] resize-none rounded-[10px] px-3 py-[10px] leading-normal"
                        )}
                    />
                </div>
                <FormError error={error} refused={refused} />
            </div>
            <div className="flex shrink-0 items-center gap-3 border-t border-border px-[18px] py-[13px]">
                <div className="min-w-0 flex-1 truncate text-[12px] text-muted">
                    The drawer reads <span className="font-mono text-[11px] text-ink-hi">{project}</span>
                </div>
                <DialogButton variant="secondary" hint="esc" data-board-form-cancel onClick={onClose}>
                    Cancel
                </DialogButton>
                <DialogButton
                    variant="primary"
                    hint={formatChordString("Cmd:Enter")}
                    data-board-form-ask
                    disabled={busy}
                    onClick={() => void ask()}
                >
                    Ask
                </DialogButton>
            </div>
        </div>
    );
}
