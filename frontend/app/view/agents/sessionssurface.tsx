// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Merged Sessions surface (absorbs the old Activity tab). Master-detail: a recency-grouped session
// list with a pinned "All activity" entry, a merged cross-session feed on the right, and a per-session
// detail that reuses NarrationTimeline. Live agents are overlaid (matched by transcript path) so the
// primary action is Jump (live) or Resume (ended). @theme tokens only — no hardcoded colors.

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { SkeletonLine } from "@/app/element/skeleton";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentEntry } from "./agentsviewmodel";
import { formatAge, formatTokens } from "./agentsviewmodel";
import { projectCodexTranscript } from "./codextranscriptprojection";
import type { Runtime } from "./launch";
import { NarrationTimeline } from "./narrationtimeline";
import { runtimeMeta } from "./runtimemeta";
import {
    filterByStatus,
    groupByRecency,
    loadSessionsArchive,
    mergedFeed,
    overlayLive,
    sessionsArchiveAtom,
    totalEvents,
    type LiveSession,
    type SessionStatusFilter,
} from "./sessionsarchivestore";
import { SurfaceEmptyState, SurfaceHeader } from "./surfacescaffold";
import { projectTranscript } from "./transcriptprojection";

const EVENT_COLOR: Record<string, string> = {
    started: "var(--color-success)",
    asked: "var(--color-asking)",
    committed: "var(--color-accent)",
    errored: "var(--color-error)",
    finished: "var(--color-muted)",
};
function eventColor(t: string): string {
    return EVENT_COLOR[t] ?? "var(--color-muted)";
}

const STATUS_META: Record<string, { label: string; color: string }> = {
    running: { label: "Running", color: "var(--color-accent)" },
    done: { label: "Done", color: "var(--color-success)" },
    failed: { label: "Failed", color: "var(--color-error)" },
    waiting: { label: "Waiting", color: "var(--color-asking)" },
};
function statusOf(s: LiveSession): { label: string; color: string } {
    return s.live ? STATUS_META.running : STATUS_META[s.status] ?? STATUS_META.done;
}

const FILTERS: { key: SessionStatusFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "live", label: "Live" },
    { key: "done", label: "Done" },
    { key: "needs", label: "Needs attention" },
];

