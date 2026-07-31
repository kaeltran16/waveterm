// frontend/app/view/agents/filessurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Diff surface (Wave-git-review.dc.html): three panes on one time axis — commit history with a lane
// gutter (historypane), the selected commit's metadata + files (commitpane), and that file's diff
// (CenterPane, below). Uncommitted work is row zero of the history, not a separate mode. Read-only.

import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { MotionConfig, motion } from "motion/react";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { useEffect, useMemo, useState } from "react";
import { MOTION } from "@/app/element/motiontokens";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { SkeletonLine } from "@/app/element/skeleton";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { type DiffLine, type FileView } from "./gitdiff";
import { StatusDot } from "./statusdot";
import { filesErrorAtom, filesStateAtom, loadFilesForAgent, loadFilesForProject, loadFilesForRun } from "./filesstore";
import { runShortId } from "./runcompletion";
import { projectsAtom } from "./projectsstore";
import { CommitPane } from "./commitpane";
import {
    activeChangesAtom,
    activeDiffAtom,
    graphOnAtom,
    historyErrorAtom,
    historyRowsAtom,
    loadHistory,
    resetHistory,
    selectCommit,
    selectCommitFile,
    selectedCommitAtom,
    selectedFileAtom,
} from "./githistorystore";
import { HistoryPane } from "./historypane";
import { WORKING_TREE } from "./historyrows";
import { SurfaceEmptyState, SurfaceError } from "./surfacescaffold";

