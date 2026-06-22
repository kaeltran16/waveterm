// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget, stringToBase64 } from "@/util/util";
import { useLayoutEffect, useRef, useState } from "react";

const ComposerMinH = 64; // ~3 lines at 12px
const ComposerMaxH = 160; // grows up to here, then the textarea scrolls

// Sends free text to an agent's terminal block. "\r" submits (the PTY treats CR as Enter), mirroring
// how term-model writes xterm input via ControllerInputCommand.
export function AgentComposer({ blockId, placeholder, className }: { blockId?: string; placeholder: string; className?: string }) {
    const [text, setText] = useState("");
    const taRef = useRef<HTMLTextAreaElement>(null);
    useLayoutEffect(() => {
        const el = taRef.current;
        if (!el) {
            return;
        }
        el.style.height = "auto";
        el.style.height = `${Math.min(Math.max(el.scrollHeight, ComposerMinH), ComposerMaxH)}px`;
    }, [text]);
    const send = () => {
        const t = text.trim();
        if (!t || !blockId) {
            return;
        }
        fireAndForget(() =>
            RpcApi.ControllerInputCommand(TabRpcClient, { blockid: blockId, inputdata64: stringToBase64(t + "\r") })
        );
        setText("");
    };
    return (
        <div className={cn("flex shrink-0 items-end gap-2 border-t border-border px-[14px] py-2", className)}>
            <textarea
                ref={taRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        send();
                    }
                }}
                placeholder={placeholder}
                className="min-w-0 flex-1 resize-none overflow-y-auto rounded-[6px] border border-border bg-transparent px-2.5 py-1.5 text-[12px] leading-[1.4] text-primary outline-none placeholder:text-muted"
            />
            <button
                type="button"
                onClick={send}
                disabled={!text.trim() || !blockId}
                className="shrink-0 cursor-pointer rounded-[5px] border border-border px-2.5 py-1 text-[11px] text-secondary hover:bg-white/[0.04] disabled:opacity-40"
            >
                Send
            </button>
        </div>
    );
}
