// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// New-memory modal: name + type + scope + body. Creates a note in the focused project's Claude
// hub (via memstore.createNote with the focused agent's cwd), falling back to the dedicated vault
// when no agent is focused. Esc / backdrop click cancels.

import { DialogButton } from "@/app/modals/dialogbutton";
import { ModalShell } from "@/app/modals/modalshell";
import { cn, fireAndForget } from "@/util/util";
import { useState } from "react";
import { createNote } from "./memstore";
import { typeMeta } from "./memtypes";

const TYPES = ["project", "reference", "feedback", "user"] as const;

export function NewMemoryModal({ onClose, cwd }: { onClose: () => void; cwd?: string }) {
    const [name, setName] = useState("");
    const [type, setType] = useState<string>("project");
    const [scope, setScope] = useState("shared");
    const [body, setBody] = useState("");

    const canSave = name.trim().length > 0 && body.trim().length > 0;
    const save = () => {
        if (!canSave) return;
        fireAndForget(async () => {
            await createNote(name.trim(), type, scope.trim(), body.trim(), cwd);
            onClose();
        });
    };

    return (
        <ModalShell open onClose={onClose} onSubmit={save} className="w-[min(560px,93vw)]" topClass="pt-[12vh]">
            <div>
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
                                            "flex items-center gap-[7px] rounded border px-[11px] py-[7px] text-[12.5px]",
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
                            className="w-full rounded border border-border bg-background px-[12px] py-[9px] font-mono text-[12.5px] text-foreground outline-none placeholder:text-ink-mid"
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
                    <DialogButton variant="secondary" hint="esc" onClick={onClose}>
                        Cancel
                    </DialogButton>
                    <DialogButton variant="primary" hint="⌘⏎" disabled={!canSave} onClick={save}>
                        Save memory
                    </DialogButton>
                </div>
            </div>
        </ModalShell>
    );
}