// Windows-only build: git reports repo-relative paths with forward slashes while cwd uses backslashes,
// so a raw `${cwd}/${path}` join is mixed-separator. Normalize the whole join to backslashes so
// open::that (ShellExecute) resolves it and a copied absolute path is a valid native Windows path.
function joinPath(cwd: string, rel: string): string {
    return `${cwd}/${rel}`.replace(/\//g, "\\");
}

export interface FilesProject {
    name: string;
    path: string;
}

// The Files surface can be scoped either to a running agent's worktree or to a registered project.
export type FilesSource = { kind: "agent"; id: string } | { kind: "project"; name: string };

// In-tab source selector: picks whose worktree the Files surface shows. Agents (with a state dot)
// write the shared focusIdAtom so a diff can be inspected without bouncing back to the Agent tab;
// registered projects (folder glyph) resolve straight from their registry path — no agent needed.
function SourcePicker({
    agents,
    projects,
    source,
    onPickAgent,
    onPickProject,
}: {
    agents: AgentVM[];
    projects: FilesProject[];
    source: FilesSource | null;
    onPickAgent: (id: string) => void;
    onPickProject: (p: FilesProject) => void;
}) {
    const [open, setOpen] = useState(false);
    const currentAgent = source?.kind === "agent" ? agents.find((a) => a.id === source.id) : undefined;
    const currentProject = source?.kind === "project" ? projects.find((p) => p.name === source.name) : undefined;
    const hasAny = agents.length > 0 || projects.length > 0;
    const label = currentAgent?.name ?? currentProject?.name ?? (hasAny ? "Select a source" : "No agents or projects");
    return (
        <div className="relative">
            <button
                onClick={() => setOpen((v) => !v)}
                disabled={!hasAny}
                className="flex w-full items-center gap-[8px] rounded border border-border px-[10px] py-[7px] hover:border-edge-strong disabled:cursor-default disabled:opacity-60"
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

function EmptyCenter({ msg }: { msg: string }) {
    return <div className="flex h-full items-center justify-center text-[13px] text-muted">{msg}</div>;
}

function DiffSkeleton() {
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[14px] border-b border-edge-faint px-[20px] py-[8px]">
                <SkeletonLine className="h-[11px] w-[34px]" />
                <SkeletonLine className="h-[11px] w-[34px]" />
                <SkeletonLine className="h-[11px] w-[92px]" />
            </div>
            <div className="flex-1 overflow-hidden px-[20px] py-[14px]">
                {Array.from({ length: 12 }).map((_, i) => (
                    <div key={i} className="mb-[10px] flex gap-[10px]">
                        <SkeletonLine className="h-[12px] w-[30px]" />
                        <SkeletonLine className="h-[12px] w-[30px]" />
                        <SkeletonLine className="h-[12px] w-[72%]" />
                    </div>
                ))}
            </div>
        </div>
    );
}

function DiffRow({ line }: { line: DiffLine }) {
    if (line.kind === "hunk") {
        return <div className="bg-surface px-[20px] py-[2px] font-mono text-[11px] text-ink-mid">{line.text}</div>;
    }
    const tint =
        line.kind === "add"
            ? "color-mix(in srgb, var(--color-success) 12%, transparent)"
            : line.kind === "del"
              ? "color-mix(in srgb, var(--color-error) 12%, transparent)"
              : undefined;
    const textColor = line.kind === "add" ? "text-success" : line.kind === "del" ? "text-error" : "text-foreground";
    return (
        <div className="flex min-w-max" style={tint ? { background: tint } : undefined}>
            <span className="w-[42px] flex-none select-none px-[8px] text-right text-ink-faint">{line.gOld}</span>
            <span className="w-[42px] flex-none select-none px-[8px] text-right text-ink-faint">{line.gNew}</span>
            <span className={cn("w-[16px] flex-none text-center", textColor)}>{line.sign}</span>
            <span className={cn("whitespace-pre pr-[28px]", textColor)}>{line.text}</span>
        </div>
    );
}

function CenterPane({ path, view, cwd }: { path: string | null; view: FileView | null; cwd: string | null }) {
    return (
        <motion.div
            key={path ?? "__empty__"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: MOTION.durMicro, ease: MOTION.easeFluid }}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
            {!path ? (
                <EmptyCenter msg="Select a file to view its changes" />
            ) : (
                <>
                    <div className="flex flex-none items-center gap-[11px] border-b border-border px-[20px] py-[13px]">
                        <span className="min-w-0 truncate font-mono text-[13px] font-semibold">{path}</span>
                        <div className="flex-1" />
                        <span className="flex-none font-mono text-[11px] text-ink-mid">Read-only</span>
                        {cwd && (
                            <button
                                onClick={() => getApi().openExternal(joinPath(cwd, path))}
                                className="flex-none rounded border border-border px-[11px] py-[6px] text-[12px] text-ink-mid hover:text-foreground"
                            >
                                Open in editor ↗
                            </button>
                        )}
                    </div>
                    {view == null ? (
                        <DiffSkeleton />
                    ) : (
                        <>
                            {view.isDiff && (
                                <div className="flex flex-none items-center gap-[14px] border-b border-edge-faint px-[20px] py-[8px] font-mono text-[11px] font-bold">
                                    <span className="text-success">+{view.adds}</span>
                                    <span className="text-error">−{view.dels}</span>
                                    <span className="font-medium text-ink-mid">{view.hunkLabel}</span>
                                </div>
                            )}
                            <div className="min-h-0 flex-1 overflow-auto py-[8px] font-mono text-[12.5px] leading-[1.75]">
                                {view.lines.map((l, i) => (
                                    <DiffRow key={i} line={l} />
                                ))}
                            </div>
                        </>
                    )}
                </>
            )}
        </motion.div>
    );
}

export function FilesSurface({ model }: { model: AgentsViewModel }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const registry = useAtomValue(projectsAtom);
    const state = useAtomValue(filesStateAtom);
    const loadError = useAtomValue(filesErrorAtom);
    const historyRows = useAtomValue(historyRowsAtom);
    const historyError = useAtomValue(historyErrorAtom);
    const selectedCommit = useAtomValue(selectedCommitAtom);
    const selectedFile = useAtomValue(selectedFileAtom);
    const graphOn = useAtomValue(graphOnAtom);
    const activeChanges = useAtomValue(activeChangesAtom);
    const activeDiff = useAtomValue(activeDiffAtom);

    // registered projects (name -> path) as a sorted, path-bearing list for the picker
    const projects: FilesProject[] = Object.entries(registry ?? {})
        .filter(([, v]) => v?.path)
        .map(([name, v]) => ({ name, path: v.path }))
        .sort((a, b) => a.name.localeCompare(b.name));

    // A picked project overrides agent-focus scoping; null means "follow the focused agent".
    const [projectSel, setProjectSel] = useState<FilesProject | null>(null);
    const runSource = useAtomValue(model.filesRunAtom);
    const agent = agents.find((a) => a.id === focusId);
    const source: FilesSource | null = projectSel
        ? { kind: "project", name: projectSel.name }
        : focusId
          ? { kind: "agent", id: focusId }
          : null;

    // The three scopes the surface already had, now named. Run wins, then a picked project, then the
    // focused agent — the same precedence the load effect below uses.
    const scope: "run" | "repo" | "agent" = runSource ? "run" : projectSel ? "repo" : "agent";
    const refExpr = runSource
        ? `${(runSource.baseCommit || "HEAD").slice(0, 7)} … HEAD`
        : scope === "agent" && state?.ref
          ? `session start ${state.ref.slice(0, 7)} … worktree`
          : `${state?.branch || "—"} · all refs`;

    // Default to the first agent when nothing is scoped, so opening Files is immediately useful
    // instead of a dead "select a source" screen.
    useEffect(() => {
        if (!projectSel && !focusId && agents.length > 0) {
            globalStore.set(model.focusIdAtom, agents[0].id);
        }
    }, [projectSel, focusId, agents]);

    useEffect(() => {
        if (runSource) {
            fireAndForget(() => loadFilesForRun(runSource.runId, runSource.cwd, runSource.baseCommit));
        } else if (projectSel) {
            fireAndForget(() => loadFilesForProject(projectSel.name, projectSel.path));
        } else if (focusId) {
            fireAndForget(() => loadFilesForAgent(focusId, agent?.transcriptPath, agent?.blockId));
        }
    }, [runSource?.runId, runSource?.cwd, runSource?.baseCommit, projectSel?.name, projectSel?.path, focusId, agent?.transcriptPath, agent?.blockId]);

    // History follows whatever cwd the change-list load resolved, and anchors on the scope's base so
    // the session-start / run-base commit gets a labelled divider. rowLabel names what the synthetic
    // top row is counting: only repo scope reads the bare working tree, so the other two must say so.
    useEffect(() => {
        if (!state?.cwd || !state.isRepo) {
            resetHistory();
            return;
        }
        const anchor = runSource ? runSource.baseCommit : state.ref;
        fireAndForget(() =>
            loadHistory(state.cwd, {
                anchor: anchor || undefined,
                anchorLabel: runSource ? "run base" : anchor ? "session start" : undefined,
                rowLabel: runSource ? "Run changes" : anchor ? "Since session start" : undefined,
            })
        );
    }, [state?.cwd, state?.isRepo, state?.ref, runSource?.runId]);

    // publish the commit list for global j/k list-nav. cursor==selection: moving selects the commit,
    // which loads its files and first diff. Must run before the early return (hooks rules).
    const commitIds = (historyRows ?? []).map((r) => r.hash);
    const historyNav = useMemo<ListNavController | null>(
        () =>
            state?.cwd && commitIds.length > 0
                ? {
                      surface: "files",
                      navigableIds: commitIds,
                      cursorId: selectedCommit ?? undefined,
                      setCursor: (hash) => fireAndForget(() => selectCommit(state.cwd!, hash)),
                      activate:
                          selectedFile && state.cwd
                              ? () => getApi().openExternal(joinPath(state.cwd!, selectedFile))
                              : undefined,
                  }
                : null,
        [state?.cwd, commitIds.join(" "), selectedCommit, selectedFile]
    );
    useSurfaceListNav(historyNav);

    if (agents.length === 0 && projects.length === 0) {
        return (
            <SurfaceEmptyState
                title="No changes to show"
                body="Start an agent or pick a project to see its changed files here."
                action={{ label: "New agent", onClick: () => globalStore.set(model.newAgentOpenAtom, true) }}
            />
        );
    }
    const selectedRow = (historyRows ?? []).find((r) => r.hash === selectedCommit) ?? null;

    return (
        <MotionConfig reducedMotion="user">
            <div className="absolute inset-0 flex min-h-0 flex-col">
                {/* subject bar: what am I looking at, and against what */}
                <div className="flex-none px-[18px] pt-[14px]">
                    <div className="flex items-center gap-[14px] pb-[11px]">
                        <h1 className="flex-none text-[16px] font-bold">Diff</h1>
                        <div className="flex items-center overflow-hidden rounded-[9px] border border-edge-mid bg-surface">
                            <div className="w-[210px] border-r border-edge-mid">
                                {runSource ? (
                                    <div className="flex items-center gap-[8px] px-[11px] py-[6px]">
                                        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-mid">
                                            run {runShortId(runSource.runId)}
                                        </span>
                                        <button
                                            onClick={() => globalStore.set(model.filesRunAtom, null)}
                                            className="flex-none rounded border border-border px-[8px] py-[2px] text-[11px] text-ink-mid hover:text-foreground"
                                        >
                                            Exit
                                        </button>
                                    </div>
                                ) : (
                                    <SourcePicker
                                        agents={agents}
                                        projects={projects}
                                        source={source}
                                        onPickAgent={(id) => {
                                            setProjectSel(null);
                                            globalStore.set(model.focusIdAtom, id);
                                        }}
                                        onPickProject={(p) => setProjectSel(p)}
                                    />
                                )}
                            </div>
                            {(
                                [
                                    ["repo", "Repository", projectSel?.name ?? ""],
                                    ["agent", "Agent", agent?.name ?? ""],
                                    ["run", "Run", runSource ? runShortId(runSource.runId) : ""],
                                ] as const
                            ).map(([key, label, sub]) => (
                                <div
                                    key={key}
                                    className={cn(
                                        "flex items-center gap-[6px] border-r border-edge-faint px-[11px] py-[6px] text-[11.5px] font-semibold",
                                        scope === key ? "bg-surface-selected text-ink-hi" : "text-muted"
                                    )}
                                >
                                    {label}
                                    <span
                                        className={cn(
                                            "max-w-[90px] truncate font-mono text-[10.5px]",
                                            scope === key ? "text-accent-soft" : "text-edge-strong"
                                        )}
                                    >
                                        {sub}
                                    </span>
                                </div>
                            ))}
                        </div>
                        <div className="flex items-center gap-[8px] rounded-[9px] border border-edge-mid bg-surface px-[11px] py-[6px]">
                            <span className="font-mono text-[8.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
                                Reading
                            </span>
                            <span className="font-mono text-[12px] text-ink-mid">{refExpr}</span>
                        </div>
                        <div className="flex-1" />
                        <button
                            onClick={() => globalStore.set(graphOnAtom, !graphOn)}
                            className={cn(
                                "flex items-center gap-[7px] rounded-[7px] border px-[10px] py-[5px] text-[11.5px] font-semibold",
                                graphOn ? "border-accent/30 bg-accentbg text-ink-hi" : "border-edge-mid bg-surface text-muted"
                            )}
                        >
                            Graph
                        </button>
                    </div>
                </div>

                {loadError || historyError ? <SurfaceError message="Couldn’t read this repository." /> : null}

                <div className="flex min-h-0 flex-1 border-t border-edge-faint">
                    <div className="flex w-[460px] flex-none flex-col border-r border-edge-faint">
                        {state?.isRepo === false && state?.cwd ? (
                            <div className="px-[14px] py-[10px] text-[12px] text-ink-mid">Not a git repository</div>
                        ) : (
                            <HistoryPane
                                rows={historyRows ?? []}
                                selected={selectedCommit}
                                graphOn={graphOn}
                                loading={historyRows == null}
                                onSelect={(hash) => state?.cwd && fireAndForget(() => selectCommit(state.cwd!, hash))}
                            />
                        )}
                    </div>
                    <div className="flex w-[300px] flex-none flex-col border-r border-edge-faint bg-surface">
                        <CommitPane
                            row={selectedRow}
                            changes={activeChanges}
                            selectedFile={selectedFile}
                            onSelectFile={(path) =>
                                state?.cwd &&
                                selectedCommit != null &&
                                fireAndForget(() => selectCommitFile(state.cwd!, selectedCommit, path))
                            }
                        />
                    </div>
                    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                        <CenterPane
                            path={selectedFile}
                            view={activeDiff}
                            cwd={selectedCommit === WORKING_TREE ? (state?.cwd ?? null) : null}
                        />
                    </div>
                </div>
            </div>
        </MotionConfig>
    );
}
