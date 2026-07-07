// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Runtime-agnostic archive of resumable agent sessions. Resume routes through launchAgent so the
// existing Agent surface focus behavior stays the single path for starting/resuming agents.

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { MOTION, cardVariants } from "@/app/element/motiontokens";
import { SkeletonLine } from "@/app/element/skeleton";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { formatAge, formatTokens } from "./agentsviewmodel";
import type { Runtime } from "./launch";
import { reflowProps } from "./sessionsmotion";
import {
    filterSessions,
    loadSessionsArchive,
    projectsOf,
    runtimesOf,
    searchSessions,
    sessionsArchiveAtom,
} from "./sessionsarchivestore";

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "cursor-pointer rounded-[8px] border px-[13px] py-[6px] text-[12px] font-medium",
                active
                    ? "border-accent bg-accentbg text-accent-soft"
                    : "border-border bg-surface text-ink-mid hover:border-edge-strong"
            )}
        >
            {label}
        </button>
    );
}

function SessionsSkeleton() {
    return (
        <div className="overflow-hidden rounded-[12px] border border-border bg-surface">
            {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-[11px] border-b border-border px-[14px] py-[12px] last:border-b-0">
                    <SkeletonLine className="h-[18px] w-[54px] rounded-[5px]" />
                    <div className="min-w-0 flex-1">
                        <SkeletonLine className="mb-[7px] h-[13px] w-[72%]" />
                        <SkeletonLine className="h-[11px] w-[48%]" />
                    </div>
                    <SkeletonLine className="h-[11px] w-[42px]" />
                    <SkeletonLine className="h-[28px] w-[76px] rounded-[7px]" />
                </div>
            ))}
        </div>
    );
}

export function SessionsSurface({ model }: { model: AgentsViewModel }) {
    const sessions = useAtomValue(sessionsArchiveAtom);
    const [query, setQuery] = useState("");
    const [runtime, setRuntime] = useState("all");
    const [project, setProject] = useState("all");
    // chips animate the reflow; search updates instantly (see sessionsmotion).
    const [reflowAnimated, setReflowAnimated] = useState(false);
    // fade the list in only on first-ever load, never on cached re-entry.
    const [mountedEmpty] = useState(() => sessions == null);

    useEffect(() => {
        fireAndForget(loadSessionsArchive);
    }, []);

    const list = sessions ?? [];
    const runtimes = runtimesOf(list);
    const projects = projectsOf(list);
    const shown = filterSessions(searchSessions(list, query), { runtime, project });
    const now = Date.now();
    const rp = reflowProps(reflowAnimated);

    const chooseRuntime = (r: string) => {
        setRuntime(r);
        setReflowAnimated(true);
    };
    const chooseProject = (p: string) => {
        setProject(p);
        setReflowAnimated(true);
    };

    const resume = (s: SessionInfo) => {
        if (!s.resumecommand) {
            return;
        }
        fireAndForget(() =>
            launchAgent(model, {
                runtime: s.runtime as Runtime,
                startupCommand: s.resumecommand,
                task: "",
                projectPath: s.projectpath,
                projectName: s.projectname || "agent",
            })
        );
    };

    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 overflow-y-auto">
                <div className="mx-auto max-w-[820px] px-[30px] pb-[70px] pt-[30px]">
                    <div className="mb-5">
                        <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Sessions</h1>
                        <p className="text-[13.5px] text-secondary">Past agent sessions across runtimes.</p>
                    </div>

                    <input
                        type="text"
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setReflowAnimated(false);
                        }}
                        placeholder="Search task, project, or branch…"
                        className="mb-4 w-full rounded-[9px] border border-border bg-surface px-[13px] py-[9px] text-[13px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                    />

                    <div className="mb-3 flex flex-wrap gap-2">
                        <FilterChip label="All runtimes" active={runtime === "all"} onClick={() => chooseRuntime("all")} />
                        {runtimes.map((r) => (
                            <FilterChip key={r} label={r} active={runtime === r} onClick={() => chooseRuntime(r)} />
                        ))}
                    </div>
                    <div className="mb-7 flex flex-wrap gap-2">
                        <FilterChip label="All projects" active={project === "all"} onClick={() => chooseProject("all")} />
                        {projects.map((p) => (
                            <FilterChip key={p} label={p} active={project === p} onClick={() => chooseProject(p)} />
                        ))}
                    </div>

                    {sessions == null ? (
                        <SessionsSkeleton />
                    ) : shown.length === 0 ? (
                        <motion.div
                            variants={cardVariants}
                            initial="initial"
                            animate="animate"
                            className="mt-10 text-center text-[13px] text-muted"
                        >
                            No sessions found.
                        </motion.div>
                    ) : (
                        <motion.div
                            initial={mountedEmpty ? { opacity: 0 } : false}
                            animate={{ opacity: 1 }}
                            transition={{ duration: MOTION.durMacro, ease: MOTION.easeFluid }}
                        >
                            <motion.div
                                layout
                                transition={rp.transition}
                                style={{ position: "relative" }}
                                className="overflow-hidden rounded-[12px] border border-border bg-surface"
                            >
                                <AnimatePresence mode="popLayout" initial={false}>
                                    {shown.map((s) => (
                                        <motion.div
                                            key={`${s.runtime}:${s.id}`}
                                            layout
                                            variants={cardVariants}
                                            initial={rp.initial}
                                            animate="animate"
                                            exit={rp.exit}
                                            transition={rp.transition}
                                            className="flex items-center gap-[11px] border-b border-border px-[14px] py-[12px] last:border-b-0 hover:bg-surface-hover"
                                            onContextMenu={(ev) => {
                                                const items: ContextMenuItem[] = [
                                                    { label: "Resume", enabled: !!s.resumecommand, click: () => resume(s) },
                                                ];
                                                if (s.resumecommand) {
                                                    items.push({ label: "Copy resume command", click: () => void navigator.clipboard.writeText(s.resumecommand) });
                                                }
                                                items.push({ label: "Copy project path", click: () => void navigator.clipboard.writeText(s.projectpath) });
                                                ContextMenuModel.getInstance().showContextMenu(items, ev);
                                            }}
                                        >
                                            <span className="shrink-0 rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[.08em] text-muted">
                                                {s.runtime}
                                            </span>
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate text-[12.5px] font-semibold text-primary">
                                                    {s.task || "(untitled session)"}
                                                </div>
                                                <div className="mt-[2px] truncate font-mono text-[10.5px] text-muted">
                                                    {s.projectname} · {s.branch || "—"} · {s.model || "—"}
                                                    {s.tokenstotal > 0 ? ` · ${formatTokens(s.tokenstotal)} tok` : ""}
                                                </div>
                                            </div>
                                            <span className="shrink-0 font-mono text-[10.5px] text-muted">
                                                {formatAge(now - s.lastactivets)}
                                            </span>
                                            {s.resumecommand ? (
                                                <button
                                                    type="button"
                                                    onClick={() => resume(s)}
                                                    className="shrink-0 cursor-pointer rounded-[7px] border border-border px-[11px] py-[5px] text-[11.5px] font-medium text-ink-mid hover:border-accent hover:text-accent-soft"
                                                >
                                                    Resume →
                                                </button>
                                            ) : (
                                                <span className="shrink-0 text-[10.5px] text-muted">read-only</span>
                                            )}
                                        </motion.div>
                                    ))}
                                </AnimatePresence>
                            </motion.div>
                        </motion.div>
                    )}
                </div>
            </div>
        </MotionConfig>
    );
}