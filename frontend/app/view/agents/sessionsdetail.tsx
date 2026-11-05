// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Sessions surface's right pane: a run (its lead and tasks, and the session of the one in view) or a single
// session, each read as its transcript or its lifecycle events. @theme tokens only.

import { launchAgentOrToast } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { openOrPeek } from "@/app/view/jarvis/openref";
import { landOn } from "@/app/view/jarvis/returnsurface";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, ChevronUp, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentEntry } from "./agentsviewmodel";
import { formatAge, formatAgeShort, formatTokens, groupTimeline } from "./agentsviewmodel";
import { docTextOf, rangeOf } from "./docreviewnotesview";
import { NarrationTimeline } from "./narrationtimeline";
import { runtimeMeta } from "./runtimemeta";
import type { LiveSession } from "./sessionsarchivestore";
import { findEnded, findRanges, findTerms, stepFind, type SessionsFind } from "./sessionsfind";
import {
    LEAD_MEMBER,
    resumeLaunchOpts,
    sessionKey,
    sessionPrimary,
    soloStatus,
    type RunMember,
    type RunView,
    type Status,
    type StatusKey,
} from "./sessionsruns";
import { eventTime, startedLabel } from "./sessionstime";
import { LIVE_REFRESH_MS, mayHaveEarlier, shouldStick, transcriptMaxLines } from "./sessionstranscript";
import { projectorFor } from "./transcriptregistry";
import { TranscriptSkeleton } from "./transcriptskeleton";

const STATUS_STYLE: Record<StatusKey, { color: string; mark: "pulse" | "dot" | "check" | "ring" | "none" }> = {
    running: { color: "var(--color-working)", mark: "pulse" },
    asking: { color: "var(--color-asking)", mark: "pulse" },
    review: { color: "var(--color-accent)", mark: "dot" },
    idle: { color: "var(--color-ink-mid)", mark: "dot" },
    pending: { color: "var(--color-muted)", mark: "ring" },
    done: { color: "var(--color-muted)", mark: "check" },
    failed: { color: "var(--color-error)", mark: "dot" },
    muted: { color: "var(--color-muted)", mark: "none" },
};

// landed recedes to grey so a running task never reads as finished
export const SEG_COLOR: Record<StatusKey, string> = {
    running: "var(--color-working)",
    asking: "var(--color-asking)",
    review: "var(--color-accent)",
    idle: "var(--color-ink-mid)",
    pending: "var(--color-edge-strong)",
    done: "var(--color-muted)",
    failed: "var(--color-error)",
    muted: "var(--color-edge-strong)",
};

const EVENT_COLOR: Record<string, string> = {
    started: "var(--color-success)",
    asked: "var(--color-asking)",
    committed: "var(--color-accent)",
    errored: "var(--color-error)",
    finished: "var(--color-muted)",
};
export function eventColor(t: string): string {
    return EVENT_COLOR[t] ?? "var(--color-muted)";
}

// the one status marker a row carries: a dot, a check or a ring, then its word
export function StatusMark({ status, className }: { status: Status; className?: string }) {
    const st = STATUS_STYLE[status.key];
    return (
        <span
            className={cn("inline-flex flex-none items-center gap-[5px] font-mono text-[10.5px]", className)}
            style={{ color: st.color }}
        >
            {st.mark === "pulse" || st.mark === "dot" ? (
                <span
                    className={cn("h-1.5 w-1.5 rounded-full", st.mark === "pulse" && "pulse-dot")}
                    style={{ backgroundColor: st.color }}
                />
            ) : null}
            {st.mark === "check" ? <Check size={11} strokeWidth={2.6} aria-hidden /> : null}
            {st.mark === "ring" ? <span className="h-[5px] w-[5px] rounded-full border border-muted" /> : null}
            <span className="truncate">{status.text}</span>
        </span>
    );
}

// A session's primary action: Jump to the live agent, else Resume the ended session; a blocked one does nothing.
// Shared by the detail buttons (mouse) and list-nav Enter (keyboard) so both do exactly one thing.
export function runSessionPrimary(model: AgentsViewModel, session: LiveSession) {
    const primary = sessionPrimary(session);
    if (primary?.kind === "jump" && session.liveId) {
        globalStore.set(model.focusIdAtom, session.liveId);
        landOn(model.surfaceAtom, "agent");
        return;
    }
    if (primary?.kind === "resume") {
        fireAndForget(() => launchAgentOrToast(model, resumeLaunchOpts(session)));
    }
}

