// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The project Overview's History region: the last 7 days of ended sessions, with the runs they started.

import { globalStore } from "@/app/store/jotaiStore";
import { isEditableTarget } from "@/app/store/keybindings/dispatcher";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { LINK_BTN, MONO_FAINT, MONO_META, ROW_BORDER } from "@/app/view/jarvis/briefstyle";
import { openTarget } from "@/app/view/jarvis/openref";
import { landOn } from "@/app/view/jarvis/returnsurface";
import { cn, fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatAgeShort } from "./agentsviewmodel";
import { RegionAlert, RegionHead, RegionNote, RegionSkeleton, type OverviewRegionProps } from "./overviewregion";
import {
    HISTORY_PAGE,
    historyEntries,
    historyRuns,
    runCardId,
    sessionLine,
    sessionTitle,
    type HistoryEntry,
    type HistoryRunItem,
} from "./projecthistorymodel";
import { projectListAtom } from "./projectsstore";
import { runtimeMeta } from "./runtimemeta";
import {
    loadSessionsArchive,
    overlayLive,
    sessionsArchiveAtom,
    sessionsErrorAtom,
    type LiveSession,
} from "./sessionsarchivestore";
import { sessionKey } from "./sessionsruns";
import { usePaging } from "./sessionssurface";

const MINUTE_MS = 60_000;

const DIAMOND: Record<HistoryRunItem["tone"], string> = {
    ok: "bg-success",
    warn: "bg-warning",
    muted: "bg-muted",
};

type RunsRead = { runs: Run[] | null; error: string | null };

// the project channel's runs, read once per channel and again on each Retry; null runs = still reading
function useChannelRuns(channelId: string | undefined, attempt: number): RunsRead {
    const [read, setRead] = useState<RunsRead>({ runs: null, error: null });
    useEffect(() => {
        if (!channelId) {
            setRead({ runs: [], error: null });
            return;
        }
        setRead({ runs: null, error: null });
        let live = true;
        RpcApi.GetChannelRunsCommand(TabRpcClient, { channelid: channelId })
            .then((rtn) => {
                if (live) {
                    setRead({ runs: rtn.runs ?? [], error: null });
                }
            })
            .catch((e) => {
                console.warn(`project overview: runs read failed for channel ${channelId}:`, e);
                if (live) {
                    setRead({ runs: [], error: e instanceof Error ? e.message : String(e) });
                }
            });
        return () => {
            live = false;
        };
    }, [channelId, attempt]);
    return read;
}

// each listed run's dag, read from the object store (loaded on first read)
function useDags(runs: Run[]): Record<string, TaskGroup | undefined> {
    const key = runs
        .map((r) => r.dagoref)
        .filter(Boolean)
        .join(",");
    const dagsAtom = useMemo(
        () =>
            atom((get) => {
                const out: Record<string, TaskGroup | undefined> = {};
                for (const id of key.split(",").filter(Boolean)) {
                    out[id] = get(WOS.getWaveObjectAtom<TaskGroup>(WOS.makeORef("dag", id)));
                }
                return out;
            }),
        [key]
    );
    return useAtomValue(dagsAtom);
}

// "/" anywhere in the modal but a field focuses the search box
function useSlashFocus(sectionRef: React.RefObject<HTMLElement>, inputRef: React.RefObject<HTMLInputElement>) {
    useEffect(() => {
        const root = sectionRef.current?.closest("[data-project-overview]");
        if (root == null) {
            return;
        }
        const onKey = (e: Event) => {
            const k = e as KeyboardEvent;
            if (k.key !== "/" || k.ctrlKey || k.metaKey || k.altKey || isEditableTarget(k.target as Element)) {
                return;
            }
            k.preventDefault();
            inputRef.current?.focus();
        };
        root.addEventListener("keydown", onKey);
        return () => root.removeEventListener("keydown", onKey);
    }, [sectionRef, inputRef]);
}

