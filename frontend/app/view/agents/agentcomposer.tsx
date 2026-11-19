// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn, fireAndForget } from "@/util/util";
import { atom, useAtom, type PrimitiveAtom } from "jotai";
import {
    forwardRef,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    type Dispatch,
    type ForwardedRef,
    type KeyboardEvent,
    type RefObject,
    type SetStateAction,
} from "react";
import { sendTypedText, toastSendFailure } from "./agentsend";
import { attachmentBlocker, type Attachment } from "./composerattachments";

// one line at 12px (rows={1}: the default two rows would set the floor instead); it grows as text wraps
const ComposerMinH = 32;
const ComposerMaxH = 160; // grows up to here, then the textarea scrolls

/** Pure: a composer can send only with a live terminal block, no attachment still uploading or failed, and
 *  non-blank text or a ready attachment. Shared by send(), the Enter guard, and the button's disabled state so
 *  all three agree (T4). */
export function canSendComposer(text: string, blockId?: string, attachments: Attachment[] = []): boolean {
    if (blockId == null || attachmentBlocker(attachments) != null) {
        return false;
    }
    return text.trim() !== "" || attachments.some((a) => a.status === "ready" && a.path);
}

/** Sends the composer's text and clears it only once the send lands, and only if the user hasn't typed
 *  since (clear gets the sent text to compare). A failed send keeps the text and raises an error toast.
 *  onStart sees the text before the send goes out. */
export async function submitComposer(
    text: string,
    blockId: string,
    clear: (sent: string) => void,
    send: (blockId: string, text: string) => Promise<void> = sendTypedText,
    onStart?: (text: string) => void
): Promise<void> {
    onStart?.(text);
    try {
        await send(blockId, text);
    } catch (e) {
        toastSendFailure("Message not sent", e);
        return;
    }
    clear(text);
}

// the typed draft per terminal block, outside the component: the Rendered view remounts per agent and the cockpit
// card unmounts with its surface, and either would drop a draft held in component state
const draftAtoms = new Map<string, PrimitiveAtom<string>>();

function composerDraftAtom(blockId: string): PrimitiveAtom<string> {
    let a = draftAtoms.get(blockId);
    if (a == null) {
        a = atom("");
        draftAtoms.set(blockId, a);
    }
    return a;
}

export interface AgentComposerHandle {
    fill: (text: string) => void;
    focus: () => void;
}

export interface UseAgentComposerOpts {
    blockId?: string;
    minH: number;
    maxH: number;
    onEscape?: () => void;
    onSubmitText?: (text: string) => void;
    // what actually goes out, built from the typed text (the card appends its attachments' paths)
    compose?: (text: string) => string;
    onSent?: () => void;
    attachments?: Attachment[];
    // how the text goes out (bash mode runs it in the shell); default sendTypedText
    send?: (blockId: string, text: string) => Promise<void>;
}

export interface UseAgentComposer {
    text: string;
    setText: Dispatch<SetStateAction<string>>;
    taRef: RefObject<HTMLTextAreaElement>;
    send: () => void;
    onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
}

// The text, autosize, double-send guard and Enter/Escape behind every agent composer.
export function useAgentComposer({
    blockId,
    minH,
    maxH,
    onEscape,
    onSubmitText,
    compose,
    onSent,
    attachments,
    send: deliver = sendTypedText,
}: UseAgentComposerOpts): UseAgentComposer {
    // without a block there is no agent to keep a draft for, so the text stays with this mount
    const draftAtom = useMemo(() => (blockId != null ? composerDraftAtom(blockId) : atom("")), [blockId]);
    const [text, setText] = useAtom(draftAtom);
    const taRef = useRef<HTMLTextAreaElement>(null);
    const sendingRef = useRef(false);
    useLayoutEffect(() => {
        const el = taRef.current;
        if (!el) {
            return;
        }
        el.style.height = "auto";
        el.style.height = `${Math.min(Math.max(el.scrollHeight, minH), maxH)}px`;
    }, [text, minH, maxH]);
    const send = () => {
        if (!canSendComposer(text, blockId, attachments)) {
            return;
        }
        // the text stays until the send lands, so a second Enter meanwhile must not send it again
        if (sendingRef.current) {
            return;
        }
        sendingRef.current = true;
        const typed = text;
        fireAndForget(() =>
            submitComposer(
                compose ? compose(typed) : typed,
                blockId!,
                () => {
                    setText((cur) => (cur === typed ? "" : cur));
                    onSent?.();
                },
                deliver,
                onSubmitText
            ).finally(() => {
                sendingRef.current = false;
            })
        );
    };
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
        } else if (e.key === "Escape" && onEscape) {
            e.preventDefault();
            onEscape();
        }
    };
    return { text, setText, taRef, send, onKeyDown };
}

// fill/focus for a parent that drives the composer (the row's quick replies, the permission band's refocus)
export function useComposerHandle(
    ref: ForwardedRef<AgentComposerHandle>,
    setText: (t: string) => void,
    taRef: RefObject<HTMLTextAreaElement>
): void {
    useImperativeHandle(
        ref,
        () => ({
            fill: (t: string) => {
                setText(t);
                taRef.current?.focus();
            },
            focus: () => taRef.current?.focus(),
        }),
        []
    );
}

// Sends free text to an agent's terminal block through sendTypedText.
export const AgentComposer = forwardRef<
    AgentComposerHandle,
    {
        blockId?: string;
        placeholder: string;
        className?: string;
        onEscape?: () => void;
        onSubmitText?: (text: string) => void;
    }
>(function AgentComposer({ blockId, placeholder, className, onEscape, onSubmitText }, ref) {
    const { text, setText, taRef, send, onKeyDown } = useAgentComposer({
        blockId,
        minH: ComposerMinH,
        maxH: ComposerMaxH,
        onEscape,
        onSubmitText,
    });
    useComposerHandle(ref, setText, taRef);
    return (
        <div className={cn("flex shrink-0 items-end gap-2 border-t border-border px-[14px] py-2", className)}>
            <textarea
                ref={taRef}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                className="min-w-0 flex-1 resize-none overflow-y-auto rounded-sm border border-border bg-transparent px-2.5 py-1.5 text-[12px] leading-[1.4] text-primary outline-none placeholder:text-muted focus:border-accent-700"
            />
            <button
                type="button"
                onClick={send}
                disabled={!canSendComposer(text, blockId)}
                className="shrink-0 cursor-pointer rounded-[5px] border border-edge-mid px-2.5 py-1 text-[11px] text-secondary hover:border-edge-strong hover:bg-surface-hover hover:text-primary disabled:cursor-default disabled:opacity-40"
            >
                Send
            </button>
        </div>
    );
});
