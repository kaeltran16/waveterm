// frontend/app/view/agents/filessurface.tsx
// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Files surface (Wave-cockpit-live.dc.html:733-804): left = changed-file list for the focused
// agent's worktree; right = the selected file's diff (or plain view for untracked). Read-only.

import { getApi } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import type { AgentsViewModel } from "./agents";
import { type DiffLine, type FileView } from "./gitdiff";
import { statusColor, type GitChange } from "./gitstatus";
import { filesDiffAtom, filesSelectedPathAtom, filesStateAtom, loadFilesForAgent, selectFile } from "./filesstore";

function baseName(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] || p;
}

function EmptyCenter({ msg }: { msg: string }) {
    return <div className="flex h-full items-center justify-center text-[13px] text-ink-mid">{msg}</div>;
}

function FileRow({ change, selected, onSelect }: { change: GitChange; selected: boolean; onSelect: () => void }) {
    return (
        <button
            onClick={onSelect}
            className={cn(
                "flex w-full items-center gap-[7px] rounded-[7px] px-[8px] py-[5px] text-left hover:bg-surface-hover",
                selected && "bg-surface-hover"
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
    if (!path) {
        return <EmptyCenter msg="Select a file to view its changes" />;
    }
    return (
        <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-[11px] border-b border-border px-[20px] py-[13px]">
                <span className="min-w-0 truncate font-mono text-[13px] font-semibold">{path}</span>
                <div className="flex-1" />
                <span className="flex-none font-mono text-[11px] text-ink-mid">Read-only</span>
                {cwd && (
                    <button
                        onClick={() => getApi().openExternal(`${cwd}/${path}`)}
                        className="flex-none rounded-[8px] border border-border px-[11px] py-[6px] text-[12px] text-ink-mid hover:text-foreground"
                    >
                        Open in editor ↗
                    </button>
                )}
            </div>
            {view == null ? (
                <EmptyCenter msg="Loading…" />
            ) : (
                <>
                    {view.isDiff && (
                        <div className="flex flex-none items-center gap-[14px] border-b border-edge-faint px-[20px] py-[8px] font-mono text-[11px] font-bold">
                            <span className="text-success">+{view.adds}</span>
                            <span className="text-error">−{view.dels}</span>
                            <span className="font-medium text-ink-mid">{view.hunkLabel}</span>
                        </div>
                    )}
                    <div className="flex-1 overflow-auto py-[8px] font-mono text-[12.5px] leading-[1.75]">
                        {view.lines.map((l, i) => (
                            <DiffRow key={i} line={l} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

export function FilesSurface({ model }: { model: AgentsViewModel }) {
    const focusId = useAtomValue(model.focusIdAtom);
    const agents = useAtomValue(model.agentsAtom);
    const state = useAtomValue(filesStateAtom);
    const selected = useAtomValue(filesSelectedPathAtom);
    const diff = useAtomValue(filesDiffAtom);

    const agent = agents.find((a) => a.id === focusId);

    useEffect(() => {
        if (focusId) {
            fireAndForget(() => loadFilesForAgent(focusId, agent?.transcriptPath, agent?.blockId));
        }
    }, [focusId, agent?.transcriptPath, agent?.blockId]);

    if (!focusId) {
        return <EmptyCenter msg="Focus an agent to see its changed files" />;
    }
    const dirLabel = state?.cwd ? baseName(state.cwd) : "—";
    const changes = state?.changes;

    return (
        <div className="absolute inset-0 flex min-h-0">
            <div className="flex w-[292px] flex-none flex-col border-r border-border bg-surface">
                <div className="flex-none border-b border-edge-faint p-[15px]">
                    <div className="mb-[11px] flex items-center gap-[9px]">
                        <h1 className="text-[16px] font-bold">Files</h1>
                        <span className="font-mono text-[10.5px] text-ink-mid">read-only</span>
                    </div>
                    <div className="flex w-full items-center gap-[8px] rounded-[8px] border border-border px-[10px] py-[7px]">
                        <span className="flex-1 truncate font-mono text-[12px] text-ink-mid">{dirLabel}</span>
                    </div>
                    {state?.isRepo && (
                        <div className="mt-[10px] flex items-center gap-[13px] font-mono text-[11px] font-semibold">
                            <span className="text-ink-mid">{state.branch || "—"}</span>
                            <span className="text-success">+{changes?.adds ?? 0}</span>
                            <span className="text-error">−{changes?.dels ?? 0}</span>
                        </div>
                    )}
                </div>
                <div className="flex-1 overflow-y-auto p-[8px]">
                    {state == null ? (
                        <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">Loading…</div>
                    ) : !state.isRepo ? (
                        <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">Not a git repository</div>
                    ) : (changes?.files.length ?? 0) === 0 ? (
                        <div className="px-[8px] py-[6px] text-[12px] text-ink-mid">No changes</div>
                    ) : (
                        changes!.files.map((c) => (
                            <FileRow
                                key={c.path}
                                change={c}
                                selected={c.path === selected}
                                onSelect={() => state.cwd && fireAndForget(() => selectFile(state.cwd!, c.path))}
                            />
                        ))
                    )}
                </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
                <CenterPane path={selected} view={diff} cwd={state?.cwd ?? null} />
            </div>
        </div>
    );
}
