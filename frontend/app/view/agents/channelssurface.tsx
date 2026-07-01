// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Channels surface: a conversational agent-dispatch surface. Type a message; @<runtime> spawns a new
// worker, @<name> steers a live one, plain text posts a note. Dispatched workers become roster rows,
// so a dispatch row shows a live status pill and an asking worker reuses AnswerBar — Cockpit still owns
// monitoring; this surface only carries the dialogue and links out (↗).

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { AnswerBar } from "./answerbar";
import { toggleSelection, type AgentVM } from "./agentsviewmodel";
import { sendChannelMessage } from "./channelactions";
import type { RosterEntry } from "./channelmessages";
import { activeChannelAtom, activeChannelIdAtom, channelsAtom, createChannel, loadChannels, selectChannel } from "./channelsstore";
import { projectsAtom } from "./projectsstore";

const STATE_DOT: Record<string, string> = {
    working: "var(--color-accent)",
    asking: "var(--color-asking)",
    idle: "var(--color-muted)",
};

// resolve a dispatch/directive RefORef ("tab:<id>") to the live roster row, if still present
function workerFor(agents: AgentVM[], refORef: string): AgentVM | undefined {
    if (!refORef.startsWith("tab:")) {
        return undefined;
    }
    const id = refORef.slice(4);
    return agents.find((a) => a.id === id);
}

function jumpToAgent(model: AgentsViewModel, id: string) {
    globalStore.set(model.focusIdAtom, id);
    globalStore.set(model.terminalTargetAtom, undefined);
    globalStore.set(model.surfaceAtom, "agent");
}

// An asking worker's answer row, reusing the cockpit's AnswerBar + model answer state.
function AskRow({ model, agent }: { model: AgentsViewModel; agent: AgentVM }) {
    const answerSel = useAtomValue(model.answerSelAtom);
    const setAnswerSel = useSetAtom(model.answerSelAtom);
    const sentIds = useAtomValue(model.sentIdsAtom);
    const toggle = (qi: number, oi: number) => {
        const multi = agent.ask?.questions?.[qi]?.multiSelect ?? false;
        setAnswerSel((prev) => ({ ...prev, [agent.id]: toggleSelection(prev[agent.id] ?? {}, qi, oi, multi) }));
    };
    return (
        <div className="mt-2 rounded-[8px] border border-asking/40 bg-accentbg/40 p-3">
            <div className="mb-1.5 text-[12px] font-semibold text-asking">{agent.name} is asking</div>
            <AnswerBar
                agent={agent}
                selections={answerSel[agent.id] ?? {}}
                sent={sentIds.has(agent.id)}
                numbered
                onToggle={toggle}
                onSubmit={() => model.submitAnswer(agent.id)}
            />
        </div>
    );
}

function Row({ model, agents, msg, now }: { model: AgentsViewModel; agents: AgentVM[]; msg: ChannelMessage; now: number }) {
    const worker = msg.reforef ? workerFor(agents, msg.reforef) : undefined;
    const isDispatch = msg.kind === "dispatch";
    return (
        <div className="border-b border-edge-faint px-1 py-3 last:border-b-0">
            <div className="flex items-baseline gap-2">
                <span className="font-mono text-[12px] font-semibold text-primary">{msg.author}</span>
                {isDispatch ? (
                    <span className="rounded-[5px] border border-border px-1.5 font-mono text-[9.5px] font-semibold uppercase tracking-[.08em] text-muted">
                        dispatch
                    </span>
                ) : null}
                <span className="ml-auto font-mono text-[10.5px] text-muted">
                    {now - msg.ts < 60_000 ? "now" : new Date(msg.ts).toLocaleTimeString()}
                </span>
            </div>
            <div className="mt-1 text-[13.5px] leading-[1.5] text-secondary">{msg.text || "(empty)"}</div>
            {isDispatch && worker ? (
                <div className="mt-1.5 flex items-center gap-2">
                    <span className="h-[8px] w-[8px] rounded-full" style={{ backgroundColor: STATE_DOT[worker.state] ?? "var(--color-muted)" }} />
                    <span className="font-mono text-[10.5px] text-muted">{worker.state}</span>
                    <button
                        type="button"
                        onClick={() => jumpToAgent(model, worker.id)}
                        className="cursor-pointer font-mono text-[10.5px] text-ink-mid hover:text-accent-soft"
                    >
                        open ↗
                    </button>
                </div>
            ) : null}
            {isDispatch && worker && worker.state === "asking" ? <AskRow model={model} agent={worker} /> : null}
        </div>
    );
}

