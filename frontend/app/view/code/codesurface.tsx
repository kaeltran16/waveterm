// frontend/app/view/code/codesurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Code surface: read any file in a registered git project. Read-only, and deliberately unconnected
// to agents and runs — this answers "what does this code look like", not "what changed".

import { PopoverReveal } from "@/app/element/popoverreveal";
import { buildCodeBindings } from "@/app/store/keybindings/bindings";
import { useKeybindings } from "@/app/store/keybindings/store";
import type { AgentsViewModel } from "@/app/view/agents/agents";
import { projectsAtom } from "@/app/view/agents/projectsstore";
import { SurfaceEmptyState, SurfaceError, SurfaceHeader } from "@/app/view/agents/surfacescaffold";
import { cn, fireAndForget } from "@/util/util";
import { useAtom, useAtomValue } from "jotai";
import { ChevronDown, FolderGit2, RotateCw, Save, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CodeFinderPalette } from "./codefinderpalette";
import { canBack, canForward } from "./codehistory";
import { CodePathBar } from "./codepathbar";
import { CodeSearchPane } from "./codesearchpane";
import { codeSearchModeAtom } from "./codesearchstore";
import {
    codeDraftsAtom,
    codeFileAtom,
    codeHistoryAtom,
    codeIndexAtom,
    codeIndexErrorAtom,
    codeProjectAtom,
    codeSaveAtom,
    draftKey,
    goBack,
    goForward,
    refreshIndex,
    reloadFromDisk,
    revertDraft,
    saveCurrent,
    selectProject,
    type CodeProject,
} from "./codestore";
import { CodeTreePane } from "./codetreepane";
import { CodeViewer } from "./codeviewer";

export function CodeSurface({ model }: { model: AgentsViewModel }) {
    const registry = useAtomValue(projectsAtom);
    const project = useAtomValue(codeProjectAtom);
    const index = useAtomValue(codeIndexAtom);
    const indexError = useAtomValue(codeIndexErrorAtom);
    const history = useAtomValue(codeHistoryAtom);
    const [pickerOpen, setPickerOpen] = useState(false);

    // stable array: every run() reads live atoms, so it never needs rebuilding
    const codeBindings = useMemo(() => buildCodeBindings(), []);
    useKeybindings(codeBindings);

    const projects: CodeProject[] = Object.entries(registry ?? {})
        .filter(([, v]) => v?.path)
        .map(([name, v]) => ({ name, path: v.path }))
        .sort((a, b) => a.name.localeCompare(b.name));

    // the index survives an unmount in a module atom, but a project picked before this surface ever
    // loaded (or a cache cleared elsewhere) leaves the atom null — reload on mount when that happens
    useEffect(() => {
        if (project != null && index == null && indexError == null) {
            fireAndForget(() => selectProject(project));
        }
    }, [project, index, indexError]);

    return (
        <div className="relative flex h-full w-full flex-col">
            <SurfaceHeader
                title="Code"
                subtitle={project != null ? `${project.name} · ${project.path}` : "No project selected"}
                actions={
                    <>
                        <div className="relative">
                            <button
                                type="button"
                                data-code-project-picker
                                onClick={() => setPickerOpen((v) => !v)}
                                className="flex cursor-pointer items-center gap-1.5 rounded-[8px] border border-border bg-surface px-2.5 py-1 text-[12px] text-secondary hover:text-primary"
                            >
                                <FolderGit2 size={13} strokeWidth={1.8} />
                                <span>{project?.name ?? "Pick a project"}</span>
                                <ChevronDown size={13} strokeWidth={1.8} />
                            </button>
                            <PopoverReveal
                                open={pickerOpen}
                                origin="top right"
                                className="absolute right-0 top-[calc(100%+6px)] z-20 min-w-[240px] overflow-hidden rounded-[10px] border border-border bg-surface shadow-lg"
                            >
                                {projects.length === 0 ? (
                                    <div className="px-3 py-2 text-[12px] text-muted">No registered projects</div>
                                ) : (
                                    projects.map((p) => (
                                        <button
                                            key={p.name}
                                            type="button"
                                            onClick={() => {
                                                setPickerOpen(false);
                                                fireAndForget(() => selectProject(p));
                                            }}
                                            className={cn(
                                                "flex w-full cursor-pointer flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-accent/10",
                                                p.path === project?.path && "bg-accent/10"
                                            )}
                                        >
                                            <span className="text-[12.5px] text-primary">{p.name}</span>
                                            <span className="font-mono text-[10.5px] text-muted">{p.path}</span>
                                        </button>
                                    ))
                                )}
                            </PopoverReveal>
                        </div>
                        <SaveControls />
                        <HeaderButton label="Refresh index" onClick={() => fireAndForget(refreshIndex)}>
                            <RotateCw size={13} strokeWidth={1.8} />
                        </HeaderButton>
                        <HeaderButton label="Back" disabled={!canBack(history)} onClick={() => fireAndForget(goBack)}>
                            ←
                        </HeaderButton>
                        <HeaderButton
                            label="Forward"
                            disabled={!canForward(history)}
                            onClick={() => fireAndForget(goForward)}
                        >
                            →
                        </HeaderButton>
                    </>
                }
            />
            {indexError != null ? (
                <SurfaceError
                    message={`Could not list files: ${indexError}`}
                    onRetry={() => fireAndForget(refreshIndex)}
                />
            ) : null}
            <SaveBanner />
            <div className="min-h-0 flex-1">
                <CodeBody model={model} onPickProject={() => setPickerOpen(true)} />
            </div>
            <CodeFinderPalette model={model} />
        </div>
    );
}

