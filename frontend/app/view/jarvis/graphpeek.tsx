// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The graph peek: an overlay over the Stage, never a destination. You enter it from an object and leave it
// by opening one — every action here closes the overlay onto something. It layers over the thread as a
// sibling, never wrapping it, so peeking cannot remount live worker output.

import type { AgentsViewModel } from "@/app/view/agents/agents";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { SourceType } from "./jarviscontract";
import { JarvisGraph } from "./jarvisgraph";
import { attributionStyle, mergeGraph } from "./jarvisgraphderive";
import {
    focusDossier,
    graphBaseAtom,
    graphBloomAtom,
    graphErrorAtom,
    graphLoadedAtom,
    graphSelectedIdAtom,
    loadGraph,
} from "./jarvisgraphstore";
import { startConversation } from "./jarvisstore";
import { activeSubjectAtom, type ActiveSubject } from "./jarvissubjectstore";
import { openORef } from "./openref";

const KIND_TONE: Record<string, string> = {
    task: "text-graph-task",
    run: "text-graph-run",
    decision: "text-graph-decision",
    memory: "text-muted",
};

const LEGEND = ["task", "run", "decision", "memory"] as const;

const KIND_DOT: Record<string, string> = {
    task: "bg-graph-task",
    run: "bg-graph-run",
    decision: "bg-graph-decision",
    memory: "bg-ink-mid",
};

// a run node's id is already its oref (ResolveDossierEdges emits RunORef); vault nodes carry a bare id.
function nodeORef(node: GraphNode): string {
    return node.kind === "run" ? node.id : `${node.kind}:${node.id}`;
}

function ActionButton({
    label,
    primary,
    onClick,
}: {
    label: string;
    primary?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "w-full cursor-pointer rounded-[8px] px-2 py-2 text-[11.5px] font-bold",
                primary
                    ? "bg-accent text-background hover:bg-accenthover"
                    : "border border-border bg-surface font-semibold text-secondary hover:text-primary"
            )}
        >
            {label}
        </button>
    );
}

