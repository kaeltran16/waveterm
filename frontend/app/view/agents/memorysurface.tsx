// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory surface (Wave-cockpit-live.dc.html:1061-1169): header (count/search/Graph-List toggle/New),
// List (grouped by scope, type pills) + detail rail (content, meta, related/backlinks, Edit/Delete).
// Graph view added in a follow-up task; until then the toggle shows a calm placeholder.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { resolveCwd } from "./agentcwdresolve";
import { MarkdownMessage } from "./markdownmessage";
import { MemGraph } from "./memgraph";
import { NewMemoryModal } from "./newmemorymodal";
import { SyncStrip } from "./syncstrip";
import {
    deleteNote,
    loadMemory,
    memBodyAtom,
    memEdgesAtom,
    memLoadedAtom,
    memNotesAtom,
    memSearchAtom,
    memSelectedIdAtom,
    memViewAtom,
    saveNote,
    selectNote,
} from "./memstore";
import { groupByScope, typeMeta, type MemNote } from "./memtypes";

function Header({ count, onNew }: { count: number; onNew: () => void }) {
    const view = useAtomValue(memViewAtom);
    const search = useAtomValue(memSearchAtom);
    return (
        <div className="flex flex-none items-center gap-[14px] px-[28px] pb-[16px] pt-[24px]">
            <div>
                <h1 className="mb-[4px] text-[25px] font-bold tracking-[-0.02em]">Memory</h1>
                <p className="text-[13.5px] text-ink-mid">What your agents remember · {count} entries</p>
            </div>
            <div className="flex-1" />
            <input
                value={search}
                onChange={(e) => globalStore.set(memSearchAtom, e.target.value)}
                placeholder="Search memory…"
                className="w-[230px] rounded-[9px] border border-border bg-surface px-[12px] py-[8px] text-[13px] text-foreground outline-none placeholder:text-ink-mid"
            />
            <div className="flex rounded-[9px] border border-edge-mid bg-surface p-[3px]">
                <button
                    onClick={() => globalStore.set(memViewAtom, "graph")}
                    className={cn(
                        "rounded-[7px] px-[14px] py-[6px] text-[12px] font-semibold",
                        view === "graph" ? "bg-accentbg text-accent-soft" : "text-ink-mid"
                    )}
                >
                    Graph
                </button>
                <button
                    onClick={() => globalStore.set(memViewAtom, "list")}
                    className={cn(
                        "rounded-[7px] px-[14px] py-[6px] text-[12px] font-semibold",
                        view === "list" ? "bg-accentbg text-accent-soft" : "text-ink-mid"
                    )}
                >
                    List
                </button>
            </div>
            <button
                onClick={onNew}
                className="flex items-center gap-[6px] rounded-[8px] bg-accent px-[13px] py-[8px] text-[12.5px] font-semibold text-background hover:bg-accenthover"
            >
                <span className="-mt-px text-[15px] leading-none">+</span>New memory
            </button>
        </div>
    );
}

