// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Somewhere to type. The panel used to say "ask me anything" in prose and offer no input at all, which is
// the same defect as a row that names its own remedy and no button.
//
// Its own file rather than more of petpeek.tsx: the reply streams, which means state and an effect, and the
// peek is a readout of things decided elsewhere.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { activeChannelAtom } from "@/app/view/agents/channelsstore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { sendErrand } from "./petactrun";
import { petErrandAtom } from "./petstore";

export function PetErrand() {
    const channel = useAtomValue(activeChannelAtom);
    const errand = useAtomValue(petErrandAtom);
    const [draft, setDraft] = useState("");
    const [runtime, setRuntime] = useState<string | null>(null);

    // Read once: the installed set changes when the user installs a cli, not while a panel is open. The
    // first installed runtime wins and its name goes on the button, so which agent answers is never a guess.
    useEffect(() => {
        void RpcApi.ListConsultRuntimesCommand(TabRpcClient)
            .then((r) => setRuntime(r?.runtimes?.find((x) => x.installed)?.runtime ?? null))
            .catch(() => setRuntime(null));
    }, []);

    const blocked = channel == null ? "no channel active" : runtime == null ? "no runtime installed" : null;
    const busy = errand?.status === "streaming";
    const send = () => {
        const prompt = draft.trim();
        if (!prompt || channel == null || runtime == null || busy) {
            return;
        }
        setDraft("");
        fireAndForget(() => sendErrand(channel.oid, runtime, prompt));
    };

    return (
        <div className="flex flex-col gap-2 border-t border-border pt-2.5">
            <div className="flex items-center gap-2">
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            send();
                        }
                    }}
                    disabled={blocked != null || busy}
                    placeholder={blocked ?? "Ask me anything"}
                    className="min-w-0 flex-1 rounded-[7px] border border-border bg-surface px-2 py-1 text-[11.5px] text-secondary placeholder:text-muted disabled:placeholder:text-muted"
                />
                <button
                    type="button"
                    onClick={send}
                    disabled={blocked != null || busy || draft.trim() === ""}
                    className="flex-none cursor-pointer rounded-[7px] bg-accent px-2 py-1 text-[11px] font-bold text-background hover:bg-accenthover disabled:cursor-default disabled:bg-surface-hover disabled:text-muted"
                >
                    {runtime != null ? `Ask ${runtime}` : "Ask"}
                </button>
            </div>
            {/* the channel is named because the question lands there as a message: an errand whose
                destination is invisible is an errand you cannot find again */}
            {channel != null ? <span className="font-mono text-[9.5px] text-muted">-&gt; #{channel.name}</span> : null}
            {errand != null ? (
                <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-[9.5px] text-muted">
                        {errand.runtime} · {errand.status === "streaming" ? "thinking" : errand.status}
                    </span>
                    <span
                        className={cn(
                            "max-h-[120px] overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-[1.45]",
                            errand.status === "error" ? "text-error" : "text-secondary"
                        )}
                    >
                        {errand.text}
                    </span>
                </div>
            ) : null}
        </div>
    );
}
