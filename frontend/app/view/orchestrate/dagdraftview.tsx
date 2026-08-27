import { type JSX } from "react";
import { modelFace } from "../agents/route";
import { DagDraftGraph } from "./dagdraftgraph";
import { DagDraftSummaryView } from "./dagdraftsummary";
import { DagTaskDrawer } from "./dagtaskdrawer";
import { projectDraftSummary, type DagDraftSummary } from "./draftsummary";
import type { DagDraftState, DagLaunchingState, DagModalAction } from "./dagmodalstate";
import { type DagDraft } from "./draftmodel";

export function DagDraftView({
    state,
    summary,
    harnesses,
    dispatch,
    onLaunch,
    onRetry,
    disabled,
}: {
    state: DagDraftState | DagLaunchingState;
    summary: DagDraftSummary;
    harnesses: HarnessInfo[];
    dispatch: (action: DagModalAction) => void;
    onLaunch: () => void;
    onRetry: () => void;
    disabled: boolean;
}): JSX.Element {
    const reviewState = state as DagDraftState;
    const applyDraft = (draft: DagDraft) => dispatch({ type: "apply-draft", draft });
    const projected = projectDraftSummary({ request: state.request, draft: state.draft, fallback: state.fallback, warnings: state.warnings, harnesses });
    const currentSummary = projected.title === summary.title && projected.taskCount === summary.taskCount ? projected : summary;
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-none items-center gap-3 border-b border-border bg-surface px-4 py-3">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-xxs uppercase tracking-wide text-accent-soft">{state.kind === "launching" ? "Launching" : state.fallback ? "Fallback draft" : "Draft plan"}</span><span className="font-mono text-xxs text-muted">{state.request.route.runtime} / {modelFace(state.request.route)}</span></div>
                    <h3 className="mt-1 truncate text-[16px] font-bold text-primary">{state.draft.title}</h3>
                </div>
                <div className="flex items-center gap-2">
                    {state.kind === "draft" && state.fallback ? <button type="button" onClick={onRetry} disabled={disabled} className="cursor-pointer rounded-md border border-edge-mid px-2.5 py-1.5 text-[11px] font-semibold text-secondary hover:border-edge-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">Retry</button> : null}
                    <button type="button" onClick={onLaunch} disabled={!currentSummary.canLaunch || disabled} data-dag-launch className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-[11px] font-bold text-background hover:bg-accenthover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50">Launch <span className="ml-1 rounded bg-accent-soft px-1 py-0.5 text-background">Ctrl Enter</span></button>
                </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                {state.view === "summary" ? (
                    <DagDraftSummaryView state={reviewState} summary={currentSummary} onSelectTask={(taskId) => dispatch({ type: "select-task", taskId })} onOpenGraph={() => dispatch({ type: "set-view", view: "graph" })} />
                ) : (
                    <DagDraftGraph draft={state.draft} selectedTaskId={state.selectedTaskId} onSelectTask={(taskId) => dispatch({ type: "select-task", taskId })} onChange={disabled ? undefined : applyDraft} onOpenSummary={() => dispatch({ type: "set-view", view: "summary" })} />
                )}
                {state.selectedTaskId ? <DagTaskDrawer draft={state.draft} taskId={state.selectedTaskId} disabled={disabled} onChange={applyDraft} onClose={() => dispatch({ type: "close-drawer" })} /> : null}
            </div>
            <div aria-live="polite" className="sr-only">{currentSummary.validationErrors.length === 0 ? "Draft is valid and ready to launch" : `${currentSummary.validationErrors.length} validation errors block launch`}</div>
        </div>
    );
}
