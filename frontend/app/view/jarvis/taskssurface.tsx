// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { activeSpaceAtom } from "@/app/view/agents/spacestore";
import { SurfaceEmptyState, SurfaceError, SurfaceHeader } from "@/app/view/agents/surfacescaffold";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { TaskDetail } from "./taskdetail";
import { groupDossiers } from "./tasksderive";
import {
    dossierDetailAtom,
    loadTaskList,
    selectDossier,
    selectedDossierIdAtom,
    taskListAtom,
    tasksErrorAtom,
} from "./tasksstore";

export function TasksSurface() {
    const list = useAtomValue(taskListAtom);
    const selectedId = useAtomValue(selectedDossierIdAtom);
    const detail = useAtomValue(dossierDetailAtom);
    const error = useAtomValue(tasksErrorAtom);
    const activeSpace = useAtomValue(activeSpaceAtom);
    const lastSpaceRef = useRef<string | null>(null);

    useEffect(() => {
        loadTaskList();
    }, []);

    // Deep-link from the app-bar Space chip: when the active Space changes (or is set on mount),
    // preselect its dossier. A manual in-surface selection (same Space) is preserved by the ref guard.
    useEffect(() => {
        const spaceId = activeSpace?.id ?? null;
        if (spaceId != null && spaceId !== lastSpaceRef.current) {
            lastSpaceRef.current = spaceId;
            selectDossier(spaceId);
        }
    }, [activeSpace]);

    const groups = groupDossiers(list);
    return (
        <div className="flex h-full w-full flex-col">
            <SurfaceHeader title="Tasks" subtitle="Task dossiers — machine-maintained, with human notes and decisions" />
            {error != null ? <SurfaceError message={error} /> : null}
            <div className="flex min-h-0 flex-1">
                <div className="flex w-[280px] flex-none flex-col overflow-y-auto border-r border-border py-2">
                    {list.length === 0 ? (
                        <div className="px-4 py-6 text-[13px] text-muted">No tasks yet.</div>
                    ) : (
                        groups.map((g) => (
                            <div key={g.key} className="mb-2">
                                <div className="px-4 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">
                                    {g.label}
                                </div>
                                {g.items.map((d) => (
                                    <button
                                        key={d.id}
                                        type="button"
                                        onClick={() => selectDossier(d.id)}
                                        className={cn(
                                            "flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left hover:bg-surface-hover",
                                            selectedId === d.id && "bg-accent/10"
                                        )}
                                    >
                                        <span className="w-full truncate text-[13px] font-medium text-secondary">
                                            {d.objective}
                                        </span>
                                        {d.ticket ? <span className="font-mono text-[10px] text-muted">{d.ticket}</span> : null}
                                    </button>
                                ))}
                            </div>
                        ))
                    )}
                </div>
                <div className="min-w-0 flex-1 overflow-y-auto">
                    {detail != null ? (
                        <TaskDetail detail={detail} />
                    ) : selectedId != null ? (
                        <div className="p-8 text-[13px] text-muted">Loading…</div>
                    ) : (
                        <SurfaceEmptyState
                            title="Select a task"
                            body="Choose a dossier to view its machine-maintained state, your notes, and its decisions."
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
