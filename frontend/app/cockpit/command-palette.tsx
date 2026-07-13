// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Command palette overlay (Ctrl+P). Fuzzy-searches live agents, resumable sessions,
// and cockpit commands, and dispatches the selected item's action. Hand-rolled to match
// the NewAgentModal overlay pattern (jotai visibility atom + fixed overlay from cockpit-root).

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { formatAge } from "@/app/view/agents/agentsviewmodel";
import { sendChannelMessage } from "@/app/view/agents/channelactions";
import { activeChannelAtom } from "@/app/view/agents/channelsstore";
import type { Runtime } from "@/app/view/agents/launch";
import { ITEMS as SURFACE_ITEMS } from "@/app/view/agents/navrail";
import { createRun, getJarvisProfile } from "@/app/view/agents/runactions";
import { loadSessionsArchive, sessionsArchiveAtom } from "@/app/view/agents/sessionsarchivestore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildLaunchItems, type LaunchDeps } from "./palette-launch";
import { rankPaletteItems } from "./palette-match";
import { cheatsheetOpenAtom } from "./shortcuts-cheatsheet";

type PaletteKind = "launch" | "command" | "agent" | "session";

interface PaletteItem {
    key: string;
    kind: PaletteKind;
    search: string; // matched text (title + keywords) — "" for launch rows (never ranked)
    title: string;
    subtitle?: string;
    hint?: string; // right-aligned (session age)
    run: () => void;
    // launch group only (rich fast-dispatch row):
    glyph?: string; // monospace badge glyph
    mode?: string; // "Quick · claude", "Run", …
    suffix?: string; // Run strategy suffix, e.g. " · pipeline"
    desc?: string; // mono subtitle
    footer?: string; // one-line echo shown in the palette footer when selected
}

const GROUP_ORDER: PaletteKind[] = ["command", "agent", "session"];
// The launch group renders its own dynamic label ("Launch in #<channel>"), so it is excluded here.
const GROUP_LABELS: Record<Exclude<PaletteKind, "launch">, string> = {
    command: "Commands",
    agent: "Agents",
    session: "Sessions",
};

