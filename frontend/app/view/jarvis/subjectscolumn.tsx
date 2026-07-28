// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Subjects column: channels, records and threads in one grouped list. Replaces ChannelRail,
// HistoryRail and the Tasks list — one column, three kinds.

import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { channelHasAsk } from "@/app/view/agents/channelderive";
import { activeChannelRunsAtom, channelsAtom, createChannel } from "@/app/view/agents/channelsstore";
import { fleetCounts } from "@/app/view/agents/jarviscards";
import { buildFleetSnapshot } from "@/app/view/agents/jarvisderive";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { resolveActiveRunId, runStatusView, type RunStatusTone } from "@/app/view/agents/runmodel";
import { SpaceBanner } from "@/app/view/agents/spacebanner";
import { spaceBannerText } from "@/app/view/agents/spacescope";
import { activeSpaceAtom, spaceRevealAtom, spaceScopeAtom } from "@/app/view/agents/spacestore";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import {
    activeRunIdAtom,
    activeSubjectAtom,
    selectSubject,
    setActiveRunId,
    subjectFilterAtom,
} from "./jarvissubjectstore";
import { conversationsAtom, loadJarvisConversations, startConversation } from "./jarvisstore";
import { buildSubjectGroups, subjectMark, type Subject, type SubjectKind } from "./subjects";
import { loadTaskList, taskListAtom } from "./tasksstore";

const RUN_DOT: Record<RunStatusTone, string> = {
    planning: "bg-accent",
    review: "bg-warning",
    running: "bg-success",
    blocked: "bg-error",
    done: "bg-muted",
    failed: "bg-error",
    cancelled: "bg-ink-faint",
};