function PrimaryButton({ model, session, strong }: { model: AgentsViewModel; session: LiveSession; strong?: boolean }) {
    const primary = sessionPrimary(session);
    if (primary == null) {
        return null;
    }
    if ("reason" in primary) {
        return (
            <span data-sessions-resume-blocked="" className="flex min-w-0 items-center gap-2.5">
                <span className="min-w-0 max-w-[280px] truncate text-[11.5px] text-muted" title={primary.reason}>
                    {primary.reason}
                </span>
                <button
                    type="button"
                    disabled
                    className="flex-none cursor-default rounded-[7px] border border-edge-mid bg-surface-raised px-[11px] py-[5px] text-[12px] font-semibold text-muted opacity-60"
                >
                    Resume
                </button>
            </span>
        );
    }
    return (
        <button
            type="button"
            onClick={() => runSessionPrimary(model, session)}
            className={cn(
                "flex-none cursor-pointer rounded-[7px] text-[12px] font-semibold",
                strong && session.live
                    ? "bg-accent px-[13px] py-[7px] text-background hover:opacity-90"
                    : "border border-edge-strong bg-surface-raised px-[11px] py-[5px] text-secondary hover:border-accent hover:text-accent-soft"
            )}
        >
            {primary.kind === "jump" ? "Jump →" : "Resume →"}
        </button>
    );
}

