// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { launchAgent } from "@/app/cockpit/cockpit-actions";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import type { AgentsViewModel } from "./agents";
import { runtimeLaunchLabel, runtimeShowsTask, runtimeStartupCommand, type Runtime } from "./launch";
import { launchableProjects, projectsAtom } from "./projectsstore";

const RUNTIMES: { id: Runtime; name: string; glyph: string }[] = [
    { id: "claude", name: "Claude Code", glyph: "✳" },
    { id: "codex", name: "Codex", glyph: "{ }" },
    { id: "antigravity", name: "Antigravity", glyph: "◭" },
    { id: "terminal", name: "Terminal", glyph: "›_" },
];

export function NewAgentModal({ model }: { model: AgentsViewModel }) {
    const open = useAtomValue(model.newAgentOpenAtom);
    const registry = useAtomValue(projectsAtom);
    const [runtime, setRuntime] = useState<Runtime>("claude");
    const [project, setProject] = useState<string>("");
    const [task, setTask] = useState("");
    const [startup, setStartup] = useState("claude");
    const [branch, setBranch] = useState("feat/new-agent");
    const [error, setError] = useState<string | null>(null);
    if (!open) {
        return null;
    }
    const projects = launchableProjects(registry);
    const selectedProject = project || projects[0]?.name || "";
    const close = () => {
        globalStore.set(model.newAgentOpenAtom, false);
        setError(null);
    };
    const pickRuntime = (r: Runtime) => {
        setRuntime(r);
        setStartup(runtimeStartupCommand(r));
    };
    const launch = async () => {
        const proj = projects.find((p) => p.name === selectedProject);
        if (!proj) {
            setError("Add a project first, then pick it here.");
            return;
        }
        try {
            await launchAgent(model, {
                runtime,
                startupCommand: startup,
                task,
                projectPath: proj.path,
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
                        {projects.length === 0 ? (
                            <div className="text-[12.5px] text-muted">
                                No projects yet — add one from the project switcher (+ New project).
                            </div>
                        ) : (
                            <div className="flex flex-wrap gap-[7px]">
                                {projects.map((p) => (
                                    <button
                                        key={p.name}
                                        onClick={() => setProject(p.name)}
                                        className={cn(
                                            "flex cursor-pointer items-center gap-[7px] rounded-[8px] border bg-surface px-[11px] py-[7px] hover:border-edge-strong",
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
                                    </button>
                                ))}
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
                        <input
                            value={branch}
                            onChange={(e) => setBranch(e.target.value)}
                            className="w-full rounded-[8px] border border-edge-mid bg-surface px-3 py-[9px] font-mono text-[12.5px] text-secondary outline-none focus:border-accent-700"
                        />
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
