// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Memory surface (Wave-cockpit-live.dc.html:1061-1169): header (count/search/Graph-List toggle/New),
// List (grouped by scope, type pills) + detail rail (content, meta, related/backlinks, Edit/Delete).
// Graph view added in a follow-up task; until then the toggle shows a calm placeholder.

import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { MOTION, cardVariants, reflowProps, type ReflowProps } from "@/app/element/motiontokens";
import { SkeletonLine } from "@/app/element/skeleton";
import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { resolveCwd } from "./agentcwdresolve";
import { MarkdownMessage } from "./markdownmessage";
import { MemGraph } from "./memgraph";
import { NewMemoryModal } from "./newmemorymodal";
import { RAIL_ICON } from "./railicons";
import { SyncStrip } from "./syncstrip";
import {
    deleteNote,
    loadMemory,
    memBodyAtom,
    memConflictAtom,
    memDraftAtom,
    memEditingAtom,
    memEdgesAtom,
    memLoadedAtom,
    memNotesAtom,
    memRailOpenAtom,
    memReflowAnimatedAtom,
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
                onChange={(e) => {
                    globalStore.set(memSearchAtom, e.target.value);
                    globalStore.set(memReflowAnimatedAtom, false); // search filters instantly, never reflow-animated
                }}
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

function ListView({
    notes,
    selectedId,
    rp,
    mountedEmpty,
}: {
    notes: MemNote[];
    selectedId: string | null;
    rp: ReflowProps;
    mountedEmpty: boolean;
}) {
    const groups = groupByScope(notes);
    return (
        <motion.div
            initial={mountedEmpty ? { opacity: 0 } : false}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
            className="mx-auto max-w-[780px] px-[28px] pb-[60px] pt-[10px]"
        >
            <AnimatePresence mode="popLayout" initial={false}>
                {groups.map((g) => (
                    <motion.div
                        key={g.name}
                        layout
                        variants={cardVariants}
                        initial={rp.initial}
                        animate="animate"
                        exit={rp.exit}
                        transition={rp.transition}
                        className="mb-[26px]"
                    >
                        <div className="mb-[11px] flex items-center gap-[10px]">
                            <h2 className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-mid">
                                {g.name}
                            </h2>
                            <span className="font-mono text-[11px] font-semibold text-ink-faint">{g.count}</span>
                            <div className="h-px flex-1 bg-gradient-to-r from-edge-faint to-transparent" />
                        </div>
                        <AnimatePresence mode="popLayout" initial={false}>
                            {g.items.map((n) => {
                                const m = typeMeta(n.type);
                                return (
                                    <motion.button
                                        key={n.id}
                                        layout
                                        variants={cardVariants}
                                        initial={rp.initial}
                                        animate="animate"
                                        exit={rp.exit}
                                        transition={rp.transition}
                                        onClick={() => fireAndForget(() => selectNote(n.id))}
                                        onContextMenu={(ev) =>
                                            ContextMenuModel.getInstance().showContextMenu(
                                                [
                                                    { label: "Open", click: () => fireAndForget(() => selectNote(n.id)) },
                                                    { label: "Copy title", click: () => void navigator.clipboard.writeText(n.title) },
                                                    { label: "Copy path", click: () => void navigator.clipboard.writeText(n.path) },
                                                    { type: "separator" },
                                                    { label: "Delete", click: () => fireAndForget(() => deleteNote(n.path)) },
                                                ],
                                                ev
                                            )
                                        }
                                        className={cn(
                                            "mb-[8px] flex w-full cursor-pointer items-center gap-[13px] rounded-[11px] border px-[15px] py-[12px] text-left transition-colors duration-150 hover:border-edge-strong",
                                            n.id === selectedId
                                                ? "border-edge-strong bg-surface"
                                                : "border-edge-faint bg-background"
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
                                    </motion.button>
                                );
                            })}
                        </AnimatePresence>
                    </motion.div>
                ))}
            </AnimatePresence>
        </motion.div>
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

function DetailBody({
    sel,
    body,
    related,
}: {
    sel: MemNote;
    body: { body: string; mtime: number } | null;
    related: MemNote[];
}) {
    const [editing, setEditing] = useAtom(memEditingAtom);
    const [draft, setDraft] = useAtom(memDraftAtom);
    const [conflict, setConflict] = useAtom(memConflictAtom);

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

    const m = typeMeta(sel.type);
    return (
        <>
            <div className="mb-[13px] flex items-center gap-[9px]">
                <span className={cn("rounded-[5px] px-[9px] py-[3px] font-mono text-[9.5px] font-semibold uppercase", m.pillClass)} style={{ background: "rgba(255,255,255,0.05)" }}>
                    {m.label}
                </span>
                <div className="flex-1" />
                <span className="font-mono text-[10.5px] text-ink-faint">{sel.scope}</span>
            </div>
            <h2 className="mb-[14px] text-[18px] font-bold leading-[1.3] text-foreground">{sel.title}</h2>
            <div className="mb-[8px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-mid">Content</div>
            <AnimatePresence mode="wait" initial={false}>
                <motion.div
                    key={editing ? "edit" : body == null ? "load" : "ready"}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } }}
                    exit={{ opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } }}
                >
                    {editing ? (
                        <textarea
                            autoFocus
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            className="mb-[10px] h-[220px] w-full resize-none rounded-[10px] border border-accent/40 bg-background px-[15px] py-[13px] font-mono text-[12.5px] leading-[1.6] text-ink-hi outline-none"
                        />
                    ) : (
                        <div className="mb-[10px] rounded-[10px] border border-edge-faint bg-background px-[15px] py-[13px] text-[13.5px] leading-[1.6] text-ink-hi">
                            {body == null ? "Loading…" : <MarkdownMessage text={body.body || sel.description} />}
                        </div>
                    )}
                </motion.div>
            </AnimatePresence>
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
        </>
    );
}

function DetailRail({ notes }: { notes: MemNote[] }) {
    const selectedId = useAtomValue(memSelectedIdAtom);
    const body = useAtomValue(memBodyAtom);
    const edges = useAtomValue(memEdgesAtom);
    const sel = notes.find((n) => n.id === selectedId);

    const relatedIds = new Set<string>();
    if (sel) {
        for (const e of edges) {
            if (e.from === sel.id) relatedIds.add(e.to);
            if (e.to === sel.id) relatedIds.add(e.from);
        }
    }
    const related = notes.filter((n) => relatedIds.has(n.id));

    const sections: RailSection[] = [
        {
            id: "detail",
            icon: RAIL_ICON.info,
            label: "Memory detail",
            content: (
                <AnimatePresence mode="wait">
                    <motion.div
                        key={sel ? sel.id : "empty"}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1, transition: { duration: MOTION.durMacro, ease: MOTION.easeFluid } }}
                        exit={{ opacity: 0, transition: { duration: MOTION.durExit, ease: MOTION.easeFluid } }}
                    >
                        {!sel ? (
                            <div className="text-[13px] text-ink-mid">Select a memory to see its content.</div>
                        ) : (
                            <DetailBody sel={sel} body={body} related={related} />
                        )}
                    </motion.div>
                </AnimatePresence>
            ),
        },
    ];

    return <CollapsibleRail openAtom={memRailOpenAtom} ariaLabel="Memory detail" sections={sections} />;
}

