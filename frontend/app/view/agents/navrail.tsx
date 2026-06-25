// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtom } from "jotai";
import type { AgentsViewModel, SurfaceKey } from "./agents";

const ITEMS: { key: SurfaceKey; label: string }[] = [
    { key: "cockpit", label: "Cockpit" },
    { key: "agent", label: "Agent" },
    { key: "activity", label: "Activity" },
    { key: "channels", label: "Channels" },
    { key: "sessions", label: "Sessions" },
    { key: "files", label: "Files" },
    { key: "memory", label: "Memory" },
    { key: "usage", label: "Usage" },
];

export function NavRail({ model }: { model: AgentsViewModel }) {
    const [active, setActive] = useAtom(model.surfaceAtom);
    return (
        <nav className="flex w-[78px] shrink-0 flex-col gap-[3px] border-r border-border bg-surface py-2.5">
            {ITEMS.map(({ key, label }) => {
                const isActive = active === key;
                return (
                    <button
                        key={key}
                        type="button"
                        onClick={() => setActive(key)}
                        className={cn(
                            "relative mx-2 flex cursor-pointer flex-col items-center gap-[5px] rounded-[10px] border-0 bg-transparent py-[11px] text-muted transition-colors hover:text-muted-foreground",
                            isActive && "text-accent-soft"
                        )}
                    >
                        {isActive ? (
                            <>
                                <span className="absolute inset-0 rounded-[10px] bg-accent/10" />
                                <span className="absolute left-[-8px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-[3px] bg-accent" />
                            </>
                        ) : null}
                        <span className="relative z-[1] font-mono text-[10px] font-semibold">{label}</span>
                    </button>
                );
            })}
        </nav>
    );
}
