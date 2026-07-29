// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Subjects column: channels, records and threads in one grouped list. Replaces ChannelRail,
// HistoryRail and the Tasks list — one column, three kinds.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { modalsModel } from "@/app/store/modalmodel";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { channelHasAsk } from "@/app/view/agents/channelderive";
import {
    activeChannelRunsAtom,
    archiveChannel,
    channelsAtom,
    createChannel,
    deleteChannel,
    renameChannel,
} from "@/app/view/agents/channelsstore";
import { fleetCounts } from "@/app/view/agents/jarviscards";
import { buildFleetSnapshot } from "@/app/view/agents/jarvisderive";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { confirmCancelRun } from "@/app/view/agents/runactions";
import {
    isTerminal,
    liveWorkers,
    resolveActiveRunId,
    runStatusView,
    type RunStatusTone,
} from "@/app/view/agents/runmodel";
import { SpaceBanner } from "@/app/view/agents/spacebanner";
import { spaceBannerText } from "@/app/view/agents/spacescope";
import { activeSpaceAtom, spaceRevealAtom, spaceScopeAtom } from "@/app/view/agents/spacestore";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { Archive, Ban, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
    activeRunIdAtom,
    activeSubjectAtom,
    persistedSubjectAtom,
    selectSubject,
    setActiveRunId,
    setComposingRun,
    startJarvisThread,
    subjectFilterAtom,
} from "./jarvissubjectstore";
import {
    archiveJarvisConversation,
    conversationsAtom,
    deleteJarvisConversation,
    loadJarvisConversations,
    persistedSummariesAtom,
} from "./jarvisstore";
import { STAGE_HEADER_BAND } from "./stagemeasure";
import { createCommitScheduler, type CommitScheduler } from "./subjectcursor";
import { restoreDecision } from "./subjectrestore";
import {
    buildSubjectGroups,
    filterSubjectGroups,
    runGoalMatches,
    subjectMark,
    type Subject,
    type SubjectGroup,
    type SubjectKind,
} from "./subjects";
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

// The column's narrow form (jarvislayout's SUBJECTS_ICON_PX): one status dot per subject, in the same
// order, still clickable and still carrying the asking signal. It is a *narrower* list, not a hidden one —
// labels go before the list does, and the thread never gives up anything. The width is the layout's, not a
// class literal: the column is continuous and this form just draws whatever it was given.
function CollapsedSubjects({
    widthPx,
    groups,
    isActive,
    signalsFor,
}: {
    widthPx: number;
    groups: SubjectGroup[];
    isActive: (s: Subject) => boolean;
    signalsFor: (s: Subject) => { asking: boolean; working: number } | null;
}) {
    return (
        <div
            data-jarvis-region="subjects"
            style={{ width: widthPx }}
            className="flex flex-none flex-col items-center gap-1 overflow-y-auto border-r border-border bg-background py-2"
        >
            {groups.flatMap((g) =>
                g.items.map((s) => {
                    const signals = signalsFor(s);
                    return (
                        <button
                            key={s.kind + ":" + s.id}
                            type="button"
                            title={s.label}
                            aria-label={s.label}
                            onClick={() => selectSubject({ kind: s.kind, id: s.id })}
                            className={cn(
                                "relative flex h-8 w-8 flex-none cursor-pointer items-center justify-center rounded-[8px] font-mono text-[12px] transition-colors duration-[140ms] hover:bg-surface-hover",
                                isActive(s) ? "bg-accentbg text-accent-soft" : "text-muted"
                            )}
                        >
                            {subjectMark(s.kind)}
                            {signals?.asking ? (
                                <span className="absolute right-0.5 top-0.5 h-[6px] w-[6px] rounded-full bg-asking" />
                            ) : signals != null && signals.working > 0 ? (
                                <span className="absolute right-0.5 top-0.5 h-[6px] w-[6px] rounded-full bg-success" />
                            ) : null}
                        </button>
                    );
                })
            )}
        </div>
    );
}

