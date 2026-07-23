// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Jarvis Fleet mode: the migrated fleet manager. Manages ONE channel's fleet at a time — reusing the
// Channels active-channel selection (channelsstore) so the two surfaces never disagree. Composes a channel
// selector, the autonomy tier toggle, the worker roster, the on-demand fleet summary, and the ⚙ profile
// drawer. All backend behavior reuses existing RPCs (SetChannelTier via setChannelTier, JarvisCommand via
// useFleetSummary, getJarvisProfile/setChannelProfile via ProfilePanel). No new state model.

import { fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "../agents/agents";
import { tierFromMeta } from "../agents/channelmessages";
import { Avatar } from "../agents/channelsprimitives";
import {
    activeChannelAtom,
    activeChannelIdAtom,
    activeChannelMessagesAtom,
    channelsAtom,
    loadChannels,
    selectChannel,
    setChannelTier,
} from "../agents/channelsstore";
import { autonomyExplainer, fleetCounts } from "../agents/jarviscards";
import { buildFleetSnapshot, fleetCostUsd } from "../agents/jarvisderive";
import { pendingFleetSummaryAtom, profileRailOpenAtom } from "./jarvisstore";
import { ProfilePanel } from "./profilepanel";
import { useFleetSummary } from "./usefleetsummary";

const STATE_TONE: Record<string, string> = {
    working: "text-working",
    asking: "text-asking",
    idle: "text-muted",
    gone: "text-ink-mid",
};

export function FleetMode({ model }: { model: AgentsViewModel }) {
    const channels = useAtomValue(channelsAtom);
    const activeId = useAtomValue(activeChannelIdAtom);
    const active = useAtomValue(activeChannelAtom);
    const messages = useAtomValue(activeChannelMessagesAtom);
    const agents = useAtomValue(model.agentsAtom);
    const setProfileOpen = useSetAtom(profileRailOpenAtom);
    const pendingSummary = useAtomValue(pendingFleetSummaryAtom);
    const setPendingSummary = useSetAtom(pendingFleetSummaryAtom);
    const { summary, runSummary } = useFleetSummary();

    useEffect(() => {
        fireAndForget(loadChannels);
    }, []);

    // land an @jarvis summary handoff: select the channel, then (once it's active) run the summary once.
    useEffect(() => {
        if (!pendingSummary) {
            return;
        }
        if (activeId !== pendingSummary.channelId) {
            fireAndForget(() => selectChannel(pendingSummary.channelId));
            return; // re-runs when activeId flips to the target
        }
        if (activeForDerive) {
            runSummary(activeForDerive, agents, pendingSummary.focus);
            setPendingSummary(null);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingSummary, activeId, messages]);

    // splice row-backed messages onto the pinned channel so buildFleetSnapshot / the summary derive from the
    // same source as the Channels surface (mirrors channelssurface's activeForDerive).
    const activeForDerive = active ? { ...active, messages } : null;
    const snapshot = activeForDerive ? buildFleetSnapshot(activeForDerive, agents) : [];
    const counts = fleetCounts(snapshot);
    const cost = fleetCostUsd(snapshot);
    const tier = tierFromMeta(active?.meta as Record<string, unknown> | undefined);
    const autonomyOn = tier !== "concierge";
    const explainer = autonomyExplainer(tier);

    const toggleAutonomy = () => {
        if (!active) {
            return;
        }
        const next = autonomyOn ? "concierge" : "gatekeeper";
        const mode = ((active.meta as Record<string, unknown> | undefined)?.["delegator:mode"] as string) ?? "report";
        fireAndForget(() => setChannelTier(active.oid, next, mode));
    };

    if (!channels || channels.length === 0) {
        return (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted">
                No channels yet. Create a channel in the Channels surface to manage its fleet here.
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
                {/* channel selector + autonomy + profile trigger */}
                <div className="flex flex-none items-center gap-2.5 border-b border-border bg-background px-6 py-3">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[.08em] text-muted">Fleet</span>
                    <select
                        value={activeId ?? ""}
                        onChange={(e) => fireAndForget(() => selectChannel(e.target.value))}
                        className="rounded-[7px] border border-edge-mid bg-surface px-2 py-1 text-[12.5px] font-semibold text-primary"
                    >
                        {channels.map((c) => (
                            <option key={c.oid} value={c.oid}>
                                #{c.name}
                            </option>
                        ))}
                    </select>
                    <div className="flex-1" />
                    {active ? (
                        <>
                            <button
                                type="button"
                                onClick={toggleAutonomy}
                                title={explainer.blurb}
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
                                title="Channel profile — playbook, principles, run engine & plan gate"
                                className="flex h-8 w-8 flex-none items-center justify-center rounded border border-edge-mid bg-background text-[15px] text-muted hover:border-edge-strong hover:text-secondary"
                            >
                                ⚙
                            </button>
                        </>
                    ) : null}
                </div>

                {/* fleet counts + summary */}
                <div className="flex flex-none items-center gap-3 border-b border-border bg-background px-6 py-2.5 text-[11.5px] text-muted">
                    <span>{counts.working} working</span>
                    <span>{counts.waiting} waiting</span>
                    {cost > 0 ? <span>${cost.toFixed(2)}</span> : null}
                    <div className="flex-1" />
                    <button
                        type="button"
                        onClick={() => activeForDerive && runSummary(activeForDerive, agents)}
                        disabled={!activeForDerive || snapshot.length === 0}
                        className="rounded-[7px] border border-accent/25 px-2.5 py-1 text-[11px] font-bold text-accent-soft hover:border-accent/40 disabled:opacity-40"
                    >
                        Summarize the fleet
                    </button>
                </div>
                {summary ? (
                    <div className="flex-none border-b border-border bg-background px-6 py-3">
                        <div className="mb-1.5 flex items-center gap-1.5">
                            <Avatar name="jarvis" />
                            <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[.08em] text-accent-soft">
                                Jarvis {summary.status === "streaming" ? "· thinking…" : ""}
                            </span>
                        </div>
                        <div className="whitespace-pre-wrap text-[12.5px] leading-[1.6] text-secondary">{summary.text || "…"}</div>
                    </div>
                ) : null}

                {/* worker roster */}
                <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-6 py-4">
                    {snapshot.length === 0 ? (
                        <div className="pt-10 text-center text-[13px] text-muted">
                            No workers dispatched in #{active?.name} yet.
                        </div>
                    ) : (
                        snapshot.map((w) => (
                            <div key={w.oref} className="flex items-center gap-2.5 rounded-[9px] border border-edge-mid bg-surface px-3 py-2">
                                <Avatar name={w.name} />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13px] font-semibold text-primary">{w.name}</div>
                                    {w.task ? <div className="truncate text-[11.5px] text-muted">{w.task}</div> : null}
                                </div>
                                {w.askText ? <span className="truncate text-[11px] text-asking" style={{ maxWidth: 220 }}>{w.askText}</span> : null}
                                <span className={"font-mono text-[10px] font-semibold uppercase tracking-[.06em] " + (STATE_TONE[w.state] ?? "text-muted")}>
                                    {w.state}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            </div>
            <ProfilePanel channelId={activeId ?? ""} />
        </div>
    );
}