// path comparison is separator-insensitive: a project registers its path verbatim, a channel stores the
// one it was created with, and on Windows those differ by slash direction (mirrors resolveTargetChannel).
function normPath(path: string | undefined): string {
    return (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

export function SubjectsColumn({ model }: { model: AgentsViewModel }) {
    const channels = useAtomValue(channelsAtom);
    const dossiers = useAtomValue(taskListAtom);
    const conversations = useAtomValue(conversationsAtom);
    const projects = useAtomValue(projectsAtom);
    const agents = useAtomValue(model.agentsAtom);
    const runs = useAtomValue(activeChannelRunsAtom);
    const runIds = useAtomValue(activeRunIdAtom);
    const active = useAtomValue(activeSubjectAtom);
    const activeSpace = useAtomValue(activeSpaceAtom);
    const spaceScope = useAtomValue(spaceScopeAtom);
    const revealed = useAtomValue(spaceRevealAtom).has("jarvis");
    const [filter, setFilter] = useAtom(subjectFilterAtom);
    const [picking, setPicking] = useState(false);
    const [pending, setPending] = useState<{ name: string; path: string } | null>(null);
    const [newName, setNewName] = useState("");

    useEffect(() => {
        loadTaskList();
        loadJarvisConversations();
    }, []);

    // a channel's project name: the registered project bound to its path, else the path's own tail.
    const projectNameFor = (channel: Channel) => {
        const want = normPath(channel.projectpath);
        const hit = Object.entries(projects ?? {}).find(([, p]) => want !== "" && normPath(p?.path) === want);
        return hit?.[0] ?? want.split("/").filter(Boolean).pop() ?? "unbound";
    };

    const groups = buildSubjectGroups({
        channels,
        dossiers,
        conversations,
        projectNameFor,
        spaceScope,
        spaceDossierId: activeSpace?.id ?? null,
        revealed,
    });

    const totalBefore = (channels?.length ?? 0) + dossiers.length + conversations.length;
    const totalAfter = groups.reduce((n, g) => n + g.items.length, 0);

    const q = filter.trim().toLowerCase();
    const shown =
        q === ""
            ? groups
            : groups
                  .map((g) => ({ ...g, items: g.items.filter((s) => s.label.toLowerCase().includes(q)) }))
                  .filter((g) => g.items.length > 0);

    // j/k over the whole column, all three kinds in render order — the Channels rail published the same
    // cursor for its channel list, and the merged column is the only list left to move through.
    const navIds = useMemo(() => shown.flatMap((g) => g.items.map((s) => `${s.kind}:${s.id}`)), [shown]);
    const listNav = useMemo<ListNavController>(
        () => ({
            surface: "jarvis",
            navigableIds: navIds,
            cursorId: active != null ? `${active.kind}:${active.id}` : undefined,
            setCursor: (key) => {
                const i = key.indexOf(":");
                selectSubject({ kind: key.slice(0, i) as SubjectKind, id: key.slice(i + 1) });
            },
        }),
        [navIds, active]
    );
    useSurfaceListNav(listNav);

    const isActive = (s: Subject) => active?.kind === s.kind && active?.id === s.id;
    // the same resolution the Stage does, so the highlighted row is the run the Stage is showing
    const activeRunId = active?.kind === "channel" ? resolveActiveRunId(runs, runIds[active.id]) : undefined;

    const newThread = () => {
        const id = startConversation({ mode: "all", chips: [], attached: [] });
        selectSubject({ kind: "conversation", id });
    };

    const pickProject = (name: string, path: string) => {
        setPicking(false);
        setPending(null);
        fireAndForget(async () => {
            const oid = await createChannel(name, path);
            selectSubject({ kind: "channel", id: oid });
        });
    };

    // the asking dot / working count for a channel row; both come from the same fleet snapshot the rail and
    // the nav badge use, so a lit dot and a counted ask never disagree.
    const channelSignals = (channel: Channel) => {
        const counts = fleetCounts(buildFleetSnapshot(channel, agents));
        return { asking: channelHasAsk(channel, agents), working: counts.working };
    };

    return (
        <div className="flex w-[272px] flex-none flex-col border-r border-border bg-background">
            <div className="flex flex-col gap-2 border-b border-edge-faint px-3 py-3">
                <div className="flex items-center gap-2 rounded-[8px] border border-edge-mid bg-surface-raised px-2.5 py-1.5 focus-within:border-accent">
                    <span className="font-mono text-[11px] font-semibold text-muted">⌕</span>
                    <input
                        type="text"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter subjects"
                        className="w-full bg-transparent text-[12px] text-primary placeholder:text-muted focus:outline-none"
                    />
                </div>
                <div className="flex gap-1.5">
                    <button
                        type="button"
                        onClick={() => setPicking((p) => !p)}
                        className="flex-1 cursor-pointer rounded-[8px] border border-accent/30 bg-accentbg px-2 py-1.5 text-[11.5px] font-semibold text-accent-soft hover:bg-accent/20"
                    >
                        + Channel
                    </button>
                    <button
                        type="button"
                        onClick={newThread}
                        className="flex-1 cursor-pointer rounded-[8px] border border-border bg-surface px-2 py-1.5 text-[11.5px] font-semibold text-secondary hover:text-primary"
                    >
                        + Thread
                    </button>
                </div>
                {picking ? (
                    <div className="flex flex-col gap-1">
                        {pending != null ? (
                            <div className="flex flex-col gap-1.5 rounded-[7px] border border-border bg-surface-raised p-2">
                                <input
                                    autoFocus
                                    value={newName}
                                    onChange={(e) => setNewName(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            e.preventDefault();
                                            pickProject(newName.trim() || pending.name, pending.path);
                                        }
                                        if (e.key === "Escape") {
                                            e.preventDefault();
                                            setPending(null);
                                        }
                                    }}
                                    placeholder="Channel name"
                                    className="rounded-[5px] border border-edge-mid bg-surface px-2 py-1 text-[12px] text-primary placeholder:text-muted focus:border-accent focus:outline-none"
                                />
                                <div className="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        onClick={() => pickProject(newName.trim() || pending.name, pending.path)}
                                        className="cursor-pointer rounded-[5px] border border-accent/50 bg-accentbg px-2 py-0.5 font-mono text-[11px] text-accent-soft hover:bg-accent/20"
                                    >
                                        Create
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setPending(null)}
                                        className="cursor-pointer rounded-[5px] px-2 py-0.5 font-mono text-[11px] text-muted hover:text-secondary"
                                    >
                                        Back
                                    </button>
                                    <span className="ml-auto truncate font-mono text-[10px] text-muted">
                                        in {pending.name}
                                    </span>
                                </div>
                            </div>
                        ) : Object.keys(projects ?? {}).length === 0 ? (
                            <span className="px-1 text-[11px] text-muted">
                                No projects — add one from the Cockpit “+ New project”.
                            </span>
                        ) : (
                            Object.entries(projects ?? {}).map(([name, p]) => (
                                <button
                                    key={name}
                                    type="button"
                                    onClick={() => {
                                        setPending({ name, path: p?.path ?? "" });
                                        setNewName(name);
                                    }}
                                    className="cursor-pointer truncate rounded-[7px] border border-border bg-surface-raised px-2.5 py-1.5 text-left text-[12px] font-medium text-ink-mid hover:border-accent"
                                >
                                    {name}
                                </button>
                            ))
                        )}
                    </div>
                ) : null}
            </div>
            {activeSpace != null ? (
                <div className="px-2 pt-2">
                    <SpaceBanner
                        surface="jarvis"
                        text={spaceBannerText(activeSpace.objective, Math.max(0, totalBefore - totalAfter), revealed)}
                        revealed={revealed}
                    />
                </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-2">
                {shown.map((g) => (
                    <div key={g.key} className="mb-2">
                        <div className="flex items-center gap-2 px-2 py-1.5">
                            <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                {g.label}
                            </span>
                            <div className="h-px flex-1 bg-border" />
                        </div>
                        {g.items.map((s) => {
                            const channel = s.kind === "channel" ? channels?.find((c) => c.oid === s.id) : undefined;
                            const signals = channel != null ? channelSignals(channel) : null;
                            const selected = isActive(s);
                            return (
                                <div key={s.kind + ":" + s.id}>
                                    <button
                                        type="button"
                                        onClick={() => selectSubject({ kind: s.kind, id: s.id })}
                                        className={cn(
                                            "flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-[7px] text-left hover:bg-surface-hover",
                                            selected && "bg-accentbg"
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                "w-[9px] flex-none font-mono text-[12px]",
                                                selected ? "text-accent-soft" : "text-muted"
                                            )}
                                        >
                                            {subjectMark(s.kind)}
                                        </span>
                                        <span
                                            className={cn(
                                                "min-w-0 flex-1 truncate text-[12.5px]",
                                                selected ? "font-semibold text-primary" : "font-medium text-secondary"
                                            )}
                                        >
                                            {s.label}
                                        </span>
                                        {signals?.asking ? (
                                            <span
                                                title="asking you"
                                                className="h-[7px] w-[7px] flex-none rounded-full bg-asking"
                                            />
                                        ) : null}
                                        {signals != null && signals.working > 0 ? (
                                            <span className="flex-none font-mono text-[9.5px] font-semibold text-success">
                                                {signals.working}▶
                                            </span>
                                        ) : null}
                                    </button>
                                    {/* the selected channel expands to its runs — this list is the run switcher */}
                                    {selected && s.kind === "channel" && runs.length > 0 ? (
                                        <div className="mb-1 ml-[18px] mt-0.5 flex flex-col gap-px border-l border-border pl-2.5">
                                            {runs.map((r) => {
                                                const view = runStatusView(r.status);
                                                return (
                                                    <button
                                                        key={r.id}
                                                        type="button"
                                                        onClick={() => setActiveRunId(s.id, r.id)}
                                                        className={cn(
                                                            "flex cursor-pointer items-center gap-[7px] rounded-[7px] px-2 py-[5px] text-left hover:bg-surface-hover",
                                                            r.id === activeRunId && "bg-surface-selected"
                                                        )}
                                                    >
                                                        <span
                                                            className={cn(
                                                                "h-1.5 w-1.5 flex-none rounded-full",
                                                                RUN_DOT[view.tone]
                                                            )}
                                                        />
                                                        <span
                                                            className={cn(
                                                                "min-w-0 flex-1 truncate text-[11.5px] font-medium",
                                                                r.id === activeRunId ? "text-primary" : "text-ink-mid"
                                                            )}
                                                        >
                                                            {r.goal}
                                                        </span>
                                                        <span className="flex-none font-mono text-[9.5px] text-muted">
                                                            {view.label}
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}
