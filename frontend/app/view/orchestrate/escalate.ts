// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure escalate verbs for the live DAG rail: judgment-only, one hop per task (the engine enforces
// the same cap; the UI mirrors it so the button disappears at the boundary).

export function canEscalate(task: { state: string; escalations?: number }): boolean {
    return (task.state === "failed" || task.state === "stalled") && (task.escalations ?? 0) < 1;
}

export function escalatePayload(channelId: string, runId: string, taskId: string, route: RoutePin): CommandDagActionData {
    return { channelid: channelId, runid: runId, taskid: taskId, action: "escalate", runtime: route.runtime, model: route.model ?? "" };
}
