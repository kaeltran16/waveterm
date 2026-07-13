// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Channels surface: a single runs-native surface where "a channel *is* its runs." No Chat｜Runs toggle
// and no message stream — the surface owns the chrome (header + autonomy toggle + ⚙, a collapsible
// overview strip, a single run strip, RunBody, and one two-face composer) and a right rail (Needs you /
// Consults / Fleet here). The composer's Launch face takes typed @quick/@run/@ask commands; its Talk face
// messages the selected run's live worker (the old "Steer"). RunBody (runbody.tsx) renders the selected
// run; all cross-process behavior reuses existing RPCs (SetChannelTier, CreateRun, Consult, Jarvis, …).

import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { MotionConfig } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentsViewModel } from "./agents";
import { type AgentVM } from "./agentsviewmodel";
import { dismissWorker, sendChannelMessage, steerWorker } from "./channelactions";
import { activeMentionQuery, resolveTargetChannel } from "./channelderive";
import { Avatar, WorkerRow, workerFor } from "./channelsprimitives";
import { ComposerShell } from "./composer-shell";
import {
    composerFace,
    LAUNCH_COMMANDS,
    parseComposerCommand,
    runFooterFor,
    type LaunchMode,
} from "./composercommand";
import { tierFromMeta, type RosterEntry } from "./channelmessages";
import { ChannelRail } from "./channelrail";
import {
    activeChannelAtom,
    activeChannelIdAtom,
    archiveChannel,
    channelsAtom,
    consultStreamsAtom,
    createChannel,
    deleteChannel,
    loadChannels,
    renameChannel,
    selectChannel,
    setChannelTier,
    type ConsultStream,
} from "./channelsstore";
import { escalationPending, fleetCounts, parseCardData, pendingAsks } from "./jarviscards";
import { buildFleetSnapshot, buildJarvisPrompt, fleetCostUsd } from "./jarvisderive";
import { MarkdownMessage } from "./markdownmessage";
import { projectsAtom } from "./projectsstore";
import { RAIL_ICON } from "./railicons";
import { channelRailOpenAtom } from "./railstore";
import { profileRailOpenAtom, ProfilePanel } from "./profilepanel";
import { createRun, getJarvisProfile, pendingRunDraftAtom } from "./runactions";
import { currentPhaseIndex, defaultRunId, phaseProgressDots, resolveActiveRunId, reviewGate, runStatusView } from "./runmodel";
import { PHASE_TONE_CLASS, RunBody, TONE_CLASS } from "./runbody";

// A consult runs a headless CLI up to the backend's 120s timeout; give the Jarvis-summary stream headroom
// past it (the RPC layer's 5s default would kill the stream long before a reply lands).
const JARVIS_RPC_TIMEOUT_MS = 130_000;

function consultIdOf(refORef?: string): string | undefined {
    return refORef?.startsWith("consult:") ? refORef.slice("consult:".length) : undefined;
}

function formatUsd(n: number): string {
    return `$${n.toFixed(2)}`;
}

type SummaryState = { status: "streaming" | "done" | "error"; text: string };

// ── The two-face composer ──────────────────────────────────────────────────────────────────────────

