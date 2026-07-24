// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { composerReveal } from "@/app/element/motiontokens";
import { PopoverReveal } from "@/app/element/popoverreveal";
import { DialogButton } from "@/app/modals/dialogbutton";
import { ModalShell } from "@/app/modals/modalshell";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { formatChordString } from "@/util/keysym";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentsViewModel } from "./agents";
import { agentCwd } from "./agentcwd";
import { liveProjectsForLaunch } from "./agentsviewmodel";
import {
    composeStartupCommand,
    deriveBranch,
    RUNTIME_FLAGS,
    runtimeLaunchLabel,
    runtimeShowsTask,
    runtimeStartupCommand,
    runtimeSupportsWorktree,
    worktreeOutcome,
    type Runtime,
} from "./launch";
import { naFlagsAtom, naRememberFlagsAtom } from "./naflagsstore";
import { canSharpen, isCurrentRequest, undoAvailable, type SharpenMode, type SharpenState } from "./sharpen";
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
    const naFlags = useAtomValue(naFlagsAtom);
    const remember = useAtomValue(naRememberFlagsAtom);
    const [runtime, setRuntime] = useState<Runtime>("claude");
    const [project, setProject] = useState<string>("");
    const [task, setTask] = useState("");
    const [startup, setStartup] = useState("claude");
    const [flagMenuOpen, setFlagMenuOpen] = useState(false);
    const [flagQuery, setFlagQuery] = useState("");
    const [useWorktree, setUseWorktree] = useState(false);
    const [branch, setBranch] = useState("");
    const [branchEdited, setBranchEdited] = useState(false);
    const [currentBranch, setCurrentBranch] = useState("");
    const [branches, setBranches] = useState<BranchInfo[]>([]);
    const [branchListOpen, setBranchListOpen] = useState(false);
    const [resolvedPaths, setResolvedPaths] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const reqIdRef = useRef(0);
    const taskRef = useRef<HTMLTextAreaElement>(null);
    const [sharpen, setSharpen] = useState<SharpenState>({ kind: "idle" });
    // Launcher targets mirror the project switcher: registered projects ∪ live-derived ones.
    const candidates = useMemo(() => launchCandidates(registry, liveProjectsForLaunch(agents)), [registry, agents]);
    const pathFor = (c: LaunchCandidate | undefined): string => (c ? c.path || resolvedPaths[c.name] || "" : "");
    const selectedProject = project || candidates[0]?.name || "";
    const selectedCandidate = candidates.find((c) => c.name === selectedProject);
    const selectedPath = pathFor(selectedCandidate);
    const branchNames = branches.map((b) => b.name);
    // The field shows the project's current branch until the user types/picks their own.
    const effectiveBranch = branchEdited ? branch : currentBranch;
    // Flags: the selected runtime's catalog, the enabled subset (as chips), the search-filtered menu,
    // and the resolved command that launch will actually run (base field + enabled flags). Flag state
    // is scoped per runtime, so read/write only the selected runtime's subrecord.
    const flagCatalog = RUNTIME_FLAGS[runtime];
    const runtimeFlags = naFlags[runtime] ?? {};
    const enabledFlags = flagCatalog.filter((f) => runtimeFlags[f.id]);
    const flagQ = flagQuery.trim().toLowerCase();
    const menuFlags = flagCatalog.filter(
        (f) => !flagQ || f.flag.toLowerCase().includes(flagQ) || f.desc.toLowerCase().includes(flagQ)
    );
    const commandPreview = composeStartupCommand(startup, runtime, runtimeFlags);
    const setFlag = (id: string, on: boolean) =>
        globalStore.set(naFlagsAtom, (prev) => ({ ...prev, [runtime]: { ...prev[runtime], [id]: on } }));
    const toggleFlagMenu = () => {
        setFlagQuery("");
        setFlagMenuOpen((v) => !v);
    };
    const close = () => {
        globalStore.set(model.newAgentOpenAtom, false);
        setError(null);
        reqIdRef.current++;
        setSharpen({ kind: "idle" });
    };
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
    // Focus the Task field when the modal opens (C1). runtime is intentionally out of deps — switching
    // runtime while the modal is open must not steal focus back to the task box.
    useEffect(() => {
        if (open && runtimeShowsTask(runtime)) {
            taskRef.current?.focus();
        }
    }, [open]);
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
    // Current branch drives the worktree default + outcome hint; GitChanges returns it via rev-parse.
    useEffect(() => {
        if (!open || !selectedPath) {
            setCurrentBranch("");
            return;
        }
        let cancelled = false;
        RpcApi.GitChangesCommand(TabRpcClient, { cwd: selectedPath })
            .then((rtn) => {
                if (!cancelled) {
                    setCurrentBranch(rtn?.branch ?? "");
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setCurrentBranch("");
                }
            });
        return () => {
            cancelled = true;
        };
    }, [open, selectedPath]);
    // Switching projects re-defaults the branch field to the new project's current branch.
    useEffect(() => {
        setBranchEdited(false);
    }, [selectedPath]);
    useEffect(() => {
        reqIdRef.current++;
        setSharpen({ kind: "idle" });
    }, [runtime, selectedProject]);
    const pickRuntime = (r: Runtime) => {
        setRuntime(r);
        setStartup(runtimeStartupCommand(r));
    };
    const runSharpen = async (mode: SharpenMode) => {
        const input = task;
        if (!canSharpen(runtime, input, sharpen.kind === "loading")) {
            return;
        }
        const reqId = ++reqIdRef.current;
        setSharpen({ kind: "loading", reqId, mode });
        try {
            const res = await RpcApi.SharpenTaskCommand(TabRpcClient, {
                task: input,
                projectname: selectedProject,
                runtime,
                mode,
            });
            if (!isCurrentRequest(reqId, reqIdRef.current)) {
                return; // stale: context changed or a newer request started
            }
            setTask(res.task);
            setSharpen({ kind: "proposed", undoTask: input, proposedTask: res.task, model: res.model });
        } catch (e) {
            if (!isCurrentRequest(reqId, reqIdRef.current)) {
                return;
            }
            setSharpen({ kind: "idle", error: String(e) });
        }
    };
    const undoSharpen = () => {
        if (sharpen.kind !== "proposed") {
            return;
        }
        setTask(sharpen.undoTask);
        reqIdRef.current++;
        setSharpen({ kind: "idle" });
    };
    const launch = async () => {
        const c = candidates.find((p) => p.name === selectedProject);
        const path = pathFor(c);
        if (!c || !path) {
            setError("Couldn't find a folder for this project. Add it via + New project.");
            return;
        }
        let branchArg: string | undefined;
        if (useWorktree && runtimeSupportsWorktree(runtime)) {
            const chosen = effectiveBranch.trim();
            if (!chosen) {
                setError("Enter a branch name or turn off the worktree option.");
                return;
            }
            // git can't reuse the already-checked-out branch; branch a fresh one off it instead.
            branchArg = chosen === currentBranch ? deriveBranch(currentBranch, branchNames) : chosen;
        }
        try {
            // Persist live-derived projects on first launch so they become stable, registered targets.
            if (!c.registered) {
                await RpcApi.CreateProjectCommand(TabRpcClient, { name: c.name, path });
            }
            await launchAgent(model, {
                runtime,
                startupCommand: composeStartupCommand(startup, runtime, runtimeFlags),
                task,
                projectPath: path,
                projectName: c.name,
                branch: branchArg,
            });
            // "Remember" off: flags are single-use, cleared for the next agent.
            if (!globalStore.get(naRememberFlagsAtom)) {
                globalStore.set(naFlagsAtom, {});
            }
            close();
        } catch (e) {
            setError(String(e));
        }
    };
    return (
        <ModalShell open={open} onClose={close} onSubmit={() => void launch()} className="flex flex-col w-[min(640px,93vw)] max-h-[86vh]" dismissOnBackdrop={false}>
            {open ? (
                <>
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
                                                "flex items-center gap-[7px] rounded border bg-surface px-[11px] py-[7px]",
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
                        <Section
                            label="Task"
                            action={
                                <SharpenControls
                                    sharpen={sharpen}
                                    canSharpenNow={canSharpen(runtime, task, sharpen.kind === "loading")}
                                    undoOk={undoAvailable(sharpen, task)}
                                    onSharpen={(mode) => void runSharpen(mode)}
                                    onUndo={undoSharpen}
                                />
                            }
                        >
                            <textarea
                                ref={taskRef}
                                value={task}
                                onChange={(e) => setTask(e.target.value)}
                                placeholder="Describe what this agent should do…"
                                className="h-[84px] w-full resize-none rounded-[10px] border border-edge-mid bg-surface px-[13px] py-[11px] text-[13.5px] leading-normal text-primary outline-none focus:border-accent-700"
                            />
                            {sharpen.kind === "idle" && sharpen.error ? (
                                <div className="mt-[7px] text-[12px] text-error">Couldn't sharpen. {sharpen.error}</div>
                            ) : null}
                        </Section>
                    ) : null}
                    <Section label="Startup command · optional">
                        <div className="flex items-center gap-[9px] rounded border border-edge-mid bg-surface px-3 py-[9px]">
                            <span className="font-mono text-[12.5px] font-semibold text-success">›</span>
                            <input
                                value={startup}
                                onChange={(e) => setStartup(e.target.value)}
                                placeholder={runtime === "terminal" ? "bash" : "claude"}
                                className="flex-1 bg-transparent font-mono text-[12.5px] text-secondary outline-none"
                            />
                        </div>
                    </Section>
                    {flagCatalog.length > 0 ? (
                        <div>
                            <div className="mb-[9px] flex items-center gap-2">
                                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                                    Flags
                                </span>
                                <div className="flex-1" />
                                <button
                                    type="button"
                                    onClick={() => globalStore.set(naRememberFlagsAtom, (v) => !v)}
                                    title="Reuse the enabled flags for every new agent"
                                    className="flex cursor-pointer items-center gap-[6px]"
                                >
                                    <span
                                        className={cn(
                                            "flex h-[12px] w-[12px] items-center justify-center rounded-[3px] border font-mono text-[8px] font-bold text-background",
                                            remember ? "border-accent bg-accent" : "border-edge-strong"
                                        )}
                                    >
                                        {remember ? "✓" : ""}
                                    </span>
                                    <span
                                        className={cn(
                                            "text-[10.5px] font-medium",
                                            remember ? "text-accent-soft" : "text-muted"
                                        )}
                                    >
                                        Remember
                                    </span>
                                </button>
                            </div>
                            <div className="flex flex-wrap items-center gap-[6px]">
                                {enabledFlags.map((f) => (
                                    <button
                                        key={f.id}
                                        type="button"
                                        onClick={() => setFlag(f.id, false)}
                                        title={`${f.desc} — click to remove`}
                                        className="flex cursor-pointer items-center gap-[7px] rounded-[7px] border border-accent-700 bg-accentbg py-[5px] pl-[9px] pr-[8px] hover:border-accent-600"
                                    >
                                        <span className="font-mono text-[11.5px] font-semibold text-accent-soft">
                                            {f.flag}
                                        </span>
                                        <span className="font-mono text-[13px] leading-none text-muted">×</span>
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    onClick={toggleFlagMenu}
                                    className={cn(
                                        "flex cursor-pointer items-center gap-[5px] rounded-[7px] border border-dashed bg-surface px-[10px] py-[5px] hover:border-edge-strong",
                                        flagMenuOpen ? "border-accent-700 text-accent-soft" : "border-edge-strong text-muted"
                                    )}
                                >
                                    <span className="font-mono text-[13px] leading-none">+</span>
                                    <span className="text-[11.5px] font-medium">Add flag</span>
                                </button>
                            </div>
                            <AnimatePresence>
                                {flagMenuOpen && (
                                    <motion.div
                                        variants={composerReveal}
                                        initial="initial"
                                        animate="animate"
                                        exit="exit"
                                        className="mt-2 overflow-hidden rounded-[10px] border border-edge-mid bg-surface"
                                    >
                                        <div className="flex items-center gap-2 border-b border-edge-faint px-[11px] py-2">
                                            <span className="font-mono text-[12px] font-semibold text-success">/</span>
                                            <input
                                                value={flagQuery}
                                                onChange={(e) => setFlagQuery(e.target.value)}
                                                placeholder="Search flags…"
                                                className="flex-1 bg-transparent font-mono text-[12px] text-secondary outline-none"
                                            />
                                            <span className="whitespace-nowrap font-mono text-[10px] text-muted">
                                                {flagCatalog.length} for {RUNTIMES.find((r) => r.id === runtime)?.name}
                                            </span>
                                        </div>
                                        <div className="max-h-[158px] overflow-y-auto p-[5px]">
                                            {menuFlags.length === 0 ? (
                                                <div className="p-[14px] text-center text-[11.5px] text-muted">
                                                    No matching flags
                                                </div>
                                            ) : (
                                                menuFlags.map((f) => {
                                                    const on = !!runtimeFlags[f.id];
                                                    return (
                                                        <button
                                                            key={f.id}
                                                            type="button"
                                                            onClick={() => setFlag(f.id, !on)}
                                                            className={cn(
                                                                "flex w-full cursor-pointer items-center gap-[10px] rounded-[7px] px-[9px] py-[7px] text-left hover:bg-surface-hover",
                                                                on ? "bg-accentbg" : ""
                                                            )}
                                                        >
                                                            <span
                                                                className={cn(
                                                                    "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border font-mono text-[9px] font-bold text-background",
                                                                    on ? "border-accent bg-accent" : "border-edge-strong"
                                                                )}
                                                            >
                                                                {on ? "✓" : ""}
                                                            </span>
                                                            <span
                                                                className={cn(
                                                                    "shrink-0 font-mono text-[11.5px] font-semibold",
                                                                    on ? "text-accent-soft" : "text-muted-foreground"
                                                                )}
                                                            >
                                                                {f.flag}
                                                            </span>
                                                            <span className="flex-1 truncate text-right text-[11px] text-muted">
                                                                {f.desc}
                                                            </span>
                                                        </button>
                                                    );
                                                })
                                            )}
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    ) : null}
                    {runtimeSupportsWorktree(runtime) ? (
                        <Section label="Worktree">
                            <div className="flex items-center gap-[10px]">
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={useWorktree}
                                    onClick={() => setUseWorktree((v) => !v)}
                                    className={cn(
                                        "relative h-[20px] w-[34px] shrink-0 cursor-pointer rounded-full transition-colors",
                                        useWorktree ? "bg-accent" : "bg-edge-strong"
                                    )}
                                >
                                    <span
                                        className={cn(
                                            "absolute top-[3px] h-[14px] w-[14px] rounded-full bg-background transition-all",
                                            useWorktree ? "left-[18px]" : "left-[2px]"
                                        )}
                                    />
                                </button>
                                <span
                                    onClick={() => setUseWorktree((v) => !v)}
                                    className="cursor-pointer text-[12.5px] font-medium text-secondary"
                                >
                                    Run in an isolated git worktree
                                </span>
                            </div>
                            {useWorktree ? (
                                <div className="relative mt-[11px]">
                                    <div className="flex items-center rounded border border-edge-mid bg-surface focus-within:border-accent-700">
                                        <input
                                            value={effectiveBranch}
                                            onChange={(e) => {
                                                setBranch(e.target.value);
                                                setBranchEdited(true);
                                            }}
                                            onFocus={() => setBranchListOpen(true)}
                                            placeholder={currentBranch || "feat/new-agent"}
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
                                    <PopoverReveal
                                        open={branchListOpen && branches.length > 0}
                                        origin="bottom left"
                                        className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-[168px] overflow-y-auto rounded border border-edge-mid bg-modalbg py-1 shadow-popover"
                                    >
                                        {branches.map((b) => (
                                            <button
                                                key={b.name}
                                                type="button"
                                                onClick={() => {
                                                    setBranch(b.name);
                                                    setBranchEdited(true);
                                                    setBranchListOpen(false);
                                                }}
                                                className={cn(
                                                    "flex w-full cursor-pointer items-center gap-2 px-3 py-[7px] text-left hover:bg-surface-hover",
                                                    b.name === effectiveBranch ? "text-primary" : "text-secondary"
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        "h-[6px] w-[6px] shrink-0 rounded-full",
                                                        b.name === effectiveBranch ? "bg-accent" : "bg-muted"
                                                    )}
                                                />
                                                <span className="flex-1 truncate font-mono text-[12px]">
                                                    {b.name}
                                                </span>
                                                {b.age ? (
                                                    <span className="shrink-0 text-[10.5px] text-muted">{b.age}</span>
                                                ) : null}
                                            </button>
                                        ))}
                                    </PopoverReveal>
                                    <div className="mt-[7px] text-[11px] text-muted">
                                        {worktreeOutcome({ branch: effectiveBranch, currentBranch, branchNames })}
                                    </div>
                                </div>
                            ) : null}
                        </Section>
                    ) : null}
                    {error ? <div className="text-[12px] text-error">{error}</div> : null}
                </div>
                <div className="flex shrink-0 items-center gap-3 border-t border-border px-[18px] py-[13px]">
                    <div className="flex min-w-0 flex-col gap-[3px] overflow-hidden">
                        <span className="font-mono text-[10px] text-muted">
                            Starting in <span className="text-accent-soft">{selectedProject || "—"}</span>
                        </span>
                        {commandPreview ? (
                            <span className="truncate font-mono text-[11px] font-semibold text-ink-mid">
                                {commandPreview}
                            </span>
                        ) : null}
                    </div>
                    <div className="flex-1" />
                    <DialogButton variant="secondary" hint="esc" onClick={close}>
                        Cancel
                    </DialogButton>
                    <DialogButton variant="primary" hint={formatChordString("Cmd:Enter")} onClick={() => void launch()}>
                        {runtimeLaunchLabel(runtime)}
                    </DialogButton>
                </div>
                </>
            ) : null}
        </ModalShell>
    );
}

function Section({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
    return (
        <div>
            <div className="mb-[9px] flex min-h-[16px] items-center gap-[9px]">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                    {label}
                </span>
                {action ? <div className="ml-auto flex items-center">{action}</div> : null}
            </div>
            {children}
        </div>
    );
}

function SharpenControls({
    sharpen,
    canSharpenNow,
    undoOk,
    onSharpen,
    onUndo,
}: {
    sharpen: SharpenState;
    canSharpenNow: boolean;
    undoOk: boolean;
    onSharpen: (mode: SharpenMode) => void;
    onUndo: () => void;
}) {
    const btn =
        "cursor-pointer rounded-[6px] border border-edge-mid bg-surface px-[9px] py-[3px] text-[11px] font-medium text-secondary hover:border-edge-strong disabled:cursor-not-allowed disabled:opacity-40";
    if (sharpen.kind === "loading") {
        return (
            <span className="flex items-center gap-[6px] text-[11px] text-muted">
                <span className="inline-block h-[10px] w-[10px] animate-spin rounded-full border border-edge-mid border-t-accent" />
                Sharpening…
            </span>
        );
    }
    if (sharpen.kind === "proposed") {
        return (
            <div className="flex items-center gap-[7px]">
                {undoOk ? (
                    <button type="button" className={btn} onClick={onUndo}>
                        Undo
                    </button>
                ) : null}
                <button type="button" className={btn} onClick={() => onSharpen("sonnet")}>
                    Try with Sonnet
                </button>
            </div>
        );
    }
    return (
        <button type="button" className={btn} disabled={!canSharpenNow} onClick={() => onSharpen("fast")}>
            Sharpen
        </button>
    );
}