export function GraphPeek({
    model,
    onClose,
    onOpenSubject,
}: {
    model: AgentsViewModel;
    onClose: () => void;
    onOpenSubject: (subject: ActiveSubject) => void;
}) {
    const base = useAtomValue(graphBaseAtom);
    const blooms = useAtomValue(graphBloomAtom);
    const loaded = useAtomValue(graphLoadedAtom);
    const error = useAtomValue(graphErrorAtom);
    const selectedId = useAtomValue(graphSelectedIdAtom);
    const subject = useAtomValue(activeSubjectAtom);

    useEffect(() => {
        if (!loaded) {
            fireAndForget(loadGraph);
        }
    }, [loaded]);

    // the peek opens *from* an object: a record subject blooms and selects itself, so the overlay arrives
    // already centred on what the user was looking at rather than on the whole vault.
    useEffect(() => {
        if (subject?.kind === "dossier") {
            fireAndForget(() => focusDossier(subject.id));
        }
    }, [subject?.kind, subject?.id]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                onClose();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const merged = mergeGraph(base ?? { nodes: [], links: [] }, blooms);
    const node = selectedId != null ? merged.nodes.find((n) => n.id === selectedId) : undefined;
    const edges = selectedId != null ? merged.links.filter((l) => l.from === selectedId || l.to === selectedId) : [];

    const openRun = (runORef: string) => {
        fireAndForget(() => openORef(model, runORef));
        onClose();
    };

    const askAbout = (n: GraphNode) => {
        const id = startConversation({
            mode: "object",
            chips: [{ label: n.label, active: true }],
            attached: [{ oref: nodeORef(n), sourceType: n.kind as SourceType, title: n.label }],
        });
        onOpenSubject({ kind: "conversation", id });
        onClose();
    };

    return (
        <div className="absolute inset-0 z-20 flex flex-col bg-background/95 backdrop-blur-[3px]">
            <div className="flex h-11 flex-none items-center gap-2.5 border-b border-border bg-surface px-4">
                <span className="font-mono text-[13px] font-semibold text-accent-soft">◇</span>
                <span className="text-[13px] font-bold text-primary">Graph peek</span>
                <span className="font-mono text-[11px] text-muted">
                    {merged.nodes.length} nodes{node != null ? ` · ${node.kind} · ${node.label}` : ""}
                </span>
                <div className="flex-1" />
                <div className="flex items-center gap-3">
                    {LEGEND.map((k) => (
                        <span key={k} className="flex items-center gap-1.5">
                            <span className={cn("h-2 w-2 rounded-full", KIND_DOT[k])} />
                            <span className="font-mono text-[10px] text-muted">{k}</span>
                        </span>
                    ))}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="cursor-pointer rounded-[7px] border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold text-secondary hover:text-primary"
                >
                    Close · Esc
                </button>
            </div>
            <div className="flex min-h-0 flex-1">
                <div className="relative min-w-0 flex-1">
                    {!loaded ? (
                        <div className="flex h-full items-center justify-center text-[13px] text-muted">
                            Loading graph…
                        </div>
                    ) : error ? (
                        <div className="flex h-full items-center justify-center text-[13px] text-muted">
                            Couldn’t read the vault.
                        </div>
                    ) : merged.nodes.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center gap-1.5 text-muted">
                            <span className="text-[14px] font-semibold text-primary">No vault yet</span>
                            <span className="text-[12px]">
                                Records, decisions and memory appear here as they’re captured.
                            </span>
                        </div>
                    ) : (
                        <JarvisGraph />
                    )}
                </div>
                <div className="flex w-[288px] flex-none flex-col gap-3 border-l border-border bg-surface p-3.5">
                    {node == null ? (
                        <span className="text-[12px] leading-[1.5] text-muted">
                            Click a node to open it. The peek closes into whatever you open.
                        </span>
                    ) : (
                        <>
                            <div className="flex flex-col gap-1.5">
                                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                    Selected node
                                </span>
                                <span className={cn("font-mono text-[11px]", KIND_TONE[node.kind] ?? "text-muted")}>
                                    {node.kind}
                                </span>
                                <span className="text-[13.5px] font-semibold leading-[1.35] text-primary">
                                    {node.label}
                                </span>
                                {node.status ? (
                                    <span className="font-mono text-[10.5px] text-muted">{node.status}</span>
                                ) : null}
                            </div>
                            <div className="h-px bg-border" />
                            <div className="flex flex-col gap-2">
                                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                    Edges
                                </span>
                                {edges.length === 0 ? (
                                    <span className="text-[11.5px] text-muted">No edge reaches this node.</span>
                                ) : (
                                    edges.map((l) => {
                                        const other = l.from === node.id ? l.to : l.from;
                                        const s = l.kind === "attribution" ? attributionStyle(l) : null;
                                        return (
                                            <div key={l.kind + other} className="flex items-center gap-2">
                                                <span
                                                    className="w-[22px] flex-none text-secondary"
                                                    style={{
                                                        borderTopStyle: s?.dashed ? "dashed" : "solid",
                                                        borderTopWidth: s?.width ?? 1,
                                                        borderTopColor: "currentColor",
                                                        opacity: s?.opacity ?? 1,
                                                    }}
                                                />
                                                <span className="min-w-0 flex-1 truncate text-[11.5px] text-secondary">
                                                    {merged.nodes.find((n) => n.id === other)?.label ?? other}
                                                </span>
                                                <span className="flex-none font-mono text-[10px] text-muted">
                                                    {l.kind === "attribution" ? `${l.state} · ${l.bucket}` : "wikilink"}
                                                </span>
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                            <div className="h-px bg-border" />
                            <div className="flex flex-col gap-1.5">
                                <span className="font-mono text-[9.5px] font-bold uppercase tracking-[.12em] text-muted">
                                    Leave the graph by opening something
                                </span>
                                {node.kind === "run" ? (
                                    <ActionButton label="Open run on the Stage" primary onClick={() => openRun(node.id)} />
                                ) : null}
                                {node.kind === "task" ? (
                                    <ActionButton
                                        label="Open record"
                                        primary
                                        onClick={() => {
                                            onOpenSubject({ kind: "dossier", id: node.id });
                                            onClose();
                                        }}
                                    />
                                ) : null}
                                <ActionButton label="Ask Jarvis about this node" onClick={() => askAbout(node)} />
                            </div>
                        </>
                    )}
                    <p className="mt-auto text-[11px] leading-[1.5] text-muted">
                        The peek is never a destination: it opens from an object and closes into one. There is no
                        graph entry in the nav rail.
                    </p>
                </div>
            </div>
        </div>
    );
}