function ViewToggle({ model, className }: { model: AgentsViewModel; className?: string }) {
    const [view, setView] = useAtom(model.sessionsViewAtom);
    const options: { key: typeof view; label: string }[] = [
        { key: "activity", label: "Activity" },
        { key: "transcript", label: "Transcript" },
    ];
    return (
        <div
            role="group"
            aria-label="Session view"
            className={cn("flex flex-none gap-0.5 rounded-[7px] border border-border bg-background p-0.5", className)}
        >
            {options.map((o) => (
                <button
                    key={o.key}
                    type="button"
                    aria-pressed={view === o.key}
                    onClick={() => setView(o.key)}
                    className={cn(
                        "cursor-pointer rounded-[5px] px-[9px] py-[3px] text-[11px] font-semibold",
                        view === o.key ? "bg-accentbg text-primary" : "text-ink-mid hover:text-primary"
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function Meta({ items, className }: { items: { k: string; v: string }[]; className?: string }) {
    return (
        <div className={cn("flex flex-wrap items-center gap-3.5 font-mono text-[11px]", className)}>
            {items.map((m) => (
                <span key={m.k}>
                    <span className="text-muted">{m.k} </span>
                    <span className="text-secondary">{m.v}</span>
                </span>
            ))}
        </div>
    );
}

interface TranscriptRead {
    entries: AgentEntry[] | null;
    error: string | null;
    // lines the last read returned
    fetched: number;
}

const UNREAD: TranscriptRead = { entries: null, error: null, fetched: 0 };

// useTranscript reads a session's transcript, and again every LIVE_REFRESH_MS while it is live; a reread keeps the
// entries shown until it lands, and one that returns the same lines changes nothing.
function useTranscript(session: LiveSession | undefined, full: boolean): TranscriptRead {
    const path = session?.transcriptpath;
    const runtime = session?.runtime;
    const live = !!session?.live;
    const [read, setRead] = useState<TranscriptRead & { of?: string }>(UNREAD);
    useEffect(() => {
        if (!path || !runtime) {
            setRead({ of: path, entries: [], error: null, fetched: 0 });
            return;
        }
        let cancelled = false;
        let inflight = false;
        let lastKey: string | null = null;
        const maxlines = transcriptMaxLines(runtime, full);
        const load = async () => {
            if (inflight) {
                return;
            }
            inflight = true;
            try {
                const lines = (await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path, maxlines })).lines ?? [];
                const key = `${lines.length}:${lines[lines.length - 1] ?? ""}`;
                if (cancelled || key === lastKey) {
                    return;
                }
                lastKey = key;
                const entries = projectorFor(runtime, path).project(lines);
                setRead({ of: path, entries, error: null, fetched: lines.length });
            } catch (e) {
                console.warn(`reading transcript ${path} failed`, e);
                if (!cancelled) {
                    const error = e instanceof Error ? e.message : String(e);
                    // a failed reread keeps what an earlier read showed
                    setRead((prev) =>
                        prev.of === path && prev.entries != null ? prev : { ...UNREAD, of: path, error }
                    );
                }
            } finally {
                inflight = false;
            }
        };
        fireAndForget(load);
        const timer = live ? setInterval(() => fireAndForget(load), LIVE_REFRESH_MS) : null;
        return () => {
            cancelled = true;
            if (timer != null) {
                clearInterval(timer);
            }
        };
    }, [path, runtime, full, live]);
    return read.of === path ? read : UNREAD;
}

// an event time column fits HH:MM, or a date and time once any event is from another day
const EVENT_TIME_COL = "grid-cols-[44px_8px_minmax(0,1fr)]";
const EVENT_DATE_COL = "grid-cols-[112px_8px_minmax(0,1fr)]";

// mark is the event a search hit opened at
function ActivityList({ events, mark }: { events: SessionEvent[]; mark?: number }) {
    const markRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        markRef.current?.scrollIntoView({ block: "center" });
    }, [mark]);
    const now = Date.now();
    const times = events.map((e) => eventTime(e.ts, now));
    const dated = events.some((e) => new Date(e.ts).toDateString() !== new Date(now).toDateString());
    return (
        <div className="flex flex-col">
            {events.map((e, i) => (
                <div
                    key={i}
                    ref={i === mark ? markRef : undefined}
                    aria-current={i === mark ? true : undefined}
                    data-sessions-event=""
                    className={cn(
                        "grid gap-x-3.5 border-b border-edge-faint py-2.5",
                        dated ? EVENT_DATE_COL : EVENT_TIME_COL,
                        i === mark && "rounded-[6px] ring-1 ring-inset ring-accent"
                    )}
                >
                    <span data-sessions-event-time="" className="pt-0.5 font-mono text-[10.5px] text-muted">
                        {times[i]}
                    </span>
                    <span
                        className="mt-[7px] h-[7px] w-[7px] rounded-full"
                        style={{ backgroundColor: eventColor(e.type) }}
                    />
                    <span className="min-w-0">
                        <span className="block text-[13px] leading-[1.5] text-secondary">{e.text}</span>
                        <span
                            className="mt-0.5 block font-mono text-[10.5px] uppercase tracking-[0.06em]"
                            style={{ color: eventColor(e.type) }}
                        >
                            {e.type}
                        </span>
                    </span>
                </div>
            ))}
        </div>
    );
}

const HIGHLIGHT_FIND = "sessions-find";
const HIGHLIGHT_FIND_CURRENT = "sessions-find-current";
const highlights = () => (typeof CSS !== "undefined" ? CSS.highlights : undefined);

const firstPos = (f: SessionsFind | null) => (f?.target.kind === "turn" ? f.target.ord : 0);

// Selecting another session ends the find, decided from the selection atoms: an outgoing detail still renders
// the old session while the pane animates, and must not clear the find just opened on the new one.
function useEndFindElsewhere(model: AgentsViewModel) {
    const [find, setFind] = useAtom(model.sessionsFindAtom);
    const sel = useAtomValue(model.sessionsSelAtom);
    const member = useAtomValue(model.sessionsMemberAtom);
    useEffect(() => {
        if (findEnded(find, sel, member)) {
            setFind(null);
        }
    }, [find, sel, member]);
}

function FindBar({
    text,
    onText,
    pos,
    total,
    onStep,
    onClose,
}: {
    text: string;
    onText: (v: string) => void;
    pos: number;
    // null while the transcript is still loading
    total: number | null;
    onStep: (dir: 1 | -1) => void;
    onClose: () => void;
}) {
    const stepButton = (dir: 1 | -1, label: string, icon: ReactNode) => (
        <button
            type="button"
            aria-label={label}
            disabled={!total}
            onClick={() => onStep(dir)}
            className="flex h-6 w-6 flex-none cursor-pointer items-center justify-center rounded-[5px] text-ink-mid hover:bg-surface-hover hover:text-primary disabled:cursor-default disabled:opacity-40"
        >
            {icon}
        </button>
    );
    return (
        <div
            data-sessions-find
            className="sticky top-0 z-10 mb-2 flex items-center gap-2 rounded-[8px] border border-edge-mid bg-surface-raised py-1 pl-2.5 pr-1"
        >
            <Search size={13} className="flex-none text-muted" aria-hidden />
            <input
                autoFocus
                aria-label="Find in transcript"
                value={text}
                onChange={(e) => onText(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== "Escape") {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === "Escape") {
                        onClose();
                    } else {
                        onStep(e.shiftKey ? -1 : 1);
                    }
                }}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-primary outline-none"
            />
            <span data-find-pos className="flex-none font-mono text-[11px] text-muted">
                {total == null ? "" : total > 0 ? `${pos + 1} of ${total}` : "No matches in transcript"}
            </span>
            {stepButton(-1, "Previous match", <ChevronUp size={14} strokeWidth={2.2} aria-hidden />)}
            {stepButton(1, "Next match", <ChevronDown size={14} strokeWidth={2.2} aria-hidden />)}
        </div>
    );
}

// SessionBody is the scrolling read of one session: its transcript, opened at the end, or its events. A session
// opened from a search hit opens at the hit instead, with a find bar over every match in its prompts and replies.
function SessionBody({
    model,
    session,
    empty,
    className,
}: {
    model: AgentsViewModel;
    session?: LiveSession;
    empty: string;
    className?: string;
}) {
    const view = useAtomValue(model.sessionsViewAtom);
    const anyFind = useAtomValue(model.sessionsFindAtom);
    const setFind = useSetAtom(model.sessionsFindAtom);
    const key = session ? sessionKey(session) : null;
    const find = key != null && anyFind?.sessionKey === key ? anyFind : null;

    // a found session keeps its whole transcript once the bar closes, so closing neither reloads nor jumps
    const [fullFor, setFullFor] = useState<string | null>(null);
    if (find != null && fullFor !== key) {
        setFullFor(key);
    }
    const full = key != null && fullFor === key;
    const read = useTranscript(view === "transcript" ? session : undefined, full);
    const entries = read.entries;
    const items = useMemo(() => (entries == null ? 0 : groupTimeline(entries).length), [entries]);
    const earlier =
        session != null &&
        entries != null &&
        entries.length > 0 &&
        mayHaveEarlier(read.fetched, transcriptMaxLines(session.runtime, full), items, full);

    // the bar's query, editable to refine the find; a new hit resets it
    const [edit, setEdit] = useState({ of: find, text: find?.query ?? "", pos: firstPos(find) });
    if (edit.of !== find) {
        setEdit({ of: find, text: find?.query ?? "", pos: firstPos(find) });
    }
    const terms = find == null ? [] : edit.text === find.query ? find.terms : findTerms(edit.text);
    const termsKey = JSON.stringify(terms);

    // whether the reader was at the bottom before the last update: a reread follows the end only then, a first read
    // opens at the end, and a find places the view itself
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickRef = useRef(true);
    const onScroll = () => {
        const el = scrollRef.current;
        if (el != null) {
            stickRef.current = shouldStick(el.scrollTop, el.scrollHeight, el.clientHeight);
        }
    };
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (entries == null) {
            stickRef.current = true;
            return;
        }
        if (el && entries.length && stickRef.current && find == null) {
            el.scrollTop = el.scrollHeight;
        }
    }, [entries]);
    const showEarlier = () => {
        stickRef.current = false;
        setFullFor(key);
    };

    // the matches, in document order, over the text of each prompt and reply as drawn
    const [ranges, setRanges] = useState<Range[] | null>(null);
    useLayoutEffect(() => {
        const root = scrollRef.current;
        if (find == null || entries == null || root == null) {
            setRanges(null);
            return;
        }
        const turns = [...root.querySelectorAll("[data-find-turn]")];
        setRanges(turns.flatMap((el) => findRanges(docTextOf(el), terms).flatMap(([s, e]) => rangeOf(el, s, e) ?? [])));
    }, [entries, find, termsKey]);

    const total = ranges?.length ?? 0;
    const cur = total > 0 ? Math.min(edit.pos, total - 1) : 0;
    useLayoutEffect(() => {
        const registry = highlights();
        const scroller = scrollRef.current;
        if (registry == null || ranges == null || scroller == null) {
            return;
        }
        registry.set(HIGHLIGHT_FIND, new Highlight(...ranges));
        registry.set(HIGHLIGHT_FIND_CURRENT, new Highlight(...ranges.slice(cur, cur + 1)));
        const r = ranges[cur]?.getBoundingClientRect();
        if (r != null) {
            const box = scroller.getBoundingClientRect();
            scroller.scrollTop += r.top - box.top - (box.height - r.height) / 2;
        }
        return () => {
            registry.delete(HIGHLIGHT_FIND);
            registry.delete(HIGHLIGHT_FIND_CURRENT);
        };
    }, [ranges, cur]);

    let body: ReactNode;
    if (session == null) {
        body = <div className="py-4 text-[13px] text-muted">{empty}</div>;
    } else if (view === "activity") {
        body =
            session.events.length > 0 ? (
                <ActivityList
                    events={session.events}
                    mark={find?.target.kind === "event" ? find.target.ord : undefined}
                />
            ) : (
                <div className="py-4 text-[13px] text-muted">No activity yet.</div>
            );
    } else if (read.error != null) {
        body = (
            <div data-sessions-transcript-error="" className="flex flex-col gap-1 py-4 text-[13px]">
                <span className="text-secondary">Couldn't read the transcript</span>
                <span className="break-all font-mono text-[11px] text-muted">{session.transcriptpath}</span>
                <span className="break-words font-mono text-[11px] text-error">{read.error}</span>
            </div>
        );
    } else if (entries == null) {
        body = <TranscriptSkeleton className="pt-3" />;
    } else if (entries.length === 0) {
        body = <div className="py-4 text-[13px] text-muted">No transcript to show.</div>;
    } else {
        body = (
            <>
                {earlier ? (
                    <button
                        type="button"
                        data-sessions-earlier=""
                        onClick={showEarlier}
                        className="w-full cursor-pointer rounded-[6px] py-2 text-center text-[12px] font-semibold text-muted hover:bg-surface-hover hover:text-primary"
                    >
                        Show earlier turns
                    </button>
                ) : null}
                <NarrationTimeline entries={entries} active={session.live} renderAll={full} />
            </>
        );
    }
    return (
        <div
            ref={scrollRef}
            onScroll={onScroll}
            data-session-key={key ?? undefined}
            className={cn("min-h-0 flex-1 overflow-y-auto", className)}
        >
            {find != null && view === "transcript" ? (
                <FindBar
                    text={edit.text}
                    onText={(text) => setEdit({ ...edit, text, pos: 0 })}
                    pos={cur}
                    total={ranges?.length ?? null}
                    onStep={(dir) => setEdit({ ...edit, pos: stepFind(cur, total, dir) })}
                    onClose={() => setFind(null)}
                />
            ) : null}
            {body}
        </div>
    );
}

