// frontend/app/view/agents/sourcepicker.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { PopoverReveal } from "@/app/element/popoverreveal";
import { cn } from "@/util/util";
import { useState } from "react";
import type { AgentVM } from "./agentsviewmodel";
import type { FilesSource } from "./diffsource";
import type { FilesProject } from "./filesstore";
import { StatusDot } from "./statusdot";

// In-tab source selector: picks whose worktree the Files surface shows. Agents (with a state dot)
// write the shared focusIdAtom so a diff can be inspected without bouncing back to the Agent tab;
// registered projects (folder glyph) resolve straight from their registry path — no agent needed.
export function SourcePicker({
    agents,
    projects,
    source,
    currentLabel,
    onPickAgent,
    onPickProject,
}: {
    agents: AgentVM[];
    projects: FilesProject[];
    source: FilesSource | null;
    // The stored scope's own label. A run is neither an agent nor a registered project, so without
    // this the picker would read "Select a source" while a run's diff is on screen.
    currentLabel?: string;
    onPickAgent: (id: string) => void;
    onPickProject: (p: FilesProject) => void;
}) {
    const [open, setOpen] = useState(false);
    const currentAgent = source?.kind === "agent" ? agents.find((a) => a.id === source.id) : undefined;
    const currentProject = source?.kind === "project" ? projects.find((p) => p.name === source.name) : undefined;
    const hasAny = agents.length > 0 || projects.length > 0;
    const fallback = hasAny ? "Select a source" : "No agents or projects";
    const label = currentAgent?.name ?? currentProject?.name ?? currentLabel ?? fallback;
    return (
        <div className="relative">
            <button
                data-files-source-picker
                onClick={() => setOpen((v) => !v)}
                disabled={!hasAny}
                className="flex w-full items-center gap-[8px] rounded-[9px] border border-border px-[10px] py-[7px] hover:border-edge-strong disabled:cursor-default disabled:opacity-60"
            >
                {currentAgent ? (
                    <StatusDot state={currentAgent.state} className="!h-[7px] !w-[7px]" />
                ) : currentProject ? (
                    <span className="flex-none text-[11px] text-ink-faint">▪</span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-ink-mid">{label}</span>
                {hasAny ? <span className="flex-none text-[10px] text-ink-faint">▾</span> : null}
            </button>
            {open && hasAny ? <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} /> : null}
            <PopoverReveal
                open={open && hasAny}
                origin="top"
                className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[280px] overflow-y-auto rounded border border-border bg-modalbg py-1 shadow-popover"
            >
                {agents.length > 0 ? (
                    <div className="px-[10px] pb-[3px] pt-[5px] font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-faint">
                        Agents
                    </div>
                ) : null}
                {agents.map((a) => (
                    <button
                        key={a.id}
                        onClick={() => {
                            onPickAgent(a.id);
                            setOpen(false);
                        }}
                        className={cn(
                            "flex w-full items-center gap-[8px] px-[10px] py-[7px] text-left hover:bg-surface-hover",
                            source?.kind === "agent" && a.id === source.id ? "text-foreground" : "text-ink-mid"
                        )}
                    >
                        <StatusDot state={a.state} className="!h-[7px] !w-[7px]" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{a.name}</span>
                    </button>
                ))}
                {projects.length > 0 ? (
                    <div className="px-[10px] pb-[3px] pt-[7px] font-mono text-[9.5px] uppercase tracking-[0.08em] text-ink-faint">
                        Projects
                    </div>
                ) : null}
                {projects.map((p) => (
                    <button
                        key={p.name}
                        // agent names and project names can collide, and this dropdown renders
                        // both — a scenario needs to click a project by name, not by text match
                        data-files-source-option={p.name}
                        title={p.path}
                        onClick={() => {
                            onPickProject(p);
                            setOpen(false);
                        }}
                        className={cn(
                            "flex w-full items-center gap-[8px] px-[10px] py-[7px] text-left hover:bg-surface-hover",
                            source?.kind === "project" && p.name === source.name ? "text-foreground" : "text-ink-mid"
                        )}
                    >
                        <span className="flex-none text-[11px] text-ink-faint">▪</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{p.name}</span>
                    </button>
                ))}
            </PopoverReveal>
        </div>
    );
}
