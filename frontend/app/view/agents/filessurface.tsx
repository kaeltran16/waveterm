// frontend/app/view/agents/filessurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Files surface (Wave-cockpit-live.dc.html:733-804): left = changed-file list for the focused
// agent's worktree; right = the selected file's diff (or plain view for untracked). Read-only.

import { getApi } from "@/app/store/global";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Copy, Pencil } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useSurfaceListNav, type ListNavController } from "@/app/store/keybindings/listnav";
import { useEffect, useMemo, useRef, useState } from "react";
import { MOTION, cardVariants, computeEntrances, easeFluidCss, initialEntranceState, type EntranceState } from "@/app/element/motiontokens";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { SkeletonLine } from "@/app/element/skeleton";
import type { AgentsViewModel } from "./agents";
import type { AgentState, AgentVM } from "./agentsviewmodel";
import { type DiffLine, type FileView } from "./gitdiff";
import { statusColor, type GitChange } from "./gitstatus";
import { filesDiffAtom, filesSelectedPathAtom, filesStateAtom, loadFilesForAgent, loadFilesForProject, selectFile } from "./filesstore";
import { projectsAtom } from "./projectsstore";
import { ReviewSurface } from "./reviewsurface";
import { decisionsAtom, fileDecision, hunkKey, loadReview, progressOf, reviewModelAtom, reviewSelectedAtom } from "./reviewstore";
import { sourceKey } from "./filesmotion";
import { SurfaceEmptyState } from "./surfacescaffold";

// Agent-state dot palette (matches the recent-activity / status-dot semantics used across the cockpit).
const STATE_DOT: Record<AgentState, string> = { asking: "bg-warning", working: "bg-success", idle: "bg-muted" };

function baseName(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] || p;
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
                    <span className={cn("h-[7px] w-[7px] flex-none rounded-full", STATE_DOT[currentAgent.state])} />
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
                                <span className={cn("h-[7px] w-[7px] flex-none rounded-full", STATE_DOT[a.state])} />
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

function FileListSkeleton() {
    return (
        <div className="space-y-[7px] px-[8px] py-[6px]">
            {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-[7px] rounded-[7px] px-[8px] py-[5px]">
                    <SkeletonLine className="h-[13px] flex-1" />
                    <SkeletonLine className="h-[10px] w-[18px]" />
                </div>
            ))}
        </div>
    );
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

