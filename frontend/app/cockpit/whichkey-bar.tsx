// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Transient bottom bar shown while a leader sequence is in progress. Reads the live registry and
// shows only the continuations available for the active leader.

import { activeLeaderAtom } from "@/app/store/keybindings/leaderatom";
import { bindingsAtom } from "@/app/store/keybindings/store";
import { useAtomValue } from "jotai";

export function WhichKeyBar() {
    const leader = useAtomValue(activeLeaderAtom);
    const bindings = useAtomValue(bindingsAtom);
    if (leader == null) {
        return null;
    }
    const items = bindings
        .filter((b) => b.keys.startsWith(leader + " "))
        .map((b) => ({ next: b.keys.split(" ")[1], label: b.label }));
    if (items.length === 0) {
        return null;
    }
    return (
        <div className="fixed inset-x-0 bottom-0 z-[65] flex items-center gap-4 border-t border-edge-strong bg-modalbg px-4 py-2 shadow-popover">
            <span className="shrink-0 font-mono text-[11px] text-accent-soft">{leader} →</span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {items.map((it) => (
                    <span key={it.next} className="flex items-center gap-1.5 text-[12px] text-secondary">
                        <span className="rounded-[5px] border border-edge-mid px-[6px] py-0.5 font-mono text-[10.5px] text-primary">
                            {it.next}
                        </span>
                        {it.label}
                    </span>
                ))}
            </div>
        </div>
    );
}
