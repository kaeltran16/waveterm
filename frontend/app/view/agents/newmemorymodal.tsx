// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// New-memory modal (Wave-cockpit-live.dc.html:1364-1402): name + type + scope + body. Creates a note
// in the dedicated vault via memstore.createNote, then closes. Esc / backdrop click cancels.

import { cn, fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { createNote } from "./memstore";
import { typeMeta } from "./memtypes";

const TYPES = ["project", "reference", "feedback", "user"] as const;

export function NewMemoryModal({ onClose }: { onClose: () => void }) {
    const [name, setName] = useState("");
    const [type, setType] = useState<string>("project");
    const [scope, setScope] = useState("shared");
    const [body, setBody] = useState("");

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const canSave = name.trim().length > 0 && body.trim().length > 0;
    const save = () => {
        if (!canSave) return;
        fireAndForget(async () => {
            await createNote(name.trim(), type, scope.trim(), body.trim());
            onClose();
        });
    };

    return (
        <div
            onClick={onClose}
            className="fixed inset-0 z-[75] flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-[3px]"
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="w-[min(560px,93vw)] overflow-hidden rounded-[14px] border border-edge-mid bg-surface-raised shadow-2xl"
            >
                <div className="flex items-center gap-[11px] border-b border-edge-faint px-[18px] py-[15px]">
                    <span className="flex-1 text-[15px] font-semibold text-foreground">New memory</span>
                    <span className="rounded-[5px] border border-edge-mid px-[7px] py-[2px] font-mono text-[10.5px] text-ink-faint">
                        esc
                    </span>
                </div>
                <div className="flex flex-col gap-[15px] p-[18px]">
                    <input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Memory name (becomes the id)"
                        className="w-full rounded-[10px] border border-border bg-background px-[13px] py-[11px] text-[13.5px] text-foreground outline-none placeholder:text-ink-mid"
                    />
                    <div>
                        <div className="mb-[9px] font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                            Type
                        </div>
                        <div className="flex flex-wrap gap-[7px]">
                            {TYPES.map((t) => {
                                const m = typeMeta(t);
                                return (
                                    <button
                                        key={t}
                                        onClick={() => setType(t)}
                                        className={cn(
                                            "flex items-center gap-[7px] rounded-[8px] border px-[11px] py-[7px] text-[12.5px]",
                                            type === t ? "border-accent text-foreground" : "border-border text-ink-mid"
                                        )}
                                    >
                                        <span className={cn("h-[7px] w-[7px] rounded-full", m.dotClass)} />
                                        {m.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div>
                        <div className="mb-[9px] font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                            Scope
                        </div>
                        <input
                            value={scope}
                            onChange={(e) => setScope(e.target.value)}
                            placeholder="shared, or a project name"
                            className="w-full rounded-[8px] border border-border bg-background px-[12px] py-[9px] font-mono text-[12.5px] text-foreground outline-none placeholder:text-ink-mid"
                        />
                    </div>
                    <div>
                        <div className="mb-[9px] font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                            Memory
                        </div>
                        <textarea
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            placeholder="What should every agent remember? e.g. Prefer Postgres over adding new dependencies."
                            className="h-[84px] w-full resize-none rounded-[10px] border border-border bg-background px-[13px] py-[11px] text-[13.5px] leading-[1.5] text-foreground outline-none placeholder:text-ink-mid"
                        />
                    </div>
                </div>
                <div className="flex items-center gap-[10px] border-t border-edge-faint px-[16px] py-[12px]">
                    <span className="font-mono text-[11px] text-ink-faint">
                        {typeMeta(type).label} · <span className="text-accent-soft">{scope || "shared"}</span>
                    </span>
                    <div className="flex-1" />
                    <button
                        onClick={onClose}
                        className="rounded-[8px] border border-border px-[15px] py-[8px] text-[12.5px] font-semibold text-ink-mid hover:text-foreground"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={save}
                        disabled={!canSave}
                        className="rounded-[8px] bg-accent px-[16px] py-[8px] text-[12.5px] font-semibold text-background disabled:opacity-50"
                    >
                        Save memory
                    </button>
                </div>
            </div>
        </div>
    );
}
