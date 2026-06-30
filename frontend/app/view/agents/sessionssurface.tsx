// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Runtime-agnostic archive of resumable agent sessions. Resume routes through launchAgent so the
// existing Agent surface focus behavior stays the single path for starting/resuming agents.

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { formatAge, formatTokens } from "./agentsviewmodel";
import type { Runtime } from "./launch";
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

export function SessionsSurface({ model }: { model: AgentsViewModel }) {
    const sessions = useAtomValue(sessionsArchiveAtom);
    const [query, setQuery] = useState("");
    const [runtime, setRuntime] = useState("all");
    const [project, setProject] = useState("all");

    useEffect(() => {
        fireAndForget(loadSessionsArchive);
    }, []);

    const list = sessions ?? [];
    const runtimes = runtimesOf(list);
    const projects = projectsOf(list);
    const shown = filterSessions(searchSessions(list, query), { runtime, project });
    const now = Date.now();

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
        <div className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto max-w-[820px] px-[30px] pb-[70px] pt-[30px]">
                <div className="mb-5">
                    <h1 className="text-[25px] font-bold tracking-[-0.02em] text-primary">Sessions</h1>
                    <p className="text-[13.5px] text-secondary">Past agent sessions across runtimes.</p>
                </div>

                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search task, project, or branch…"
                    className="mb-4 w-full rounded-[9px] border border-border bg-surface px-[13px] py-[9px] text-[13px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                />

                <div className="mb-3 flex flex-wrap gap-2">
                    <FilterChip label="All runtimes" active={runtime === "all"} onClick={() => setRuntime("all")} />
                    {runtimes.map((r) => (
                        <FilterChip key={r} label={r} active={runtime === r} onClick={() => setRuntime(r)} />
                    ))}
                </div>
                <div className="mb-7 flex flex-wrap gap-2">
                    <FilterChip label="All projects" active={project === "all"} onClick={() => setProject("all")} />
                    {projects.map((p) => (
                        <FilterChip key={p} label={p} active={project === p} onClick={() => setProject(p)} />
                    ))}
                </div>

                {sessions == null ? (
                    <div className="mt-10 text-center text-[13px] text-muted">Loading…</div>
                ) : shown.length === 0 ? (
                    <div className="mt-10 text-center text-[13px] text-muted">No sessions found.</div>
                ) : (
                    <div className="overflow-hidden rounded-[12px] border border-border bg-surface">
                        {shown.map((s) => (
                            <div
                                key={`${s.runtime}:${s.id}`}
                                className="flex items-center gap-[11px] border-b border-border px-[14px] py-[12px] last:border-b-0 hover:bg-surface-hover"
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
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}