function sessionMeta(s: LiveSession | undefined, extra: { k: string; v: string }[] = []): { k: string; v: string }[] {
    if (s == null) {
        return extra;
    }
    return [
        { k: "runtime", v: runtimeMeta(s.runtime).label.toLowerCase() },
        ...extra,
        { k: "branch", v: s.branch || "—" },
        ...timeMeta(s.startedts, s.durationms),
        { k: "tokens", v: s.tokenstotal > 0 ? `${formatTokens(s.tokenstotal)} tok` : "—" },
    ];
}

function timeMeta(startedts: number, ranMs: number): { k: string; v: string }[] {
    return [
        { k: "started", v: startedts > 0 ? startedLabel(startedts, Date.now()) : "—" },
        { k: "ran", v: ranMs > 0 ? formatAgeShort(ranMs) : "—" },
    ];
}

function RuntimeTile({ runtime }: { runtime: string }) {
    const rt = runtimeMeta(runtime);
    return (
        <span
            className={cn(
                "flex h-[42px] w-[42px] flex-none items-center justify-center rounded-[10px] border font-mono text-[15px]",
                rt.text,
                rt.softBg,
                rt.line
            )}
        >
            {rt.glyph}
        </span>
    );
}

export function SoloDetail({ model, session }: { model: AgentsViewModel; session: LiveSession }) {
    useEndFindElsewhere(model);
    const status = soloStatus(session);
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div data-sessions-solo-header="" className="@container mb-1 flex-none border-b border-edge-faint pb-4">
                <div className="flex flex-wrap items-start gap-x-3.5 gap-y-3">
                    <RuntimeTile runtime={session.runtime} />
                    <div className="min-w-0 flex-1">
                        <div className="mb-[7px] flex items-center gap-3">
                            <h2 className="truncate text-[19px] font-bold tracking-[-0.01em] text-primary">
                                {session.task || "(untitled session)"}
                            </h2>
                            <StatusMark status={status} />
                        </div>
                        <Meta
                            items={[{ k: "project", v: session.projectname || "—" }, ...sessionMeta(session).slice(1)]}
                        />
                    </div>
                    <div className="flex flex-none items-center gap-3.5 self-center @max-[600px]:basis-full @max-[600px]:pl-14">
                        <ViewToggle model={model} />
                        <PrimaryButton model={model} session={session} strong />
                    </div>
                </div>
            </div>
            <SessionBody model={model} session={session} empty="" className="pb-2" />
        </div>
    );
}

