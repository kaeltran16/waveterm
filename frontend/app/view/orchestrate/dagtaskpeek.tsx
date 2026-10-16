// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// The selected task's peek: what it is, who works on it, and what can be done to it, in the shell beside its
// node. The graph mounts it per task (key={task.id}), so its open panels never follow the selection.

import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import type { AgentsViewModel } from "../agents/agents";
import { glyphKind, wordOf } from "./dagcanvas";
import type { TaskBrief } from "./dagdigest";
import { closeDagModal, dagModalAgentsContextAtom } from "./dagmodalstate";
import { DagPeekCard, type PeekPlace } from "./dagpeekcard";
import type { DagViewNode } from "./dagstore";
import { openTaskWorker, resolveTaskWorker, type TaskWorkerView } from "./taskcorrelate";

const HINT = "double-click opens its worker · Esc closes";

export function DagTaskPeek({
    view,
    task,
    place,
}: {
    group: TaskGroup;
    owner: Run;
    view: DagViewNode;
    task: TaskNode;
    digestTask: DagTaskDigest | undefined;
    briefs: Map<string, TaskBrief>;
    place: PeekPlace;
}) {
    return (
        <DagPeekCard
            place={place}
            attrs={{ "data-dag-task-peek": task.id }}
            label={`${task.id} details`}
            closeLabel="Close task details"
            glyph={glyphKind(task)}
            title={view.label}
            meta={
                <>
                    <span className="text-secondary">{task.id}</span>
                    <span>·</span>
                    <span>{wordOf(task)}</span>
                </>
            }
            hint={HINT}
        >
            {null}
        </DagPeekCard>
    );
}

// openTaskFromGraph opens a task's worker from a double-click or Enter, to the same place the peek's button
// goes. It loads the child run first rather than reading its atom: only the selected task's run is
// subscribed, and an unloaded run would resolve a live worker as unavailable.
export async function openTaskFromGraph(task: TaskNode): Promise<void> {
    const childRun = task.runid ? await WOS.loadAndPinWaveObject<Run>(WOS.makeORef("run", task.runid)) : undefined;
    const ctx = globalStore.get(dagModalAgentsContextAtom);
    if (ctx == null) return;
    openFromGraph(resolveTaskWorker({ id: task.id, runid: task.runid }, childRun, ctx.agents), ctx.model);
}

// openFromGraph is openTaskWorker for the graph's own entry points. A child run lands on the Brief, the
// surface this modal covers, so the modal closes first; left open, the run opened out of sight behind it and
// the press looked like it did nothing.
export function openFromGraph(worker: TaskWorkerView, model: AgentsViewModel): void {
    if (worker.state === "unavailable") closeDagModal();
    openTaskWorker(worker, model);
}
