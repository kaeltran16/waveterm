// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { agentCwd } from "./agentcwd";
import { liveProjectsForLaunch } from "./agentsviewmodel";
import { runtimeLaunchLabel, runtimeShowsTask, runtimeStartupCommand, type Runtime } from "./launch";
import { launchCandidates, projectsAtom, type LaunchCandidate } from "./projectsstore";

const RUNTIMES: { id: Runtime; name: string; glyph: string }[] = [
    { id: "claude", name: "Claude Code", glyph: "✳" },
    { id: "codex", name: "Codex", glyph: "{ }" },
    { id: "antigravity", name: "Antigravity", glyph: "◭" },
    { id: "terminal", name: "Terminal", glyph: "›_" },
];

const CWD_TAIL_LINES = 200;

export function NewAgentModal({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(model.newAgentOpenAtom);
    const registry = useAtomValue(projectsAtom);
    const agents = useAtomValue(model.agentsAtom);
    const [runtime, setRuntime] = useState<Runtime>("claude");
    const [project, setProject] = useState<string>("");
    const [task, setTask] = useState("");
    const [startup, setStartup] = useState("claude");
    const [branch, setBranch] = useState("feat/new-agent");
    const [branches, setBranches] = useState<BranchInfo[]>([]);
    const [branchListOpen, setBranchListOpen] = useState(false);
    const [resolvedPaths, setResolvedPaths] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    // Launcher targets mirror the project switcher: registered projects ∪ live-derived ones.
    const candidates = useMemo(() => launchCandidates(registry, liveProjectsForLaunch(agents)), [registry, agents]);
    const pathFor = (c: LaunchCandidate | undefined): string => (c ? c.path || resolvedPaths[c.name] || "" : "");
    const selectedProject = project || candidates[0]?.name || "";
    const selectedCandidate = candidates.find((c) => c.name === selectedProject);
    const selectedPath = pathFor(selectedCandidate);
    // Resolve a launch cwd for live (un-registered) projects from a representative agent's transcript
    // (the same source the Files surface uses). Registered projects already carry a stored path.
    useEffect(() => {
        if (!open) {
            return;
        }
        const todo = candidates.filter((c) => !c.registered && !c.path && c.transcriptPath && !(c.name in resolvedPaths));
        if (todo.length === 0) {
            return;
        }
        let cancelled = false;
        void Promise.all(
            todo.map(async (c) => {
                try {
                    const rtn = await RpcApi.GetAgentTranscriptCommand(TabRpcClient, {
                        path: c.transcriptPath!,
                        maxlines: CWD_TAIL_LINES,
                    });
                    return [c.name, agentCwd(rtn?.lines ?? []) ?? ""] as const;
                } catch {
                    return [c.name, ""] as const;
                }
            })
        ).then((pairs) => {
            if (cancelled) {
                return;
            }
            setResolvedPaths((prev) => {
                const next = { ...prev };
                for (const [name, p] of pairs) {
                    next[name] = p;
                }
                return next;
            });
        });
        return () => {
            cancelled = true;
        };
        // resolvedPaths is read for the dedup filter but kept out of deps: the merge is functional and
        // re-running on every resolution would loop.
    }, [open, candidates]);
    // Pull the project's branches (recency-ordered) for the worktree-branch suggestions. Terminal
    // runtime and non-repo projects degrade to free-text (empty list).
    useEffect(() => {
        if (!open || runtime === "terminal" || !selectedPath) {
            setBranches([]);
            return;
        }
        let cancelled = false;
        RpcApi.ListBranchesCommand(TabRpcClient, { projectpath: selectedPath })
            .then((rtn) => {
                if (!cancelled) {
                    setBranches(rtn.branches ?? []);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setBranches([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [open, runtime, selectedPath]);
    if (!open) {
        return null;
    }
    const close = () => {
        globalStore.set(model.newAgentOpenAtom, false);
        setError(null);
    };
    const pickRuntime = (r: Runtime) => {
        setRuntime(r);
        setStartup(runtimeStartupCommand(r));
    };
    const launch = async () => {
        const c = candidates.find((p) => p.name === selectedProject);
        const path = pathFor(c);
        if (!c || !path) {
            setError("Couldn't find a folder for this project. Add it via + New project.");
            return;
        }
        try {
            // Persist live-derived projects on first launch so they become stable, registered targets.
            if (!c.registered) {
                await RpcApi.CreateProjectCommand(TabRpcClient, { name: c.name, path });
            }
            await launchAgent(model, {
                runtime,
                startupCommand: startup,
                task,
                projectPath: path,
                branch,
            });
            close();
        } catch (e) {
            setError(String(e));
        }
    };
    return (
        <div
            onClick={close}
            className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 pt-[11vh] backdrop-blur-sm"
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="flex max-h-[86vh] w-[min(640px,93vw)] flex-col overflow-hidden rounded-[14px] border border-edge-strong bg-modalbg shadow-popover"
            >
                <div className="flex shrink-0 items-center gap-[11px] border-b border-border px-[18px] py-[15px]">
                    <div className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-gradient-to-br from-accent-300 to-accent-500">
                        <div className="h-[7px] w-[7px] rounded-full bg-surface" />
                    </div>
                    <span className="flex-1 text-[15px] font-semibold text-primary">New agent</span>
                    <span className="rounded-[5px] border border-edge-mid px-[7px] py-0.5 font-mono text-[10.5px] text-muted">
                        esc
                    </span>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-[15px] overflow-y-auto px-[18px] py-4">
                    <Section label="Runtime">
                        <div className="grid grid-cols-4 gap-2">
                            {RUNTIMES.map((r) => (
                                <button
                                    key={r.id}
                                    onClick={() => pickRuntime(r.id)}
                                    className={cn(
                                        "flex cursor-pointer flex-col items-center gap-2 rounded-[11px] border bg-surface px-2 py-[13px] hover:border-edge-strong",
                                        runtime === r.id ? "border-accent-700 bg-accentbg" : "border-edge-mid"
                                    )}
                                >
                                    <div className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-accentbg font-mono text-[13px] font-bold text-accent-soft">
                                        {r.glyph}
                                    </div>
                                    <span
                                        className={cn(
                                            "text-[12px] font-semibold",
                                            runtime === r.id ? "text-primary" : "text-muted-foreground"
                                        )}
                                    >
                                        {r.name}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </Section>
                    <Section label="Project">
                        {candidates.length === 0 ? (
                            <div className="text-[12.5px] text-muted">
                                No projects yet — add one from the project switcher (+ New project).
                            </div>
                        ) : (
                            <div className="flex flex-wrap gap-[7px]">
                                {candidates.map((p) => {
                                    const failed = !p.registered && p.name in resolvedPaths && !resolvedPaths[p.name];
                                    const resolving = !p.registered && !pathFor(p) && !failed;
                                    return (
                                        <button
                                            key={p.name}
                                            disabled={failed}
                                            onClick={() => setProject(p.name)}
                                            title={failed ? "No working directory found for this project" : undefined}
                                            className={cn(
                                                "flex items-center gap-[7px] rounded-[8px] border bg-surface px-[11px] py-[7px]",
                                                failed
                                                    ? "cursor-not-allowed opacity-40"
                                                    : "cursor-pointer hover:border-edge-strong",
                                                selectedProject === p.name ? "border-accent-700 bg-accentbg" : "border-edge-mid"
                                            )}
                                        >
                                            <div
                                                className={cn(
                                                    "h-[7px] w-[7px] rounded-[2px]",
                                                    selectedProject === p.name ? "bg-accent" : "bg-muted"
                                                )}
                                            />
                                            <span
                                                className={cn(
                                                    "text-[12.5px] font-medium",
                                                    selectedProject === p.name ? "text-primary" : "text-muted-foreground"
                                                )}
                                            >
                                                {p.name}
                                            </span>
                                            {resolving ? <span className="font-mono text-[9.5px] text-muted">…</span> : null}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </Section>
                    {runtimeShowsTask(runtime) ? (
                        <Section label="Task">
                            <textarea
                                value={task}
                                onChange={(e) => setTask(e.target.value)}
                                placeholder="Describe what this agent should do…"
                                className="h-[84px] w-full resize-none rounded-[10px] border border-edge-mid bg-surface px-[13px] py-[11px] text-[13.5px] leading-normal text-primary outline-none focus:border-accent-700"
                            />
                        </Section>
                    ) : null}
                    <Section label="Startup command · optional">
                        <div className="flex items-center gap-[9px] rounded-[8px] border border-edge-mid bg-surface px-3 py-[9px]">
                            <span className="font-mono text-[12.5px] font-semibold text-success">›</span>
                            <input
                                value={startup}
                                onChange={(e) => setStartup(e.target.value)}
                                placeholder={runtime === "terminal" ? "bash" : "claude"}
                                className="flex-1 bg-transparent font-mono text-[12.5px] text-secondary outline-none"
                            />
                        </div>
                    </Section>
                    <Section label="Worktree branch">
                        <div className="relative">
                            <div className="flex items-center rounded-[8px] border border-edge-mid bg-surface focus-within:border-accent-700">
                                <input
                                    value={branch}
                                    onChange={(e) => setBranch(e.target.value)}
                                    onFocus={() => setBranchListOpen(true)}
                                    placeholder="feat/new-agent"
                                    className="flex-1 bg-transparent px-3 py-[9px] font-mono text-[12.5px] text-secondary outline-none"
                                />
                                {branches.length > 0 ? (
                                    <button
                                        type="button"
                                        onClick={() => setBranchListOpen((v) => !v)}
                                        className="cursor-pointer px-3 py-[9px] text-[10px] text-muted hover:text-primary"
                                    >
                                        ▾
                                    </button>
                                ) : null}
                            </div>
                            {branchListOpen && branches.length > 0 ? (
                                <div className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-[168px] overflow-y-auto rounded-[8px] border border-edge-mid bg-modalbg py-1 shadow-popover">
                                    {branches.map((b) => (
                                        <button
                                            key={b.name}
                                            type="button"
                                            onClick={() => {
                                                setBranch(b.name);
                                                setBranchListOpen(false);
                                            }}
                                            className={cn(
                                                "flex w-full cursor-pointer items-center gap-2 px-3 py-[7px] text-left hover:bg-surface-hover",
                                                b.name === branch ? "text-primary" : "text-secondary"
                                            )}
                                        >
                                            <span
                                                className={cn(
                                                    "h-[6px] w-[6px] shrink-0 rounded-full",
                                                    b.name === branch ? "bg-accent" : "bg-muted"
                                                )}
                                            />
                                            <span className="flex-1 truncate font-mono text-[12px]">{b.name}</span>
                                            {b.age ? <span className="shrink-0 text-[10.5px] text-muted">{b.age}</span> : null}
                                        </button>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    </Section>
                    {error ? <div className="text-[12px] text-error">{error}</div> : null}
                </div>
                <div className="flex shrink-0 items-center gap-3 border-t border-border px-[18px] py-[13px]">
                    <span className="font-mono text-[11px] text-muted">
                        Starting in <span className="text-accent-soft">{selectedProject || "—"}</span>
                    </span>
                    <div className="flex-1" />
                    <button
                        onClick={close}
                        className="cursor-pointer rounded-[8px] border border-edge-mid bg-transparent px-[15px] py-2 text-[12.5px] font-semibold text-ink-mid hover:border-edge-strong hover:text-primary"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => void launch()}
                        className="flex cursor-pointer items-center gap-[7px] rounded-[8px] border-0 bg-accent px-4 py-2 text-[12.5px] font-semibold text-background hover:bg-accenthover"
                    >
                        {runtimeLaunchLabel(runtime)}
                        <span className="font-mono text-[10.5px] opacity-70">⌘↵</span>
                    </button>
                </div>
            </div>
        </div>
    );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="mb-[9px] font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                {label}
            </div>
            {children}
        </div>
    );
}
