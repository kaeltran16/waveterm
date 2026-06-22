// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget, stringToBase64 } from "@/util/util";
import { useState } from "react";

// Sends free text to an agent's terminal block. "\r" submits (the PTY treats CR as Enter), mirroring
// how term-model writes xterm input via ControllerInputCommand.
export function AgentComposer({ blockId, placeholder }: { blockId?: string; placeholder: string }) {
    const [text, setText] = useState("");
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
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-[14px] py-2">
            <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        send();
                    }
                }}
                placeholder={placeholder}
                className="min-w-0 flex-1 rounded-[6px] border border-border bg-transparent px-2.5 py-1 text-[12px] text-primary outline-none placeholder:text-muted"
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
