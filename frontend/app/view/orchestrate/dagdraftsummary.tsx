import { useState, type JSX, type ReactNode } from "react";
import { modelFace } from "../agents/route";
import type { DagDraftState } from "./dagmodalstate";
import type { DagDraftSummary } from "./draftsummary";

export function DagDraftSummaryView({
    state,
    summary,
    onSelectTask,
    onOpenGraph,
}: {
    state: DagDraftState;
    summary: DagDraftSummary;
    onSelectTask: (taskId: string) => void;
    onOpenGraph: () => void;
}): JSX.Element {
    const [showAllTasks, setShowAllTasks] = useState(false);
    const routineTasks = state.draft.tasks.filter((task) => summary.routineTaskIds.includes(task.id));
    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <section className="rounded-md border border-border bg-surface p-3" aria-label="Execution shape">
                <div className="flex items-center justify-between gap-3">
                    <h3 className="font-mono text-xxs font-semibold uppercase tracking-[.1em] text-ink-mid">Execution shape</h3>
                    <span className="font-mono text-xxs text-muted">{summary.runRoute.runtime} / {modelFace(summary.runRoute)}</span>
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2">
                    <Metric label="tasks" value={summary.taskCount} />
                    <Metric label="parallel" value={summary.parallelism} />
                    <Metric label="waves" value={summary.waves.length} />
                </div>
                <div className="mt-3 flex flex-col gap-1.5">
                    {summary.waves.map((wave) => (
                        <div key={wave.index} className="flex items-center gap-2 rounded-md bg-surface-raised px-2 py-1.5">
                            <span className="w-12 flex-none font-mono text-xxs text-muted">Wave {wave.index + 1}</span>
                            <div className="flex min-w-0 flex-wrap gap-1">
                                {wave.taskIds.map((taskId) => (
                                    <button
                                        key={taskId}
                                        type="button"
                                        onClick={() => onSelectTask(taskId)}
                                        className="cursor-pointer rounded-full border border-edge-faint bg-surface px-2 py-0.5 text-xxs text-secondary hover:border-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                                    >
                                        {state.draft.tasks.find((task) => task.id === taskId)?.label ?? taskId}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="rounded-md border border-border bg-surface p-3" aria-label="Planner status">
                <h3 className="font-mono text-xxs font-semibold uppercase tracking-[.1em] text-ink-mid">Planner status</h3>
                {state.fallback ? <StatusRow tone="warning" icon="!">Fallback draft · review before launch</StatusRow> : null}
                {summary.warnings.map((warning) => <StatusRow key={warning} tone="warning" icon="!">{warning}</StatusRow>)}
                {summary.validationErrors.map((error) => <StatusRow key={error} tone="error" icon="×">{error}</StatusRow>)}
                {!state.fallback && summary.warnings.length === 0 && summary.validationErrors.length === 0 ? (
                    <p className="mt-2 text-[12px] text-muted">No planner exceptions.</p>
                ) : null}
            </section>

            <section className="rounded-md border border-border bg-surface p-3" aria-label="Exceptions">
                <h3 className="font-mono text-xxs font-semibold uppercase tracking-[.1em] text-ink-mid">Exceptions</h3>
                <div className="mt-2 flex flex-col gap-1">
                    {summary.exceptions.length === 0 ? <p className="text-[12px] text-muted">All tasks inherit the Run route.</p> : null}
                    {summary.exceptions.map((exception) => (
                        <button
                            key={`${exception.kind}-${exception.taskId}`}
                            type="button"
                            onClick={() => onSelectTask(exception.taskId)}
                            className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        >
                            <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-xxs uppercase text-warning">{exception.kind}</span>
                            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-primary">{exception.label}</span>
                            <span className="font-mono text-xxs text-muted">{exception.taskId}</span>
                        </button>
                    ))}
                </div>
            </section>

            {showAllTasks ? (
                <section className="rounded-md border border-border bg-surface p-3" aria-label="All tasks">
                    <h3 className="font-mono text-xxs font-semibold uppercase tracking-[.1em] text-ink-mid">All tasks</h3>
                    <div className="mt-2 flex flex-col gap-1">
                        {routineTasks.map((task) => (
                            <button key={task.id} type="button" onClick={() => onSelectTask(task.id)} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                                <span className="font-mono text-xxs text-muted">{task.id}</span><span className="truncate text-[12px] text-secondary">{task.label}</span>
                            </button>
                        ))}
                    </div>
                </section>
            ) : null}

            <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setShowAllTasks((current) => !current)} className="cursor-pointer rounded-md border border-edge-mid bg-surface-raised px-3 py-1.5 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    {showAllTasks ? "Hide routine tasks" : "Show all tasks"}
                </button>
                <button type="button" onClick={onOpenGraph} className="cursor-pointer rounded-md border border-edge-mid bg-surface-raised px-3 py-1.5 text-[11px] font-semibold text-secondary hover:border-edge-strong hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    Open graph
                </button>
            </div>
        </div>
    );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
    return <div className="rounded-md border border-edge-faint bg-surface-raised p-2"><strong className="block text-title text-primary">{value}</strong><span className="font-mono text-xxs text-muted">{label}</span></div>;
}

function StatusRow({ tone, icon, children }: { tone: "warning" | "error"; icon: string; children: ReactNode }): JSX.Element {
    const colors = tone === "error" ? "border-error/60 text-error-soft" : "border-warning/60 text-warning-soft";
    return <div className={`mt-2 flex items-start gap-2 rounded-md border-l-2 bg-surface-raised px-2 py-1.5 text-[11px] ${colors}`}><span className="font-mono font-bold">{icon}</span><span>{children}</span></div>;
}