export function ProjectHistory({ model, project, path, close }: OverviewRegionProps) {
    const base = useAtomValue(sessionsArchiveAtom);
    const sessionsFailed = useAtomValue(sessionsErrorAtom);
    const roster = useAtomValue(model.agentsAtom);
    const lineage = useAtomValue(model.lineageAtom);
    const now = useAtomValue(model.nowAtom);
    const channelId = useAtomValue(projectListAtom).find((r) => r.name === project)?.channel?.oid;
    const [attempt, setAttempt] = useState(0);
    const runsRead = useChannelRuns(channelId, attempt);
    const [query, setQuery] = useState("");
    const sectionRef = useRef<HTMLElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    useSlashFocus(sectionRef, inputRef);

    useEffect(() => {
        fireAndForget(loadSessionsArchive);
    }, []);

    // ages and the window move by the minute, not by the 1 s clock
    const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
    const runs = useMemo(() => historyRuns(runsRead.runs ?? [], minute), [runsRead.runs, minute]);
    const dags = useDags(runs);
    const sessions = useMemo(() => (base ? overlayLive(base, roster) : []), [base, roster]);
    const all = useMemo(
        () => historyEntries(sessions, runs, dags, path, minute, ""),
        [sessions, runs, dags, path, minute]
    );
    const shown = useMemo(
        () => (query.trim() ? historyEntries(sessions, runs, dags, path, minute, query) : all),
        [all, sessions, runs, dags, path, minute, query]
    );
    const sessionCount = all.filter((e) => e.kind === "session").length;
    const loading = base == null || runsRead.runs == null;
    // the sentinel mounts only once loading ends; a zero total until then makes the pager observe it when it does
    const { count, setCount, sentinelRef } = usePaging(HISTORY_PAGE, loading ? 0 : shown.length);
    useEffect(() => setCount(HISTORY_PAGE), [query, project, setCount]);

    const openSession = (s: LiveSession) => {
        globalStore.set(model.sessionsSelAtom, sessionKey(s));
        landOn(model.surfaceAtom, "sessions");
        close();
    };
    // the run's Cockpit card while it has one; an ended run has none, so its sheet on the Hub
    const openRun = (runId: string) => {
        const cardId = runCardId(lineage, roster, runId);
        if (cardId != null) {
            globalStore.set(model.cursorIdAtom, cardId);
            globalStore.set(model.surfaceAtom, "cockpit");
        } else {
            fireAndForget(() => openTarget(model, { kind: "run", runId }));
        }
        close();
    };
    const openSessions = () => {
        landOn(model.surfaceAtom, "sessions");
        close();
    };

    return (
        <section ref={sectionRef} aria-label="History" className="flex flex-col gap-1.5">
            <RegionHead
                label="History"
                count={loading ? null : `${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`}
                aside={<span className={MONO_FAINT}>last 7 days</span>}
            />
            {sessionsFailed ? (
                <RegionAlert onRetry={() => fireAndForget(loadSessionsArchive)}>Could not read sessions.</RegionAlert>
            ) : null}
            {runsRead.error != null ? (
                <RegionAlert onRetry={() => setAttempt((n) => n + 1)}>
                    Could not read runs, so sessions show without them.{" "}
                    <span className="font-mono text-[11px] text-muted">{runsRead.error}</span>
                </RegionAlert>
            ) : null}
            {loading ? (
                <RegionSkeleton rows={6} />
            ) : (
                <>
                    {all.length > 0 ? <HistorySearch inputRef={inputRef} query={query} setQuery={setQuery} /> : null}
                    {all.length === 0 && !sessionsFailed ? (
                        <RegionNote>No sessions in {project} in the last 7 days.</RegionNote>
                    ) : null}
                    {all.length > 0 && shown.length === 0 ? (
                        <RegionNote>No sessions match “{query.trim()}”.</RegionNote>
                    ) : null}
                    <div data-history-list className="flex flex-col">
                        {shown.slice(0, count).map((e) => (
                            <HistoryRow
                                key={e.key}
                                entry={e}
                                now={minute}
                                openSession={openSession}
                                openRun={openRun}
                            />
                        ))}
                        <div ref={sentinelRef} aria-hidden="true" />
                    </div>
                </>
            )}
            <button type="button" onClick={openSessions} className={cn(LINK_BTN, "mt-2")}>
                older sessions in Sessions ↗
            </button>
        </section>
    );
}