function ListView({ notes, selectedId }: { notes: MemNote[]; selectedId: string | null }) {
    const groups = groupByScope(notes);
    return (
        <div className="mx-auto max-w-[780px] px-[28px] pb-[60px] pt-[10px]">
            {groups.map((g) => (
                <div key={g.name} className="mb-[26px]">
                    <div className="mb-[11px] flex items-center gap-[10px]">
                        <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-mid">
                            {g.name}
                        </h2>
                        <span className="font-mono text-[11px] font-semibold text-ink-faint">{g.count}</span>
                        <div className="h-px flex-1 bg-gradient-to-r from-edge-faint to-transparent" />
                    </div>
                    <div className="flex flex-col gap-[8px]">
                        {g.items.map((n) => {
                            const m = typeMeta(n.type);
                            return (
                                <button
                                    key={n.id}
                                    onClick={() => fireAndForget(() => selectNote(n.id))}
                                    className={cn(
                                        "flex cursor-pointer items-center gap-[13px] rounded-[11px] border px-[15px] py-[12px] text-left hover:border-edge-strong",
                                        n.id === selectedId ? "border-edge-strong bg-surface" : "border-edge-faint bg-background"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "min-w-[78px] flex-none rounded-[5px] px-[8px] py-[3px] text-center font-mono text-[9.5px] font-semibold uppercase tracking-[0.05em]",
                                            m.pillClass
                                        )}
                                        style={{ background: "rgba(255,255,255,0.05)" }}
                                    >
                                        {m.label}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-mono text-[13px] font-semibold text-foreground">
                                            {n.title}
                                        </div>
                                        <div className="truncate text-[11.5px] text-ink-mid">{n.description}</div>
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}

function MetaRow({ label, value, border }: { label: string; value: string; border?: boolean }) {
    return (
        <div className={cn("flex justify-between py-[8px]", border && "border-b border-edge-faint")}>
            <span className="text-[12.5px] text-ink-mid">{label}</span>
            <span className="font-mono text-[12px] text-ink-hi">{value}</span>
        </div>
    );
}

function DetailRail({ notes }: { notes: MemNote[] }) {
    const selectedId = useAtomValue(memSelectedIdAtom);
    const body = useAtomValue(memBodyAtom);
    const edges = useAtomValue(memEdgesAtom);
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState("");
    const [conflict, setConflict] = useState(false);
    const sel = notes.find((n) => n.id === selectedId);

    useEffect(() => {
        setEditing(false);
        setConflict(false);
    }, [selectedId]);

    if (!sel) {
        return (
            <aside className="w-[330px] flex-none border-l border-edge-faint bg-surface p-[22px] text-[13px] text-ink-mid">
                Select a memory to see its content.
            </aside>
        );
    }
    const m = typeMeta(sel.type);
    const relatedIds = new Set<string>();
    for (const e of edges) {
        if (e.from === sel.id) relatedIds.add(e.to);
        if (e.to === sel.id) relatedIds.add(e.from);
    }
    const related = notes.filter((n) => relatedIds.has(n.id));

    const startEdit = () => {
        setDraft(body?.body ?? "");
        setConflict(false);
        setEditing(true);
    };
    const doSave = () => {
        const baseMtime = body?.mtime ?? 0;
        fireAndForget(async () => {
            const r = await saveNote(sel.path, draft, baseMtime);
            if (r.conflict) {
                setConflict(true); // file changed on disk since open; reload to see it
            } else {
                setEditing(false);
            }
        });
    };

    return (
        <aside className="w-[330px] flex-none overflow-y-auto border-l border-edge-faint bg-surface px-[20px] pb-[40px] pt-[22px]">
            <div className="mb-[13px] flex items-center gap-[9px]">
                <span className={cn("rounded-[5px] px-[9px] py-[3px] font-mono text-[9.5px] font-semibold uppercase", m.pillClass)} style={{ background: "rgba(255,255,255,0.05)" }}>
                    {m.label}
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[10.5px] text-ink-faint">{sel.scope}</span>
            </div>
            <h2 className="mb-[14px] text-[18px] font-bold leading-[1.3] text-foreground">{sel.title}</h2>
            <div className="mb-[8px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-mid">Content</div>
            {editing ? (
                <textarea
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    className="mb-[10px] h-[220px] w-full resize-none rounded-[10px] border border-accent/40 bg-background px-[15px] py-[13px] font-mono text-[12.5px] leading-[1.6] text-ink-hi outline-none"
                />
            ) : (
                <div className="mb-[10px] rounded-[10px] border border-edge-faint bg-background px-[15px] py-[13px] text-[13.5px] leading-[1.6] text-ink-hi">
                    {body == null ? (
                        "Loading…"
                    ) : (
                        <MarkdownMessage text={body.body || sel.description} />
                    )}
                </div>
            )}
            {conflict && (
                <div className="mb-[10px] rounded-[8px] border border-warning/40 bg-warning/10 px-[11px] py-[8px] text-[12px] text-warning">
                    This note changed on disk since you opened it. Reload to see the latest before saving.
                </div>
            )}
            <div className="mb-[22px] flex gap-[8px]">
                {editing ? (
                    <>
                        <button onClick={doSave} className="flex-1 rounded-[8px] bg-accent py-[8px] text-[12px] font-semibold text-background hover:bg-accenthover">
                            Save
                        </button>
                        <button
                            onClick={() => {
                                setEditing(false);
                                setConflict(false);
                            }}
                            className="flex-1 rounded-[8px] border border-edge-mid bg-surface py-[8px] text-[12px] text-ink-mid hover:border-edge-strong"
                        >
                            Cancel
                        </button>
                        {conflict && (
                            <button
                                onClick={() => fireAndForget(() => selectNote(sel.id))}
                                className="rounded-[8px] border border-edge-mid px-[10px] py-[8px] text-[12px] text-ink-mid"
                            >
                                Reload
                            </button>
                        )}
                    </>
                ) : (
                    <>
                        <button onClick={startEdit} className="flex-1 rounded-[8px] border border-edge-mid bg-surface py-[8px] text-[12px] text-ink-mid hover:border-edge-strong">
                            Edit
                        </button>
                        <button
                            onClick={() => fireAndForget(() => deleteNote(sel.path))}
                            className="rounded-[8px] border border-error/30 px-[12px] py-[8px] text-[12px] text-error hover:bg-error/10"
                        >
                            Delete
                        </button>
                    </>
                )}
            </div>
            <div className="mb-[22px] flex flex-col">
                <MetaRow label="Scope" value={sel.scope} border />
                <MetaRow label="Source" value={sel.source} border />
                <MetaRow label="Updated" value={new Date(sel.updatedts).toLocaleDateString()} />
            </div>
            {related.length > 0 && (
                <>
                    <div className="mb-[11px] font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-mid">
                        Related memory
                    </div>
                    <div className="flex flex-col gap-[7px]">
                        {related.map((r) => {
                            const rm = typeMeta(r.type);
                            return (
                                <button
                                    key={r.id}
                                    onClick={() => fireAndForget(() => selectNote(r.id))}
                                    className="flex cursor-pointer items-center gap-[9px] rounded-[9px] border border-edge-faint bg-background px-[11px] py-[9px] hover:border-edge-strong"
                                >
                                    <div className={cn("h-[6px] w-[6px] flex-none rounded-full", rm.dotClass)} />
                                    <span className="min-w-0 flex-1 truncate text-left font-mono text-[11.5px] text-ink-hi">
                                        {r.title}
                                    </span>
                                    <span className="text-[10px] text-ink-faint">→</span>
                                </button>
                            );
                        })}
                    </div>
                </>
            )}
        </aside>
    );
}

export function MemorySurface({ model }: { model: AgentsViewModel }) {
    const notes = useAtomValue(memNotesAtom);
    const loaded = useAtomValue(memLoadedAtom);
    const view = useAtomValue(memViewAtom);
    const selectedId = useAtomValue(memSelectedIdAtom);
    const search = useAtomValue(memSearchAtom);
    const [newOpen, setNewOpen] = useState(false);

    // Resolve the focused agent's cwd so new notes land in that project's Claude hub (mirrors
    // FilesSurface). Null when no agent is focused -> authoring falls back to the dedicated vault.
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const agent = agents.find((a) => a.id === focusId);
    const [focusedCwd, setFocusedCwd] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        void resolveCwd(agent?.transcriptPath, agent?.blockId).then((c) => {
            if (live) setFocusedCwd(c);
        });
        return () => {
            live = false;
        };
    }, [agent?.transcriptPath, agent?.blockId]);

    useEffect(() => {
        fireAndForget(() => loadMemory());
    }, []);

    const q = search.trim().toLowerCase();
    const filtered = q
        ? notes.filter((n) => (n.title + " " + n.description).toLowerCase().includes(q))
        : notes;

    return (
        <div className="absolute inset-0 flex flex-col">
            <Header count={notes.length} onNew={() => setNewOpen(true)} />
            <SyncStrip focusedCwd={focusedCwd} />
            <div className="flex min-h-0 flex-1">
                <div className={cn("relative min-w-0 flex-1", view === "graph" ? "overflow-hidden" : "overflow-auto")}>
                    {!loaded ? (
                        <div className="p-[28px] text-[13px] text-ink-mid">Loading memory…</div>
                    ) : notes.length === 0 ? (
                        <div className="p-[28px] text-[13px] text-ink-mid">
                            No memory yet. Create one with “New memory”, or point{" "}
                            <span className="font-mono">memory:vaultpath</span> at an existing vault.
                        </div>
                    ) : view === "list" ? (
                        <ListView notes={filtered} selectedId={selectedId} />
                    ) : (
                        <MemGraph notes={filtered} selectedId={selectedId} />
                    )}
                </div>
                <DetailRail notes={notes} />
            </div>
            {newOpen && <NewMemoryModal onClose={() => setNewOpen(false)} cwd={focusedCwd ?? undefined} />}
        </div>
    );
}
