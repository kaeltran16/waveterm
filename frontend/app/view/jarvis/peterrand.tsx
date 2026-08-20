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
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { sendErrand } from "./petactrun";
import { petErrandState } from "./peterrandmodel";
import { petErrandAtom } from "./petstore";

export function PetErrand({ channel }: { channel: Channel | null }) {
    const errand = useAtomValue(petErrandAtom);
    const pref = useAtomValue(harnessPreferenceAtom);
    const harnesses = useAtomValue(harnessesAtom);
    const [draft, setDraft] = useState("");

    const busy = errand?.status === "streaming";
    const state = petErrandState({
        channel: channel != null,
        draft,
        busy,
        runtime: pref.route?.runtime ?? "",
        saving: pref.saving,
        harnesses,
    });
    const placeholder = state.inputDisabled
        ? state.reason === "no channel active"
            ? "Select a channel to ask Jarvis"
            : state.reason === "busy"
              ? "Jarvis is thinking"
              : (state.reason ?? "Ask Jarvis anything")
        : "Ask Jarvis anything";
    const hint =
        state.reason != null &&
        state.reason !== "empty draft" &&
        state.reason !== "no channel active" &&
        state.reason !== "busy"
            ? state.reason
            : busy
              ? "Jarvis is thinking"
              : "Replies are saved to the active channel";

    const send = () => {
        const prompt = draft.trim();
        if (!prompt || state.submitDisabled || channel == null) {
            return;
        }
        setDraft("");
        fireAndForget(() => sendErrand(channel.oid, state.runtime, prompt));
    };

    return (
        <div className="p-3">
            <div className="flex items-center gap-2">
                <input
                    data-pet-errand-input
                    aria-label="Ask Jarvis"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            send();
                        }
                    }}
                    disabled={state.inputDisabled}
                    placeholder={placeholder}
                    className="min-h-9 min-w-0 flex-1 rounded-[8px] border border-border bg-background px-2.5 text-[11.5px] text-secondary placeholder:text-muted focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default"
                />
                <button
                    type="button"
                    onClick={send}
                    disabled={state.submitDisabled}
                    className="min-h-9 flex-none rounded-[8px] bg-accent px-3 text-[11px] font-bold text-background hover:bg-accenthover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:bg-surface-hover disabled:text-muted"
                >
                    Ask
                </button>
            </div>

            <div className="mt-2 flex min-w-0 items-center gap-2 text-[9.5px] text-muted">
                <HarnessPicker operation="consult" placement="top-start" />
                <span className="min-w-0 flex-1 truncate">{hint}</span>
                <span className="flex-none font-mono">{channel == null ? "No destination" : `→ #${channel.name}`}</span>
            </div>

            {errand != null ? (
                <div className="mt-2.5 border-t border-border pt-2.5">
                    <span className="font-mono text-[9.5px] text-muted">
                        {errand.runtime} · {errand.status === "streaming" ? "thinking" : errand.status}
                    </span>
                    <span
                        className={cn(
                            "mt-1 block max-h-[120px] overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-[1.45]",
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
