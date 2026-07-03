// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useAtom } from "jotai";
import type { ReactNode } from "react";
import type { AgentsViewModel, SurfaceKey } from "./agents";

// Handoff NavRail glyphs (lines 86-125). Icons inherit currentColor; the active label sets text-accent-soft.
const ICON: Record<SurfaceKey, ReactNode> = {
    cockpit: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <rect x="2" y="2" width="7" height="7" rx="1.6" />
            <rect x="11" y="2" width="7" height="7" rx="1.6" />
            <rect x="2" y="11" width="7" height="7" rx="1.6" />
            <rect x="11" y="11" width="7" height="7" rx="1.6" />
        </svg>
    ),
    agent: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="10" cy="10" r="7" />
            <circle cx="10" cy="10" r="2.3" fill="currentColor" stroke="none" />
        </svg>
    ),
    activity: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <circle cx="3.5" cy="5" r="1.6" />
            <rect x="7" y="4" width="11" height="2" rx="1" />
            <circle cx="3.5" cy="10" r="1.6" />
            <rect x="7" y="9" width="11" height="2" rx="1" />
            <circle cx="3.5" cy="15" r="1.6" />
            <rect x="7" y="14" width="8" height="2" rx="1" />
        </svg>
    ),
    channels: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="4" width="14" height="10" rx="2.5" />
            <path d="M7 14v3l4-3" fill="currentColor" stroke="none" />
        </svg>
    ),
    sessions: (
        <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
        >
            <path d="M10 3l7 3.5-7 3.5-7-3.5z" />
            <path d="M3 10.5l7 3.5 7-3.5" />
        </svg>
    ),
    files: (
        // diff glyph: an added row (+) over a removed row (−)
        <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M3.8 6.8h2.4M5 5.6v2.4" />
            <path d="M9 6.8h7.2" />
            <path d="M3.8 13.2h2.4" />
            <path d="M9 13.2h7.2" />
        </svg>
    ),
    memory: (
        <svg width="20" height="20" viewBox="0 0 20 20">
            <line x1="5.5" y1="6" x2="14.5" y2="5" stroke="currentColor" strokeWidth="1.5" />
            <line x1="5.5" y1="6" x2="10" y2="15" stroke="currentColor" strokeWidth="1.5" />
            <line x1="14.5" y1="5" x2="10" y2="15" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="5.5" cy="6" r="2.4" fill="currentColor" />
            <circle cx="14.5" cy="5" r="2.1" fill="currentColor" />
            <circle cx="10" cy="15" r="2.7" fill="currentColor" />
        </svg>
    ),
    usage: (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" strokeLinecap="round">
            <circle cx="10" cy="10" r="7" stroke="var(--color-edge-strong)" strokeWidth="1.8" />
            <path d="M10 3a7 7 0 0 1 6.1 10.4" stroke="currentColor" strokeWidth="1.8" />
        </svg>
    ),
    settings: (
        // cog: teeth fused to a ring (the old free-floating rays read as a sun, not a gear)
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    ),
};

export const ITEMS: { key: SurfaceKey; label: string }[] = [
    { key: "cockpit", label: "Cockpit" },
    { key: "agent", label: "Agent" },
    { key: "activity", label: "Activity" },
    { key: "channels", label: "Channels" },
    { key: "sessions", label: "Sessions" },
    { key: "files", label: "Diff" },
    { key: "memory", label: "Memory" },
    { key: "usage", label: "Usage" },
];

export function NavRail({ model }: { model: AgentsViewModel }) {
    const [active, setActive] = useAtom(model.surfaceAtom);
    const renderItem = (key: SurfaceKey, label: string) => {
        const isActive = active === key;
        return (
            <button
                key={key}
                type="button"
                onClick={() => setActive(key)}
                className={cn(
                    "relative mx-2 flex cursor-pointer flex-col items-center gap-[5px] rounded-[10px] border-0 bg-transparent py-[11px] text-muted hover:text-muted-foreground",
                    isActive && "text-accent-soft"
                )}
            >
                {isActive ? (
                    <>
                        <span className="absolute inset-0 rounded-[10px] bg-accent/10" />
                        <span className="absolute left-[-8px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-[3px] bg-accent" />
                    </>
                ) : null}
                <span className="relative z-[1]">{ICON[key]}</span>
                <span className="relative z-[1] text-[10px] font-semibold">{label}</span>
            </button>
        );
    };
    return (
        <nav className="flex w-[78px] shrink-0 flex-col gap-[3px] border-r border-border bg-surface py-2.5">
            {ITEMS.map(({ key, label }) => renderItem(key, label))}
            <div className="flex-1" />
            {renderItem("settings", "Settings")}
        </nav>
    );
}
