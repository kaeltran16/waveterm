// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Somewhere to type. The panel used to say "ask me anything" in prose and offer no input at all, which is
// the same defect as a row that names its own remedy and no button.
//
// Its own file rather than more of petpeek.tsx: the reply streams, which means state and an effect, and the
// peek is a readout of things decided elsewhere.

import { HarnessPicker } from "@/app/view/agents/harnesspicker";
import { harnessPreferenceAtom, harnessesAtom } from "@/app/view/agents/harnessstore";
import { activeChannelAtom } from "@/app/view/agents/channelsstore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { sendErrand } from "./petactrun";
import { petErrandAtom } from "./petstore";
import { petErrandState } from "./peterrandmodel";

export function PetErrand() {
    const channel = useAtomValue(activeChannelAtom);
    const errand = useAtomValue(petErrandAtom);
    const pref = useAtomValue(harnessPreferenceAtom);
    const harnesses = useAtomValue(harnessesAtom);
    const [draft, setDraft] = useState("");

    const busy = errand?.status === "streaming";
    const state = petErrandState({
        channel: channel != null,
        draft,
        busy,
        runtime: pref.runtime,
        saving: pref.saving,
        harnesses,
    });
    const blocked = state.disabled ? state.reason : null;
    const send = () => {
        const prompt = draft.trim();
        if (!prompt || blocked != null || busy) {
            return;
        }
        setDraft("");
        fireAndForget(() => sendErrand(channel!.oid, state.runtime, prompt));
    };

    return (
        <div className="flex flex-col gap-2 border-t border-border pt-2.5">
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
            {/* the footer row: consult picker, destination channel, Ask — one visible choice for every errand */}
            <div className="flex items-center gap-2">
                <HarnessPicker operation="consult" placement="top-start" />
                {channel != null ? <span className="font-mono text-[9.5px] text-muted">-&gt; #{channel.name}</span> : null}
                <div className="flex-1" />
                <button
                    type="button"
                    onClick={send}
                    disabled={blocked != null || busy || draft.trim() === ""}
                    className="flex-none cursor-pointer rounded-[7px] bg-accent px-2 py-1 text-[11px] font-bold text-background hover:bg-accenthover disabled:cursor-default disabled:bg-surface-hover disabled:text-muted"
                >
                    Ask
                </button>
            </div>
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
