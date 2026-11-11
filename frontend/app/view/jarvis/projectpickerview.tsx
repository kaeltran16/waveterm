// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The New run window's project field (ProjectPicker.dc.html variant 1), and the list it opens, which Check
// Jira's project cell shares. The list's keys are local rather than keybindings.ts bindings: they only mean
// anything while the search box has focus.

import { PopoverReveal } from "@/app/element/popoverreveal";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { stepPick } from "./newrun";
import { homeFromInfo, pickerSections, projectWhere, recentNames } from "./projectpicker";

const GROUP_LABEL = "px-3 pb-0.5 pt-2 font-mono text-[10.5px] uppercase tracking-[.08em] text-muted";

// the home folder, read on mount rather than on first open: a closed field already shows the picked project's where
export function useHomeDir(): string {
    const [home, setHome] = useState("");
    useEffect(() => {
        let live = true;
        fireAndForget(async () => {
            let next = "";
            try {
                next = homeFromInfo(await RpcApi.FileInfoCommand(TabRpcClient, { info: { path: "~" } }));
            } catch (e) {
                console.error("project picker: could not read the home folder, showing full paths", e);
            }
            if (live) {
                setHome(next);
            }
        });
        return () => {
            live = false;
        };
    }, []);
    return home;
}

export function ProjectPicker({
    projects,
    recent,
    picked,
    onPick,
    onRegister,
}: {
    projects: { name: string; path: string }[];
    recent: string[];
    picked: string | null;
    onPick: (name: string) => void;
    onRegister: () => void;
}) {
    const [open, setOpen] = useState(false);
    const home = useHomeDir();
    const rootRef = useRef<HTMLDivElement>(null);
    const fieldRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const close = (e: Event) => {
            if (!rootRef.current?.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
    }, [open]);

    const pathOf = new Map(projects.map((p) => [p.name, p.path]));
    const whereOf = (name: string) => projectWhere(pathOf.get(name) ?? "", home);
    const names = projects.map((p) => p.name);

    const closeList = () => {
        setOpen(false);
        fieldRef.current?.focus();
    };

    return (
        <div ref={rootRef} className="flex flex-col gap-0.5">
            <button
                ref={fieldRef}
                type="button"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen(!open)}
                className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-[7px] border bg-surface px-2.5 py-[7px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    open ? "border-accent-700" : "border-edge-mid"
                )}
            >
                {picked != null ? (
                    <>
                        <span className="flex-none truncate text-[13px] font-semibold text-primary">{picked}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted">
                            {whereOf(picked)}
                        </span>
                    </>
                ) : (
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted">Pick a project</span>
                )}
                <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                    className="flex-none text-muted"
                >
                    <path d="m6 9 6 6 6-6" />
                </svg>
            </button>
            <PopoverReveal open={open} origin="top">
                <ProjectList
                    projects={projects}
                    top={recentNames(names, recent)}
                    topLabel="Recent"
                    picked={picked}
                    whereOf={whereOf}
                    onPick={(name) => {
                        setOpen(false);
                        onPick(name);
                    }}
                    onClose={closeList}
                    onRegister={() => {
                        setOpen(false);
                        onRegister();
                    }}
                />
            </PopoverReveal>
        </div>
    );
}

// The open list: search, a top group (Recent here, Suggested in Check Jira), then every other project. Mounted
// per open, so each open starts with an empty search and the highlight on the picked project.
export function ProjectList({
    projects,
    top,
    topLabel,
    picked,
    whereOf,
    sideOf = whereOf,
    onPick,
    onClose,
    onRegister,
}: {
    projects: { name: string; path: string }[];
    top: string[];
    topLabel: string;
    picked: string | null;
    whereOf: (name: string) => string;
    sideOf?: (name: string) => string;
    onPick: (name: string) => void;
    onClose: () => void;
    onRegister?: () => void;
}) {
    const [query, setQuery] = useState("");
    const [highlight, setHighlight] = useState<string | null>(picked);
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (highlight == null) {
            return;
        }
        listRef.current
            ?.querySelector(`[data-project-option="${CSS.escape(highlight)}"]`)
            ?.scrollIntoView({ block: "nearest" });
    }, [highlight]);

    const pathOf = new Map(projects.map((p) => [p.name, p.path]));
    const names = projects.map((p) => p.name);
    const sections = pickerSections(
        names,
        top.filter((n) => names.includes(n)),
        query,
        whereOf
    );
    const visible = [...sections.recent, ...sections.rest];

    // Enter and Escape stop here: ModalShell listens on window, and neither key is the dialog's while the
    // list is open (Escape closes only the list; Enter is a pick, not the dialog's submit).
    const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight(stepPick(visible, highlight, e.key === "ArrowDown" ? 1 : -1));
        } else if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            const next = highlight != null && visible.includes(highlight) ? highlight : visible[0];
            if (next != null) {
                onPick(next);
            }
        }
    };
    const onRootKey = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
        }
    };

    const option = (name: string) => {
        const on = name === picked;
        return (
            <button
                key={name}
                type="button"
                role="option"
                aria-selected={on}
                data-project-option={name}
                title={pathOf.get(name)}
                onMouseEnter={() => setHighlight(name)}
                onClick={() => onPick(name)}
                className={cn(
                    "flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left",
                    name === highlight ? "bg-surface-selected" : "bg-transparent"
                )}
            >
                <span className="w-3 flex-none text-[11px] text-accent-soft">{on ? "✓" : ""}</span>
                <span className="flex-none truncate text-[12.5px] font-medium text-ink-hi">{name}</span>
                <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] text-muted">
                    {sideOf(name)}
                </span>
            </button>
        );
    };

    return (
        <div
            onKeyDown={onRootKey}
            className="flex flex-col overflow-hidden rounded-[8px] border border-edge-strong bg-surface-raised shadow-popover-md"
        >
            <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
                <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                    className="flex-none text-muted"
                >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                    autoFocus
                    value={query}
                    aria-label="Search projects"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onSearchKey}
                    placeholder={`Search ${names.length} projects`}
                    className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] text-primary outline-none placeholder:text-muted"
                />
            </div>
            <div
                ref={listRef}
                role="listbox"
                aria-label="Projects"
                className="flex max-h-[240px] flex-col overflow-y-auto pb-1"
            >
                {sections.recent.length > 0 ? (
                    <>
                        <span className={GROUP_LABEL}>{topLabel}</span>
                        {sections.recent.map(option)}
                    </>
                ) : null}
                <span className={GROUP_LABEL}>{sections.restLabel}</span>
                {sections.rest.map(option)}
                {visible.length === 0 ? (
                    <span className="px-3 py-1.5 text-[12px] text-muted">No project matches.</span>
                ) : null}
            </div>
            <div className="flex items-center gap-3.5 border-t border-border px-3 py-1.5 font-mono text-[10.5px] text-muted">
                <span>↑↓ move</span>
                <span>⏎ pick</span>
                <span>esc close</span>
                {onRegister ? (
                    <>
                        <span className="flex-1" />
                        <button
                            type="button"
                            onClick={onRegister}
                            className="cursor-pointer text-ink-mid hover:text-primary"
                        >
                            Register a project
                        </button>
                    </>
                ) : null}
            </div>
        </div>
    );
}