export function ChannelsSurface({ model }: { model: AgentsViewModel }) {
    const channels = useAtomValue(channelsAtom);
    const activeId = useAtomValue(activeChannelIdAtom);
    const active = useAtomValue(activeChannelAtom);
    const agents = useAtomValue(model.agentsAtom);
    const now = useAtomValue(model.nowAtom);
    const projects = useAtomValue(projectsAtom); // Record<string, { path?: string }>
    const [draft, setDraft] = useState("");
    const [picking, setPicking] = useState(false);
    useEffect(() => {
        fireAndForget(loadChannels);
    }, []);

    const roster: RosterEntry[] = agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId }));
    const messages = active?.messages ?? [];

    const send = () => {
        const text = draft.trim();
        if (!text || !activeId) {
            return;
        }
        setDraft("");
        fireAndForget(() =>
            sendChannelMessage({
                model,
                channelId: activeId,
                projectPath: active?.projectpath ?? "",
                projectName: active?.name ?? "agent",
                roster,
                text,
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

    return (
        <div className="absolute inset-0 flex flex-col">
            <div className="flex items-center gap-2 border-b border-border px-[30px] py-3">
                <h1 className="text-[18px] font-bold tracking-[-0.02em] text-primary">Channels</h1>
                <div className="ml-3 flex flex-wrap gap-1.5">
                    {(channels ?? []).map((c) => (
                        <button
                            key={c.oid}
                            type="button"
                            onClick={() => fireAndForget(() => selectChannel(c.oid))}
                            className={cn(
                                "cursor-pointer rounded-[7px] border px-[11px] py-[5px] text-[12px] font-medium",
                                c.oid === activeId
                                    ? "border-accent bg-accentbg text-accent-soft"
                                    : "border-border bg-surface text-ink-mid hover:border-edge-strong"
                            )}
                        >
                            {c.name}
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={() => setPicking((p) => !p)}
                        className="cursor-pointer rounded-[7px] border border-border bg-surface px-[11px] py-[5px] text-[12px] font-medium text-ink-mid hover:border-accent"
                    >
                        + New
                    </button>
                </div>
            </div>

            {picking ? (
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-[30px] py-2.5">
                    <span className="text-[11px] text-muted">New channel in project:</span>
                    {Object.entries(projects).map(([name, p]) => (
                        <button
                            key={name}
                            type="button"
                            onClick={() => pickProject(name, p?.path ?? "")}
                            className="cursor-pointer rounded-[7px] border border-border bg-surface px-[11px] py-[5px] text-[12px] font-medium text-ink-mid hover:border-accent"
                        >
                            {name}
                        </button>
                    ))}
                    {Object.keys(projects).length === 0 ? (
                        <span className="text-[11px] text-muted">No projects registered — add one from the Cockpit “+ New project”.</span>
                    ) : null}
                </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto px-[30px] py-4">
                <div className="mx-auto max-w-[820px]">
                    {channels == null ? (
                        <div className="mt-10 text-center text-[13px] text-muted">Loading…</div>
                    ) : !activeId ? (
                        <div className="mt-10 text-center text-[13px] text-muted">
                            No channel yet — click <span className="text-secondary">+ New</span> to create one bound to a project.
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="mt-10 text-center text-[13px] text-muted">
                            Empty channel. Try <span className="font-mono text-secondary">@claude do something</span>.
                        </div>
                    ) : (
                        messages.map((m) => <Row key={m.id} model={model} agents={agents} msg={m} now={now} />)
                    )}
                </div>
            </div>

            <div className="border-t border-border px-[30px] py-3">
                <div className="mx-auto flex max-w-[820px] items-end gap-2">
                    <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                send();
                            }
                        }}
                        rows={1}
                        placeholder="Message, or @claude / @codex to dispatch, @worker to steer…"
                        disabled={!activeId}
                        className="min-h-[38px] flex-1 resize-none rounded-[9px] border border-border bg-surface px-[13px] py-[9px] text-[13px] text-primary placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50"
                    />
                    <button
                        type="button"
                        onClick={send}
                        disabled={!activeId}
                        className="shrink-0 cursor-pointer rounded-[8px] border border-accent bg-accentbg px-[15px] py-[9px] text-[12.5px] font-semibold text-accent-soft hover:brightness-110 disabled:opacity-50"
                    >
                        Send
                    </button>
                </div>
            </div>
        </div>
    );
}