function HistorySearch({
    inputRef,
    query,
    setQuery,
}: {
    inputRef: React.RefObject<HTMLInputElement>;
    query: string;
    setQuery: (q: string) => void;
}) {
    return (
        <label className="mb-1 mt-0.5 flex h-[30px] items-center gap-2 rounded-[8px] border border-edge-mid bg-surface px-2.5">
            <Search size={13} aria-hidden className="flex-none text-muted" />
            <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search this project's history"
                placeholder="Search this project's history"
                className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-primary outline-none placeholder:text-muted"
            />
            <span className="rounded-[4px] border border-edge-mid px-[5px] font-mono text-[10.5px] text-ink-faint">
                /
            </span>
        </label>
    );
}

function HistoryRow({
    entry,
    now,
    openSession,
    openRun,
}: {
    entry: HistoryEntry;
    now: number;
    openSession: (s: LiveSession) => void;
    openRun: (runId: string) => void;
}) {
    if (entry.kind === "run") {
        return <RunRow run={entry.run} now={now} nested={false} onOpen={() => openRun(entry.run.runId)} />;
    }
    const s = entry.session;
    const rt = runtimeMeta(s.runtime);
    return (
        <>
            <button
                type="button"
                data-history-session={sessionKey(s)}
                onClick={() => openSession(s)}
                className={cn(
                    "flex w-full cursor-pointer flex-col gap-[3px] py-[9px] text-left hover:bg-surface-hover",
                    ROW_BORDER
                )}
            >
                <span className="flex w-full items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-primary">{sessionTitle(s)}</span>
                    <span className={MONO_FAINT}>{formatAgeShort(now - s.lastactivets)}</span>
                </span>
                <span className={cn("flex items-center gap-1.5", MONO_META)}>
                    <span aria-hidden className={cn("h-1.5 w-1.5 flex-none rounded-[2px] bg-current", rt.text)} />
                    {sessionLine(s)}
                </span>
            </button>
            {entry.runs.map((r) => (
                <RunRow key={r.key} run={r} now={now} nested onOpen={() => openRun(r.runId)} />
            ))}
        </>
    );
}

function RunRow({
    run,
    now,
    nested,
    onOpen,
}: {
    run: HistoryRunItem;
    now: number;
    nested: boolean;
    onOpen: () => void;
}) {
    return (
        <button
            type="button"
            data-history-run={run.runId}
            data-history-nested={nested ? "" : undefined}
            onClick={onOpen}
            className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 py-[7px] text-left hover:bg-surface-hover",
                ROW_BORDER,
                nested && "pl-[15px]"
            )}
        >
            {nested ? (
                <span
                    aria-hidden
                    className="-mt-3.5 h-[18px] w-[9px] flex-none rounded-bl-[4px] border-b border-l border-edge-strong"
                />
            ) : null}
            <span aria-hidden className={cn("h-[7px] w-[7px] flex-none rotate-45 rounded-[1px]", DIAMOND[run.tone])} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[12.5px] text-secondary">{run.title}</span>
                <span className={MONO_META}>
                    <span className="text-accent-soft">run</span>
                    {run.line ? ` · ${run.line}` : null}
                    <span className="text-warning">{run.warn}</span>
                </span>
            </span>
            <span className={MONO_FAINT}>{formatAgeShort(now - run.ts)}</span>
        </button>
    );
}
