// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { runtimeShowsTask, type Runtime } from "./launch";

export type SharpenMode = "fast" | "sonnet";

// Local-only sharpen state for NewAgentModal. No jotai atom or persistence — it lives and dies with
// the modal context. `reqId` on `loading` pairs with a monotonic counter to drop stale responses.
export type SharpenState =
    | { kind: "idle"; error?: string }
    | { kind: "loading"; reqId: number; mode: SharpenMode }
    | { kind: "proposed"; undoTask: string; proposedTask: string; model: string };

// The Sharpen button is only meaningful for agent runtimes (Terminal has no task field), and only
// when there is a non-empty task and no request already in flight.
export function canSharpen(runtime: Runtime, task: string, loading: boolean): boolean {
    return runtimeShowsTask(runtime) && task.trim().length > 0 && !loading;
}

// A response is applied only if it belongs to the latest request. The caller bumps the counter on
// every new request and on any context change (runtime/project), so a slow prior response is dropped.
export function isCurrentRequest(responseReqId: number, latestReqId: number): boolean {
    return responseReqId === latestReqId;
}

// Undo is offered only while the textarea still holds exactly the proposed text. Editing the result
// (textarea value diverges), a new request, or a context change all invalidate it.
export function undoAvailable(state: SharpenState, currentTask: string): boolean {
    return state.kind === "proposed" && currentTask === state.proposedTask;
}
