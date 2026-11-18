// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useAtomValue } from "jotai";
import type { AgentsViewModel } from "./agents";
import type { AgentVM } from "./agentsviewmodel";
import { ASK_OWNER_USER } from "./childaskmodel";
import { roleRunId } from "./runlineage";
import { useRunAsks } from "./runrailsections";

// the agent's run role, its run's asks, and those waiting on the user: the lead's, or a worker's own task's
export function useRoleAsks(model: AgentsViewModel, agent: AgentVM) {
    const lineage = useAtomValue(model.lineageAtom);
    const role = lineage.roles[agent.id];
    const roleRun = role ? lineage.runs[roleRunId(role)] : undefined;
    const asks = useRunAsks(roleRun);
    const yours = asks.filter(
        (a) =>
            a.owner === ASK_OWNER_USER &&
            (role?.kind === "lead" || (role?.kind === "worker" && a.taskid === role.taskId))
    );
    return { lineage, role, roleRun, asks, yours };
}