function HeaderButton({
    label,
    onClick,
    disabled,
    children,
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className="flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-[8px] border border-border bg-surface text-[12px] text-secondary hover:text-primary disabled:cursor-default disabled:opacity-40"
        >
            {children}
        </button>
    );
}

function useDirty(): boolean {
    const project = useAtomValue(codeProjectAtom);
    const file = useAtomValue(codeFileAtom);
    const drafts = useAtomValue(codeDraftsAtom);
    if (project == null || file.kind !== "text") {
        return false;
    }
    return drafts.has(draftKey(project, file.path));
}

function SaveControls() {
    const dirty = useDirty();
    const save = useAtomValue(codeSaveAtom);

    // the only steady-state feedback that a write landed; the banner is for the failures
    const status =
        save.kind === "saving" ? "Saving…" : save.kind === "saved" && !dirty ? "Saved" : dirty ? "Unsaved" : null;

    return (
        <>
            {status != null ? (
                <span className={cn("text-[11.5px]", dirty ? "text-accent-soft" : "text-muted")}>{status}</span>
            ) : null}
            <HeaderButton
                label="Save (Ctrl+S)"
                disabled={!dirty || save.kind === "saving"}
                onClick={() => fireAndForget(saveCurrent)}
            >
                <Save size={13} strokeWidth={1.8} />
            </HeaderButton>
            <HeaderButton label="Discard unsaved edits" disabled={!dirty} onClick={revertDraft}>
                <Undo2 size={13} strokeWidth={1.8} />
            </HeaderButton>
        </>
    );
}

// A refused save and a failed save are different things and say so. Both keep the draft: the button
// reloads from disk, which is the one action that throws typed text away, so it is never automatic.
function SaveBanner() {
    const save = useAtomValue(codeSaveAtom);
    if (save.kind === "conflict") {
        return (
            <SurfaceError
                message={`${save.path}: ${save.message}`}
                actionLabel="Reload from disk"
                onRetry={() => fireAndForget(reloadFromDisk)}
            />
        );
    }
    if (save.kind === "error") {
        return (
            <SurfaceError
                message={`Could not save ${save.path}: ${save.message}`}
                onRetry={() => fireAndForget(saveCurrent)}
            />
        );
    }
    return null;
}

function CodeBody({ model, onPickProject }: { model: AgentsViewModel; onPickProject: () => void }) {
    const registry = useAtomValue(projectsAtom);
    const project = useAtomValue(codeProjectAtom);
    const index = useAtomValue(codeIndexAtom);
    const indexError = useAtomValue(codeIndexErrorAtom);

    if (Object.keys(registry ?? {}).length === 0) {
        return (
            <SurfaceEmptyState
                title="No registered projects"
                body="Register a project in Settings to browse its source here."
            />
        );
    }
    if (project == null) {
        return (
            <SurfaceEmptyState
                title="No project selected"
                body="Pick a project to browse its files."
                action={{ label: "Pick a project", onClick: onPickProject }}
            />
        );
    }
    if (indexError != null) {
        return null; // the banner above already says it, and a second message would double up
    }
    if (index == null) {
        return <SurfaceEmptyState title="Listing files…" />;
    }
    if (!index.isRepo) {
        return <SurfaceEmptyState title="Not a git repository" body={project.path} />;
    }
    return <CodePanes model={model} />;
}

function CodePanes({ model }: { model: AgentsViewModel }) {
    const [mode, setMode] = useAtom(codeSearchModeAtom);
    return (
        <div className="flex h-full w-full">
            {/* Search rows carry a line number and a line of source, which is unreadable at the
                tree's width, so the column widens for them rather than truncating everything. */}
            <div className={cn("flex flex-none flex-col", mode === "search" ? "w-[380px]" : "w-[280px]")}>
                <div className="flex flex-none gap-1 border-b border-border px-2 py-1">
                    {(["files", "search"] as const).map((m) => (
                        <button
                            key={m}
                            type="button"
                            data-code-column-tab={m}
                            onClick={() => setMode(m)}
                            className={cn(
                                "cursor-pointer rounded-[6px] px-2 py-[3px] text-[11px] capitalize",
                                m === mode ? "bg-accent/10 text-accent-soft" : "text-muted hover:text-primary"
                            )}
                        >
                            {m}
                        </button>
                    ))}
                </div>
                <div className="min-h-0 flex-1">
                    {mode === "files" ? <CodeTreePane model={model} /> : <CodeSearchPane model={model} />}
                </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
                <CodePathBar model={model} />
                <div className="min-h-0 flex-1">
                    <CodeViewer model={model} />
                </div>
            </div>
        </div>
    );
}
