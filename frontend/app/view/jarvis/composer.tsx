// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Composer + scope chips. Plan 2 wires submit -> JarvisConverseCommand: Enter starts a real conversation
// (if a fixture is showing) or appends to the active one, then streams the answer into the store. Scope
// chips render the active conversation's scope so "what will Jarvis look at?" is always visible.

import { globalStore } from "@/app/store/global";
import { cn } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { activeConversationAtom, activeConversationIdAtom, jarvisDraftAtom, startConversation, submitJarvisQuery } from "./jarvisstore";

export function Composer() {
    const conv = useAtomValue(activeConversationAtom);
    const [draft, setDraft] = useAtom(jarvisDraftAtom);

    const submit = () => {
        const text = draft.trim();
        if (text === "") return;
        let convId = globalStore.get(activeConversationIdAtom);
        if (convId == null) convId = startConversation(conv.scope);
        submitJarvisQuery(convId, text);
        setDraft("");
    };

    return (
        <div className="flex-none border-t border-border bg-background px-6 py-4">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
                {conv.scope.chips.map((chip) => (
                    <span
                        key={chip.label}
                        className={cn(
                            "rounded-full border px-2.5 py-0.5 text-[11.5px]",
                            chip.active ? "border-accent/40 bg-accentbg text-accent-soft" : "border-border text-ink-mid"
                        )}
                    >
                        {chip.label}
                    </span>
                ))}
            </div>
            <div className="flex items-center gap-2 rounded-[10px] border border-edge-mid bg-surface px-3.5 py-2.5">
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            submit();
                        }
                    }}
                    placeholder="Ask Jarvis…"
                    className="min-w-0 flex-1 bg-transparent text-[14px] text-secondary placeholder:text-muted focus:outline-none"
                />
            </div>
        </div>
    );
}