// Launch face: a plain goal input driven by typed @quick/@run/@ask commands (a bare goal defaults to
// @run). Typing a leading `@` opens an autocomplete of the three; a mid-text `@` is left as-is. The
// footer surfaces what the parsed mode will do — @run's strategy comes from the channel's ⚙ profile.
function LaunchComposer({
    value,
    onChange,
    onSubmit,
    profile,
    channelName,
    pending,
}: {
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    profile: JarvisProfile | undefined;
    channelName: string;
    pending: boolean;
}) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    const pendingCaret = useRef<number | null>(null);
    const [sugg, setSugg] = useState<{ query: string; start: number } | null>(null);
    const [sel, setSel] = useState(0);

    const mode: LaunchMode = pending ? "run" : parseComposerCommand(value).mode;
    // only a leading `@` token is a command — mid-text `@` (start > 0) is not
    const matches =
        sugg && sugg.start === 0
            ? LAUNCH_COMMANDS.filter((c) => c.cmd.startsWith("@" + sugg.query.toLowerCase()))
            : [];
    const open = matches.length > 0;

    useEffect(() => setSel(0), [sugg?.query, sugg?.start]);
    useLayoutEffect(() => {
        if (pendingCaret.current != null && taRef.current) {
            const p = pendingCaret.current;
            pendingCaret.current = null;
            taRef.current.setSelectionRange(p, p);
        }
    }, [value]);

    const syncSuggest = () => {
        const ta = taRef.current;
        if (ta) {
            setSugg(activeMentionQuery(ta.value, ta.selectionStart ?? ta.value.length));
        }
    };
    const accept = (cmd: (typeof LAUNCH_COMMANDS)[number]) => {
        const rest = value.slice((sugg?.query.length ?? 0) + 1); // drop the leading "@query" token
        const next = cmd.cmd + " " + rest.replace(/^\s+/, "");
        pendingCaret.current = cmd.cmd.length + 1;
        setSugg(null);
        onChange(next);
    };
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (open) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => (s + 1) % matches.length);
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => (s - 1 + matches.length) % matches.length);
                return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                accept(matches[Math.min(sel, matches.length - 1)]);
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                setSugg(null);
                return;
            }
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
        }
    };

    const footer =
        pending || mode === "run"
            ? runFooterFor(profile)
            : mode === "quick"
              ? `→ spawns one worker in #${channelName}`
              : "→ no worker · answer lands in Consults";
    const sendLabel = mode === "ask" ? "Ask" : "Run ⏎";

    return (
        <ComposerShell
            onSubmit={onSubmit}
            sendLabel={sendLabel}
            overlay={
                open ? (
                    <div className="absolute bottom-full left-0 mb-1.5 w-[300px] overflow-hidden rounded-[9px] border border-edge-strong bg-surface-raised shadow-lg">
                        {matches.map((c, i) => (
                            <button
                                key={c.cmd}
                                type="button"
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    accept(c);
                                }}
                                onMouseEnter={() => setSel(i)}
                                className={
                                    "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left " +
                                    (i === sel ? "bg-accentbg" : "")
                                }
                            >
                                <span className="font-mono text-[12.5px] font-semibold text-accent-soft">{c.cmd}</span>
                                <span className="ml-auto font-mono text-[10px] text-muted">{c.desc}</span>
                            </button>
                        ))}
                    </div>
                ) : null
            }
            inputRegion={
                <textarea
                    ref={taRef}
                    value={value}
                    onChange={(e) => {
                        onChange(e.target.value);
                        syncSuggest();
                    }}
                    onKeyDown={onKeyDown}
                    onKeyUp={syncSuggest}
                    onClick={syncSuggest}
                    onBlur={() => setSugg(null)}
                    rows={1}
                    autoFocus
                    placeholder="Give Jarvis a goal…"
                    className="max-h-[160px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none"
                    style={{ caretColor: "var(--color-primary)" }}
                />
            }
            footerLeft={<span className="font-mono text-[11px] text-ink-mid">{footer}</span>}
        />
    );
}

// Talk face: a plain message box addressed to the run's live worker. Sending injects the text as a
// follow-up turn (the behavior formerly called "Steer"). No command autocomplete; a + New run breaks
// back to the Launch face.
function TalkComposer({
    worker,
    phaseLabel,
    value,
    onChange,
    onSubmit,
    onNewRun,
}: {
    worker: AgentVM;
    phaseLabel: string | undefined;
    value: string;
    onChange: (next: string) => void;
    onSubmit: () => void;
    onNewRun: () => void;
}) {
    return (
        <ComposerShell
            onSubmit={onSubmit}
            sendLabel="Send ⏎"
            inputRegion={
                <>
                    <div className="mb-2.5 flex items-center gap-2 border-b border-edge-mid pb-2.5">
                        <span className="text-[12px] font-bold text-primary">{worker.name}</span>
                        <span className="rounded-[4px] bg-success/12 px-1.5 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-[.05em] text-success">
                            live
                        </span>
                        {phaseLabel ? <span className="text-[11px] text-muted">· {phaseLabel}</span> : null}
                        <div className="flex-1" />
                        <button
                            type="button"
                            onClick={onNewRun}
                            className="cursor-pointer rounded-[7px] border border-edge-mid px-2.5 py-1 font-mono text-[11px] text-muted hover:border-edge-strong hover:text-secondary"
                        >
                            ＋ New run
                        </button>
                    </div>
                    <textarea
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                onSubmit();
                            }
                        }}
                        rows={1}
                        autoFocus
                        placeholder={`Message ${worker.name}…`}
                        className="max-h-[160px] w-full resize-none overflow-y-auto bg-transparent text-[14px] leading-[1.5] text-primary placeholder:text-muted focus:outline-none"
                        style={{ caretColor: "var(--color-primary)" }}
                    />
                </>
            }
            footerLeft={
                <span className="font-mono text-[11px] text-ink-mid">→ injected as a follow-up turn to {worker.name}</span>
            }
        />
    );
}

// ── The context panel: Needs you / Consults / Fleet here ─────────────────────────────────────────────

// One compact attention card for the Needs-you list. Clicking it selects the owning run so the full
// gate/ask card in the run body is one navigation away.
function NeedsRow({ kind, source, text, action, onGo }: { kind: string; source: string; text: string; action: string; onGo: () => void }) {
    return (
        <button
            type="button"
            onClick={onGo}
            className="relative w-full overflow-hidden rounded-[11px] border border-asking/40 bg-warning/10 px-3 py-2.5 text-left hover:border-asking/60"
        >
            <span className="absolute inset-y-0 left-0 w-[3px] bg-asking" />
            <div className="mb-1.5 flex items-center gap-2">
                <span className="h-[7px] w-[7px] flex-none rounded-full bg-asking" />
                <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[.07em] text-asking">{kind}</span>
                <div className="flex-1" />
                <span className="truncate font-mono text-[9.5px] text-muted" style={{ maxWidth: 120 }}>
                    {source}
                </span>
            </div>
            <p className="mb-2 text-[12.5px] font-medium leading-[1.45] text-primary">{text}</p>
            <span className="inline-block rounded-[6px] bg-asking px-2.5 py-1 font-mono text-[10.5px] font-bold text-background">
                {action}
            </span>
        </button>
    );
}

