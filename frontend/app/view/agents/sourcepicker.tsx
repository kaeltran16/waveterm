// frontend/app/view/agents/sourcepicker.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { PopoverReveal } from "@/app/element/popoverreveal";
import { REGION_LABEL } from "@/app/view/jarvis/briefstyle";
import { cn } from "@/util/util";
import { Check, ChevronDown, Folder, Search } from "lucide-react";
import { useState } from "react";
import { agentStateLabel, type AgentVM } from "./agentsviewmodel";
import { filterSources, moveHighlight, pickerRows, worktreeParent, type FilesSource } from "./diffsource";
import type { FilesProject } from "./filesstore";
import { AgentStateMark } from "./statusdot";

const groupLabelClass = cn(REGION_LABEL, "px-[12px] pb-[3px] text-muted");

function rowClass(current: boolean, highlighted: boolean): string {
    return cn(
        "flex h-[30px] w-full items-center gap-[9px] px-[12px] text-left hover:bg-surface-hover",
        current ? "bg-surface-selected text-ink-hi" : highlighted ? "bg-surface-hover text-ink-hi" : "text-ink-mid"
    );
}

// the list scrolls once there are a dozen projects, and the source already picked should open in view
// rather than below the fold
const revealCurrent = (el: HTMLElement | null) => el?.scrollIntoView({ block: "nearest" });

function CurrentMark({ current }: { current: boolean }) {
    return (
        <span className="flex w-[14px] flex-none justify-center text-accent">
            {current ? <Check size={12} /> : null}
        </span>
    );
}

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
    const [query, setQuery] = useState("");
    // the row Enter picks: the first match until an arrow key moves it
    const [highlight, setHighlight] = useState(0);
    const close = () => {
        setOpen(false);
        setQuery("");
        setHighlight(0);
    };
    const currentAgent = source?.kind === "agent" ? agents.find((a) => a.id === source.id) : undefined;
    const currentProject = source?.kind === "project" ? projects.find((p) => p.name === source.name) : undefined;
    const hasAny = agents.length > 0 || projects.length > 0;
    const fallback = hasAny ? "Select a source" : "No agents or projects";
    const label = currentAgent?.name ?? currentProject?.name ?? currentLabel ?? fallback;
    const shown = filterSources(query, agents, projects);
    const rows = pickerRows(shown.agents, shown.projects);
    const hlRow = rows[highlight];
    const hlAgentId = hlRow?.kind === "agent" ? hlRow.id : undefined;
    const hlProjectName = hlRow?.kind === "project" ? hlRow.name : undefined;
    const pickAgent = (id: string) => {
        onPickAgent(id);
        close();
    };
    const pickProject = (p: FilesProject) => {
        onPickProject(p);
        close();
    };
    const onFilterKey = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            close();
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight(moveHighlight(rows.length, highlight, e.key === "ArrowDown" ? 1 : -1));
        } else if (e.key === "Enter") {
            e.preventDefault();
            // no rows (a filter that matches nothing) picks nothing and leaves the popover open on "No match"
            if (hlAgentId != null) {
                pickAgent(hlAgentId);
            } else if (hlProjectName != null) {
                pickProject(shown.projects.find((p) => p.name === hlProjectName));
            }
        }
    };
    return (
        <div className="relative">
            <button
                data-files-source-picker
                onClick={() => (open ? close() : setOpen(true))}
                disabled={!hasAny}
                aria-expanded={open}
                className={cn(
                    "flex w-full items-center gap-[8px] rounded-[9px] border px-[10px] py-[7px] hover:border-edge-strong disabled:cursor-default disabled:opacity-60",
                    open ? "border-accent" : "border-border"
                )}
            >
                {currentAgent ? (
                    <AgentStateMark agent={currentAgent} className="!h-[7px] !w-[7px]" />
                ) : currentProject ? (
                    <Folder size={13} className="flex-none text-muted" />
                ) : null}
                <span className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-ink-mid">{label}</span>
                {hasAny ? <ChevronDown size={12} className="flex-none text-muted" /> : null}
            </button>
            {open && hasAny ? <div className="fixed inset-0 z-10" onClick={close} /> : null}
            <PopoverReveal
                open={open && hasAny}
                origin="top left"
                className="absolute left-0 top-full z-20 mt-1 w-[340px] rounded-[8px] border border-edge-mid bg-surface-raised py-[6px] shadow-popover"
            >
                <label className="mx-[6px] mb-[4px] flex h-[30px] items-center gap-[8px] rounded-[7px] border border-edge-mid bg-surface px-[9px]">
                    <Search size={13} className="flex-none text-muted" />
                    <input
                        autoFocus
                        value={query}
                        onChange={(e) => {
                            setQuery(e.target.value);
                            setHighlight(0);
                        }}
                        onKeyDown={onFilterKey}
                        placeholder="Filter agents and projects"
                        aria-label="Filter sources"
                        className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink-hi outline-none placeholder:text-ink-faint"
                    />
                </label>
                <div className="max-h-[280px] overflow-y-auto">
                    {shown.agents.length > 0 ? <div className={cn(groupLabelClass, "pt-[6px]")}>Agents</div> : null}
                    {shown.agents.map((a) => {
                        const current = source?.kind === "agent" && a.id === source.id;
                        const highlighted = a.id === hlAgentId;
                        return (
                            <button
                                key={a.id}
                                ref={current || (highlighted && highlight > 0) ? revealCurrent : undefined}
                                data-files-source-agent={a.id}
                                data-highlighted={highlighted || undefined}
                                onClick={() => pickAgent(a.id)}
                                className={rowClass(current, highlighted)}
                            >
                                <AgentStateMark agent={a} className="!h-[7px] !w-[7px]" />
                                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{a.name}</span>
                                <span className="flex-none text-[10.5px] text-muted">{agentStateLabel(a)}</span>
                                <CurrentMark current={current} />
                            </button>
                        );
                    })}
                    {shown.projects.length > 0 ? <div className={cn(groupLabelClass, "pt-[8px]")}>Projects</div> : null}
                    {shown.projects.map((p) => {
                        const current = source?.kind === "project" && p.name === source.name;
                        const parent = worktreeParent(p, projects);
                        const highlighted = p.name === hlProjectName;
                        return (
                            <button
                                key={p.name}
                                ref={current || (highlighted && highlight > 0) ? revealCurrent : undefined}
                                // agent names and project names can collide, and this dropdown renders
                                // both — a scenario needs to click a project by name, not by text match
                                data-files-source-option={p.name}
                                data-highlighted={highlighted || undefined}
                                title={p.path}
                                onClick={() => pickProject(p)}
                                className={rowClass(current, highlighted)}
                            >
                                <Folder size={12} className="flex-none text-muted" />
                                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{p.name}</span>
                                {parent != null ? (
                                    <span className="flex-none text-[10.5px] text-muted">worktree · {parent}</span>
                                ) : null}
                                <CurrentMark current={current} />
                            </button>
                        );
                    })}
                    {shown.agents.length === 0 && shown.projects.length === 0 ? (
                        <div className="px-[12px] py-[7px] text-[11.5px] text-muted">No match</div>
                    ) : null}
                </div>
            </PopoverReveal>
        </div>
    );
}
