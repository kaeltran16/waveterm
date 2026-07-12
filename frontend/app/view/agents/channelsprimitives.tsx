// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared UI atoms for the Channels + Runs surfaces: avatars, tags, the live-ask answer row, a fleet
// worker row, and small worker-resolution helpers. Extracted from channelssurface.tsx so runssurface.tsx
// reuses them without duplication.

import { globalStore } from "@/app/store/jotaiStore";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { useAtomValue, useSetAtom } from "jotai";
import type { AgentsViewModel } from "./agents";
import { toggleSelection, type AgentVM } from "./agentsviewmodel";
import { AnswerBar } from "./answerbar";
import { avatarColor } from "./channelderive";
import type { WorkerState } from "./jarvisderive";
import { runtimeLogo } from "./runtimelogo";

export const STATE_DOT: Record<string, string> = {
    working: "var(--color-success)",
    asking: "var(--color-asking)",
    idle: "var(--color-muted)",
    gone: "var(--color-edge-strong)",
};

// resolve a dispatch/directive RefORef ("tab:<id>") to the live roster row, if still present
export function workerFor(agents: AgentVM[], refORef: string): AgentVM | undefined {
    if (!refORef.startsWith("tab:")) {
        return undefined;
    }
    const id = refORef.slice(4);
    return agents.find((a) => a.id === id);
}

export function jumpToAgent(model: AgentsViewModel, id: string) {
    globalStore.set(model.focusIdAtom, id);
    globalStore.set(model.terminalTargetAtom, undefined);
    globalStore.set(model.surfaceAtom, "agent");
}

export function timeLabel(ts: number, now: number): string {
    return now - ts < 60_000 ? "now" : new Date(ts).toLocaleTimeString();
}

// 32px rounded avatar. Jarvis (the manager) gets a diamond glyph on an accent gradient; a runtime
// author (claude/codex/antigravity) gets its real brand mark on a white logo-tile (initials are
// ambiguous — claude and codex both start with "C"); everyone else gets a deterministically-colored initial.
export function Avatar({ name }: { name: string }) {
    if (name.toLowerCase() === "jarvis") {
        return (
            <div className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] bg-accent">
                <span className="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-background" />
            </div>
        );
    }
    const logo = runtimeLogo(name);
    if (logo) {
        return (
            <img
                src={logo}
                alt={name}
                title={name}
                className="h-8 w-8 flex-none rounded-[9px] border border-edge-mid bg-white object-contain p-1.5"
            />
        );
    }
    return (
        <div
            className="flex h-8 w-8 flex-none items-center justify-center rounded-[9px] font-mono text-[13px] font-bold text-background"
            style={{ backgroundColor: avatarColor(name) }}
        >
            {(name.charAt(0) || "?").toUpperCase()}
        </div>
    );
}

export function Tag({ label, tone }: { label: string; tone: "muted" | "asking" }) {
    if (tone === "asking") {
        return (
            <span className="rounded-[4px] bg-asking px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-background">
                {label}
            </span>
        );
    }
    return (
        <span className="rounded-[4px] border border-edge-mid bg-surface-raised px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-[.08em] text-ink-mid">
            {label}
        </span>
    );
}

// An asking worker's answer row, reusing the cockpit's AnswerBar + model answer state.
export function AskRow({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const answerSel = useAtomValue(model.answerSelAtom);
    const setAnswerSel = useSetAtom(model.answerSelAtom);
    const answerText = useAtomValue(model.answerTextAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const toggle = (qi: number, oi: number) => {
        const multi = agent.ask?.questions?.[qi]?.multiSelect ?? false;
        setAnswerSel((prev) => ({ ...prev, [agent.id]: toggleSelection(prev[agent.id] ?? {}, qi, oi, multi) }));
        model.setAnswerText(agent.id, qi, ""); // selecting clears this question's free text (exclusive)
    };
    return (
        <div className="rounded-[9px] border border-edge-mid bg-lane p-3">
            <AnswerBar
                agent={agent}
                selections={answerSel[agent.id] ?? {}}
                texts={answerText[agent.id] ?? {}}
                sent={sentIds.has(agent.id)}
                numbered
                onToggle={toggle}
                onText={(qi, value) => model.setAnswerText(agent.id, qi, value)}
                onSubmit={() => model.submitAnswer(agent.id)}
            />
        </div>
    );
}

export function WorkerRow({
    model,
    w,
    channelId,
    onDismiss,
}: {
    model: AgentsViewModel;
    w: WorkerState;
    channelId?: string;
    onDismiss?: (channelId: string, oref: string) => void;
}) {
    return (
        <div
            className="mb-2.5"
            onContextMenu={(ev) =>
                ContextMenuModel.getInstance().showContextMenu(
                    [
                        {
                            label: "Open agent",
                            enabled: w.state !== "gone",
                            click: () => jumpToAgent(model, w.oref.slice("tab:".length)),
                        },
                        ...(w.state === "gone" && channelId && onDismiss
                            ? [{ label: "Dismiss", click: () => onDismiss(channelId, w.oref) }]
                            : []),
                    ],
                    ev
                )
            }
        >
            <div className="flex items-center gap-2">
                <span
                    className="h-2 w-2 flex-none rounded-full"
                    style={{ backgroundColor: STATE_DOT[w.state] ?? "var(--color-muted)" }}
                />
                <span className="font-mono text-[12.5px] text-primary">{w.name}</span>
                {w.outcome ? (
                    <span
                        title={`outcome: ${w.outcome.status}`}
                        className={
                            w.outcome.status === "failed"
                                ? "text-[11px] text-asking"
                                : w.outcome.status === "waiting"
                                  ? "text-[11px] text-warning"
                                  : "text-[11px] text-success"
                        }
                    >
                        {w.outcome.status === "failed" ? "✗" : w.outcome.status === "waiting" ? "⏸" : "✓"}
                    </span>
                ) : null}
                {w.state !== "gone" && w.costUsd != null && w.costUsd > 0 ? (
                    <span
                        title={w.contextPct != null ? `context ${Math.round(w.contextPct)}%` : undefined}
                        className="font-mono text-[10px] text-muted"
                    >
                        ${w.costUsd.toFixed(2)}
                    </span>
                ) : null}
                {w.state === "gone" ? (
                    <span className="ml-auto font-mono text-[10px] text-muted">gone</span>
                ) : (
                    <button
                        type="button"
                        onClick={() => jumpToAgent(model, w.oref.slice("tab:".length))}
                        className="ml-auto cursor-pointer font-mono text-[10px] text-accent-soft hover:text-accent"
                    >
                        open ↗
                    </button>
                )}
            </div>
            {(w.outcome?.summary || w.dispatchTask || w.task) ? (
                <div
                    title={w.outcome?.summary || w.dispatchTask || w.task}
                    className="mt-0.5 truncate pl-4 text-[11px] text-muted"
                >
                    {w.outcome?.summary || w.dispatchTask || w.task}
                </div>
            ) : null}
            {w.state !== "gone" && w.activity ? (
                <div title={w.activity} className="mt-0.5 truncate pl-4 text-[10.5px] text-accent-soft/80">
                    {w.activity}
                </div>
            ) : null}
        </div>
    );
}
