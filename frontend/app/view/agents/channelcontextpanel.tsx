// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The channel context panel: the right rail with Needs you / Consults / Fleet here. Extracted from
// channelssurface.tsx. Presentational + light derivation; the needs assembly is the pure buildNeeds.

import { CollapsibleRail, type RailSection } from "@/app/element/collapsiblerail";
import { fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { type AgentVM } from "./agentsviewmodel";
import { dismissWorker } from "./channelactions";
import { buildNeeds } from "./channelneeds";
import { WorkerRow } from "./channelsprimitives";
import { type ConsultStream } from "./channelsstore";
import { fleetCounts } from "./jarviscards";
import { buildFleetSnapshot, fleetCostUsd } from "./jarvisderive";
import { RAIL_ICON } from "./railicons";
import { channelRailOpenAtom } from "./railstore";

function consultIdOf(refORef?: string): string | undefined {
    return refORef?.startsWith("consult:") ? refORef.slice("consult:".length) : undefined;
}

function formatUsd(n: number): string {
    return `$${n.toFixed(2)}`;
}

// One compact attention card for the Needs-you list. Clicking it selects the owning run so the full
// gate/ask card in the run body is one navigation away.
function NeedsRow({ kind, source, text, action, onGo }: { kind: string; source: string; text: string; action: string; onGo?: () => void }) {
    // no onGo → the owning run couldn't be resolved (e.g. a bare @quick worker in no run); render the
    // card as static info, not a clickable-looking affordance that silently no-ops.
    const interactive = !!onGo;
    return (
        <button
            type="button"
            onClick={onGo}
            disabled={!interactive}
            className={
                "relative w-full overflow-hidden rounded-[11px] border border-asking/40 bg-warning/10 px-3 py-2.5 text-left " +
                (interactive ? "cursor-pointer hover:border-asking/60" : "cursor-default")
            }
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
            <span className="inline-block rounded-sm bg-asking px-2.5 py-1 font-mono text-[10.5px] font-bold text-background">
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

export function ContextPanel({
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
    // the dispatched-consult set is view-local; drop it on channel switch so a "Promoted to a run"
    // marker from one channel never bleeds into another
    useEffect(() => setDispatched(new Set()), [channel?.oid]);
    const snapshot = channel ? buildFleetSnapshot(channel, agents) : [];
    const messages = channel?.messages ?? [];
    const counts = fleetCounts(snapshot);
    const costUsd = fleetCostUsd(snapshot);
    const liveWorkers = snapshot.filter((w) => w.state !== "gone");
    const goneWorkers = snapshot.filter((w) => w.state === "gone");

    const needs = buildNeeds({ runs, messages, agents, snapshot });

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
                                    onGo={n.runId ? () => onSelectRun(n.runId!) : undefined}
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

    return (
        <CollapsibleRail openAtom={channelRailOpenAtom} ariaLabel="Channel context" sections={sections} />
    );
}