function FileRow({
    change,
    selected,
    onSelect,
    onContextMenu,
}: {
    change: GitChange;
    selected: boolean;
    onSelect: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
}) {
    return (
        <button
            onClick={onSelect}
            onContextMenu={onContextMenu}
            className={cn(
                "flex w-full items-center gap-[7px] rounded-[7px] px-[8px] py-[5px] text-left transition-colors duration-[140ms] hover:bg-surface-hover",
                selected && "bg-surface-selected"
            )}
        >
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-mid">{change.path}</span>
            <span className={cn("flex-none font-mono text-[10px] font-bold", statusColor(change.status))}>{change.status}</span>
        </button>
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
                                onClick={() => getApi().openExternal(`${cwd}/${path}`)}
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
    const selected = useAtomValue(filesSelectedPathAtom);
    const diff = useAtomValue(filesDiffAtom);
    const reviewModel = useAtomValue(reviewModelAtom);
    const decisions = useAtomValue(decisionsAtom);
    const reviewSel = useAtomValue(reviewSelectedAtom);

    // registered projects (name -> path) as a sorted, path-bearing list for the picker
    const projects: FilesProject[] = Object.entries(registry ?? {})
        .filter(([, v]) => v?.path)
        .map(([name, v]) => ({ name, path: v.path }))
        .sort((a, b) => a.name.localeCompare(b.name));

    // A picked project overrides agent-focus scoping; null means "follow the focused agent".
    const [projectSel, setProjectSel] = useState<FilesProject | null>(null);
    const [mode, setMode] = useState<"browse" | "review">("browse");
    const agent = agents.find((a) => a.id === focusId);
    const source: FilesSource | null = projectSel
        ? { kind: "project", name: projectSel.name }
        : focusId
          ? { kind: "agent", id: focusId }
          : null;

    // No-cascade entrance guard: switching source reseeds the file list silently; only files that
    // arrive from a live git update within the held source animate in.
    const filePaths = state?.changes?.files.map((f) => f.path) ?? [];
    const guardKey = sourceKey(source);
    const entranceRef = useRef<EntranceState>(initialEntranceState());
    const { animate: entranceIds } = computeEntrances(entranceRef.current, guardKey, filePaths);
    useEffect(() => {
        entranceRef.current = computeEntrances(entranceRef.current, guardKey, filePaths).state;
    }, [guardKey, filePaths.join(" ")]);

    // Default to the first agent when nothing is scoped, so opening Files is immediately useful
    // instead of a dead "select a source" screen.
    useEffect(() => {
        if (!projectSel && !focusId && agents.length > 0) {
            globalStore.set(model.focusIdAtom, agents[0].id);
        }
    }, [projectSel, focusId, agents]);

    useEffect(() => {
        if (projectSel) {
            fireAndForget(() => loadFilesForProject(projectSel.name, projectSel.path));
        } else if (focusId) {
            fireAndForget(() => loadFilesForAgent(focusId, agent?.transcriptPath, agent?.blockId));
        }
    }, [projectSel?.name, projectSel?.path, focusId, agent?.transcriptPath, agent?.blockId]);

    useEffect(() => {
        if (mode === "review" && state?.cwd) {
            void loadReview(state.cwd);
        }
    }, [mode, state?.cwd]);

    // publish the browse file list for global j/k list-nav; review mode has its own keys
    // (buildReviewBindings), so withdraw the controller (null) there. cursor==selection: moving
    // selects the file, which loads its diff. Must run before the early return (hooks rules).
    const browseNav = useMemo<ListNavController | null>(
        () =>
            mode === "browse" && state?.cwd
                ? {
                      surface: "files",
                      navigableIds: filePaths,
                      cursorId: selected ?? undefined,
                      setCursor: (path) => fireAndForget(() => selectFile(state.cwd!, path)),
                  }
                : null,
        [mode, state?.cwd, filePaths.join(" "), selected]
    );
    useSurfaceListNav(browseNav);

    if (agents.length === 0 && projects.length === 0) {
        return (
            <SurfaceEmptyState
                title="No changes to show"
                body="Start an agent or pick a project to see its changed files here."
            />
        );
    }
    const dirLabel = state?.cwd ? baseName(state.cwd) : "—";
    const changes = state?.changes;
    // review mode reuses this one sidebar list: progress header + per-file verdict/counts,
    // selection driven through reviewSelectedAtom (the hunk pane lives in ReviewSurface).
    const rprog = reviewModel ? progressOf(reviewModel.files, decisions) : null;
    const rSelPath = reviewModel
        ? (reviewModel.files.find((f) => f.path === reviewSel)?.path ?? reviewModel.files[0]?.path ?? null)
        : null;

    return (
        <MotionConfig reducedMotion="user">
        <div className="absolute inset-0 flex min-h-0">
            <div className="flex w-[292px] flex-none flex-col border-r border-border bg-surface">
                <div className="flex-none border-b border-edge-faint p-[15px]">
                    <div className="mb-[11px] flex items-center gap-[9px]">
                        <h1 className="text-[16px] font-bold">Diff</h1>
                        <div className="ml-auto flex gap-[2px] rounded-[7px] border border-border p-[2px]">
                            <button onClick={() => setMode("browse")}
                                className={cn("rounded-[5px] px-[9px] py-[3px] text-[11px] font-[600]", mode === "browse" ? "bg-surface-selected text-foreground" : "text-ink-mid")}>Browse</button>
                            <button onClick={() => setMode("review")}
                                className={cn("rounded-[5px] px-[9px] py-[3px] text-[11px] font-[600]", mode === "review" ? "bg-surface-selected text-foreground" : "text-ink-mid")}>Review</button>
                        </div>
                    </div>
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
                    {state?.cwd && <div className="mt-[7px] truncate px-[2px] font-mono text-[11px] text-ink-faint">{dirLabel}</div>}
                    {state?.isRepo && (
                        <div className="mt-[10px] flex items-center gap-[13px] font-mono text-[11px] font-semibold">
                            <span className="text-ink-mid">{state.branch || "—"}</span>
                            <span className="text-success">+{changes?.adds ?? 0}</span>
                            <span className="text-error">−{changes?.dels ?? 0}</span>
                        </div>
                    )}
                    {mode === "review" && rprog && (
                        <div className="mt-[11px]">
                            <div className="mb-[6px] flex items-baseline justify-between font-mono text-[11px]">
                                <span className="text-ink-faint">{reviewModel!.files.length} files</span>
                                <span className="text-ink-mid">{rprog.reviewed}/{rprog.total} reviewed</span>
                            </div>
                            <div className="flex h-[6px] overflow-hidden rounded-[4px] bg-surface-hover">
                                <div className="h-full bg-success" style={{ width: `${rprog.total ? (rprog.accepted / rprog.total) * 100 : 0}%`, transition: `width ${MOTION.durMacro}s ${easeFluidCss}` }} />
                                <div className="h-full bg-error" style={{ width: `${rprog.total ? (rprog.rejected / rprog.total) * 100 : 0}%`, transition: `width ${MOTION.durMacro}s ${easeFluidCss}` }} />
                            </div>
                        </div>
                    )}
                </div>
                <div className="flex-1 overflow-y-auto p-[8px]">
                    {mode === "review" ? (
                        reviewModel == null ? (
                            <FileListSkeleton />
                        ) : reviewModel.files.length === 0 ? (
                            <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">No changes to review</div>
                        ) : (
                            reviewModel.files.map((f) => {
                                const verdict = fileDecision(f, decisions);
                                const dec = f.hunks.filter((h) => decisions[hunkKey(f.path, h.id)]).length;
                                const ring =
                                    verdict === "accept" ? "text-success"
                                    : verdict === "reject" ? "text-error"
                                    : verdict === "partial" ? "text-warning"
                                    : "text-ink-faint";
                                return (
                                    <button
                                        key={f.path}
                                        onClick={() => globalStore.set(reviewSelectedAtom, f.path)}
                                        className={cn(
                                            "flex w-full items-center gap-[8px] rounded px-[9px] py-[7px] text-left transition-colors duration-[140ms] hover:bg-surface-hover",
                                            f.path === rSelPath && "bg-surface-selected"
                                        )}
                                    >
                                        <span className={cn("font-mono text-[11px]", ring)}>●</span>
                                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-mid">{f.path}</span>
                                        <span className="flex-none font-mono text-[10px] text-ink-faint">{dec}/{f.hunks.length}</span>
                                    </button>
                                );
                            })
                        )
                    ) : state == null ? (
                        <FileListSkeleton />
                    ) : !state.isRepo ? (
                        <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">Not a git repository</div>
                    ) : (changes?.files.length ?? 0) === 0 ? (
                        <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">No changes</div>
                    ) : (
                        <AnimatePresence mode="popLayout" initial={false}>
                            {changes!.files.map((c) => (
                                <motion.div
                                    key={c.path}
                                    layout
                                    variants={cardVariants}
                                    initial={entranceIds.has(c.path) ? "initial" : false}
                                    animate="animate"
                                    exit="exit"
                                >
                                    <FileRow
                                        change={c}
                                        selected={c.path === selected}
                                        onSelect={() => state.cwd && fireAndForget(() => selectFile(state.cwd!, c.path))}
                                        onContextMenu={(ev) => {
                                            const cwd = state.cwd;
                                            if (!cwd) {
                                                return;
                                            }
                                            ContextMenuModel.getInstance().showContextMenu(
                                                [
                                                    { label: "Open in editor", icon: <Pencil size={15} />, click: () => getApi().openExternal(`${cwd}/${c.path}`) },
                                                    { label: "Copy path", icon: <Copy size={15} />, click: () => void navigator.clipboard.writeText(c.path) },
                                                    { label: "Copy absolute path", icon: <Copy size={15} />, click: () => void navigator.clipboard.writeText(`${cwd}/${c.path}`) },
                                                ],
                                                ev
                                            );
                                        }}
                                    />
                                </motion.div>
                            ))}
                        </AnimatePresence>
                    )}
                </div>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {mode === "review" ? <ReviewSurface /> : <CenterPane path={selected} view={diff} cwd={state?.cwd ?? null} />}
            </div>
        </div>
        </MotionConfig>
    );
}