function MemorySkeleton() {
    return (
        <div className="absolute inset-0 flex">
            <div className="min-w-0 flex-1 p-[28px]">
                <div className="mb-[22px] flex items-center gap-[10px]">
                    <SkeletonLine className="h-[24px] w-[170px]" />
                    <SkeletonLine className="h-[24px] w-[66px] rounded-[7px]" />
                </div>
                <div className="space-y-[18px]">
                    {Array.from({ length: 3 }).map((_, group) => (
                        <div key={group}>
                            <SkeletonLine className="mb-[9px] h-[11px] w-[86px]" />
                            <div className="space-y-[7px]">
                                {Array.from({ length: 3 }).map((_, row) => (
                                    <div key={row} className="rounded-[10px] border border-border bg-surface px-[12px] py-[10px]">
                                        <SkeletonLine className="mb-[8px] h-[13px] w-[58%]" />
                                        <SkeletonLine className="h-[11px] w-[82%]" />
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
            <div className="hidden w-[300px] flex-none border-l border-border p-[18px] xl:block">
                <SkeletonLine className="mb-[12px] h-[16px] w-[65%]" />
                <SkeletonLine className="mb-[8px] h-[11px] w-full" />
                <SkeletonLine className="mb-[8px] h-[11px] w-[88%]" />
                <SkeletonLine className="h-[11px] w-[55%]" />
            </div>
        </div>
    );
}

export function MemorySurface({ model }: { model: AgentsViewModel }) {
    const notes = useAtomValue(memNotesAtom);
    const loaded = useAtomValue(memLoadedAtom);
    const view = useAtomValue(memViewAtom);
    const selectedId = useAtomValue(memSelectedIdAtom);
    const search = useAtomValue(memSearchAtom);
    const reflowAnimated = useAtomValue(memReflowAnimatedAtom);
    // fade the list in only on the first-ever populate; memNotesAtom persists across remounts so a
    // cached re-entry mounts non-empty and the reveal is suppressed (mirrors Sessions/Activity).
    const [mountedEmpty] = useState(() => notes.length === 0);
    const rp = reflowProps(reflowAnimated);
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

    // re-scan on mount and whenever the vault path changes (Settings > Memory). getSettingsKeyAtom is
    // cached per key, so this atom identity is stable and the effect fires only on an actual path change.
    const vaultPath = useAtomValue(getSettingsKeyAtom("memory:vaultpath"));
    useEffect(() => {
        fireAndForget(() => loadMemory());
    }, [vaultPath]);

    const q = search.trim().toLowerCase();
    const filtered = q
        ? notes.filter((n) => (n.title + " " + n.description).toLowerCase().includes(q))
        : notes;
    // graph gets the FULL set + a match-id filter: search dims non-matches in place instead of
    // removing them, so typing never restarts the force simulation
    const graphFilterIds = useMemo(
        () =>
            q
                ? new Set(
                      notes
                          .filter((n) => (n.title + " " + n.description).toLowerCase().includes(q))
                          .map((n) => n.id)
                  )
                : null,
        [q, notes]
    );

    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 flex">
                <div className="flex min-w-0 flex-1 flex-col">
                    <Header count={notes.length} onNew={() => setNewOpen(true)} />
                    <SyncStrip focusedCwd={focusedCwd} />
                    <div className="relative min-h-0 flex-1 overflow-hidden">
                        {!loaded ? (
                            <MemorySkeleton />
                        ) : notes.length === 0 ? (
                            <div className="p-[28px] text-[13px] text-ink-mid">
                                No memory yet. Create one with “New memory”, or point{" "}
                                <span className="font-mono">memory:vaultpath</span> at an existing vault.
                            </div>
                        ) : (
                            <AnimatePresence mode="wait" initial={false}>
                                <motion.div
                                    key={view}
                                    className="absolute inset-0"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                                >
                                    {view === "list" ? (
                                        <div className="absolute inset-0 overflow-auto">
                                            <ListView notes={filtered} selectedId={selectedId} rp={rp} mountedEmpty={mountedEmpty} />
                                        </div>
                                    ) : (
                                        <MemGraph notes={notes} filteredIds={graphFilterIds} selectedId={selectedId} />
                                    )}
                                </motion.div>
                            </AnimatePresence>
                        )}
                    </div>
                </div>
                <DetailRail notes={notes} />
                {newOpen && <NewMemoryModal onClose={() => setNewOpen(false)} cwd={focusedCwd ?? undefined} />}
            </div>
        </MotionConfig>
    );
}
