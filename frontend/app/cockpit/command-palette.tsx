// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Command palette overlay (Ctrl+P). Fuzzy-searches live agents, resumable sessions,
// and cockpit commands, and dispatches the selected item's action. Hand-rolled to match
// the NewAgentModal overlay pattern (jotai visibility atom + fixed overlay from cockpit-root).

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import type { Runtime } from "@/app/view/agents/launch";
import { ITEMS as SURFACE_ITEMS } from "@/app/view/agents/navrail";
import { loadSessionsArchive, sessionsArchiveAtom } from "@/app/view/agents/sessionsarchivestore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { rankPaletteItems } from "./palette-match";

type PaletteKind = "command" | "agent" | "session";

interface PaletteItem {
    key: string;
    kind: PaletteKind;
    search: string; // matched text (title + keywords)
    title: string;
    subtitle?: string;
    hint?: string; // right-aligned (session age)
    run: () => void;
}

const GROUP_ORDER: PaletteKind[] = ["command", "agent", "session"];
const GROUP_LABELS: Record<PaletteKind, string> = {
    command: "Commands",
    agent: "Agents",
    session: "Sessions",
};

export function CommandPalette({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(model.paletteOpenAtom);
    const agents = useAtomValue(model.agentsAtom);
    const sessions = useAtomValue(sessionsArchiveAtom);
    const [query, setQuery] = useState("");
    const [sel, setSel] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const loadedRef = useRef(false);

    const close = () => globalStore.set(model.paletteOpenAtom, false);

    // Lazy-load the sessions archive on first open (as SessionsSurface does).
    useEffect(() => {
        if (open && !loadedRef.current) {
            loadedRef.current = true;
            fireAndForget(loadSessionsArchive);
        }
    }, [open]);

    // Each open: reset query + selection and focus the input after paint.
    useEffect(() => {
        if (!open) {
            return;
        }
        setQuery("");
        setSel(0);
        const raf = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(raf);
    }, [open]);

    const items = useMemo<PaletteItem[]>(() => {
        const now = Date.now();
        const commands: PaletteItem[] = [
            ...SURFACE_ITEMS.map((it) => ({
                key: `cmd:surface:${it.key}`,
                kind: "command" as const,
                search: `Go to ${it.label}`,
                title: `Go to ${it.label}`,
                run: () => {
                    globalStore.set(model.surfaceAtom, it.key);
                    close();
                },
            })),
            {
                key: "cmd:new-agent",
                kind: "command",
                search: "New agent",
                title: "New agent",
                run: () => {
                    globalStore.set(model.newAgentOpenAtom, true);
                    close();
                },
            },
            {
                key: "cmd:new-project",
                kind: "command",
                search: "New project",
                title: "New project",
                run: () => {
                    globalStore.set(model.newProjectOpenAtom, true);
                    close();
                },
            },
        ];
        const agentItems: PaletteItem[] = agents.map((a) => ({
            key: `agent:${a.id}`,
            kind: "agent" as const,
            search: `${a.name} ${a.task ?? ""} ${a.project ?? ""}`,
            title: a.task ? `${a.name} — ${a.task}` : a.name,
            subtitle: [a.project, a.state].filter(Boolean).join(" · ") || undefined,
            run: () => {
                model.openTerminal(a.id);
                close();
            },
        }));
        const sessionItems: PaletteItem[] = (sessions ?? [])
            .filter((s) => s.resumecommand)
            .map((s) => ({
                key: `session:${s.runtime}:${s.id}`,
                kind: "session" as const,
                search: `${s.task} ${s.projectname} ${s.branch}`,
                title: s.task || "(untitled session)",
                subtitle: [s.projectname, s.branch || "—", s.model || "—"].join(" · "),
                hint: formatAge(now - s.lastactivets),
                run: () => {
                    fireAndForget(() =>
                        launchAgent(model, {
                            runtime: s.runtime as Runtime,
                            startupCommand: s.resumecommand!,
                            task: "",
                            projectPath: s.projectpath,
                            projectName: s.projectname || "agent",
                        })
                    );
                    close();
                },
            }));
        return [...commands, ...agentItems, ...sessionItems];
    }, [agents, sessions, model]);

    // rankPaletteItems sorts globally by score; re-grouping by kind preserves per-kind
    // score order (stable sort). Empty query -> natural order in GROUP_ORDER.
    const ranked = useMemo(() => rankPaletteItems(items, query), [items, query]);
    const groups = GROUP_ORDER.map((kind) => ({ kind, items: ranked.filter((it) => it.kind === kind) })).filter(
        (g) => g.items.length > 0
    );
    const flat = groups.flatMap((g) => g.items);
    const selClamped = flat.length === 0 ? 0 : Math.min(sel, flat.length - 1);
    const flatIndex = new Map(flat.map((it, i) => [it.key, i]));

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSel((s) => (flat.length ? (s + 1) % flat.length : 0));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setSel((s) => (flat.length ? (s - 1 + flat.length) % flat.length : 0));
        } else if (e.key === "Enter") {
            e.preventDefault();
            flat[selClamped]?.run();
        } else if (e.key === "Escape") {
            e.preventDefault();
            close();
        }
    };

    if (!open) {
        return null;
    }
    return (
        <div
            className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 pt-[11vh] backdrop-blur-sm"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                    close();
                }
            }}
        >
            <div className="flex max-h-[70vh] w-[min(640px,93vw)] flex-col overflow-hidden rounded-[14px] border border-edge-strong bg-modalbg shadow-popover">
                <div className="flex shrink-0 items-center gap-[11px] border-b border-border px-4 py-[13px]">
                    <svg
                        width="15"
                        height="15"
                        viewBox="0 0 13 13"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        className="shrink-0 text-muted"
                    >
                        <circle cx="5.5" cy="5.5" r="4" />
                        <path d="M9 9l3 3" strokeLinecap="round" />
                    </svg>
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setSel(0);
                        }}
                        onKeyDown={onKeyDown}
                        placeholder="Search agents, sessions, commands…"
                        className="flex-1 bg-transparent text-[14px] text-primary outline-none placeholder:text-muted"
                    />
                    <span className="shrink-0 rounded-[5px] border border-edge-mid px-[7px] py-0.5 font-mono text-[10.5px] text-muted">
                        esc
                    </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto py-2">
                    {flat.length === 0 ? (
                        <div className="px-4 py-8 text-center text-[13px] text-muted">No results.</div>
                    ) : (
                        groups.map((g) => (
                            <div key={g.kind}>
                                <div className="px-4 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                                    {GROUP_LABELS[g.kind]}
                                </div>
                                {g.items.map((it) => {
                                    const myIdx = flatIndex.get(it.key)!;
                                    const active = myIdx === selClamped;
                                    return (
                                        <button
                                            key={it.key}
                                            type="button"
                                            onMouseMove={() => setSel(myIdx)}
                                            onClick={() => it.run()}
                                            className={cn(
                                                "flex w-full cursor-pointer items-center gap-3 px-4 py-[7px] text-left",
                                                active ? "bg-accentbg" : "hover:bg-surface-hover"
                                            )}
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span
                                                    className={cn(
                                                        "block truncate text-[13px]",
                                                        active ? "text-primary" : "text-secondary"
                                                    )}
                                                >
                                                    {it.title}
                                                </span>
                                                {it.subtitle ? (
                                                    <span className="block truncate font-mono text-[10.5px] text-muted">
                                                        {it.subtitle}
                                                    </span>
                                                ) : null}
                                            </span>
                                            {it.hint ? (
                                                <span className="shrink-0 font-mono text-[10.5px] text-muted">
                                                    {it.hint}
                                                </span>
                                            ) : null}
                                            {active ? (
                                                <span className="shrink-0 font-mono text-[11px] text-accent-soft">⏎</span>
                                            ) : null}
                                        </button>
                                    );
                                })}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
