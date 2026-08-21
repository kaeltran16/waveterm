import { toDagSubmitPayload, type DagDraft } from "./draftmodel";
import type { DagDraftRequest } from "../agents/composercommand";

export type DagSubmitPayload = ReturnType<typeof toDagSubmitPayload>;

export type DagLaunchDeps = {
    createDeferredRun(request: DagDraftRequest): Promise<Run>;
    submitDag(channelId: string, runId: string, payload: DagSubmitPayload): Promise<TaskGroup>;
    cancelRun(channelId: string, runId: string): Promise<void>;
};

export type DagLaunchResult =
    | { ok: true; channelId: string; runId: string; dagOref: string }
    | { ok: false; error: string };

export async function launchDagDraft(
    request: DagDraftRequest,
    draft: DagDraft,
    deps: DagLaunchDeps,
): Promise<DagLaunchResult> {
    const payload = toDagSubmitPayload(draft);
    let run: Run;
    try {
        run = await deps.createDeferredRun(request);
    } catch (error) {
        return { ok: false, error: `Couldn't create the deferred run: ${String(error)}` };
    }

    try {
        const group = await deps.submitDag(request.channelId, run.id, payload);
        return { ok: true, channelId: request.channelId, runId: run.id, dagOref: `dag:${group.oid}` };
    } catch (submitError) {
        try {
            await deps.cancelRun(request.channelId, run.id);
        } catch (cancelError) {
            return {
                ok: false,
                error: `DAG submission failed for run ${run.id}: ${String(submitError)}. Cleanup also failed: ${String(cancelError)}`,
            };
        }
        return { ok: false, error: `DAG submission failed for run ${run.id}: ${String(submitError)}` };
    }
}
