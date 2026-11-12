// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Approve in a brainstorm pane and Build this… on a canvas hand an approved design on. A run waiting on this
// session takes it; any other session opens the launcher. The server looks the run up: the frontend's run lists
// are loaded per channel and could miss it.

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { CREATE_RUN_TIMEOUT_MS } from "./runactions";

export type DesignAttach = (data: CommandRunDesignAttachData) => Promise<CommandRunDesignAttachRtnData>;

export type DesignRouteIO = {
    attach: DesignAttach;
    onAttached(channelId: string, runId: string): void;
    openLauncher(): void;
};

// the attach starts the run's lead before it replies, as CreateRun does, so it gets CreateRun's budget
export const tauriDesignAttach: DesignAttach = (data) =>
    RpcApi.RunDesignAttachCommand(TabRpcClient, data, { timeout: CREATE_RUN_TIMEOUT_MS });

export type DesignWaiting = (data: CommandRunDesignWaitingData) => Promise<CommandRunDesignAttachRtnData>;

export const tauriDesignWaiting: DesignWaiting = (data) => RpcApi.RunDesignWaitingCommand(TabRpcClient, data);

// the approve bar's Change opens the launcher, which in a session a run waits on would start a second run;
// Approve hands that run the design. A failed lookup keeps Change, the designed flow everywhere else
export async function changeShown(
    blockId: string | undefined,
    waiting: DesignWaiting = tauriDesignWaiting
): Promise<boolean> {
    if (!blockId) {
        return true;
    }
    try {
        return !(await waiting({ blockid: blockId }))?.runid;
    } catch (e) {
        console.warn("brainstorm: looking up the run waiting on the session failed", blockId, e);
        return true;
    }
}

// an attach the server refuses (a run already took this session's design) throws, and nothing opens
export async function routeDesign(
    io: DesignRouteIO,
    blockId: string,
    design: { spec?: string; prototype?: string }
): Promise<"attached" | "launcher"> {
    // the server refuses an empty design, which would leave an unlinked session's Approve opening nothing
    if (!design.spec && !design.prototype) {
        io.openLauncher();
        return "launcher";
    }
    const rtn = await io.attach({ blockid: blockId, spec: design.spec, prototype: design.prototype });
    if (rtn?.channelid && rtn?.runid) {
        io.onAttached(rtn.channelid, rtn.runid);
        return "attached";
    }
    io.openLauncher();
    return "launcher";
}