export function SubjectsColumn({
    model,
    widthPx,
    icons,
}: {
    model: AgentsViewModel;
    widthPx: number;
    icons: boolean;
}) {
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
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState("");

    useEffect(() => {
        loadTaskList();
        loadJarvisConversations();
    }, []);

    // restore the last subject once — and only once its own kind's list has loaded. One attempt, like
    // pendingRunFocusAtom's `landed` guard: a stored id that never resolves must not retry forever.
    const [stored, setStored] = useAtom(persistedSubjectAtom);
    // the derived conversationsAtom coalesces a null summary list to [], so it cannot say "not loaded".
    // Read the raw summaries for that signal and keep conversationsAtom for the ids themselves.
    const summaries = useAtomValue(persistedSummariesAtom);
    const restoredRef = useRef(false);
    useEffect(() => {
        if (restoredRef.current || active != null) {
            return;
        }
        const decision = restoreDecision(stored, {
            channels: channels?.map((c) => c.oid) ?? null,
            dossiers: dossiers?.map((d) => d.id) ?? null,
            conversations: summaries == null ? null : conversations.map((v) => v.id),
        });
        if (decision.action === "wait") {
            return;
        }
        restoredRef.current = true;
        if (decision.action === "select") {
            selectSubject(decision.subject);
            return;
        }
        setStored(null);
    }, [stored, channels, dossiers, conversations, summaries, active, setStored]);

    // a channel's project name: the registered project bound to its path, else the path's own tail.
    const projectNameFor = (channel: Channel) => {
        const want = normPath(channel.projectpath);
        const hit = Object.entries(projects ?? {}).find(([, p]) => want !== "" && normPath(p?.path) === want);
        return hit?.[0] ?? want.split("/").filter(Boolean).pop() ?? "unbound";
    };

    const groups = buildSubjectGroups({
        channels,
        // the column collapses "not loaded" to empty here; the pure module keeps one meaning of empty, and
        // the only consumer that needs the distinction is the boot restore below.
        dossiers: dossiers ?? [],
        conversations,
        projectNameFor,
        spaceScope,
        spaceDossierId: activeSpace?.id ?? null,
        revealed,
    });

    const totalBefore = (channels?.length ?? 0) + (dossiers?.length ?? 0) + conversations.length;
    const totalAfter = groups.reduce((n, g) => n + g.items.length, 0);

    const shown = filterSubjectGroups(groups, filter, channels);

    // the cursor moves on every keypress; committing it waits for the user to stop. See subjectcursor.ts.
    const [cursorKey, setCursorKey] = useState<string | undefined>(undefined);
    const commitRef = useRef<CommitScheduler | null>(null);
    if (commitRef.current == null) {
        commitRef.current = createCommitScheduler((key) => {
            const i = key.indexOf(":");
            selectSubject({ kind: key.slice(0, i) as SubjectKind, id: key.slice(i + 1) });
        });
    }
    useEffect(() => () => commitRef.current?.cancel(), []);

    const activeKey = active != null ? `${active.kind}:${active.id}` : undefined;
    // a selection made anywhere else (a click, the palette, a Radar landing, a boot restore) moves the
    // cursor to match. During a j/k burst activeKey does not change, so this cannot fight the cursor.
    useEffect(() => setCursorKey(activeKey), [activeKey]);

    // j/k over the whole column, all three kinds in render order — the Channels rail published the same
    // cursor for its channel list, and the merged column is the only list left to move through.
    const navIds = useMemo(() => shown.flatMap((g) => g.items.map((s) => `${s.kind}:${s.id}`)), [shown]);
    const listNav = useMemo<ListNavController>(
        () => ({
            surface: "jarvis",
            navigableIds: navIds,
            cursorId: cursorKey ?? activeKey,
            setCursor: (key) => {
                setCursorKey(key);
                commitRef.current?.schedule(key);
            },
            // deliberately no `activate`: bindings.ts only lets Enter pass through while the controller
            // leaves it unset, so claiming it would swallow Enter across the whole surface (the composer's
            // submit included) to save the 150ms the pending commit was going to take anyway.
        }),
        [navIds, cursorKey, activeKey]
    );
    useSurfaceListNav(listNav);

    const isActive = (s: Subject) => (cursorKey ?? activeKey) === `${s.kind}:${s.id}`;
    // the same resolution the Stage does, so the highlighted row is the run the Stage is showing
    const activeRunId = active?.kind === "channel" ? resolveActiveRunId(runs, runIds[active.id]) : undefined;

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

    const commitRename = (channel: Channel) => {
        const next = renameDraft.trim();
        setRenamingId(null);
        if (next && next !== channel.name) {
            fireAndForget(() => renameChannel(channel.oid, next));
        }
    };

    // Channel lifecycle. It lived on the deleted ChannelRail's per-row menu and came back here rather than
    // into the header: the header acts on the channel you are *on*, and renaming or deleting one you are
    // not is the whole point. Autonomy deliberately did not come back — the header ladder owns it, and a
    // second control would be a second source of truth.
    // "New run" from the column: put the Stage on the channel and force the composer's Launch face — the
    // same flag "＋ New run" sets, so a channel with a live worker stops offering to message it. It does
    // not dispatch: a run needs a goal, and the goal is typed.
    const newRun = (channelId: string) => {
        selectSubject({ kind: "channel", id: channelId });
        setComposingRun(channelId, true);
        // the Launch face autofocuses on mount, but a channel already showing it does not remount
        requestAnimationFrame(() =>
            document
                .querySelector<HTMLElement>("[data-jarvis-composer] input, [data-jarvis-composer] textarea")
                ?.focus()
        );
    };

    // Runs get their own right-click for the acts the row cannot offer by clicking: starting another run
    // beside this one, and cancelling it. Cancel routes through confirmCancelRun, so a run with live
    // workers still asks before stopping them.
    const runMenu = (channelId: string, channelName: string, run: Run, ev: React.MouseEvent) => {
        ContextMenuModel.getInstance().showContextMenu(
            [
                {
                    label: `New run in #${channelName}`,
                    icon: <Plus size={15} />,
                    click: () => newRun(channelId),
                },
                { type: "separator" },
                {
                    label: "Copy goal",
                    icon: <Copy size={15} />,
                    click: () => fireAndForget(() => navigator.clipboard.writeText(run.goal ?? "")),
                },
                {
                    label: "Copy run id",
                    icon: <Copy size={15} />,
                    click: () => fireAndForget(() => navigator.clipboard.writeText(run.id)),
                },
                { type: "separator" },
                {
                    label: "Cancel run",
                    icon: <Ban size={15} />,
                    danger: true,
                    enabled: !isTerminal(run.status),
                    click: () => confirmCancelRun(channelId, run.id, liveWorkers(run, agents).length),
                },
            ],
            ev
        );
    };

    const channelMenu = (channel: Channel, ev: React.MouseEvent) => {
        const archived = (channel.meta as Record<string, unknown> | undefined)?.["archived"] === true;
        ContextMenuModel.getInstance().showContextMenu(
            [
                {
                    label: "New run",
                    icon: <Plus size={15} />,
                    click: () => newRun(channel.oid),
                },
                { type: "separator" },
                {
                    label: "Rename channel",
                    icon: <Pencil size={15} />,
                    click: () => {
                        setRenameDraft(channel.name ?? "");
                        setRenamingId(channel.oid);
                    },
                },
                {
                    label: archived ? "Unarchive channel" : "Archive channel",
                    icon: <Archive size={15} />,
                    click: () => fireAndForget(() => archiveChannel(channel.oid, !archived)),
                },
                { type: "separator" },
                {
                    label: "Delete channel",
                    icon: <Trash2 size={15} />,
                    danger: true,
                    click: () =>
                        modalsModel.pushModal("ConfirmModal", {
                            title: "Delete channel",
                            message: `Delete #${channel.name}? This can't be undone.`,
                            confirmLabel: "Delete channel",
                            destructive: true,
                            onConfirm: () => fireAndForget(() => deleteChannel(channel.oid)),
                        }),
                },
            ],
            ev
        );
    };

    // threads get the same right-click affordances channels got, for the same reason: a row you cannot
    // remove is a permanent one. No rename — a thread's title comes from its first turn.
    const threadMenu = (id: string, title: string, archived: boolean, ev: React.MouseEvent) => {
        ContextMenuModel.getInstance().showContextMenu(
            [
                {
                    label: archived ? "Unarchive thread" : "Archive thread",
                    icon: <Archive size={15} />,
                    click: () => fireAndForget(() => archiveJarvisConversation(id, !archived)),
                },
                { type: "separator" },
                {
                    label: "Delete thread",
                    icon: <Trash2 size={15} />,
                    danger: true,
                    click: () =>
                        modalsModel.pushModal("ConfirmModal", {
                            title: "Delete thread",
                            message: `Delete "${title}"? This can't be undone.`,
                            confirmLabel: "Delete thread",
                            destructive: true,
                            onConfirm: () => fireAndForget(() => deleteJarvisConversation(id)),
                        }),
                },
            ],
            ev
        );
    };

    if (icons) {
        return (
            <CollapsedSubjects
                widthPx={widthPx}
                groups={shown}
                isActive={isActive}
                signalsFor={(s) => {
                    const ch = s.kind === "channel" ? channels?.find((c) => c.oid === s.id) : undefined;
                    return ch != null ? channelSignals(ch) : null;
                }}
            />
        );
    }

    return (
        <div
            data-jarvis-region="subjects"
            style={{ width: widthPx }}
            className="flex flex-none flex-col border-r border-border bg-background"
        >
            {/* STAGE_HEADER_BAND, same as the Stage's header and the rail's: one rule across all three
                columns at one height, in one tone. This was py-3 with the two buttons inside it and an
                edge-faint rule, which put the column's first rule 52px below the Stage's. */}
            <div className={cn(STAGE_HEADER_BAND, "px-3")}>
                <div className="flex w-full items-center gap-2 rounded-[8px] border border-edge-mid bg-surface-raised px-2.5 py-1 focus-within:border-accent">
                    <span className="font-mono text-[11px] font-semibold text-muted">⌕</span>
                    <input
                        type="text"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="Filter subjects"
                        className="w-full bg-transparent text-[12px] text-primary placeholder:text-muted focus:outline-none"
                    />
                </div>
            </div>
            <div className="flex flex-none flex-col gap-2 px-3 py-2.5">
                <div className="flex gap-1.5">
                    {/* data-jarvis-new-channel: the `c` key presses this rather than owning a second copy of
                        the picker's open state (buildJarvisBindings). */}
                    <button
                        type="button"
                        data-jarvis-new-channel
                        onClick={() => setPicking((p) => !p)}
                        className="flex-1 cursor-pointer rounded-[8px] border border-accent/30 bg-accentbg px-2 py-1.5 text-[11.5px] font-semibold text-accent-soft transition-colors duration-[140ms] hover:bg-accent/20"
                    >
                        + Channel
                    </button>
                    <button
                        type="button"
                        onClick={startJarvisThread}
                        className="flex-1 cursor-pointer rounded-[8px] border border-border bg-surface px-2 py-1.5 text-[11.5px] font-semibold text-secondary transition-colors duration-[140ms] hover:text-primary"
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
                            // the first thing a new user clicks used to point them somewhere else; the
                            // palette's New-project modal opens from anywhere, so open it from here.
                            <button
                                type="button"
                                onClick={() => {
                                    setPicking(false);
                                    globalStore.set(model.newProjectOpenAtom, true);
                                }}
                                className="cursor-pointer rounded-[7px] border border-accent/30 bg-accentbg px-2.5 py-1.5 text-left text-[11.5px] font-semibold text-accent-soft hover:bg-accent/20"
                            >
                                No projects yet — register one
                            </button>
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
                            // the selected channel shows the live run list; any other channel shows only the
                            // runs the filter matched (nothing when the filter is empty).
                            const rowRuns = selected ? runs : channel != null ? runGoalMatches(channel, filter) : [];
                            if (channel != null && renamingId === channel.oid) {
                                return (
                                    <div
                                        key={s.kind + ":" + s.id}
                                        className="flex items-center gap-2 rounded-[8px] bg-accentbg px-2.5 py-[7px]"
                                    >
                                        <span className="w-[9px] flex-none font-mono text-[12px] text-accent-soft">
                                            #
                                        </span>
                                        <input
                                            autoFocus
                                            value={renameDraft}
                                            onChange={(e) => setRenameDraft(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") {
                                                    e.preventDefault();
                                                    commitRename(channel);
                                                }
                                                if (e.key === "Escape") {
                                                    e.preventDefault();
                                                    setRenamingId(null);
                                                }
                                            }}
                                            onBlur={() => commitRename(channel)}
                                            className="min-w-0 flex-1 rounded-[5px] border border-accent bg-surface px-1 text-[12.5px] text-primary focus:outline-none"
                                        />
                                    </div>
                                );
                            }
                            return (
                                <div key={s.kind + ":" + s.id}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            // a commit still queued from j/k would land after this and move
                                            // the user off the row they clicked
                                            commitRef.current?.cancel();
                                            selectSubject({ kind: s.kind, id: s.id });
                                        }}
                                        onContextMenu={(ev) => {
                                            if (channel != null) {
                                                channelMenu(channel, ev);
                                                return;
                                            }
                                            if (s.kind === "conversation") {
                                                const conv = conversations.find((v) => v.id === s.id);
                                                threadMenu(s.id, s.label, conv?.archived === true, ev);
                                            }
                                        }}
                                        className={cn(
                                            "flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-hover",
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
                                    {/* the selected channel expands to its runs — this list is the run switcher.
                                        While filtering, an unselected channel expands to its matching runs
                                        instead, so a run can be found by what it was about. */}
                                    {s.kind === "channel" && rowRuns.length > 0 ? (
                                        <div className="mb-1 ml-[18px] mt-0.5 flex flex-col gap-px border-l border-border pl-2.5">
                                            {rowRuns.map((r) => {
                                                const view = runStatusView(r.status);
                                                return (
                                                    <button
                                                        key={r.id}
                                                        type="button"
                                                        onClick={() => {
                                                            if (!selected) {
                                                                selectSubject({ kind: "channel", id: s.id });
                                                            }
                                                            setActiveRunId(s.id, r.id);
                                                        }}
                                                        onContextMenu={(ev) =>
                                                            runMenu(s.id, channel?.name ?? "channel", r, ev)
                                                        }
                                                        className={cn(
                                                            "flex cursor-pointer items-center gap-[7px] rounded-[7px] px-2 py-[5px] text-left transition-colors duration-[140ms] hover:bg-surface-hover",
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
