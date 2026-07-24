// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { activeSpaceAtom, enterSpace, exitSpace, loadSpaces, spacesAtom } from "./spacestore";

// App-bar Space (Presence C) switcher: "◇ <objective> ▾" (or "Global"). Mirrors ProjectSwitcher's
// bar trigger + PopoverReveal dropdown. Selecting a task focuses it; "Global" returns to no-focus. The
// list refreshes on each open (dossiers change as work is dispatched).
export function SpaceSwitcher() {
    const active = useAtomValue(activeSpaceAtom);
    const spaces = useAtomValue(spacesAtom);
    const [open, setOpen] = useState(false);
    const label = active ? active.objective : "Global";
    const toggle = () =>
        setOpen((v) => {
            if (!v) loadSpaces();
            return !v;
        });
    const close = () => setOpen(false);
    return (
        <div className="relative">
            <button
                type="button"
                onClick={toggle}
                className="flex cursor-pointer items-center gap-1.5 rounded-sm px-[7px] py-1 text-[13px] font-medium text-secondary hover:bg-surface-hover hover:text-primary"
            >
                {active ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
                <span className="max-w-[180px] truncate">{label}</span>
                <span className="text-[9px] text-muted">▾</span>
            </button>
            {open ? <div className="fixed inset-0 z-50" onClick={close} /> : null}
            <PopoverReveal
                open={open}
                origin="top left"
                className="absolute left-0 top-[calc(100%+7px)] z-[60] w-[268px] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-popover"
            >
                <div className="px-3 pb-1.5 pt-[9px]">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                        Focus on task
                    </span>
                </div>
                <div className="max-h-[46vh] overflow-y-auto px-1.5 pb-1.5">
                    <button
                        type="button"
                        onClick={() => {
                            exitSpace();
                            close();
                        }}
                        className={cn(
                            "flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-surface-hover",
                            active == null && "bg-accent/10"
                        )}
                    >
                        <span className="h-2 w-2 shrink-0 rounded-[3px] bg-muted" />
                        <span className="flex-1 truncate text-[13px] font-medium text-secondary">Global (no focus)</span>
                    </button>
                    {spaces.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => {
                                enterSpace(s);
                                close();
                            }}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-surface-hover",
                                active?.id === s.id && "bg-accent/10"
                            )}
                        >
                            <span
                                className={cn(
                                    "h-2 w-2 shrink-0 rounded-[3px]",
                                    s.status === "paused" ? "bg-muted" : "bg-success"
                                )}
                            />
                            <span className="flex-1 truncate text-[13px] font-medium text-secondary">{s.objective}</span>
                            {s.ticket ? <span className="font-mono text-[10px] text-muted">{s.ticket}</span> : null}
                        </button>
                    ))}
                    {spaces.length === 0 ? (
                        <div className="px-2 py-3 text-[12px] text-muted">No active tasks yet.</div>
                    ) : null}
                </div>
            </PopoverReveal>
        </div>
    );
}
