// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { PopoverReveal } from "@/app/element/popoverreveal";
import { globalStore } from "@/app/store/jotaiStore";
import { selectSubject } from "@/app/view/jarvis/jarvissubjectstore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { projectOf } from "./agentsviewmodel";
import { activeFocusAtom, enterFocusFor, exitFocus, focusesAtom, loadFocuses, type FocusKind } from "./focusstore";

// One dropdown row, for any of the three focus kinds.
function FocusRow({
    rowKey,
    label,
    hint,
    dotClass,
    selected,
    onClick,
}: {
    rowKey: string;
    label: string;
    hint?: string;
    dotClass: string;
    selected: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            data-focus-row={rowKey}
            onClick={onClick}
            className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-surface-hover",
                selected && "bg-accent/10"
            )}
        >
            <span className={cn("h-2 w-2 shrink-0 rounded-[3px]", dotClass)} />
            <span className="flex-1 truncate text-[13px] font-medium text-secondary">{label}</span>
            {hint ? <span className="font-mono text-[10px] text-muted">{hint}</span> : null}
        </button>
    );
}

function SectionLabel({ children }: { children: string }) {
    return (
        <div className="px-2 pb-1 pt-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                {children}
            </span>
        </div>
    );
}

// App-bar focus (Presence C) switcher: "◇ <label> ▾" (or "Global"). Mirrors ProjectSwitcher's bar
// trigger + PopoverReveal dropdown. Selecting a row focuses that agent, run or task; "Global" returns
// to no-focus; "Open dossier" puts the active focus's record on the Jarvis Stage as a subject.
export function FocusSwitcher({ model }: { model: AgentsViewModel }) {
    const active = useAtomValue(activeFocusAtom);
    const spaces = useAtomValue(focusesAtom);
    const agents = useAtomValue(model.agentsAtom);
    const [open, setOpen] = useState(false);
    const label = active ? active.label : "Global";
    const isOn = (kind: FocusKind, id: string) => active?.ref.kind === kind && active.ref.id === id;

    // Runs come off the live roster (an agent carries the run it works for) rather than a new RPC: the
    // runs worth focusing are the ones with a worker on screen, which is exactly this set.
    const runs = useMemo(() => {
        const byId = new Map<string, { id: string; label: string; project: string }>();
        for (const a of agents) {
            if (!a.runId || byId.has(a.runId)) {
                continue;
            }
            byId.set(a.runId, { id: a.runId, label: a.task || a.name, project: projectOf(a) });
        }
        return [...byId.values()];
    }, [agents]);
    const toggle = () =>
        setOpen((v) => {
            if (!v) loadFocuses();
            return !v;
        });
    const close = () => setOpen(false);
    return (
        <div className="relative">
            <button
                type="button"
                data-focus-switcher
                onClick={toggle}
                className="flex cursor-pointer items-center gap-1.5 rounded-sm px-[7px] py-1 text-[13px] font-medium text-secondary hover:bg-surface-hover hover:text-primary"
            >
                {active ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
                <span className="max-w-[180px] truncate">{label}</span>
                <span className="text-[9px] text-muted">▾</span>
            </button>
            {open ? <div className="fixed inset-0 z-50" onClick={close} /> : null}
            <PopoverReveal
                open={open}
                origin="top left"
                className="absolute left-0 top-[calc(100%+7px)] z-[60] w-[268px] overflow-hidden rounded-lg border border-edge-strong bg-surface-raised shadow-popover"
            >
                <div className="px-3 pb-1.5 pt-[9px]">
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                        Focus on
                    </span>
                </div>
                <div className="max-h-[46vh] overflow-y-auto px-1.5 pb-1.5">
                    <button
                        type="button"
                        onClick={() => {
                            exitFocus();
                            close();
                        }}
                        className={cn(
                            "flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-surface-hover",
                            active == null && "bg-accent/10"
                        )}
                    >
                        <span className="h-2 w-2 shrink-0 rounded-[3px] bg-muted" />
                        <span className="flex-1 truncate text-[13px] font-medium text-secondary">
                            Global (no focus)
                        </span>
                    </button>
                    {active != null && active.ref.kind === "task" ? (
                        <button
                            type="button"
                            onClick={() => {
                                selectSubject({ kind: "dossier", id: active.ref.id });
                                globalStore.set(model.surfaceAtom, "jarvis");
                                close();
                            }}
                            className="flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-left text-accent hover:bg-surface-hover"
                        >
                            <span className="flex-1 truncate text-[13px] font-medium">Open dossier ↗</span>
                        </button>
                    ) : null}
                    {agents.length > 0 ? <SectionLabel>Agents</SectionLabel> : null}
                    {agents.map((a) => (
                        <FocusRow
                            key={a.id}
                            rowKey={`agent:${a.id}`}
                            label={a.name}
                            hint={a.task || undefined}
                            dotClass={a.state === "asking" ? "bg-asking" : "bg-success"}
                            selected={isOn("agent", a.id)}
                            onClick={() => {
                                enterFocusFor(model, {
                                    ref: { kind: "agent", id: a.id },
                                    label: a.name,
                                    project: projectOf(a),
                                });
                                close();
                            }}
                        />
                    ))}
                    {runs.length > 0 ? <SectionLabel>Runs</SectionLabel> : null}
                    {runs.map((r) => (
                        <FocusRow
                            key={r.id}
                            rowKey={`run:${r.id}`}
                            label={r.label}
                            hint={r.project || undefined}
                            dotClass="bg-accent"
                            selected={isOn("run", r.id)}
                            onClick={() => {
                                enterFocusFor(model, {
                                    ref: { kind: "run", id: r.id },
                                    label: r.label,
                                    project: r.project,
                                });
                                close();
                            }}
                        />
                    ))}
                    {spaces.length > 0 ? <SectionLabel>Tasks</SectionLabel> : null}
                    {spaces.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            data-focus-row={`task:${s.id}`}
                            onClick={() => {
                                // a task summary carries no project, so the project filter is left alone
                                enterFocusFor(model, {
                                    ref: { kind: "task", id: s.id },
                                    label: s.objective,
                                    project: "",
                                });
                                close();
                            }}
                            className={cn(
                                "flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-surface-hover",
                                isOn("task", s.id) && "bg-accent/10"
                            )}
                        >
                            <span
                                className={cn(
                                    "h-2 w-2 shrink-0 rounded-[3px]",
                                    s.status === "paused" ? "bg-muted" : "bg-success"
                                )}
                            />
                            <span className="flex-1 truncate text-[13px] font-medium text-secondary">
                                {s.objective}
                            </span>
                            {s.ticket ? <span className="font-mono text-[10px] text-muted">{s.ticket}</span> : null}
                        </button>
                    ))}
                    {spaces.length === 0 && agents.length === 0 && runs.length === 0 ? (
                        <div className="px-2 py-3 text-[12px] text-muted">Nothing to focus on yet.</div>
                    ) : null}
                </div>
            </PopoverReveal>
        </div>
    );
}
