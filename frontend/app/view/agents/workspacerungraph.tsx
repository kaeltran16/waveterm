// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Run tab's Graph view: the DAG modal's graph, static and without its header, since the tab's head already names
// the run. A selected task's card opens its agent, which needs the roster the modal otherwise gets from the Brief.

import { DagGraphView } from "@/app/view/orchestrate/daggraph";
import { setDagModalAgentsContext } from "@/app/view/orchestrate/dagmodalstate";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { runAtom } from "./channelsstore";
import { harnessesAtom } from "./harnessstore";
import type { RunViewProps } from "./workspaceruntab";

export function GraphView({ model, run }: RunViewProps) {
    const owner = useAtomValue(runAtom(run.runId));
    const harnesses = useAtomValue(harnessesAtom);
    const agents = useAtomValue(model.agentsAtom);
    useEffect(() => {
        setDagModalAgentsContext(model, agents);
    }, [model, agents]);
    if (run.dag == null || owner == null) {
        return (
            <div className="px-[18px] py-[14px] text-[12.5px] text-muted">
                No plan submitted yet, so there is no graph.
            </div>
        );
    }
    return (
        <div data-workspace-run-graph className="flex min-h-[360px] flex-1 flex-col">
            <DagGraphView oref={`dag:${run.dag.oid}`} owner={owner} harnesses={harnesses} embedded />
        </div>
    );
}
