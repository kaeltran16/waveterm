// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The Sessions surface's right pane: a run (its lead and tasks, and the session of the one in view) or a single
// session, each read as its transcript or its lifecycle events. @theme tokens only.

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { openOrPeek } from "@/app/view/jarvis/openref";
import { landOn } from "@/app/view/jarvis/returnsurface";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Check, ChevronDown, ChevronUp, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AgentsViewModel } from "./agents";
import type { AgentEntry } from "./agentsviewmodel";
import { formatAgeShort, formatTokens } from "./agentsviewmodel";
import { docTextOf, rangeOf } from "./docreviewnotesview";
import { NarrationTimeline } from "./narrationtimeline";
import { runtimeMeta } from "./runtimemeta";
import type { LiveSession } from "./sessionsarchivestore";
import { findRanges, findTerms, stepFind, type SessionsFind } from "./sessionsfind";
import {
    LEAD_MEMBER,
    resumeLaunchOpts,
    sessionKey,
    sessionPrimary,
    type RunMember,
    type RunView,
    type Status,
    type StatusKey,
} from "./sessionsruns";
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

// A session's primary action: Jump to the live agent, else Resume the ended session (if resumable).
// Shared by the detail buttons (mouse) and list-nav Enter (keyboard) so both do exactly one thing.
export function runSessionPrimary(model: AgentsViewModel, session: LiveSession) {
    if (session.live && session.liveId) {
        globalStore.set(model.focusIdAtom, session.liveId);
        landOn(model.surfaceAtom, "agent");
        return;
    }
    if (session.resumecommand) {
        fireAndForget(() => launchAgent(model, resumeLaunchOpts(session)));
    }
}

function PrimaryButton({ model, session, strong }: { model: AgentsViewModel; session: LiveSession; strong?: boolean }) {
    const primary = sessionPrimary(session);
    if (primary == null) {
        return null;
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
            {primary === "jump" ? "Jump →" : "Resume →"}
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

function useTranscript(session: LiveSession | undefined, full: boolean): AgentEntry[] | null {
    const [entries, setEntries] = useState<AgentEntry[] | null>(null);
    const path = session?.transcriptpath;
    const runtime = session?.runtime;
    useEffect(() => {
        let cancelled = false;
        setEntries(null);
        if (!path || !runtime) {
            setEntries([]);
            return;
        }
        fireAndForget(async () => {
            try {
                // Pi's parent-linked active branch needs the complete file, and a find may target the first turn;
                // otherwise tail the recent window.
                const maxlines = runtime === "pi" || full ? -1 : 2000;
                const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, { path, maxlines });
                const projected = projectorFor(runtime, path).project(rtn.lines ?? []);
                if (!cancelled) {
                    setEntries(projected);
                }
            } catch (e) {
                console.warn(`reading transcript ${path} failed`, e);
                if (!cancelled) {
                    setEntries([]);
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [path, runtime, full]);
    return entries;
}

function clock(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

// mark is the event a search hit opened at
function ActivityList({ events, mark }: { events: SessionEvent[]; mark?: number }) {
    const markRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        markRef.current?.scrollIntoView({ block: "center" });
    }, [mark]);
    return (
        <div className="flex flex-col">
            {events.map((e, i) => (
                <div
                    key={i}
                    ref={i === mark ? markRef : undefined}
                    aria-current={i === mark ? true : undefined}
                    className={cn(
                        "grid grid-cols-[44px_8px_minmax(0,1fr)] gap-x-3.5 border-b border-edge-faint py-2.5",
                        i === mark && "rounded-[6px] ring-1 ring-inset ring-accent"
                    )}
                >
                    <span className="pt-0.5 font-mono text-[10.5px] text-muted">{clock(e.ts)}</span>
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

// Selecting another session ends the find. settled is false while a run's member in view is still resolving
// (the run shows its lead until then), so the first frame after a hit opens does not end the hit's find.
function useEndFindElsewhere(model: AgentsViewModel, session: LiveSession | undefined, settled: boolean) {
    const [find, setFind] = useAtom(model.sessionsFindAtom);
    const key = session ? sessionKey(session) : null;
    useEffect(() => {
        if (find != null && settled && key != null && key !== find.sessionKey) {
            setFind(null);
        }
    }, [find, key, settled]);
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
    const entries = useTranscript(view === "transcript" ? session : undefined, full);

    // the bar's query, editable to refine the find; a new hit resets it
    const [edit, setEdit] = useState({ of: find, text: find?.query ?? "", pos: firstPos(find) });
    if (edit.of !== find) {
        setEdit({ of: find, text: find?.query ?? "", pos: firstPos(find) });
    }
    const terms = find == null ? [] : edit.text === find.query ? find.terms : findTerms(edit.text);
    const termsKey = JSON.stringify(terms);

    const scrollRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (el && entries?.length && !full) {
            el.scrollTop = el.scrollHeight;
        }
    }, [entries, full]);

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
    } else if (entries == null) {
        body = <TranscriptSkeleton className="pt-3" />;
    } else if (entries.length === 0) {
        body = <div className="py-4 text-[13px] text-muted">No transcript to show.</div>;
    } else {
        body = <NarrationTimeline entries={entries} active={session.live} renderAll={full} />;
    }
    return (
        <div
            ref={scrollRef}
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
        { k: "time", v: s.durationms > 0 ? formatAgeShort(s.durationms) : "—" },
        { k: "tokens", v: s.tokenstotal > 0 ? `${formatTokens(s.tokenstotal)} tok` : "—" },
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
    useEndFindElsewhere(model, session, true);
    const status: Status = session.live
        ? session.needsAttention
            ? { key: "asking", text: "asking" }
            : { key: "running", text: "running" }
        : { key: "done", text: "done" };
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="mb-1 flex flex-none items-start gap-3.5 border-b border-edge-faint pb-4">
                <RuntimeTile runtime={session.runtime} />
                <div className="min-w-0 flex-1">
                    <div className="mb-[7px] flex items-center gap-3">
                        <h2 className="truncate text-[19px] font-bold tracking-[-0.01em] text-primary">
                            {session.task || "(untitled session)"}
                        </h2>
                        <StatusMark status={status} />
                    </div>
                    <Meta items={[{ k: "project", v: session.projectname || "—" }, ...sessionMeta(session).slice(1)]} />
                </div>
                <ViewToggle model={model} className="self-center" />
                <div className="self-center">
                    <PrimaryButton model={model} session={session} strong />
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
    return (
        <button
            type="button"
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
    const selectedMember = useAtomValue(model.sessionsMemberAtom);
    useEndFindElsewhere(model, memberSession, member.key === selectedMember);
    const lead = view.members[0].session;
    const head: Status =
        view.live || view.head.key !== "done" ? view.head : { key: "done", text: `done · ${view.head.text} ago` };
    const elapsed = (view.live ? now : view.lastactivets) - view.startedts;
    const meta = [
        { k: "lead", v: `${runtimeMeta(view.runtime).glyph} ${view.runtime}` },
        ...(view.plan ? [{ k: "plan", v: view.plan }] : []),
        { k: "project", v: view.project || "—" },
        { k: "time", v: formatAgeShort(elapsed) },
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
                        Open in Orchestrate
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
                    <div className="flex-none border-b border-edge-faint px-4 pb-2.5 pt-3">
                        <div className="mb-1.5 flex items-center gap-3">
                            <h3 className="min-w-0 flex-1 truncate text-[15px] font-bold text-primary">{title}</h3>
                            <ViewToggle model={model} />
                            {memberSession ? <PrimaryButton model={model} session={memberSession} /> : null}
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