function memberEmpty(m: RunMember): string {
    if (m.status.key === "pending") {
        return m.waitsOn?.length ? `Starts when task ${m.waitsOn.join(", ")} lands.` : "Not started yet.";
    }
    return m.key === LEAD_MEMBER ? "No lead session recorded." : "No session recorded for this task.";
}

function MemberRow({
    model,
    view,
    member,
    current,
}: {
    model: AgentsViewModel;
    view: RunView;
    member: RunMember;
    current: boolean;
}) {
    const rt = runtimeMeta(view.runtime);
    const isLead = member.key === LEAD_MEMBER;
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (current) {
            ref.current?.scrollIntoView({ block: "nearest" });
        }
    }, [current]);
    return (
        <button
            ref={ref}
            type="button"
            data-sessions-member={member.key}
            aria-current={current}
            onClick={() => globalStore.set(model.sessionsMemberAtom, member.key)}
            className={cn(
                "grid h-[30px] flex-none cursor-pointer grid-cols-[22px_minmax(0,1fr)_150px_56px_36px] items-center gap-x-3 rounded-[6px] px-2 text-left",
                current ? "bg-surface-selected" : "hover:bg-surface-hover"
            )}
        >
            <span className={cn("text-center font-mono text-[10.5px]", isLead ? rt.text : "text-muted")}>
                {isLead ? rt.glyph : member.num}
            </span>
            <span
                className={cn(
                    "truncate text-[12.5px]",
                    member.status.key === "done" ? "text-ink-mid" : "text-secondary"
                )}
            >
                {member.label}
            </span>
            <StatusMark status={member.status} />
            <span className="text-right font-mono text-[10.5px] text-muted">
                {member.tokens > 0 ? formatTokens(member.tokens) : "—"}
            </span>
            <span className="text-right font-mono text-[10.5px] text-muted">
                {member.durationMs > 0 ? formatAgeShort(member.durationMs) : "—"}
            </span>
        </button>
    );
}

