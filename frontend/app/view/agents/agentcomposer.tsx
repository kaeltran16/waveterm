// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn, fireAndForget } from "@/util/util";
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { sendAgentText } from "./agentsend";

// one line at 12px (rows={1}: the default two rows would set the floor instead); it grows as text wraps
const ComposerMinH = 32;
const ComposerMaxH = 160; // grows up to here, then the textarea scrolls

/** Pure: a composer can send only with non-empty text AND a live terminal block. Shared by send(), the
 *  Enter guard, and the button's disabled state so all three agree (T4). */
export function canSendComposer(text: string, blockId?: string): boolean {
    return text.trim() !== "" && blockId != null;
}

/** Sends the composer's text and clears it only once the send lands, and only if the user hasn't typed
 *  since (clear gets the sent text to compare). A failed send keeps the text and is logged. */
export async function submitComposer(
    text: string,
    blockId: string,
    clear: (sent: string) => void,
    send: (blockId: string, text: string) => Promise<void> = sendAgentText
): Promise<void> {
    try {
        await send(blockId, text);
    } catch (e) {
        console.error("agent composer: send failed, text kept", e);
        return;
    }
    clear(text);
}

export interface AgentComposerHandle {
    fill: (text: string) => void;
}

// Sends free text to an agent's terminal block through sendAgentText.
export const AgentComposer = forwardRef<
    AgentComposerHandle,
    {
        blockId?: string;
        placeholder: string;
        className?: string;
        onEscape?: () => void;
    }
>(function AgentComposer({ blockId, placeholder, className, onEscape }, ref) {
    const [text, setText] = useState("");
    const taRef = useRef<HTMLTextAreaElement>(null);
    const sendingRef = useRef(false);
    useImperativeHandle(
        ref,
        () => ({
            fill: (t: string) => {
                setText(t);
                taRef.current?.focus();
            },
        }),
        []
    );
    useLayoutEffect(() => {
        const el = taRef.current;
        if (!el) {
            return;
        }
        el.style.height = "auto";
        el.style.height = `${Math.min(Math.max(el.scrollHeight, ComposerMinH), ComposerMaxH)}px`;
    }, [text]);
    const send = () => {
        if (!canSendComposer(text, blockId)) {
            return;
        }
        // the text stays until the send lands, so a second Enter meanwhile must not send it again
        if (sendingRef.current) {
            return;
        }
        sendingRef.current = true;
        fireAndForget(() =>
            submitComposer(text, blockId!, (sent) => setText((cur) => (cur === sent ? "" : cur))).finally(() => {
                sendingRef.current = false;
            })
        );
    };
    return (
        <div className={cn("flex shrink-0 items-end gap-2 border-t border-border px-[14px] py-2", className)}>
            <textarea
                ref={taRef}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                    } else if (e.key === "Escape" && onEscape) {
                        e.preventDefault();
                        onEscape();
                    }
                }}
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
