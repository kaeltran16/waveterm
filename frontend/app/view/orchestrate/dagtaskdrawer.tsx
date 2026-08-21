import { type JSX } from "react";
import { RoutePicker } from "../agents/routepicker";
import {
    deleteDraftTask,
    dependencyCandidates,
    renameDraftTask,
    setDraftDependency,
    setDraftDescription,
    setDraftGate,
    setDraftRoute,
    type DagDraft,
} from "./draftmodel";

export function DagTaskDrawer({
    draft,
    taskId,
    disabled,
    onChange,
    onClose,
}: {
    draft: DagDraft;
    taskId: string;
    disabled: boolean;
    onChange: (draft: DagDraft) => void;
    onClose: () => void;
}): JSX.Element | null {
    const task = draft.tasks.find((candidate) => candidate.id === taskId);
    if (task == null) return null;
    const candidates = dependencyCandidates(draft, taskId);
    const apply = (next: DagDraft) => {
        if (next !== draft) onChange(next);
    };
    return (
        <aside className="flex w-full flex-none flex-col gap-3 border-l border-border bg-surface-raised p-4 lg:w-[320px]" aria-label={`Task details ${task.id}`}>
            <div className="flex items-center justify-between gap-2">
                <div><h3 className="font-mono text-xxs font-semibold uppercase tracking-[.1em] text-ink-mid">Task details</h3><p className="mt-1 font-mono text-xxs text-muted">{task.id}</p></div>
                <button type="button" onClick={onClose} disabled={disabled} aria-label="Close task drawer" className="cursor-pointer rounded-md border border-edge-mid px-2 py-1 text-xxs text-secondary hover:border-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50">Close</button>
            </div>
            <label className="flex flex-col gap-1 font-mono text-xxs text-muted">
                Label
                <input autoFocus disabled={disabled} value={task.label} onChange={(event) => apply(renameDraftTask(draft, taskId, event.target.value))} className="rounded-md border border-edge-mid bg-surface px-2 py-1.5 text-[12px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent" />
            </label>
            <label className="flex flex-col gap-1 font-mono text-xxs text-muted">
                Description
                <textarea disabled={disabled} value={task.description} onChange={(event) => apply(setDraftDescription(draft, taskId, event.target.value))} className="min-h-[84px] resize-y rounded-md border border-edge-mid bg-surface px-2 py-1.5 text-[12px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-accent" />
            </label>
            <fieldset disabled={disabled} className="flex flex-col gap-1 font-mono text-xxs text-muted">
                <legend>Dependencies</legend>
                <div className="flex flex-col gap-1 rounded-md border border-edge-mid bg-surface p-2">
                    {candidates.length === 0 ? <span>No cycle-safe dependencies</span> : candidates.map((candidate) => (
                        <label key={candidate.id} className="flex items-center gap-2 py-1 text-[11px] text-secondary">
                            <input type="checkbox" checked={task.deps.includes(candidate.id)} onChange={(event) => apply(setDraftDependency(draft, taskId, candidate.id, event.target.checked))} className="accent-accent focus-visible:ring-2 focus-visible:ring-accent" />
                            <span className="truncate">{candidate.id} · {candidate.label}</span>
                        </label>
                    ))}
                </div>
            </fieldset>
            <label className="flex items-center gap-2 text-[11px] text-secondary">
                <input type="checkbox" disabled={disabled} checked={task.gate} onChange={(event) => apply(setDraftGate(draft, taskId, event.target.checked))} className="accent-accent focus-visible:ring-2 focus-visible:ring-accent" />
                Gate on completion
            </label>
            <div className="flex flex-col gap-1 font-mono text-xxs text-muted">
                <span>Route</span>
                {disabled ? (
                    <span className="rounded-md border border-edge-mid bg-surface px-2.5 py-1.5 text-[11px] text-secondary">{task.route == null ? "Inherit Run route" : `${task.route.runtime} / ${task.route.tier}`}</span>
                ) : (
                    <RoutePicker value={task.route} canInherit inheritedLabel="Inherit Run route" onChange={(route) => apply(setDraftRoute(draft, taskId, route))} />
                )}
            </div>
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3">
                <button type="button" disabled={disabled || draft.tasks.length <= 1} onClick={() => { const next = deleteDraftTask(draft, taskId); if (next !== draft) { onChange(next); onClose(); } }} className="cursor-pointer rounded-md px-2 py-1 text-[11px] font-semibold text-error-soft hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error disabled:cursor-not-allowed disabled:opacity-50">Delete task</button>
                <span className="font-mono text-xxs text-muted">{draft.tasks.length}/8 tasks</span>
            </div>
        </aside>
    );
}