export function RunDetail({
    model,
    view,
    member,
    memberSession,
    now,
}: {
    model: AgentsViewModel;
    view: RunView;
    member: RunMember;
    // the session the member in view opens, including a live one the scan has not picked up yet
    memberSession?: LiveSession;
    now: number;
}) {
    useEndFindElsewhere(model);
    const lead = view.members[0].session;
    const head: Status =
        view.live || view.head.key !== "done"
            ? view.head
            : { key: "done", text: `done · ${formatAge(now - view.lastactivets)} ago` };
    const elapsed = (view.live ? now : view.lastactivets) - view.startedts;
    const meta = [
        { k: "lead", v: `${runtimeMeta(view.runtime).glyph} ${view.runtime}` },
        ...(view.plan ? [{ k: "plan", v: view.plan }] : []),
        { k: "project", v: view.project || "—" },
        ...timeMeta(view.startedts, elapsed),
        { k: "tokens", v: view.tokens > 0 ? `${formatTokens(view.tokens)} tok` : "—" },
    ];
    // a stage member has no task number: its label names it
    const title =
        member.key === LEAD_MEMBER ? "Lead" : member.num ? `Task ${member.num} · ${member.label}` : member.label;
    return (
        <div className="flex h-full min-h-0 flex-col gap-4">
            <div className="flex flex-none items-start gap-3.5 border-b border-edge-faint pb-4">
                <RuntimeTile runtime={view.runtime} />
                <div className="min-w-0 flex-1">
                    <div className="mb-[7px] flex items-center gap-3">
                        <h2 className="truncate text-[19px] font-bold tracking-[-0.01em] text-primary">{view.title}</h2>
                        <StatusMark status={head} />
                    </div>
                    <Meta items={meta} />
                </div>
                <div className="flex flex-none gap-2">
                    <button
                        type="button"
                        data-peek
                        onClick={(e) => fireAndForget(() => openOrPeek(model, { kind: "run", runId: view.runId }, e))}
                        className="cursor-pointer rounded-[7px] border border-edge-mid bg-surface-raised px-3 py-[7px] text-[12px] font-semibold text-ink-mid hover:text-primary"
                    >
                        Open run sheet
                    </button>
                    {lead?.live ? (
                        <button
                            type="button"
                            onClick={() => runSessionPrimary(model, lead)}
                            className="cursor-pointer rounded-[7px] bg-accent px-[13px] py-[7px] text-[12px] font-semibold text-background hover:opacity-90"
                        >
                            Jump to lead →
                        </button>
                    ) : null}
                </div>
            </div>

            {view.ask ? (
                <div className="flex flex-none items-center gap-3 rounded-lg bg-askingbg py-2.5 pl-3.5 pr-3">
                    <span className="h-[7px] w-[7px] flex-none pulse-dot rounded-full bg-asking" />
                    <span className="min-w-0 flex-1 text-[13px] leading-[1.45] text-secondary">
                        <span className="font-semibold text-ink-hi">Task {view.ask.num} asks:</span> {view.ask.text}
                    </span>
                    <button
                        type="button"
                        onClick={() => globalStore.set(model.sessionsMemberAtom, view.ask!.member)}
                        className="flex-none cursor-pointer rounded-[7px] border border-edge-strong bg-surface-raised px-[11px] py-1.5 text-[12px] font-semibold text-secondary hover:text-primary"
                    >
                        Show task
                    </button>
                </div>
            ) : null}

            <div className="flex min-h-0 flex-1 flex-col gap-3.5">
                <div role="group" aria-label="Sessions in this run" className="flex flex-none flex-col">
                    <div className="flex items-center gap-2.5 pb-1.5">
                        <h3 className={cn(REGION_LABEL, "text-muted")}>In this run</h3>
                        <div className="h-px flex-1 bg-edge-faint" />
                        <span className="font-mono text-[10.5px] text-muted">
                            {view.total > 0 ? `${view.landed}/${view.total} landed` : "planning"}
                        </span>
                    </div>
                    <div className="flex max-h-[186px] flex-col gap-px overflow-y-auto">
                        {view.members.map((m) => (
                            <MemberRow
                                key={m.key}
                                model={model}
                                view={view}
                                member={m}
                                current={m.key === member.key}
                            />
                        ))}
                    </div>
                </div>

                <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-[10px] border border-edge-mid bg-surface">
                    <div
                        data-sessions-member-header=""
                        className="@container flex-none border-b border-edge-faint px-4 pb-2.5 pt-3"
                    >
                        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                            <h3 className="min-w-0 flex-1 truncate text-[15px] font-bold text-primary">{title}</h3>
                            <div className="flex min-w-0 flex-none items-center gap-3 @max-[600px]:basis-full">
                                <ViewToggle model={model} />
                                {memberSession ? <PrimaryButton model={model} session={memberSession} /> : null}
                            </div>
                        </div>
                        <Meta items={sessionMeta(memberSession, [{ k: "status", v: member.status.text }])} />
                    </div>
                    <SessionBody
                        model={model}
                        session={memberSession}
                        empty={memberEmpty(member)}
                        className="px-4 pb-4 pt-1"
                    />
                </div>
            </div>
        </div>
    );
}