export function CommandPalette({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(model.paletteOpenAtom);
    const agents = useAtomValue(model.agentsAtom);
    const sessions = useAtomValue(sessionsArchiveAtom);
    const channel = useAtomValue(activeChannelAtom);
    const [query, setQuery] = useState("");
    const [sel, setSel] = useState(0);
    const [runProfile, setRunProfile] = useState<{ mode?: string; planGate?: boolean } | null>(null);
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

    // Pre-fetch the active channel's Jarvis strategy so the Run row can label itself
    // (Run · pipeline / Run · orchestrator). Before it loads the row reads plain "Run" and
    // resolves the strategy at click time (see launch deps below).
    useEffect(() => {
        if (!open || !channel) {
            setRunProfile(null);
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const p = await getJarvisProfile(channel.oid);
            if (!cancelled) {
                setRunProfile({ mode: p.resolved?.defaultmode, planGate: p.resolved?.defaultplangate });
            }
        });
        return () => {
            cancelled = true;
        };
    }, [open, channel?.oid]);

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
            {
                key: "cmd:shortcuts",
                kind: "command",
                search: "Keyboard shortcuts help cheat sheet",
                title: "Keyboard shortcuts",
                run: () => {
                    globalStore.set(cheatsheetOpenAtom, true);
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

    // Fast-dispatch rows: the typed query is the *goal*, not a filter. Built only when a goal is
    // typed AND a channel is active (buildLaunchItems returns [] otherwise). The user never types
    // "@"/"ask @" — we synthesize that transport string for sendChannelMessage internally.
    const launchItems = useMemo<PaletteItem[]>(() => {
        if (!channel) {
            return [];
        }
        const fireLaunch = (action: () => Promise<unknown>) => {
            fireAndForget(action);
            globalStore.set(model.surfaceAtom, "channels"); // surface the result, then close
            close();
        };
        const sendText = (text: string) =>
            sendChannelMessage({
                model,
                channelId: channel.oid,
                projectPath: channel.projectpath ?? "",
                projectName: channel.name ?? "agent",
                roster: agents.map((a) => ({ id: a.id, name: a.name, blockId: a.blockId })),
                agents,
                text,
            });
        const deps: LaunchDeps = {
            dispatch: (runtime, goal) => fireLaunch(() => sendText(`@${runtime} ${goal}`)),
            run: (goal) =>
                fireLaunch(() =>
                    createRun(channel.oid, goal, {
                        mode: runProfile?.mode ?? "pipeline",
                        planGate: runProfile?.planGate ?? true,
                    })
                ),
            consult: (runtime, goal) => fireLaunch(() => sendText(`ask @${runtime} ${goal}`)),
        };
        return buildLaunchItems(query, channel.name, runProfile?.mode, deps).map((li) => ({
            key: li.key,
            kind: "launch" as const,
            search: "",
            title: li.mode,
            run: li.run,
            glyph: li.glyph,
            mode: li.mode,
            suffix: li.suffix,
            desc: li.desc,
            footer: li.footer,
        }));
    }, [query, channel, runProfile, agents, model]);

    // rankPaletteItems sorts globally by score; re-grouping by kind preserves per-kind
    // score order (stable sort). Empty query -> natural order in GROUP_ORDER.
    const ranked = useMemo(() => rankPaletteItems(items, query), [items, query]);
    const rankedGroups = GROUP_ORDER.map((kind) => ({ kind, items: ranked.filter((it) => it.kind === kind) })).filter(
        (g) => g.items.length > 0
    );
    // Launch group leads and is never fuzzy-ranked.
    const groups: { kind: PaletteKind; items: PaletteItem[] }[] =
        launchItems.length > 0 ? [{ kind: "launch", items: launchItems }, ...rankedGroups] : rankedGroups;
    const flat = groups.flatMap((g) => g.items);
    const selClamped = flat.length === 0 ? 0 : Math.min(sel, flat.length - 1);
    const flatIndex = new Map(flat.map((it, i) => [it.key, i]));
    const selected = flat[selClamped];
    const selFooter = selected?.kind === "launch" ? selected.footer : undefined;

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
        }
    };

    return (
        <ModalShell open={open} onClose={close} className="flex flex-col w-[min(640px,93vw)] max-h-[70vh]">
            {open ? (
                <>
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
                        groups.map((g) =>
                            g.kind === "launch" ? (
                                <div
                                    key="launch"
                                    className="relative mx-0.5 mb-2 mt-1 rounded-[10px] bg-accent/5 px-1 pb-1"
                                >
                                    {/* accent rail marks the one group that acts on your typed goal */}
                                    <div className="absolute bottom-2 left-0 top-2 w-0.5 rounded-full bg-accent/80" />
                                    <div className="px-3 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-accent-soft">
                                        Launch in <span className="text-accent-100">#{channel?.name}</span>
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
                                                    "flex w-full cursor-pointer items-center gap-[11px] rounded-[9px] px-3 py-[7px] text-left transition-colors duration-[140ms]",
                                                    active ? "bg-accentbg" : "hover:bg-surface-hover"
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border font-mono text-[13px]",
                                                        active
                                                            ? "border-accent-700 bg-accentbg text-accent-soft"
                                                            : "border-edge-mid text-muted"
                                                    )}
                                                >
                                                    {it.glyph}
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block text-[13px] leading-tight">
                                                        <span
                                                            className={cn(
                                                                "font-medium",
                                                                active ? "text-primary" : "text-secondary"
                                                            )}
                                                        >
                                                            {it.mode}
                                                        </span>
                                                        {it.suffix ? (
                                                            <span className={active ? "text-accent-soft" : "text-muted"}>
                                                                {it.suffix}
                                                            </span>
                                                        ) : null}
                                                    </span>
                                                    <span className="mt-0.5 block truncate font-mono text-[10.5px] text-muted">
                                                        {it.desc}
                                                    </span>
                                                </span>
                                                {active ? (
                                                    <span className="shrink-0 font-mono text-[11px] text-accent-soft">
                                                        ⏎
                                                    </span>
                                                ) : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : (
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
                                                    "flex w-full cursor-pointer items-center gap-3 px-4 py-[7px] text-left transition-colors duration-[140ms]",
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
                                                    <span className="shrink-0 font-mono text-[11px] text-accent-soft">
                                                        ⏎
                                                    </span>
                                                ) : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            )
                        )
                    )}
                </div>
                {flat.length > 0 ? (
                    <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-[9px]">
                        {selFooter ? (
                            <>
                                <span className="shrink-0 font-mono text-[11px] text-accent-soft">⏎</span>
                                <span className="min-w-0 flex-1 truncate text-[12px] text-secondary">{selFooter}</span>
                            </>
                        ) : (
                            <>
                                <span className="font-mono text-[10.5px] text-muted">↑↓ navigate</span>
                                <span className="font-mono text-[10.5px] text-muted">↵ open</span>
                            </>
                        )}
                    </div>
                ) : null}
                </>
            ) : null}
        </ModalShell>
    );
}