export function SessionsSurface({ model }: { model: AgentsViewModel }) {
    const base = useAtomValue(sessionsArchiveAtom);
    const roster = useAtomValue(model.agentsAtom);
    const now = useAtomValue(model.nowAtom);
    const [sel, setSel] = useAtom(model.sessionsSelAtom);
    const [filter, setFilter] = useAtom(model.sessionsStatusFilterAtom);

    useEffect(() => {
        fireAndForget(loadSessionsArchive);
    }, []);

    const live = base == null ? [] : overlayLive(base, roster, now);
    const shown = filterByStatus(live, filter);
    const groups = groupByRecency(shown, now);
    const liveCount = live.filter((s) => s.live).length;
    // detail resolves against the full set so a filter chip never blanks the open session.
    const selected = sel === "all" ? undefined : live.find((s) => `${s.runtime}:${s.id}` === sel);

    // publish the "All activity" + grouped-session order for global j/k list-nav. cursor==selection.
    const navIds = useMemo(
        () => ["all", ...groups.flatMap((g) => g.items.map((s) => `${s.runtime}:${s.id}`))],
        [groups]
    );
    const listNav = useMemo<ListNavController>(
        () => ({ surface: "sessions", navigableIds: navIds, cursorId: sel, setCursor: setSel }),
        [navIds, sel, setSel]
    );
    useSurfaceListNav(listNav);

    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <SurfaceHeader
                title="Sessions"
                badge={
                    liveCount > 0 ? (
                        <span className="inline-flex items-center gap-1.5 rounded-sm border border-accent bg-accentbg px-2 py-[3px] font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-accent-soft">
                            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                            {liveCount} live
                        </span>
                    ) : null
                }
                subtitle="Every agent session and its activity — one timeline per run, or the full feed across all of them."
                actions={
                    <div className="flex items-center gap-1 rounded border border-border bg-surface p-0.5">
                        {FILTERS.map((f) => (
                            <button
                                key={f.key}
                                type="button"
                                onClick={() => setFilter(f.key)}
                                className={cn(
                                    "cursor-pointer rounded-sm px-[11px] py-[5px] text-[11px] font-semibold",
                                    filter === f.key ? "bg-accentbg text-primary" : "text-ink-mid hover:text-primary"
                                )}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                }
            />

            {/* body: list + detail */}
            <div className="flex min-h-0 flex-1">
                {/* LEFT · session list */}
                <div className="w-[392px] flex-none overflow-y-auto border-r border-edge-faint p-3 pb-10">
                    <button
                        type="button"
                        onClick={() => setSel("all")}
                        className={cn(
                            "mb-3.5 flex w-full items-center gap-[11px] rounded-[11px] border px-[13px] py-[11px] text-left",
                            sel === "all" ? "border-accent bg-surface-hover" : "border-border bg-surface hover:border-edge-strong"
                        )}
                    >
                        <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] border border-accent bg-accentbg text-accent-soft">≡</span>
                        <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold text-primary">All activity</span>
                            <span className="block font-mono text-[11px] text-muted">Merged feed · every session</span>
                        </span>
                        <span className="rounded-full bg-surface-hover px-2 py-0.5 font-mono text-[11px] text-secondary">
                            {totalEvents(live)}
                        </span>
                    </button>

                    {base == null ? (
                        <div className="mt-4 flex flex-col gap-[7px]">
                            {Array.from({ length: 6 }).map((_, i) => (
                                <SkeletonLine key={i} className="h-[58px] rounded-[11px]" />
                            ))}
                        </div>
                    ) : groups.length === 0 ? (
                        <div className="mt-6">
                            <SurfaceEmptyState title="No sessions found" body="Sessions appear here as agents run." />
                        </div>
                    ) : (
                        groups.map((g) => (
                            <div key={g.key} className="mb-3.5">
                                <div className="flex items-center gap-2.5 px-1 pb-2 pt-0.5">
                                    <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.13em] text-accent-soft">
                                        {g.label}
                                    </span>
                                    <div className="h-px flex-1 bg-edge-faint" />
                                    <span className="font-mono text-[10px] text-muted">{g.items.length}</span>
                                </div>
                                <div className="flex flex-col gap-[7px]">
                                    {g.items.map((s) => {
                                        const st = statusOf(s);
                                        const active = sel === `${s.runtime}:${s.id}`;
                                        return (
                                            <button
                                                key={`${s.runtime}:${s.id}`}
                                                type="button"
                                                onClick={() => setSel(`${s.runtime}:${s.id}`)}
                                                className={cn(
                                                    "flex flex-col gap-[7px] rounded-[11px] border px-[13px] py-[11px] text-left",
                                                    active ? "border-accent bg-surface-hover" : "border-border bg-surface hover:border-edge-strong"
                                                )}
                                            >
                                                <span className="flex items-center gap-2.5">
                                                    <span className="h-2 w-2 flex-none rounded-full" style={{ backgroundColor: st.color }} />
                                                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-primary">
                                                        {s.task || "(untitled session)"}
                                                    </span>
                                                    <span
                                                        className="flex-none rounded-[4px] px-1.5 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[0.06em]"
                                                        style={{ color: st.color, backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)" }}
                                                    >
                                                        {st.label}
                                                    </span>
                                                </span>
                                                <span className="flex items-center gap-2 font-mono text-[10px] text-muted">
                                                    <span className="text-secondary">{s.projectname}</span>
                                                    <span className="text-edge-strong">·</span>
                                                    <span>{s.branch || "—"}</span>
                                                    <span className="flex-1" />
                                                    <span>{runtimeMeta(s.runtime).glyph}</span>
                                                    {s.tokenstotal > 0 ? (
                                                        <>
                                                            <span className="text-edge-strong">·</span>
                                                            <span>{formatTokens(s.tokenstotal)} tok</span>
                                                        </>
                                                    ) : null}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* RIGHT · detail */}
                <div className="min-w-0 flex-1 overflow-y-auto px-7 pb-12 pt-5">
                    {selected ? (
                        <SessionDetail model={model} session={selected} now={now} />
                    ) : (
                        <MergedFeed model={model} list={live} now={now} />
                    )}
                </div>
            </div>
        </div>
    );
}

function MergedFeed({ model, list, now }: { model: AgentsViewModel; list: LiveSession[]; now: number }) {
    const feed = mergedFeed(list);
    return (
        <>
            <div className="mb-3.5 flex items-center gap-2.5">
                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.13em] text-muted">All activity</span>
                <div className="h-px flex-1 bg-edge-faint" />
                <span className="font-mono text-[10px] text-muted">{feed.length} events</span>
            </div>
            {feed.length === 0 ? (
                <div className="mt-8 text-center text-[13px] text-muted">No recent activity.</div>
            ) : (
                <div className="flex flex-col">
                    {feed.map((e) => (
                        <button
                            key={e.key}
                            type="button"
                            onClick={() => globalStore.set(model.sessionsSelAtom, e.sessionKey)}
                            className="flex gap-4 border-b border-edge-faint px-1 py-3 text-left hover:bg-surface"
                        >
                            <span className="mt-1 h-[9px] w-[9px] flex-none rounded-full" style={{ backgroundColor: eventColor(e.type) }} />
                            <span className="min-w-0 flex-1">
                                <span className="block text-[13px] leading-[1.5] text-secondary">
                                    <span className="font-mono text-[12px] font-semibold text-accent-soft">{e.sessionTitle}</span> {e.text}
                                </span>
                                <span className="mt-1 flex items-center gap-2">
                                    <span className="font-mono text-[10px] font-medium uppercase tracking-[0.06em]" style={{ color: eventColor(e.type) }}>
                                        {e.type}
                                    </span>
                                    <span className="font-mono text-[10.5px] text-muted">{e.project}</span>
                                    <span className="font-mono text-[10.5px] text-muted">· {now - e.ts < 60_000 ? "now" : `${formatAge(now - e.ts)} ago`}</span>
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            )}
        </>
    );
}

function SessionDetail({ model, session, now }: { model: AgentsViewModel; session: LiveSession; now: number }) {
    const [entries, setEntries] = useState<AgentEntry[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        setEntries(null);
        if (!session.transcriptpath) {
            setEntries([]);
            return;
        }
        fireAndForget(async () => {
            try {
                const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path: session.transcriptpath, maxlines: 2000 });
                const lines = rtn.lines ?? [];
                const projected = session.runtime === "codex" ? projectCodexTranscript(lines) : projectTranscript(lines);
                if (!cancelled) {
                    setEntries(projected);
                }
            } catch {
                if (!cancelled) {
                    setEntries([]);
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [session.transcriptpath, session.runtime]);

    const st = statusOf(session);
    const rt = runtimeMeta(session.runtime);

    const act = () => {
        if (session.live && session.liveId) {
            globalStore.set(model.focusIdAtom, session.liveId);
            globalStore.set(model.terminalTargetAtom, undefined);
            globalStore.set(model.surfaceAtom, "agent");
            return;
        }
        if (session.resumecommand) {
            fireAndForget(() =>
                launchAgent(model, {
                    runtime: session.runtime as Runtime,
                    startupCommand: session.resumecommand,
                    task: "",
                    projectPath: session.projectpath,
                    projectName: session.projectname || "agent",
                })
            );
        }
    };

    const meta: { k: string; v: string }[] = [
        { k: "repo", v: session.projectname || "—" },
        { k: "branch", v: session.branch || "—" },
        { k: "duration", v: session.durationms > 0 ? formatAge(session.durationms) : "—" },
        { k: "tokens", v: session.tokenstotal > 0 ? `${formatTokens(session.tokenstotal)} tok` : "—" },
    ];

    return (
        <>
            <div className="mb-5 flex items-start gap-3.5 border-b border-edge-faint pb-4">
                <span className={cn("flex h-[42px] w-[42px] flex-none items-center justify-center rounded-[11px] border font-mono text-[15px]", rt.text, rt.softBg, rt.line)}>
                    {rt.glyph}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="mb-1.5 flex items-center gap-2.5">
                        <h2 className="text-[19px] font-bold tracking-[-0.01em] text-primary">{session.task || "(untitled session)"}</h2>
                        <span className="rounded-[5px] px-1.5 py-[3px] font-mono text-[9px] font-bold uppercase tracking-[0.06em]" style={{ color: st.color, backgroundColor: "color-mix(in srgb, currentColor 14%, transparent)" }}>
                            {st.label}
                        </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2.5 font-mono text-[11px] text-muted">
                        {meta.map((m) => (
                            <span key={m.k}>
                                <span className="text-edge-strong">{m.k} </span>
                                <span className="text-secondary">{m.v}</span>
                            </span>
                        ))}
                    </div>
                </div>
                <button
                    type="button"
                    onClick={act}
                    disabled={!session.live && !session.resumecommand}
                    className={cn(
                        "flex-none cursor-pointer rounded px-[13px] py-[7px] text-[12px] font-semibold",
                        session.live
                            ? "bg-accent text-background hover:opacity-90"
                            : "border border-border text-ink-mid hover:border-accent hover:text-accent-soft disabled:cursor-default disabled:opacity-40"
                    )}
                >
                    {session.live ? "Jump →" : "Resume →"}
                </button>
            </div>

            <div className="mb-3.5 flex items-center gap-2.5">
                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.13em] text-muted">Activity</span>
                <div className="h-px flex-1 bg-edge-faint" />
                <span className="font-mono text-[10px] text-muted">{entries?.length ?? 0} events</span>
            </div>

            {entries == null ? (
                <div className="text-[13px] text-muted">Loading transcript…</div>
            ) : entries.length === 0 ? (
                <div className="text-[13px] text-muted">No activity to show.</div>
            ) : (
                <NarrationTimeline entries={entries} active={session.live} />
            )}
        </>
    );
}