function ConsultCard({
    msg,
    allMessages,
    streams,
    dispatched,
    onDispatch,
}: {
    msg: ChannelMessage;
    allMessages: ChannelMessage[];
    streams: Record<string, ConsultStream>;
    dispatched: boolean;
    onDispatch: () => void;
}) {
    const cid = consultIdOf(msg.reforef);
    const replies = cid ? allMessages.filter((m) => m.kind === "consult-reply" && consultIdOf(m.reforef) === cid) : [];
    const repliedRuntimes = new Set(replies.map((r) => r.author));
    const liveKeys = cid
        ? Object.keys(streams).filter((k) => k.startsWith(`${cid}:`) && !repliedRuntimes.has(k.split(":")[1]))
        : [];
    return (
        <div className="rounded-[11px] border border-border bg-background px-3 py-2.5">
            <p className="mb-1.5 text-[12px] font-medium leading-[1.45] text-secondary">{msg.text || "(empty)"}</p>
            <div className="flex flex-col gap-1.5">
                {replies.map((r) => (
                    <div key={r.id}>
                        <span className="mb-0.5 inline-block rounded-[4px] border border-accent/25 bg-accentbg/10 px-1.5 py-px font-mono text-[8px] font-semibold uppercase tracking-[.05em] text-accent-soft">
                            {r.author}
                        </span>
                        <p className="text-[11.5px] leading-[1.5] text-muted">{r.text}</p>
                    </div>
                ))}
                {liveKeys.map((k) => {
                    const runtime = k.split(":")[1];
                    const s = streams[k];
                    return (
                        <div key={k}>
                            <span className="mb-0.5 inline-block rounded-[4px] border border-accent/25 bg-accentbg/10 px-1.5 py-px font-mono text-[8px] font-semibold uppercase tracking-[.05em] text-accent-soft">
                                {runtime} {s.status === "streaming" ? "· consulting…" : ""}
                            </span>
                            <p className="text-[11.5px] leading-[1.5] text-muted">{s.text || "…"}</p>
                        </div>
                    );
                })}
            </div>
            {dispatched ? (
                <div className="mt-2 flex items-center gap-1.5">
                    <span className="text-[11px] text-success">✓</span>
                    <span className="text-[11px] text-success">Promoted to a run</span>
                </div>
            ) : (
                <button
                    type="button"
                    onClick={onDispatch}
                    className="mt-2 cursor-pointer rounded-[7px] border border-edge-mid px-2.5 py-1 font-mono text-[11px] text-accent-soft hover:border-accent/50"
                >
                    Dispatch ↗
                </button>
            )}
        </div>
    );
}

