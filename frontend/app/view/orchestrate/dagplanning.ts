import { draftFromPlan } from "./draftmodel";
import type { DagDraftRequest } from "../agents/composercommand";
import { dispatchDagModal, type DagModalAction } from "./dagmodalstate";

export function createDagPlanningCoordinator(
    invoke: (request: DagDraftRequest) => Promise<CommandJarvisPlanDagRtnData>,
    dispatch: (action: DagModalAction) => void = dispatchDagModal,
): { run(requestId: number, request: DagDraftRequest): Promise<void> } {
    const inFlight = new Set<number>();
    return {
        async run(requestId, request) {
            if (inFlight.has(requestId)) return;
            inFlight.add(requestId);
            try {
                const response = await invoke(request);
                dispatch({
                    type: "plan-succeeded",
                    requestId,
                    draft: draftFromPlan(response),
                    fallback: response.fallback ?? false,
                    warnings: response.warnings ?? [],
                });
            } catch (error) {
                dispatch({ type: "plan-failed", requestId, error: `Planning request failed: ${String(error)}` });
            } finally {
                inFlight.delete(requestId);
            }
        },
    };
}
