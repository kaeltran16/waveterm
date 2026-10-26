// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// The Usage surface's Workflow lens: which scan run it follows, and the start of one. Every way into the lens
// is the address workflowscan:<runid>, so a start lands through the one router like any other open.

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, type PrimitiveAtom } from "jotai";
import { openTarget } from "../jarvis/openref";
import type { AgentsViewModel } from "./agents";

// module-level, not lens state: the surface unmounts on a switch, and the router writes this before it switches
export const workflowScanRunAtom = atom<string | null>(null) as PrimitiveAtom<string | null>;

// creating the run starts the scan agent's tab, which outlasts the 5s default
const START_SCAN_TIMEOUT_MS = 60_000;

// a start error propagates: the lens shows it where the button was
export async function startWorkflowScan(model: AgentsViewModel, channelId: string): Promise<Run> {
    const rtn = await RpcApi.WorkflowScanStartCommand(
        TabRpcClient,
        { channelid: channelId, workspaceid: globalStore.get(atoms.workspaceId) },
        { timeout: START_SCAN_TIMEOUT_MS }
    );
    if (rtn?.run == null) {
        throw new Error("starting the scan returned no run");
    }
    await openTarget(model, { kind: "workflowscan", runId: rtn.run.id });
    return rtn.run;
}