function ContextPanel({
    model,
    channel,
    agents,
    runs,
    consultStreams,
    onSelectRun,
    onDispatchConsult,
}: {
    model: AgentsViewModel;
    channel: Channel | null;
    agents: AgentVM[];
    runs: Run[];
    consultStreams: Record<string, ConsultStream>;
    onSelectRun: (runId: string) => void;
    onDispatchConsult: (question: string) => void;
}) {
    const [dispatched, setDispatched] = useState<Set<string>>(new Set());
    const [showGone, setShowGone] = useState(false);
    const snapshot = channel ? buildFleetSnapshot(channel, agents) : [];
    const messages = channel?.messages ?? [];
    const counts = fleetCounts(snapshot);
    const costUsd = fleetCostUsd(snapshot);
    const liveWorkers = snapshot.filter((w) => w.state !== "gone");
    const goneWorkers = snapshot.filter((w) => w.state === "gone");

    // owning run of a worker tab oref (for click-to-navigate)
    const runIdOfWorker = (oref: string): string | undefined =>
        runs.find((r) => (r.phases ?? []).some((p) => (p.workerorefs ?? []).includes(oref)))?.id;

    // Needs you — unified: review gates + Jarvis escalations + live-worker asks
    const gateItems = runs
        .filter((r) => reviewGate(r))
        .map((r) => ({ key: `gate:${r.id}`, kind: "review gate", source: r.goal, text: "Approve before Jarvis proceeds.", action: "Review", runId: r.id }));
    const escItems = messages
        .filter((m) => m.kind === "jarvis-escalation")
        .map((m) => {
            const card = parseCardData(m);
            if (!card) {
                return null;
            }
            const worker = workerFor(agents, card.workerORef);
            if (!escalationPending(card, worker)) {
                return null;
            }
            return { key: m.id, kind: "escalation", source: worker?.name ?? "worker", text: card.question, action: "Decide", runId: runIdOfWorker(card.workerORef) };
        })
        .filter((x): x is NonNullable<typeof x> => x != null);
    const asks = pendingAsks(snapshot, messages);
    const askItems = asks.map((w) => ({
        key: w.oref,
        kind: "worker ask",
        source: w.name,
        text: w.askText ?? "Waiting on your reply",
        action: "Answer",
        runId: runIdOfWorker(w.oref),
    }));
    const needs = [...gateItems, ...escItems, ...askItems];

    const consultMsgs = messages.filter((m) => m.kind === "consult");
    const label = "mb-2 font-mono text-[9px] uppercase tracking-[.09em] text-muted";

    const sections: RailSection[] = [
        {
            id: "needs-you",
            label: needs.length > 0 ? `Needs you · ${needs.length}` : "Needs you",
            icon: RAIL_ICON.bell,
            content: (
                <div>
                    <div className={label}>Needs you{needs.length > 0 ? ` · ${needs.length}` : ""}</div>
                    {needs.length === 0 ? (
                        <div className="flex items-center gap-2 rounded-[10px] border border-border bg-background px-3 py-2.5">
                            <span className="h-[7px] w-[7px] flex-none rounded-full bg-success" />
                            <span className="text-[12px] leading-[1.4] text-secondary">All clear — Jarvis is handling routine asks.</span>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            {needs.map((n) => (
                                <NeedsRow
                                    key={n.key}
                                    kind={n.kind}
                                    source={n.source}
                                    text={n.text}
                                    action={n.action}
                                    onGo={() => n.runId && onSelectRun(n.runId)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            ),
        },
        {
            id: "consults",
            label: "Consults",
            icon: RAIL_ICON.info,
            content: (
                <div>
                    <div className={label}>Consults · Ask-mode results</div>
                    {consultMsgs.length === 0 ? (
                        <p className="text-[11.5px] text-muted">No consults yet — try @ask in the composer.</p>
                    ) : (
                        <div className="flex flex-col gap-2">
                            {consultMsgs.map((m) => {
                                const cid = consultIdOf(m.reforef) ?? m.id;
                                return (
                                    <ConsultCard
                                        key={m.id}
                                        msg={m}
                                        allMessages={messages}
                                        streams={consultStreams}
                                        dispatched={dispatched.has(cid)}
                                        onDispatch={() => {
                                            setDispatched((d) => new Set(d).add(cid));
                                            onDispatchConsult(m.text);
                                        }}
                                    />
                                );
                            })}
                        </div>
                    )}
                </div>
            ),
        },
        {
            id: "fleet",
            label: "Fleet here",
            icon: RAIL_ICON.fleet,
            content: (
                <div>
                    <div className={label}>
                        Fleet here · {counts.working} working · {counts.waiting} waiting
                        {costUsd > 0 ? ` · ${formatUsd(costUsd)}` : ""}
                    </div>
                    {snapshot.length === 0 ? (
                        <p className="text-[11.5px] text-muted">No workers dispatched here yet.</p>
                    ) : (
                        <>
                            {liveWorkers.length === 0 ? (
                                <p className="text-[11.5px] text-muted">No active workers.</p>
                            ) : (
                                liveWorkers.map((w) => <WorkerRow key={w.oref} model={model} w={w} />)
                            )}
                            {goneWorkers.length > 0 ? (
                                <div className="mt-1">
                                    <button
                                        type="button"
                                        onClick={() => setShowGone((v) => !v)}
                                        className="mb-1.5 flex w-full cursor-pointer items-center gap-1.5 font-mono text-[10px] uppercase tracking-[.09em] text-muted hover:text-secondary"
                                    >
                                        <span>{showGone ? "▾" : "▸"}</span> Done · {goneWorkers.length}
                                    </button>
                                    {showGone
                                        ? goneWorkers.map((w) => (
                                              <WorkerRow
                                                  key={w.oref}
                                                  model={model}
                                                  w={w}
                                                  channelId={channel?.oid}
                                                  onDismiss={(cid, oref) => fireAndForget(() => dismissWorker(cid, oref))}
                                              />
                                          ))
                                        : null}
                                </div>
                            ) : null}
                        </>
                    )}
                </div>
            ),
        },
    ];

    return <CollapsibleRail openAtom={channelRailOpenAtom} ariaLabel="Channel context" sections={sections} />;
}

// ── The surface ──────────────────────────────────────────────────────────────────────────────────────

export function ChannelsSurface({ model }: { model: AgentsViewModel }) {
    const channels = useAtomValue(channelsAtom);
    const activeId = useAtomValue(activeChannelIdAtom);
    const active = useAtomValue(activeChannelAtom);
    const agents = useAtomValue(model.agentsAtom);
    const projects = useAtomValue(projectsAtom);
    const consultStreams = useAtomValue(consultStreamsAtom);
    const pendingDraft = useAtomValue(pendingRunDraftAtom);
    const setPendingDraft = useSetAtom(pendingRunDraftAtom);
    const setProfileOpen = useSetAtom(profileRailOpenAtom);

    const [draft, setDraft] = useState("");
    const [picking, setPicking] = useState(false);
    const [overviewOpen, setOverviewOpen] = useState(false);
    const [summary, setSummary] = useState<SummaryState | null>(null);
    const [profile, setProfile] = useState<JarvisProfile | undefined>(undefined);
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());

    const runs = (active?.runs ?? []).filter((r) => !dismissed.has(r.id));
    const [activeRunId, setActiveRunId] = useState<string | undefined>(() => defaultRunId(runs));

    const tier = tierFromMeta(active?.meta as Record<string, unknown> | undefined);
    const autonomyOn = tier !== "concierge";

    // keep a valid run selection as the channel / visible runs change; drop view-local dismissals on switch
    useEffect(() => {
        setActiveRunId((cur) => resolveActiveRunId(runs, cur));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [active?.oid, runs.length]);
    useEffect(() => {
        setDismissed(new Set());
        setSummary(null);
        setDraft("");
        setOverviewOpen(false);
    }, [activeId]);

    // the channel's resolved Jarvis profile drives the composer's run footer + createRun defaults (the ⚙
    // drawer edits it). Refetched on channel change.
    useEffect(() => {
        if (!activeId) {
            setProfile(undefined);
            return;
        }
        let live = true;
        getJarvisProfile(activeId)
            .then((r) => {
                if (live) {
                    setProfile(r.resolved);
                }
            })
            .catch(() => {});
        return () => {
            live = false;
        };
    }, [activeId]);

    useEffect(() => {
        fireAndForget(loadChannels);
    }, []);

    // land a Radar handoff exactly once: resolve its project to a channel and select it. The guard lives
    // on the atom (not a ref) so it survives ChannelsSurface unmounting on navigation.
    useEffect(() => {
        if (!pendingDraft || pendingDraft.landed) {
            return;
        }
        const target = resolveTargetChannel(channels ?? [], pendingDraft.projectPath);
        if (target) {
            fireAndForget(() => selectChannel(target.oid));
            setPendingDraft({ ...pendingDraft, landed: true });
        } else {
            setPicking(true); // no channel for this project yet — stays unlanded so it retries once one exists
        }
    }, [pendingDraft, channels]);

    const roster: RosterEntry[] = agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId }));

    const dismissTab = (id: string) => {
        const next = new Set(dismissed);
        next.add(id);
        setDismissed(next);
        const visible = (active?.runs ?? []).filter((r) => !next.has(r.id));
        setActiveRunId((cur) => (cur === id ? defaultRunId(visible) : cur));
    };

    const run = runs.find((r) => r.id === activeRunId);
    const launchRun = pendingDraft ? undefined : run; // a pending Radar draft forces the Launch (investigation) face
    const face = active ? composerFace(launchRun, agents) : { face: "launch" as const };

    const selectNewRun = () => {
        setPendingDraft(null);
        setDraft("");
        setActiveRunId(undefined);
    };
    const goToRun = (id: string) => {
        setPendingDraft(null);
        setActiveRunId(id);
    };

    const toggleAutonomy = () => {
        if (!active) {
            return;
        }
        const next = autonomyOn ? "concierge" : "gatekeeper";
        const mode = ((active.meta as Record<string, unknown> | undefined)?.["delegator:mode"] as string) ?? "report";
        fireAndForget(() => setChannelTier(active.oid, next, mode));
    };

    // Jarvis fleet summary → overview strip (streams JarvisCommand into local state; not autonomy-gated)
    const runSummary = () => {
        if (!active) {
            return;
        }
        const snapshot = buildFleetSnapshot(active, agents);
        if (snapshot.length === 0) {
            setSummary({ status: "done", text: "No workers dispatched in this channel yet." });
            return;
        }
        const prompt = buildJarvisPrompt(snapshot, active, "");
        const reqId = crypto.randomUUID();
        setSummary({ status: "streaming", text: "" });
        fireAndForget(async () => {
            try {
                const gen = RpcApi.JarvisCommand(
                    TabRpcClient,
                    { channelid: active.oid, prompt, requestid: reqId },
                    { timeout: JARVIS_RPC_TIMEOUT_MS }
                );
                let acc = "";
                for await (const chunk of gen) {
                    acc += chunk?.text ?? "";
                    setSummary({ status: "streaming", text: acc });
                }
                setSummary({ status: "done", text: acc });
            } catch {
                setSummary((s) => ({ status: "error", text: s?.text ?? "" }));
            }
        });
    };

    const launchValue = pendingDraft ? pendingDraft.goal : draft;
    const onLaunchChange = pendingDraft ? (v: string) => setPendingDraft((d) => (d ? { ...d, goal: v } : d)) : setDraft;

    const dispatchToRun = (goal: string) => {
        if (!active || !goal.trim()) {
            return;
        }
        fireAndForget(async () => {
            const created = await createRun(active.oid, goal, { mode: profile?.defaultmode, planGate: profile?.defaultplangate });
            goToRun(created.id);
        });
    };

    const send = () => {
        if (!active) {
            return;
        }
        if (face.face === "talk") {
            const text = draft.trim();
            if (!text) {
                return;
            }
            setDraft("");
            fireAndForget(() => steerWorker({ channelId: active.oid, workerORef: `tab:${face.worker.id}`, agents, text }));
            return;
        }
        // Launch face
        if (pendingDraft) {
            const goal = pendingDraft.goal.trim();
            if (!goal) {
                return;
            }
            const radarOrigin = pendingDraft.radarOrigin;
            setPendingDraft(null);
            fireAndForget(async () => {
                const created = await createRun(active.oid, goal, {
                    mode: profile?.defaultmode,
                    planGate: profile?.defaultplangate,
                    radarOrigin,
                });
                setActiveRunId(created.id);
            });
            return;
        }
        const text = draft.trim();
        if (!text) {
            return;
        }
        setDraft("");
        const cmd = parseComposerCommand(text);
        if (cmd.mode === "run") {
            fireAndForget(async () => {
                const created = await createRun(active.oid, cmd.body, {
                    mode: profile?.defaultmode,
                    planGate: profile?.defaultplangate,
                });
                setActiveRunId(created.id);
            });
            return;
        }
        // Quick → dispatch a bare worker; Ask → one-shot consult. Both route through sendChannelMessage's
        // planMessage transport (@runtime … / ask @runtime …); this mirrors the Ctrl+P palette exactly.
        const transport = cmd.mode === "quick" ? `@${cmd.runtime ?? "claude"} ${cmd.body}` : `ask @${cmd.runtime ?? "claude"} ${cmd.body}`;
        fireAndForget(() =>
            sendChannelMessage({
                model,
                channelId: active.oid,
                projectPath: active.projectpath ?? "",
                projectName: active.name ?? "agent",
                roster,
                agents,
                text: transport,
            })
        );
    };

    // A channel is bound to a project at creation, so every dispatch has a valid cwd (no unbound state).
    const pickProject = (name: string, path: string) => {
        setPicking(false);
        fireAndForget(async () => {
            await createChannel(name, path);
        });
    };

    const phaseLabel = run ? run.phases?.[currentPhaseIndex(run)]?.kind : undefined;

    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 flex">
                <ChannelRail
                    channels={channels}
                    activeId={activeId}
                    agents={agents}
                    projects={projects}
                    picking={picking}
                    onSelect={(id) => fireAndForget(() => selectChannel(id))}
                    onToggleNew={() => setPicking((p) => !p)}
                    onPickProject={pickProject}
                    onDeleteChannel={(id) => fireAndForget(() => deleteChannel(id))}
                    onSetTier={(id, t) =>
                        fireAndForget(() =>
                            setChannelTier(
                                id,
                                t,
                                ((channels?.find((c) => c.oid === id)?.meta as Record<string, unknown> | undefined)?.[
                                    "delegator:mode"
                                ] as string) ?? "report"
                            )
                        )
                    }
                    onRenameChannel={(id, name) => fireAndForget(() => renameChannel(id, name))}
                    onArchiveChannel={(id, archived) => fireAndForget(() => archiveChannel(id, archived))}
                />

                <div className="@container flex min-w-0 flex-1">
                    <div className="flex min-w-0 flex-1 flex-col">
                        {/* header */}
                        <div className="flex flex-none items-center gap-2.5 border-b border-border bg-background px-[22px] py-3">
                            <span className="font-mono text-[17px] font-bold text-muted">#</span>
                            <div className="min-w-0">
                                <div className="truncate text-[15px] font-bold tracking-[-0.01em] text-primary">
                                    {active?.name ?? "no channel"}
                                </div>
                                {active?.projectpath ? (
                                    <div className="truncate font-mono text-[11.5px] text-muted">{active.projectpath}</div>
                                ) : null}
                            </div>
                            <div className="flex-1" />
                            {active ? (
                                <>
                                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[.09em] text-muted">Jarvis</span>
                                    <button
                                        type="button"
                                        onClick={toggleAutonomy}
                                        title={
                                            autonomyOn
                                                ? "Jarvis auto-answers routine asks and escalates real forks to you. Click to switch to Observing."
                                                : "Jarvis stays hands-off; every worker ask routes to you. Click to let Jarvis handle routine asks."
                                        }
                                        className={
                                            "flex cursor-pointer items-center gap-2.5 rounded-[9px] border px-2.5 py-1.5 " +
                                            (autonomyOn ? "border-accent/40 bg-accentbg/20" : "border-edge-mid bg-background")
                                        }
                                    >
                                        <span className={"text-[11.5px] font-bold " + (autonomyOn ? "text-accent-soft" : "text-secondary")}>
                                            {autonomyOn ? "Handling asks" : "Observing"}
                                        </span>
                                        <span
                                            className={
                                                "relative h-[18px] w-[34px] flex-none rounded-full transition-colors " +
                                                (autonomyOn ? "bg-accent" : "bg-edge-mid")
                                            }
                                        >
                                            <span
                                                className={
                                                    "absolute top-0.5 h-[14px] w-[14px] rounded-full transition-all " +
                                                    (autonomyOn ? "left-[18px] bg-background" : "left-0.5 bg-secondary")
                                                }
                                            />
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setProfileOpen((o) => !o)}
                                        title="Channel profile — run engine (pipeline vs. adaptive lead) & plan gate live here"
                                        className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] border border-edge-mid bg-background text-[15px] text-muted hover:border-edge-strong hover:text-secondary"
                                    >
                                        ⚙
                                    </button>
                                </>
                            ) : null}
                        </div>

                        {active ? (
                            <>
                                {/* overview / notes strip */}
                                <div className="flex-none border-b border-border bg-background">
                                    <button
                                        type="button"
                                        onClick={() => setOverviewOpen((o) => !o)}
                                        className="flex w-full cursor-pointer items-center gap-2.5 px-[22px] py-2 hover:bg-surface"
                                    >
                                        <span className={"font-mono text-[7px] text-muted transition-transform " + (overviewOpen ? "rotate-90" : "")}>
                                            ▶
                                        </span>
                                        <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-muted">
                                            Overview &amp; notes
                                        </span>
                                        <span className="font-mono text-[11px] text-ink-mid">
                                            · {runs.length} run{runs.length === 1 ? "" : "s"}
                                        </span>
                                        <div className="flex-1" />
                                        {!overviewOpen ? (
                                            <span className="truncate text-[11px] text-muted" style={{ maxWidth: 420 }}>
                                                Channel notes — coming soon
                                            </span>
                                        ) : null}
                                    </button>
                                    {overviewOpen ? (
                                        <div className="flex items-start gap-3.5 px-[22px] pb-3.5 pt-0.5">
                                            <div className="min-w-0 flex-1">
                                                <div className="mb-1.5 font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-muted">
                                                    Channel notes
                                                </div>
                                                <div className="rounded-[10px] border border-border bg-background px-3 py-2.5 text-[12.5px] leading-[1.6] text-muted opacity-60">
                                                    Channel notes — coming soon.
                                                </div>
                                            </div>
                                            <div className="w-[280px] flex-none">
                                                <div className="mb-1.5 font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-muted">
                                                    Jarvis summary
                                                </div>
                                                {summary ? (
                                                    <div className="rounded-[10px] border border-accent/25 bg-accentbg/15 px-3 py-2.5">
                                                        <div className="mb-1.5 flex items-center gap-1.5">
                                                            <Avatar name="jarvis" />
                                                            <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-accent-soft">
                                                                Jarvis {summary.status === "streaming" ? "· thinking…" : ""}
                                                            </span>
                                                        </div>
                                                        <MarkdownMessage text={summary.text || "…"} className="text-[12px] leading-[1.55] text-secondary" />
                                                    </div>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        onClick={runSummary}
                                                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] border border-accent/25 bg-background px-3 py-2.5 text-left hover:border-accent/40"
                                                    >
                                                        <Avatar name="jarvis" />
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block text-[12px] font-bold text-accent-soft">Summarize the fleet</span>
                                                            <span className="text-[10.5px] text-muted">on-demand · not gated by autonomy</span>
                                                        </span>
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ) : null}
                                </div>

                                {/* run strip */}
                                <div className="sc flex flex-none gap-2 overflow-x-auto border-b border-border bg-background px-[22px] py-2.5">
                                    {runs.map((r) => {
                                        const { tone } = runStatusView(r.status);
                                        const dots = phaseProgressDots(r);
                                        const isActive = !pendingDraft && r.id === activeRunId;
                                        return (
                                            <div
                                                key={r.id}
                                                className={
                                                    "group flex max-w-[250px] flex-none items-center gap-2 rounded-[9px] border px-3 py-2 " +
                                                    (isActive ? "border-accent/50 bg-accentbg/40" : "border-edge-mid hover:border-edge-strong")
                                                }
                                            >
                                                <button type="button" onClick={() => goToRun(r.id)} className="flex min-w-0 items-center gap-2">
                                                    {r.mode === "quick" ? (
                                                        <span className="flex-none font-mono text-[8px] font-bold uppercase tracking-[.05em] text-accent-soft">Q</span>
                                                    ) : null}
                                                    <span className={"h-[7px] w-[7px] flex-none rounded-full bg-current " + (TONE_CLASS[tone] ?? "text-muted")} />
                                                    <span className="truncate text-[12px] font-semibold text-primary">{r.goal}</span>
                                                </button>
                                                {dots.length > 0 ? (
                                                    <span className="flex flex-none items-center gap-0.5">
                                                        {dots.map((t, i) => (
                                                            <span key={i} className={"h-[4px] w-[4px] rounded-full bg-current " + (PHASE_TONE_CLASS[t] ?? "text-muted")} />
                                                        ))}
                                                    </span>
                                                ) : null}
                                                <button
                                                    type="button"
                                                    onClick={() => dismissTab(r.id)}
                                                    title="Dismiss from this list (does not cancel the run)"
                                                    className="flex-none font-mono text-[13px] leading-none text-muted opacity-0 hover:text-secondary group-hover:opacity-100"
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        );
                                    })}
                                    <button
                                        type="button"
                                        onClick={selectNewRun}
                                        className={
                                            "flex-none rounded-[9px] border px-3 py-2 text-[12px] font-semibold " +
                                            (!pendingDraft && !run
                                                ? "border-accent/50 bg-accentbg/40 text-accent-soft"
                                                : "border-dashed border-edge-mid text-muted hover:text-secondary")
                                        }
                                    >
                                        ＋ New run
                                    </button>
                                </div>

                                {/* run body */}
                                {pendingDraft ? (
                                    <div className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5">
                                        <div className="mx-auto w-full max-w-[620px]">
                                            <div className="mb-1 text-center text-[17px] font-bold text-primary">Start investigation</div>
                                            <div className="mb-5 text-center text-[13px] text-muted">Review the draft goal below, then start it.</div>
                                            <div className="rounded-[10px] border border-accent/30 bg-accentbg/15 px-3.5 py-3">
                                                <div className="mb-2 flex items-center gap-2">
                                                    <span className="font-mono text-[9px] font-semibold uppercase tracking-[.1em] text-accent-soft">From Radar finding</span>
                                                    <span className="flex-1" />
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setPendingDraft(null);
                                                            setDraft("");
                                                        }}
                                                        className="rounded-[6px] border border-edge-mid px-2 py-0.5 font-mono text-[10px] text-muted hover:border-edge-strong hover:text-secondary"
                                                    >
                                                        Discard
                                                    </button>
                                                </div>
                                                {pendingDraft.files.length > 0 ? (
                                                    <div className="mb-1.5 flex flex-wrap gap-1.5">
                                                        {pendingDraft.files.map((f) => (
                                                            <span key={f} className="rounded-full border border-edge-mid px-2 py-0.5 font-mono text-[10.5px] text-muted">
                                                                {f}
                                                            </span>
                                                        ))}
                                                    </div>
                                                ) : null}
                                                {pendingDraft.evidenceRefs.length > 0 ? (
                                                    <div className="font-mono text-[10.5px] text-muted">
                                                        {pendingDraft.evidenceRefs.length} evidence signal{pendingDraft.evidenceRefs.length === 1 ? "" : "s"}
                                                    </div>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                ) : run ? (
                                    <RunBody model={model} channel={active} agents={agents} run={run} />
                                ) : (
                                    <div className="sc min-h-0 flex-1 overflow-y-auto px-6 pb-3 pt-5">
                                        <div className="mx-auto flex max-w-[520px] flex-col items-center gap-3.5 pt-16 text-center">
                                            <div className="text-[20px] font-bold tracking-[-0.01em] text-primary">Start a run in #{active.name}</div>
                                            <p className="max-w-[420px] text-[13.5px] leading-[1.6] text-muted">
                                                Give Jarvis a goal below. <b className="text-secondary">@quick</b> spawns one worker,{" "}
                                                <b className="text-secondary">@run</b> kicks off the channel's full strategy — pipeline or adaptive lead, set in{" "}
                                                <b className="text-secondary">⚙</b> — and <b className="text-secondary">@ask</b> is a one-shot consult.
                                            </p>
                                        </div>
                                    </div>
                                )}

                                {/* composer (two faces) */}
                                <div className="flex-none px-6 pb-[18px] pt-2">
                                    <div className="mx-auto max-w-[760px]">
                                        {face.face === "talk" ? (
                                            <TalkComposer
                                                worker={face.worker}
                                                phaseLabel={phaseLabel}
                                                value={draft}
                                                onChange={setDraft}
                                                onSubmit={send}
                                                onNewRun={selectNewRun}
                                            />
                                        ) : (
                                            <LaunchComposer
                                                value={launchValue}
                                                onChange={onLaunchChange}
                                                onSubmit={send}
                                                profile={profile}
                                                channelName={active.name ?? "channel"}
                                                pending={!!pendingDraft}
                                            />
                                        )}
                                    </div>
                                </div>
                            </>
                        ) : (
                            <div className="flex min-h-0 flex-1 items-start justify-center">
                                <div className="mt-16 text-center text-[13px] text-muted">
                                    {channels == null ? (
                                        "Loading…"
                                    ) : (
                                        <>
                                            No channel yet — click <span className="text-secondary">＋ New channel</span> to create one bound to a project.
                                        </>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                    <ContextPanel
                        model={model}
                        channel={active}
                        agents={agents}
                        runs={runs}
                        consultStreams={consultStreams}
                        onSelectRun={goToRun}
                        onDispatchConsult={dispatchToRun}
                    />
                    <ProfilePanel channelId={active?.oid ?? ""} />
                </div>
            </div>
        </MotionConfig>
    );
}
