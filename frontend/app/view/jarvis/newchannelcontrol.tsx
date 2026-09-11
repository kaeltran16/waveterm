// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// + Channel: the app's ONLY way to start a channel, and therefore its only way to start any work at all.
// It lived in the Subjects column until B5 deleted the column, and it is moved here rather than rebuilt —
// the Brief would otherwise be a surface you can read and not act on. The `c` binding presses this button
// by its data attribute (buildJarvisBindings), which is why the attribute matters more than the label.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { createChannel } from "../agents/channelsstore";
import { projectsAtom } from "../agents/projectsstore";
import { openChannelSheet } from "./openref";

// the two-step picker: choose a registered project, then name the channel. A name is required by the
// server, so an empty one is filled with the project's own name rather than refused.
export function NewChannelControl({ model }: { model: AgentsViewModel }) {
    const projects = useAtomValue(projectsAtom);
    const [picking, setPicking] = useState(false);
    const [pending, setPending] = useState<{ name: string; path: string } | null>(null);
    const [newName, setNewName] = useState("");

    const create = (name: string, path: string) => {
        setPicking(false);
        setPending(null);
        fireAndForget(async () => {
            const oid = await createChannel(name, path);
            void openChannelSheet(oid, null);
        });
    };

    return (
        <div className="relative flex-none">
            {/* data-jarvis-new-channel: the `c` key presses this rather than owning a second copy of the
                picker's open state (buildJarvisBindings). */}
            <button
                type="button"
                data-jarvis-new-channel
                aria-expanded={picking}
                onClick={() => {
                    setPicking((p) => !p);
                    setPending(null);
                }}
                className={cn(
                    "cursor-pointer rounded-[6px] border px-2.5 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[.06em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    "border-accent/30 bg-accentbg text-accent-soft hover:bg-accent/20"
                )}
            >
                + Channel
            </button>
            {picking ? (
                <div className="absolute right-0 top-[26px] z-30 flex w-[240px] flex-col gap-1.5 rounded-[10px] border border-border bg-surface p-2.5 shadow-xl">
                    {pending != null ? (
                        <div className="flex flex-col gap-1.5 rounded-[7px] border border-border bg-surface-raised p-2">
                            <input
                                autoFocus
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                        e.preventDefault();
                                        create(newName.trim() || pending.name, pending.path);
                                    }
                                    if (e.key === "Escape") {
                                        e.preventDefault();
                                        setPending(null);
                                    }
                                }}
                                placeholder="Channel name"
                                className="rounded-[5px] border border-edge-mid bg-surface px-2 py-1 text-[12px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                            />
                            <div className="flex items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => create(newName.trim() || pending.name, pending.path)}
                                    className="cursor-pointer rounded-[5px] border border-accent/50 bg-accentbg px-2 py-0.5 font-mono text-[11px] text-accent-soft hover:bg-accent/20"
                                >
                                    Create
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setPending(null)}
                                    className="cursor-pointer rounded-[5px] px-2 py-0.5 font-mono text-[11px] text-muted hover:text-secondary"
                                >
                                    Back
                                </button>
                                <span className="ml-auto truncate font-mono text-[10px] text-muted">
                                    in {pending.name}
                                </span>
                            </div>
                        </div>
                    ) : Object.keys(projects ?? {}).length === 0 ? (
                        // the first thing a new user clicks used to point them somewhere else; the palette's
                        // New-project modal opens from anywhere, so open it from here.
                        <button
                            type="button"
                            onClick={() => {
                                setPicking(false);
                                globalStore.set(model.newProjectOpenAtom, true);
                            }}
                            className="cursor-pointer rounded-[7px] border border-accent/30 bg-accentbg px-2.5 py-1.5 text-left text-[11.5px] font-semibold text-accent-soft hover:bg-accent/20"
                        >
                            No projects yet — register one
                        </button>
                    ) : (
                        Object.entries(projects ?? {}).map(([name, p]) => (
                            <button
                                key={name}
                                type="button"
                                onClick={() => {
                                    setPending({ name, path: p?.path ?? "" });
                                    setNewName(name);
                                }}
                                className="cursor-pointer truncate rounded-[7px] border border-border bg-surface-raised px-2.5 py-1.5 text-left text-[12px] font-medium text-ink-mid hover:border-accent"
                            >
                                {name}
                            </button>
                        ))
                    )}
                </div>
            ) : null}
        </div>
    );
}
